# 2026-07-30 WU 执行过程可视化 + 确认语义 + publish 归属链

> 依据：PMO 走查四问（WU 里看不到模型思考过程 / 确认按钮语义不明且疑似绕过 / 工具·skill 监控覆盖不足 / publish 归属链没接上）。
> 状态：Layer A（步级）、证据台账、publish 归属链已交付（commit `c1c6a2d4`）；Layer B（步内流式）本轮交付。
> 范围：apps/api（agents 模块、events 路由）、packages/studio-shared（process-io）、packages/studio-agent（session-manager、runner-lightweight）、apps/web（WorkUnitDrawer）。

## 问题与第一性结论

1. **过程可视化的位置**：频道是协作记录，只留里程碑（需求、分析结论、任务拆解、交付结果）；每步思考写进频道会迅速淹没讨论。过程明细属于 **WU 详情抽屉**，走事件流，不进频道、不写 WU metadata（防膨胀）。
2. **确认按钮语义**（三层证据台账，F6）：
   - L1 自动验证（verify 命令）、L2 Agent 评审 = **流程硬门**——过了才推进（analysis 过了才拆任务派工）；
   - L3 人工验收 = **台账留痕，不阻断**——done 缺 l3 时派生展示回审查列（`deriveDisplayState`），确认后出列。
   - in_review 的「通过」是审查硬门；done 的「确认」是 L3 留痕。实证 WU `41080c9f` 由 L2 agent-review 正常推进，无绕过。
3. **工具/skill 覆盖**：每步提炼 thinking（≤3×500 字符）/ toolCalls（≤30×160 字符摘要）/ skills / usage 落事件流；完整 transcript 按 claude projects 文件回放，不在事件流复制。
4. **publish 归属链缺口**：`resolveExecutionWorkspaceRoot` 只认 `metadata.workspaceRoot/workspaceId`，而 publish 建的 WU 只带 pmoId/pmoNumber → task WU 不走 per-WU worktree + PMO 分支合并，直接落共享开发仓。

## 已交付（Layer A + 配套）

- `agents/execution-step-events.ts`：step 结束提炼 rawOutput → `workunit:execution_step` 事件，落盘 studio-events.jsonl（REST 回放）+ SSE `workunit.execution.step`；fire-and-forget。
- `event.routes.ts`：GET /events 支持 `workUnitId` 过滤。
- WorkUnitDrawer：「证据台账」（L1/L2/L3 + 人工确认入口）与「执行过程」（步级时间线）两区块。
- publish 归属链：`project.service.ts` publish 建 analysis WU 落 `metadata.workspaceRoot = project.gitRepo`；`analysis-handoff.ts` 派生 task 继承 → B3a/B3b worktree + PMO 分支自动接上。
- `system-executor.ts` env 补 `IS_SANDBOX=1`：sdd-freshness post-commit LLM 的 root+flag 阻断消除（2min 超时是性能问题，按设计落 append 兜底）。

## Layer B：步内流式（本轮）

Layer A 只在 step **结束后**产出事件，step 执行的几分钟内抽屉仍是黑的。Layer B 在步内按行透传：

- `execSh` 新增 `onLine` 回调（`process-io.ts`）：stdout 按行增量切分，完整行即时回调，进程关闭时冲刷尾部；回调异常只记日志不影响执行。
- `AgentTask.onStreamLine`（session-manager.ts，与 `onProgress` 同形态的一等回调字段）→ `runner-lightweight.ts` 接线进 execSh。
- `execution-step-events.ts` 新增 `buildExecutionStreamChunks`：单行 stream-json → 0..n 个轻量 chunk（thinking/text/tool/result，截断）；`emitExecutionStreamChunks` **只发 SSE `workunit.execution.stream`，不落盘**（行级体量落盘会撑爆事件流）。
- agent-loop 在 execute 前发 `step-start` chunk（provider 无关的执行开始信号），执行中行级 chunk 实时到抽屉。
- 前端抽屉「执行过程」顶部加实时区块：订阅 `workunit.execution.stream`，按 workUnitId 过滤，内存保留当前步 ≤50 条，新 step-start 清空；step 结束事件到达后由 REST 回放的步级卡片接替（实时区自动让位）。

**容量纪律**：chunk 只走 SSE 内存，不写文件、不写 metadata；单条文本 ≤500 字符；前端只留当前步。

## 明确不做 / 遗留

- **token 级流式（Layer C）**：需给 CLI 加 `--include-partial-messages`（stream_event 增量），会改变 stdout 事件构成并放大输出量；行级（消息级）已覆盖「步内可见」诉求，事件结构已兼容，需要时再加。
- **deploy state.json 未记录手动部署**：装饰性，auto-deploy cron 下次执行自愈，不动。
- **sdd-freshness LLM 2min 超时**：性能问题（root 阻断已修），优化另议。
- RemoteExecutor（P1）接入时 `onStreamLine` 为函数不可序列化，远程节点需走节点侧回传通道，届时另设。

## 验证

- studio-shared：`process-io` onLine 行切分/尾部冲刷/异常隔离测试。
- apps/api：`buildExecutionStreamChunks` 提炼（thinking/text/tool/result/非 JSON 行跳过）+ 既有 529 agents 测试。
- apps/web：stream chunk 解析 + 抽屉实时区块渲染测试；tsc + build + 全量 vitest。
