# Studio 模块上下文（唯一沉淀正本）

> 本文件是 studio 仓模块级耐久知识的唯一正本（#152，依 T2b/#124 落点裁决：探索沉淀归业务仓 .studio/CONTEXT.md；跨模块领域术语词表在根 CONTEXT.md）。
> 组织方式：每个 `## <模块路径>` 锚点对应一个源码目录，锚点下分「职责 / 核心导出 / 依赖关系 / 测试 / 注意事项」等小节。
> 维护：按 ~/.studio/skills/exploration-sediment/SKILL.md 的分流清单重写（非追加）；模块增删时同步锚点。
> 旧模型（各源码目录散置 CONTEXT.md）已于 #152 摘除，历史内容见 git。


## apps/api/src/modules/admin

### 职责

提供 REST API 端点检查 CLAUDE.md 和 CAPABILITIES.md 的文档新鲜度，包括文件是否存在、最近修改时间、harness 约束检查结果，用于监控文档同步状态。

### 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `router` | `docs-freshness.routes.ts` | Express Router，挂载 `GET /` 路由，返回文档新鲜度检查结果（`FreshnessResult` 对象）。 |

### 依赖关系

**上游**：`@dommaker/studio-shared`（logger）、`@dommaker/harness`（checkConstraints）、Node.js 内置 `fs/promises`（readFile、stat）和 `path`（join）。
**下游**：`apps/api/src/route-registry.ts` 导入本目录的 `router` 并注册到主应用路由。

### 注意事项

- 端点路由为 `GET /`，挂载路径在 `route-registry.ts` 中决定（通常为 `/api/v1/admin/docs-freshness`）。
- `CLAUDE.md` 路径硬编码为 `process.cwd() + '/CLAUDE.md'`，部署时需确保工作目录正确。
- harness 约束检查失败时仅记录警告，不中断正常响应。
- 返回的 `harnessCheck` 字段在 harness 不可用时可能缺失，客户端需做可选处理。
- 若 `CLAUDE.md` 不存在，返回 `status: 'missing'` 和创建建议。
- **鉴权（2026-07-24 收紧）**：/api/v1/admin/docs-freshness 挂载层已收 requireAuth+requireAdmin（响应含服务器文件路径存在性/mtime）。


## apps/api/src/modules/agents

### 职责

负责管理 Agent 的配置（profile）、运行实例（instance）、决策循环（loop）以及内部审计 Agent（Auditor）等核心编排逻辑。提供 REST API 进行 CRUD 操作，并通过事件驱动机制实现 Agent 的自动挂载、运行和终止。

### 目录结构（工单 31，2026-08 按子域重组）

- `loop/` — 决策循环与 WU 执行链（agent-loop 及拆出文件、executor/remote-executor、completion-gates、wu-verification、execution-step-events、review-contract/review-dispatcher、daily-token-budget）
- `auditor/` — Auditor 内部 Agent（service/rules/execution/reports）
- `monitor/` — Monitor 内部 Agent（service/probes/system-probes/alerts/reports/lifecycle）
- `ops/` — 进程级守护（ops.service/ops-rules/system-health）
- `knowledge/` — 知识维护 Agent（curator/cold-start/extraction/maintenance）
- `triage/` — Triage 内部 Agent（triage.service）
- 根目录 — 共享与 legacy CRUD：routes、types、agent-profile/*、agent-instance/*、token-usage/*、default-provider、default-triggers、system-executor、session-summary.service、requirement-gate

### 核心导出

- `monitor/monitor.service.ts` — MonitorAgent 门面（健康监控 + 渐进告警，每 5min 轮询），T3 拆分后仅保留聚合/调度逻辑与实例状态；对外导出 `MonitorAgent` / `monitorAgent` 不变。
  - `monitor/monitor-probes.ts` — 任务/WorkUnit 级探测（失败趋势/停滞/超时/工具模式）；**#176 起系统推向 closed 双出声（决策 #62 §3）**：autoAbandonStaleBlocked（死信计时基准 = metadata.blockedAt，无则回退 createdAt；decision/spec 豁免）与 checkTotalExecutionTime 2.5h 强杀均经 workunit/wu-closure 统一出口（workunit:closed 事件 + 频道说明），不再静默 commitSnapshot；**#181（决策 #62 D2 + #167③）**：checkFailureTrend 改读统一事件流（workunit:failed + execution_step failed 近 1h 计数，阈值语义维持 ≥3 warning / 失败率>50% 且样本≥5 critical，旧 data/tasks 读取删除）；新增 checkPoolStagnation（unassigned 最老 >2h warning / >12h critical，指名未认领 assigneeId=profile id 与无人认领池分开出声）与 checkReviewStagnation（in_review 最老 updatedAt >24h warning / >72h critical）；三探针均走 dispatchMonitorAlerts 既有管线，不升级 Triage；**#221（#214 决议）**：checkStaleClaimGuard——unassigned 且 updatedAt>72h（STALE_CLAIM_GUARD_MS，constants/monitoring）的 WU 已被 observe 可见性层拦截（agent-loop 纯过滤零副作用，含显式指名），探针负责首次拦截发 1 条 warning（subject=wuId）；防重 = metadata.staleGuardBlockedAt 落盘（updateMetadata `touchUpdatedAt:false`——守卫写不能刷新 updatedAt 否则守卫复活僵尸）+ #220 冷却；updatedAt 被任何外部写刷新即复活，再沉睡超阈值重新告警
  - `monitor/monitor-system-probes.ts` — 系统/知识级探测与自修复（systemHealthCheck/worktree GC/知识健康循环/KnowledgeSync）
  - `monitor/monitor-alerts.ts` — 告警分发/Triage 升级（FL-037）/studio.jsonl 事件写入；#186 起 MonitorAlertSource 增 `analysis_confirm`（无频道 analysis 确认提示投 Web 收件箱，不升级 Triage）；**#220（#218 决议）**：`filterCooldownAlerts` 指纹冷却去重——指纹 = source+subject（回退 relatedTaskIds[0]→source 单车道），同指纹 warning 4h/critical 1h 只出声一次，升级立即出声重置计时，惰性 GC 24h，进程内存 Map 不落盘；接线于 check() 三消费者前 + instance-timeout-scan dispatch 前
  - `monitor/monitor-reports.ts` — 轨迹评估（G4）/每日洞察（DailyReflection）/交互模式观察（B9-025）
  - `monitor/monitor-lifecycle.ts` — G31 知识沉淀闸门 + 每日 23:55 数据 TTL 清理
- `auditor/auditor.service.ts` — AuditorAgent 门面（跨任务审计 + 周期洞察，每 24h 日审），T3 拆分后仅保留聚合/委托逻辑；对外导出 `AuditorAgent` / `auditorAgent` 不变。
  - `auditor/auditor-rules.ts` — 审计规则（错误归类/技能与 agent-type 建议 B3-005/用户模型质量/知识电路健康 I2）
  - `auditor/auditor-execution.ts` — 建议执行（低风险自动应用/确认卡片+铃铛通知/RKB Resolution 创建/Triage 升级/eval case 生成）
  - `auditor/auditor-reports.ts` — 洞察与报告输出（会话行为趋势/B13-011 七日趋势/tier 成功率反馈/#系统 推送）
- `knowledge/knowledge-curator.service.ts` — KnowledgeAgent 门面（知识库冷启动 + F1 每日维护），T3 拆分后保留公共 API（coldStartAll / runDailyMaintenance 聚合）；对外导出 `KnowledgeAgent` / `knowledgeAgent` / `EXTRACT_FROM_TEXT_SYSTEM_PROMPT` / `getExtractFromTextSystemPrompt` 不变。
  - `knowledge/knowledge-extraction.ts` — 提取 prompt 单一来源（EXTRACT_FROM_TEXT_SYSTEM_PROMPT + E1 文件覆盖 getter）
  - `knowledge/knowledge-cold-start.ts` — 冷启动四源导入（P1b: docs/code/git/manual）+ Discord 通知
  - `knowledge/knowledge-maintenance.ts` — 语料分析（F1：语义去重/质量评估/过期验证/矛盾审查）
- `default-triggers.ts` — 9 个系统默认 trigger 注册（6 retained + #163 inspection-scan 双通道 + #183 dispatch-reconciliation 对账扫描；含 `doc-semantic-review` 周级文档语义审查，2026-07 文档治理闭环 P1；#102 删 4 个：knowledge-quality-audit / session-knowledge-extraction / zero-consumption-audit / knowledge-synthesis，配置真相源归注册块，`getDefaultTriggerConfigs()` 已删；#162 T8-E1 行为修正：doc-semantic-review 从「周五自动跑」改「周五建单落 pending 待人确认」，闸在 trigger-action.ts 统一落；#183 增 `dispatch-reconciliation` 5min 对账扫描）
- `agent-loop.ts` — AgentLoop 门面（observe→resolveTarget→agentStep→recordResult 决策循环，AS-025），T3 拆分后仅保留循环主流程（start/runLoop/observe/agentStep 编排 + 薄壳委托）与 re-export；对外导出 `AgentLoop` / `parseAgentOutput` / `parseReviewReport` / `parseTaskBreakdown` / `dynamicInterval` / `analyzeKnowledgeSearch` / `extractKnowledgeEntryIds` / `resolveRealUsage` / `writeWorkunitTokenEvent` / `resolveToolTraceFile` / `writeToolCallEvents` / `isProcessAlive` / `isGitRepoRoot` / `resolveWorktreesDir` / `findAnchorMessage` / `resolveTarget` / `testWuGuardEnabled` / `isTestLikeWorkUnit` 及类型 `StepResult` / `KnowledgeSearchAnalysis` / `RealUsage` / `WorkunitTokenEventArgs` / `Observations` / `Target` 不变。
  - `agent-output-parser.ts` — ACTION 协议解析（parseAgentOutput）/ REVIEW_RESULT 审查结论解析 / TASK: 分析拆分行 / 动态轮询间隔（dynamicInterval）
  - `agent-knowledge-analysis.ts` — 知识检索行为分析（stream-json 日志 → searchCalls / 知识条目 id 提取）
  - `workunit-token-events.ts` — workunit:tokens / tool:call 事件写入（M2 成本红线 + B6 真实账单口径）+ STUDIO_EVENTS_JSONL 路径解析
  - `agent-loop-utils.ts` — 进程存活 / git 仓库根 / worktrees 目录小工具
  - `agent-targeting.ts` — Observations → Target 解析（认领优先级）+ 频道锚点消息
  - `wu-test-guards.ts` — B2 测试特征 WU 判定（STUDIO_TEST_WU_GUARD 开关 + scope 模式）
  - `prompt-composer.ts` — prompt 组装（base prompt 选择 + guard hint 注入 + persona/roster/skills/map/memory/knowledge/contract/handoff 注入段，#91 分段软定额 + 池内余量共享 + section_trimmed 埋点；#119 段序稳定性重排：稳定前缀序 persona → roster → skills → map → memory → knowledge（进 knowledgeContext，吃输入缓存），尾组序 base → contract → handoff → hint；#111 T5 探路地图完整段：destination + 近 N 条 decisions + 开放 fog 清单，non-blocking；#119 契约段生成器：按 WU type 产出格式 + 最小模板（review → REVIEW_RESULT / implement → 测试先行 + Phase commit / decision → 结论摘要 / analysis → research/prototype 产出载体（T3/#125）+ bug 路由规则与升级触发器（#121）/ bug → 复现测试先行 + 防回归测试随修复同 commit（#121），200 软定额，见 buildContractSection）；#95 handoff 前序进展段：续用不命中（含执行期降级换新号——check 判命中但执行报「会话不存在」时重算 prompt）+ stepCount>0 时注入，挂 base 后/hint 前，waitingQuestion 仅新会话回放截 300 字符；#100 角色记忆索引常驻注入：memory 段 = per-role MEMORY.md 索引全文，正文按需读，见 buildMemorySection）
  - `agent-loop-workspace.ts` — 执行根目录/worktree 解析（B3a 归属链 / B3b-i 专属 worktree / 提交守卫 git 探针；#113 T7 多腿：PMO 分支解析经 requirements `pmo-branch-resolver` 按 WU→腿归属出腿分支——metadata.workspaceRoot/worktreeBaseRepo 命中腿 gitRepo 或 pmoBranch 命中腿 branch，未命中回落项目级分支，单腿行为不变）
  - `session-resume.ts` — #94 会话续用判定纯函数（只信档案 metadata.sessionId；claude 按 cwd 校验 `~/.claude/projects/<cwd-slug>/<id>.jsonl` 存在性，slug = cwd 的 `/`、`.` → `-`；kimi/codex/opencode 档案有号即续用；RESUME_FAILURE_RE 识别「会话不存在」错误供降级重试）。B5 会话数上限（MAX_SESSIONS_PER_WU=5，#95 2→5，失败/超时的会话建立尝试计入预算）与降级重试编排在 agent-loop.ts agentStep
  - `agent-loop-instance-state.ts` — 运行时实例状态写入（启动失败记录 / idle 心跳 / 忙闲 SSE）
  - `agent-loop-record-result.ts` — recordResult（提交/子任务/验证守卫 + DELEGATE + 新鲜度检查 + 状态迁移 + 里程碑回帖）
  - `agent-loop-step-guards.ts` — agentStep 前置守卫（B2 测试特征 WU 关闭 / C3 每日 token 预算熔断）
- `default-provider.ts` — F1 provider 默认选取工具（2026-07-28 分析文档）：`resolveDefaultProvider()` 取 `scanAllProviders()` 第一个（扫不到 → null + warn，不再隐式兜底 claude）；`backfillProfileProviders()` 启动时回填存量空 provider 的 active 角色（不含 studio，幂等）。`agent-profile.service.create` 缺省 provider 经此打戳
- `loop/executor.ts` — §9.6 Executor 接口（AgentLoop 执行面抽象）：P0 `LocalExecutor` 原样委托 `agentRunner.executeLightweight`；P1 远程节点执行经同一接口接入；#178 增可选 `stopProcessGroup(executionId)`（fencing 易主杀 CLI 整进程组，委托 agentRunner 同名方法）
- `instance-timeout-scan.ts` — #179（#66 决议 3 scan 侧，2026-08-16）agent-timeout-scan handler 本体（自 index.ts 内联抽出）：心跳过期（5min，`AGENT_TIMEOUT_MS`）实例 terminate 前 pid 复核——`process.kill(pid, 0)` 活且 `pidStartMatchesInstance`（#178 /proc 启动时间比对，排 pid 复用）= FileStore 故障非 loop 死 → 不 terminate，发 warning 告警走 #62 管线（`dispatchMonitorAlerts`，source=`agent_timeout_scan`）；pid 死/无 pid/pid 复用 → 照常 terminate
- `dispatch-reconciliation.ts` — #183（#159 + #66 决议①，2026-08-16）派工/评审断链 5min 对账扫描 handler 本体（挂 default-triggers `dispatch-reconciliation`，timeout-scan 同类；对账哲学见根 CONTEXT.md）：analysis 侧比对哨兵清单 `analysisTasksSpawned` vs `analysisTasks` 补差集（`AnalysisHandoff.listMissingSpawnScopes`/`respawnScopes`，活体去重 + 人工关单不复活 + 旧时间戳哨兵兼容跳过，哨兵落档 ≥10min 宽限）；review 侧父 WU in_review ≥10min（updatedAt 为锚）且无未完结 review 子 WU → 幂等重跑 `ReviewDispatcher.redispatchReview`（createGuarded 锁内同父唯一性）。结构化 warning 事件 `analysis.respawned`/`review.redispatched` 落 studio-events + `dispatchMonitorAlerts` 走 #62 告警管线（频道不出声）；**#228：事件落盘（`writeStudioEvent`）改 await**（原 fire-and-forget `void`——reconcile 返回后事件文件未必落盘，测试读文件偶发空断言红；writeStudioEvent 永不抛出，await 安全；告警管线仍 fire-and-forget）；尝试数落 WU metadata（`analysisRespawnAttempts`/`reviewRedispatchAttempts`），连续 3 次仍败停跑并升 critical（达标轮发一次，不重复刷告警）
- `loop/execution-step-events.ts` — WU 过程可视化（2026-07-30）：Layer A 步级——每个 agent step 结束把 stream-json rawOutput 提炼成 `workunit:execution_step` 事件（thinking ≤3×500 字符 / toolCalls ≤30×160 字符摘要 / skills 注入名单 / usage），落盘 studio-events.jsonl（REST 回放）+ `workunit.execution.step` SSE 信封（自动落 workunits topic）；Layer B 步内流式——execSh `onLine` 把 CLI stdout 按行透传（runner-lightweight 接线 `AgentTask.onStreamLine`），每行提炼成轻量 chunk（thinking/text/tool/tool-result/result，≤500 字符、单行 ≤10 条）经 `workunit.execution.stream` SSE 直发，**只发 SSE 不落盘**（行级体量防膨胀），agent-loop 在 spawn 前合成 step-start 信号。**#240（2026-08-19）**：tool chunk 带 `toolUseId`（tool_use.id），user 事件 tool_result 块提炼为 `tool-result` chunk（toolUseId 配对 + isError + 扁平化文本，缺 tool_use_id 跳过）——支撑前端工具行四态；此前 user(tool_result) 整类跳过（降噪），per-tool 结果不存在于事件流。不进频道、不写 metadata 防膨胀；fire-and-forget 绝不影响任务流程。完整 transcript 不回放这里——查 agent HOME 的 `.claude/projects/<cwd-slug>/<sessionId>.jsonl`。**#172（#60 决策 Q1）**：execution_step payload 加 `status: success|failed` + errorType/errorDetail，失败步（CLI success:false / spawn 异常，agentStep 全部失败出口）也落盘——此前失败提前 return 到不了发射点；新增 `workunit:failed`（WU 转 blocked 终态失败时由 recordResult 落盘，envelope level=warning，payload = workUnitId/failureType/blockReason/consecutiveStuck/attempts/totalDurationMs/traceId，need_input 挂起不算失败不发射）
- `loop/wu-verification.ts` — B3b-i WU 自动验证的可复用实现（2026-07-30 F6-c 从 agent-loop 原样抽出，行为不变）：`CODE_WORKTREE_TYPES` / `resolveVerifyCommands`（覆盖 > 约定）/ `runWuVerification` / `extractExecOutputTail`；消费方 = completion-gates 的 COMPLETE 验证守卫 + agent-loop 步骤超限强制收口路径 + workunit 模块 `POST /workunits/:id/verify`
- `loop/completion-gates.ts` — 收口守卫链（2026-08 从 agent-loop.recordResult 抽出，行为不变）：`runCompletionGuards(ctx, deps)` 依次跑 §10.5 提交守卫（含 PROGRESS 无提交监视）→ §6-2 子任务守卫 → B3b-i 自动验证守卫（消费 wu-verification）→ #161 T7-E2 软观测段（仅 action 仍 complete 时跑，不降级不阻断：一次 `git log base..HEAD`（`%H/%s/%P/%(trailers)` + --name-only，2s 超时）喂 harness 三纯函数 tdd-chain/phase-format（仅 CODE_WORKTREE_TYPES）与 contract-presence（yml `completion_checkers:` contracts 清单圈定，review → metadata.reviewReport 在场），pass/violation/waiver 落 `checker:soft_check` 台账事件（skip 不记），违规合并 processCheckHint 走 prompt-composer 一次性消费回路；harness 函数经 runtime.loadHarness 特征检测，缺席（npm 0.19.0 未含 #160 导出）/git/超时（合计 5s）一律 fail-open 静默跳过），守卫顺序即优先级（前者降级后后者不触发）；hint 写入（commitGuardHint/childGuardHint/verifyFailHint/processCheckHint）与 l1 台账（approved/rejected）在本模块，git 探针 `hasUncommittedChanges`/`readHeadHash` 与验证/软观测实现经 deps 注入（单测纯 ctx 对象驱动，无需模块工厂 mock）；recordResult 只保留编排（构建合并视图 → 守卫 → delegate/新鲜度/强制收口补验 → **updateMetadata 锁内字段级合并写（#170，决策 #65-1：stepCount/consecutiveStuck 锁内重计、progressLog/pendingReplies 锁内追加，不再全量回写陈旧快照）** → 状态迁移/频道通知）；hint 的消费与清除仍在 agentStep（属 prompt 组装，非守卫政策）
- `loop/review-contract.ts` — 审查结论（verdict）语义单一来源（2026-08 收编）：`ReviewVerdict`（pass/reject/needs-info）与 issue 词表 + `ParsedReviewReport` 落档形状。消费方：agent-loop parseReviewReport（返回类型）、review-dispatcher.ts（路径 B 消费同型）。**2026-08-06 旧管理端点链路整体删除**：review.service.ts / review-report.ts / `POST /review/diff` 端点零真实调用方（web/CLI/scripts 均无），legacy 映射函数（deriveVerdictFromLegacyReport 等）随之移除；verdict 语义仅剩新管线一处解释
- `loop/agent-loop.ts` — AgentLoop 决策循环编排（observe→resolveTarget→agentStep→recordResult）。工单 28（2026-08）拆分后本文件只保留类编排逻辑与 re-export（对外导出语义不变），纯函数/辅助各归其位：
  - `loop/agent-loop.types.ts` — 类型契约（`StepResult`/`Observations`/`Target`/`RuntimeInstanceRow`/`KnowledgeSearchAnalysis`，纯类型零运行时依赖）
  - `loop/agent-loop-parsers.ts` — 输出解析与 prompt 模板纯函数（ACTION 协议 `parseAgentOutput`/`parseReviewReport`/`parseTaskBreakdown`、目标选择 `resolveTarget`/`dynamicInterval`、进程/git 探针、continue/reply prompt 模板）
  - `loop/agent-loop-events.ts` — `workunit:tokens` 与 `tool:call` 事件落盘（`writeWorkunitTokenEvent`/`resolveRealUsage`/`writeToolCallEvents`，含共享 `metricsFileStore`）。**#134（2026-08-18）usage 解析按 provider 分流**：`resolveRealUsage(result, provider)` 委托 studio-shared `extractProviderUsage`（opencode 读 step_finish.part.tokens、codex 读 turn.completed.usage、kimi stdout 无 usage 出口 → null，调研见 docs/research/kimi-usage-outlet.md），缺省 claude 行为不变；`workunit:tokens` payload 增 `provider` 字段（#120 按 provider 分桶的数据源）
  - `loop/agent-loop-guards.ts` — B2 测试特征 WU 守卫（`testWuGuardEnabled`/`isTestLikeWorkUnit`）+ F4 `parseExcludeAssignee`
  - `loop/lease-heartbeat.ts` — #178（#63 决议 1/2，2026-08-16）WU 租约心跳：持有中 WU 每 30s（`LEASE_HEARTBEAT_INTERVAL_MS`）把 timeoutAt 推前为 now+5min（`WU_LEASE_TTL_MS`，常量在 workunit.types），写经 FileStore `refreshWorkUnitLease` 锁内 fencing（claimedAt 代际令牌 + assigneeId 双比对与写入原子）；易主（lost）/WU 消失（missing）→ 停跳 + onLost 回调。AgentLoop 侧编排：runLoop 在认领/续跑后 `ensureLease`（幂等，令牌换代先停旧轨）、recordResult 入口 fencing 校验（易主放弃回写）、全部状态迁移走 `transitionIfHeld`（迁移前校验）、recordResult 后 `releaseLeaseIfForfeited`（WU 离 active 停跳，blocked 复活回 active 时 ensureLease 重开）、易主善后 `handleLeaseLost`（杀自身 CLI 进程组 + 停跳 + 静默退出）。**#179（#66 决议 3 loop 侧）**：实例心跳写（active/idle 两处）不再静默吞错，统一走 `updateStateWithHeartbeatWatch` 连败计数——连败 `HEARTBEAT_FAIL_LIMIT`=3 次（idle 45s 一跳 ≈90s）判定 FileStore 故障，`selfTerminateOnHeartbeatFailure` 自我了断（停租约 + 杀自身 CLI 进程组 + alive=false 静默退出，不写状态），在飞 WU 由租约到期正常回收
  - `loop/context-overflow.ts` — #96 CLI 上下文溢出纯反应式策略（纯函数零服务依赖）：`OVERFLOW_ERROR_RE`/`isContextOverflowError` 溢出识别（与 `RESUME_FAILURE_RE`「会话不存在」是不同失败类型；匹配 "Prompt is too long"/context length/token limit 等）+ `buildRollingSummary` 会话滚动摘要构建（来源 = wu.scope + progressLog，不递归摘要、不建语义搜索）。编排（溢出重试/配额检查/摘要落盘）在 agent-loop.ts agentStep
  - #162（T8-E1）WU 级 token 预算编排在 agentStep（日预算守卫之后）：`metadata.tokenBudget` 显式数值在场即生效，对照 `_cumulativeTokens`（billed 口径）超线 → need_input 挂起（waitingReason='wu-token-budget'），人三选分流在 workunit/waiting-input.ts

### 依赖关系

- 上游
  - `@dommaker/studio-shared`（eventBus、FileStore、logger、parseStreamEvents 等）
  - `@dommaker/studio-shared/node`（resolveProviderDefinition、buildHealthProbeCommand）
  - `@dommaker/studio-agent`（agentRunner、AgentTask、ExecutionResult）
  - `../../utils/errors.js`、`../../utils/pagination.js`
  - `../workunit/workunit.service.js`（WorkUnitService）
  - `../knowledge/knowledge-service.js`、`../knowledge/knowledge-bus.service.js`
  - `../triggers/trigger-registry.js`、`../workspaces/workspace-store.js`
  - `../../core/event-store.js`
  - 子模块：`auditor/auditor-rules.js`、`auditor/auditor-execution.js`、`auditor/auditor-reports.js`
- 下游
  - **apps/api/src**（cli/server.ts、index.ts、route-registry.ts）—— API 入口挂载 agents 路由及启动时初始化
  - **apps/api/src/modules/knowledge**（internal.routes.ts、knowledge-service.ts）—— 知识模块依赖本目录的 knowledge-agent.service 等
  - **apps/api/src/modules/workunit**（waiting-input.ts）—— 等待输入流程引用 agent 实例

### 注意事项

- **#96 CLI 上下文溢出纯反应式策略（2026-08-13）**：`SESSION_TOKEN_LIMIT`/`checkSessionTruncation` 观测防线整体删除（生产从未生效，读 outputText 纯文本从未命中过）。溢出改为纯反应式：CLI 回报溢出错误（`loop/context-overflow.ts` `OVERFLOW_ERROR_RE`）→ 会话滚动摘要落盘（`metadata.sessionSummary`，来源 = wu.scope + progressLog，不递归摘要）→ 新会话带摘要注入重试一次 → 再败 NEED_INPUT。溢出重试占会话配额（超限走 need_input），#95 续用降级路径也收口遵守 `MAX_SESSIONS_PER_WU`（删除 #94「绕过 MAX 一次」先例）；预防层（token 记账 + 阈值预警）不建
- **AgentProfile 持久化布局**：`~/.studio/data/agents/{id}/profile.json`（身份：name/description/provider/status/nodeId，模型见 `packages/studio-shared/src/file-store.ts`，无 systemPrompt 字段）+ 同目录 `state.json`（运行时实例）；原子写 + mkdir 锁，永久存在仅可显式 DELETE；保留名 `studio`（系统执行角色，provider 由 StudioRoleSetupModal 补配）
- **prompt 注入架构 = index-on-demand（严禁全量注入）**：skills 走索引+按需（step 时匹配：#92 硬预裁剪——只注入 +skill 点名 + 域匹配两类（scope 文本匹配与 rest 热度不进段，段尾 `~/.studio/skills/MANIFEST.md` 指针按需兜底），预裁剪后仍按段有效预算块级截断取代封顶 3；prompt 只放 name+description+triggers 摘要+`~/.studio/skills/<name>/SKILL.md` 绝对路径指针，正文不注入，agent 按需阅读，见 `loop/prompt-composer.ts` buildSkillSection）；知识分层（rule/context 约束层按设计全量、signal 层 `[id] summary` 索引、reference 层只报条数，见 knowledge-service.injectContext）；roster 只放 `name（provider）：description` 索引行且不含自身；#91 起注入段按分段软定额 + 池内余量共享截断（persona 300 / roster 400 / skills 600 / map 800（#111）/ memory 300 / knowledge 1000 / contract 200（#119）/ handoff 800，前段余量流入后段，总量 ~4.5K；任一段截断落 `prompt:section_trimmed` 事件；#119 段序稳定性重排（2026-08 落地）：稳定前缀序 persona → roster → skills → map → memory → knowledge（进 knowledgeContext，吃输入缓存，任务本体组以 recency 锚定行为），尾组序 base → contract → handoff → hint；handoff 段内容源 = #95 前序进展段（2026-08-13 落地：续用不命中 + stepCount>0 注入，挂 base 后/hint 前，waitingQuestion 仅新会话回放截 300 字符）；contract 段内容源 = #119 契约段生成器（按 WU type 产出格式 + 最小模板：review → REVIEW_RESULT 协议行 / implement → 测试先行 + Phase commit / decision → 结论摘要格式 / analysis → research 报告落 .studio/research/ 回挂来源单 + prototype 一次性分支不合并（T3/#125）+ bug 路由规则与升级触发器（#121，#105 快速路裁决进分析角色契约段）/ bug → 复现测试先行 + 防回归测试随修复同 commit（#121）；未知 type → 空段；内容定稿随 #118 续烤迭代）；memory 段内容源 = #100 角色记忆索引常驻注入（2026-08-14 落地：per-role MEMORY.md 索引全文，每行 = topic 路径 + 一句话摘要，正文由 agent 现成文件工具按需读，**不引入语义搜索/RAG**，受 300 软定额约束；索引不存在/为空/读盘失败 → 空段兜底 non-blocking，见 `loop/prompt-composer.ts` buildMemorySection）；persona 段消费 role preset 的 persona + skills/tools/constraints（#91 修复 preset 三字段不落盘不消费的断链）。不注入：agent 完整记录、频道列表、成员 ID、记忆 topic 正文
- **#111 T5 探路地图完整段（2026-08-11，接替 #107 T1 一行 tracer bullet）**：WU `metadata.pmoId` 反查 PMO 有 `map` 时渲染 `## PMO 地图` 段（无 pmoId / 无 map / 读取失败 → 不渲染，non-blocking）——destination 一行 + 近 N 条 decisions（新→旧，decisions[] 尾 = 最新；summary 超 160 字符截断加省略号）+ 开放 fog（open/in-discussion，resolved 不列）清单；段文本 #119 起移入稳定前缀（skills 后、memory 前，进 knowledgeContext，不再拼 prompt 尾部）。**N=10、定额 800 token 实测校准**（口径 TokenEstimator.estimateText）：典型场景（10 决策 × 30 字 summary + 5 雾 × 20 字）≈160 tok；顶格偏重（10 决策 × 160 字 + 15 雾 × 60 字）≈720 tok 仍在定额内；N=12 顶格偏重 ≈806 tok 破定额故取 10；30 条雾不可裁底 ≈570 tok，「fog 全保留」与 800 定额兼容。超预算截断策略：**fog 全保留，decisions 从旧到新逐条裁**（保最新）；决策裁光仍超（fog+destination 病态规模）按 TokenEstimator 兜底截。N 封顶不算截断；预算裁条落 `prompt:section_trimmed` 事件（payload：section=map / originalTokens / trimmedTokens / quota=800，同 #91 管道经 metricsFileStore 写 studio-events.jsonl）
- A2A 协作 P1（2026-07-agent-to-agent-collab-design）：`ACTION: DELEGATE:@<profileName>:<scope>` 协议由 recordResult 拦截，经 workunit/delegation-gate 校验后建子单（`metadata.collab`）+ 发 delegate 卡片，拒绝则降级 NEED_INPUT；父 complete 守卫（未完结子 WU → 降级 progress）；发言层新鲜度检查（step 期间房间有外部新消息 → 结果帖拦截注入 pendingReplies，连续 2 次后照发）；花名册段（## 频道成员与委派）纳入 #91 分段定额（roster 400 + 池余量）
- Idle 心跳间隔固定 45 秒（`IDLE_HEARTBEAT_INTERVAL_MS`），配合超时扫描 5 分钟阈值
- **#171 三层超时（2026-08-15，#54 决议 A1，数值 #68 实测）**：废除 120s 固定墙钟（连健康步 p90=128s 都不到，大量误杀）。新机制 = 步墙钟 1800s 仅兜底天花板（p99=693s × 2.6）+ 静默看门狗（判据 = 距最后一次输出间隔：300s warn 落 `workunit:step_silence` 事件 + logger.warn / 600s 杀进程组）+ maxTurns=50 与 token 记账维持预算语义。杀 = 杀进程组（execSh `killProcessGroup`：detached spawn + `kill(-pid, SIGKILL)`；#68 实测 SIGTERM 杀不死孙进程，孤儿烧 token 26s~36min）；静默看门狗实现在 studio-shared execSh（`silence` 选项），agent-loop 经 AgentTask `silenceWarnMs/silenceKillMs/onSilenceWarn` → runner-lightweight 透传；warn 探活（/proc 进程树）为 #54 留的迭代方向，本期不做
- `AgentLoopRegistry.mount()` 幂等且不抛错，失败仅标记为 failed 状态
- 路由层统一使用 `getErrorMessage` 捕获异常，并返回标准错误码（如 `INTERNAL_ERROR`、`NOT_FOUND`）
- 所有 Agent 数据均通过 `FileStore` 存储（已从 Prisma 迁移）
- 审计日志写入 `~/.studio/logs/studio-events.jsonl` 文件
- `agent-profile.service.ts` 在创建 profile 时会发布 `agent-profile.created` 事件，由 `AgentLoopRegistry` 监听并自动挂载 loop
- **mention 派单调度链**：`WorkUnitService.create` 发 `workunit.created` 事件 → TriggerScheduler 唤醒对应 AgentLoop.observe（另有 15s 轮询兜底）→ 过滤（assigneeId 精确匹配 / 频道成员 / F4 `metadata.excludeAssignee` 排除实现者 / #109 `metadata.blockedBy` 有未 done 依赖则不可见）→ claim（assigneeId 改写为 instance.id）→ agentStep → LocalExecutor → runner-lightweight spawn CLI → recordResult 解析 ACTION → postToDiscussionSpace 经 workunit `wu-messenger.postWuSystemMessage`（agentName=本 loop role.name，绑定 loop 自身 fileStore，测试可注入临时 store；内部走 `ChannelMessageService.createAgentMessage`）回帖（**2026-07-29 起走 EventBus/SSE**，此前直写 fileStore 不发事件，频道页只能轮询/刷新才能看到 agent 回复）
- **F4 review 派发（2026-07-28 分析文档决策 5）**：ReviewDispatcher 不再按 description 含 'reviewer' 找具名角色（字符串锚点已废除，`builtin-roles.ts` 已删除）——父 WU 进 in_review → 建 `assigneeId=null` 的未指派 review 子 WU 走 claim 涌现；实现者（assigneeId 两种形态：profile id / instance id→state.roleId）写入 `metadata.excludeAssignee` 禁止自领；频道内除实现者外无 active 成员（或 members 未回填）→ 自评兜底：不排除 + `metadata.selfReview=true` + 频道系统消息提醒人工复核。**#170（决策 #65-2）**：同父唯一性检查 + 建单收进同一把 workunits flock（`createGuarded` 锁内 check-then-create，照抄 claimWorkUnit 锁内复查模式）——并发/多实例事件链下不重复建单；锁内 guard 拒绝时路径 A 静默跳过、`dispatchReviewNow` 抛 already in flight。**#228 测试可观测性**：实例方法 `waitForSettled()`（纯增量，等在途事件链落定；#228 复审起实现归并 studio-shared `createSettledTracker`）——订阅 handler 在 trackInFlight 登记后异步推进，publish 经 eventBus emit 同步触发，await transitionStatus 返回时在途链必已登记；测试盲等（定长 sleep）全量负载下吃不满自评兜底消息落盘，F4 决策 5 曾近确定性红
- **R3 评审输入契约（2026-07-28 分析文档 §4-R3）**：评审子 WU scope = diff-only + `+code-review` 点名——只审 `git diff <baseBranch>...HEAD`（实现叙述仅作背景定位）；上下文失效 `verdict=needs-info` → parseReviewReport 返回 null → 转人工（不猜不硬判）；`metadata.reviewInput` 落档审计。评审回传经 reviewPassed/reviewRejected 的 attestation 入参落父 WU 台账 l2（selfReview/ref 透传，F6 决策 1）
- **PMO 分析接力（2026-07-29）**：ReviewDispatcher 路径 A 跳过 `type='analysis'`（分析结论的评审 = 人工确认 F6 l3，diff-only 契约对非代码产物恒 needs-info 纯噪声；接力提示与派工见 pmo/analysis-handoff.ts）。analysis WU COMPLETE 时 agent-loop 用 `parseTaskBreakdown` 解析输出中的 `TASK: <任务描述>` 行（去重/封顶 ANALYSIS_TASKS_MAX=8/条 ≤300 字符）落 `metadata.analysisTasks`；契约写在 pmo/project.service.publish 的 analysis scope 里，人工「通过」后由 analysis-handoff 建未指派 task 子 WU 派工。**#106 M7 对齐（2026-08-12）**：同一 COMPLETE 还用 pmo/map-opening 的 `parseMapOpening`（契约单一来源）解析 `FOG:`/`DESTINATION:` 行落 `metadata.analysisFog`/`analysisDestination`——web 确认弹窗据此预填待决问题清单，人审改后随 l3.summary 回传开图；无 FOG 行 = 非探路型不落档
- **#108（2026-08-11）decision/spec 不派评审**：ReviewDispatcher 跳过集扩 `DECISION_SPEC_TYPES`（路径 A 与 `dispatchReviewNow` 人工补派同拒）——决策单/成文单验收走人工 in_review（同 analysis 先例），review 子 WU 不从 decision/spec 派生；配套裁剪状态机与超时豁免见本文 `apps/api/src/modules/workunit` 锚点
- **F6 台账 l1（决策 1）**：COMPLETE 前自动验证守卫同时写 `metadata.attestations.l1`（approved/rejected 都落，by=profile id；守卫实现见 `loop/completion-gates.ts`）
- **F6-c 证据断链修复（2026-07-30）**：①验证逻辑抽出 `loop/wu-verification.ts`（见核心导出）；②**步骤超限强制收口补跑 L1**——COMPLETE 守卫只在 action=complete 时跑，超限路径（任意 action）此前完全跳过验证，强制 in_review 的代码类 WU 永远缺 l1；现在收口前对代码类 + 有 worktree 的 WU 补跑一次（本 step 守卫已跑则不重复），台账写法同守卫但不计 verifyFailCount、不改 blocked 语义；③`POST /workunits/:id/verify` 人工重跑 L1（human-only，只动台账不动状态，见本文 `apps/api/src/modules/workunit` 锚点）；④`POST /workunits/:id/dispatch-review` 人工补派评审（`ReviewDispatcher.dispatchReviewNow`，复用路径 A 建单逻辑；守卫：type≠review/analysis、status∈in_review/done、deriveDisplayState 判定 l2 未达成、有频道、无在途评审子 WU）+ handleReviewChildDone 放宽——父已被人工直推 done 且 l2 缺失时，迟到 approved 经 reviewPassed F6-c 幂等口补写 l2（不动状态；迟到 rejected 不打回人工收口的 WU，频道转人工复核）。幂等补写证据后发 status_changed（状态值不变也发）让 pmo rollup 重估。**纪律：验证失败只落 l1 rejected，绝不写 verifyReport**（metrics 按 verifyReport 存在计通过，失败写入会虚增通过率）
- **isOnline 语义（2026-07-27 起）** = loop 存活：state status 为 idle/active 且心跳新鲜（≤5min，与 agent-timeout-scan 同阈值；null 心跳按 startedAt 宽限）。另知一坑（未修）：手动 `POST /agent-instances` 只建 idle 记录、并不起 loop，null 心跳约 2 分钟内被 timeout-scan 终止（假在线）
- **多实例单活（2026-07-30 走查修复）**：同一 `~/.studio` 被多 api 实例共享时（本机 dev:13001 / prod:13101 并存），`STUDIO_AGENT_LOOP_ENABLED=false` 的实例 standby——index.ts 不注册系统触发器（含定时 WU 创建）不挂载 loop，但保留 ReviewDispatcher/AnalysisHandoff/事件桥订阅（状态变更由谁发起就在谁进程内触发，两侧都有幂等哨兵）。此外 `AgentLoop.start()` 内置同角色单活守卫：另一进程持有的活实例（异 pid 存活 + 心跳/启动时间 <120s 新鲜）存在时 standby 返回 false 并记 error 状态（message 含「活实例」），持有者退出后重启即接管；AC-4.6 stale 清理只管死 pid，管不了双活进程
- **instance 忙闲 SSE（2026-07-31 PMO-flow UX §6-2）**：agent-loop 在 claim 后置 active 与 `updateIdleState` 两处经 eventStore 发 `agent.instance.status_changed`（信封同 agent.health.failed；data = `{profileId,instanceId,name,status,currentWorkUnitId}`）。sse.routes 无 `agent.*` 显式映射 → 落 `all` topic，前端订阅 all 即收（无需改路由）。`lastPublishedStatus` 内存去重：仅状态实际变化时发一次——updateIdleState 的 45s 节流心跳重入 idle 不刷屏
- **里程碑消息 meta（2026-07-31 PMO-flow UX §6-3）**：recordResult 四类里程碑（COMPLETE 汇报/NEED_INPUT/验证失败 ≥3 次打回 blocked/连续 3 步无进展 blocked 转人工）经 `postToDiscussionSpace` 第三参传持久化 wu 本体（2026-08 归因统一后解析链只读创建期落档数据（metadata.pmoId/reqId），原「持久化 + 本 step metadataUpdates」合并视图已随 pmoProjectId 缓存一并移除），由 wu-messenger 按 `milestone: true` 附带 meta `{pmoId?, atHuman:true}`（pmoId 由 requirements 模块 `resolvePmoProjectIdForWU` 解析，解析不到不携带）；普通 progress 不带。ReviewDispatcher.postSystemMessage（评审结果转人工）同样委托 wu-messenger 里程碑通道；`MessageMeta` 增 `pmoId` 字段（channel-message.service）
- **ReviewDispatcher 子 WU 不继承会话簿记（2026-07-30 走查修复）**：review 子 WU metadata 原样 spread 父 WU 会带上 `sessionId` 等字段 → 子 WU 误续用父 WU 的 CLI 会话（违反「同一 WU 内才续用」，异 cwd 必失败；root 下 `--resume` 还会触发 CLI 自注入 `--dangerously-skip-permissions` 被 root guard 秒拒 exit 1）。createReviewWorkUnit 经 workunit/wu-metadata 的 `clearSessionBookkeeping` 清除（**14 字段权威清单 2026-08-15 起**（#94 增 lastSessionResumed、#95 增 progressLog、#96 增 sessionSummary、#171 删只写零消费方的 input_tokens 死字段——#67 决议）：sessionId/startedAt/sessionResumes/sessionCount/lastSessionResumed/blockReason/stepCount/consecutiveStuck/errorType/errorDetail/errorAt/_cumulativeTokens/progressLog/sessionSummary；agent-loop 新增簿记字段必须同步该清单）；pmoId/pmoNumber 等域血缘保留
- **鉴权（2026-07-24 收紧）**：legacy agents POST `/`、PUT `/:agentId` 与 agent-profiles/agent-instances 写 = `requireAuth()+requireNotGuest()`；instances `POST /:id/terminate` = `requireAuth()+requireAdmin()`；legacy DELETE 原有 requireRole('Admin') 不变。agent-configs 模块已随工单 20 整体删除（前端零调用，其 `:id` 路径拼接穿越面连带消亡）。`POST /review/diff` 端点已随旧 review 栈删除（2026-08-06）——其 shell 拼接面、.claude/settings.json 写任意仓库、.review-prompt.md 残留三个隐患连带消亡
- **频道发声策略（2026-08-09 #55 决议，2026-08-15 #175 落地）**：频道发声集 = 里程碑 + 异常 + 每步简报；已补两个缺口——①每次认领发一条 WU 线程普通消息（「『角色名』已认领任务，开始执行」，含超时释放后的重新认领，与 timeout-release 释放消息配对；`agent-loop.ts` `claimAndAnnounce`，runLoop 认领路径唯一入口）；②每次步失败发一条普通消息（「『角色名』执行失败（第 N 次）：原因截断 200 字符」，不带 atHuman；重试不单独发声；连续第 3 次走现有 blocked 里程碑收尾，不额外发声；recordResult `case 'failed'`）。认领/失败消息按**系统通知**对待，不过 §4.2 发言层新鲜度检查（闸只拦 agent 结果回帖；failed 结果不携带 channelVersion，不参与新鲜度判定）
- **认领门槛定型（2026-08-09，#56 决议）**：认领层维持纯显式，永不引入类型/角色匹配机制——acceptedTypes 的语义定位就此锁定为 **skill 排序的可选提示**（决策 9 出生定位），不得作为路由/认领的输入（决策 10 原则被 PMO-12 事件检验后保留：推断只配出现在低代价处）。认领仅有的三个门槛：`assigneeId` 排他指派（人工 @mention）+ review 的 `metadata.excludeAssignee` + #109 的 `metadata.blockedBy` 未了结依赖门禁（了结口径 = done/closed，判定收敛在 workunit/wu-dependencies.ts，全局 index 跨 PMO 生效）。「WU 无人认领滞留池中」的探测已由 #181 落地（monitor-probes.checkPoolStagnation，2h/12h 阈值）。创建侧人工可选显式指派（publish/分析确认节点）留作后续可选增强 #69
- **#90 失败步 outcome 埋点（2026-08-13）**：失败步最终收敛处——action=failed（`failResult`）/ 溢出·续用降级重试再败转 need_input / spawn 异常 catch——经 `agent-loop.ts` `recordOutcomeEvent`（单一正本）落 `knowledge:outcome:failure` 事件（success=false + `errorType='execution_failed'` + details=错误原文）；成功步经同一正本落 `knowledge:outcome:success`（errorType 缺省，JSON 丢弃）。`ExecutionOutcome` 增 `errorType?`（knowledge-service.ts 与 knowledge-types.ts 两处同构）。`extractFromExecution` 仅成功步触发（失败无 diff）。会话预算耗尽的前置 need_input（未执行即返回）不算失败步不埋点。AC2（提取跳过原因四重门）已划掉归 #99
- **#90 Auditor 零执行噪声抑制（2026-08-13）**：`dailyAudit()` 过去 24h `total===0`（零执行）早退——不 push #系统摘要、不 `recordPattern`（trend）、不 `escalateToTriage`、不生成 eval case/resolution（`generateEvalCases`/`autoCreateResolutions`）；有执行时行为不变。早退点 = `recentExecs.length===0` 判定后、任何分析/建议执行前
- **#99 WU 收尾批量提取钩子（2026-08-14）**：role-memory/completion-extraction.ts 订阅 `workunit.status_changed` → done，读归档 transcript（#97 readTranscript）→ 一次 LLM（`getSystemExecutor` + `MEMORY_EXTRACTION_SYSTEM_PROMPT`）→ `roleMemoryStore.appendDraft`（角色记忆草稿区）。与旧 R3 会话提取（COMPLETE 步 → `extractFromConversation`，proposal 入库 KnowledgeStore）并行独立，去重哨兵各用各的：R3=`knowledgeExtractedAt`、#99=`memoryExtractedAt`（WorkUnitMetadata 两字段并存）。跳过原因四重门（去重哨兵/no-role-id/预算熔断/空 transcript）与成功/失败均落 `knowledge:extraction` 事件（`trigger:'wu-completion'`），fire-and-forget 不阻塞收尾；旧 R3 路径及其触发器删除归 #102


## apps/api/src/modules/audit-logs

### 职责

提供审计日志的查询与统计 API 端点，支持按用户、角色、公司、操作类型、资源、状态、时间范围等条件过滤，并支持分页查询和统计汇总。

### 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `router` (默认导出) | routes.ts | Express 路由对象，包含 `GET /api/audit-logs`（查询日志）和 `GET /api/audit-logs/stats`（获取统计）两个端点。 |

### 依赖关系

- **上游依赖**：`../../utils/logger.js`（日志）、`../../utils/pagination.js`（分页格式化）、`../../utils/services.js`（惰性服务工厂）、`@dommaker/studio-audit`（审计服务与枚举）、`@dommaker/studio-shared`（FileStore）、`express`。
- **下游依赖**：`apps/api/src/route-registry.ts` 注册此模块的路由。

### 注意事项

- 查询参数 `anonymousId` 为 SEC-009 新增字段，需确保前端传递正确。
- 所有错误场景统一返回 `{ error: { code, message } }` 格式，内部日志使用 `logger.error`。
- 审计服务通过 `createLazyService` 延迟初始化，避免启动时加载依赖。
- 分页默认值为 page=1, limit=50，调用方不应依赖默认值以外的行为。
- **鉴权（2026-07-24 收紧）**：`/api/v1/audit-logs` 挂载级 `requireAuth()+requireAdmin()` —— 日志含 IP/UA/email（PII），且 `POST /`（伪造审计）、`POST /cleanup`（销毁证据）此前无角色限制。另：`GET /export` 注册在 `GET /:id` 之后被遮蔽不可达（历史 bug，未修）。


## apps/api/src/modules/audit

### 职责

将 EventBus 中的审计事件（`events:audit`）持久化到 KnowledgeStore，提供启动和停止订阅控制，确保每条事件以 `guideline` 类型存储，并记录错误日志。

### 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `startAuditSubscriber` | `audit-subscriber.ts` | 启动审计事件订阅，将事件持久化到 KnowledgeStore，只生效一次 |
| `stopAuditSubscriber` | `audit-subscriber.ts` | 停止审计事件订阅（通过标志位控制） |

### 依赖关系

**上游依赖**
- `apps/api/src/core/event-store.js`：提供 `eventStore.subscribe` 方法
- `@dommaker/studio-shared`：提供日志工具 `logger`
- `apps/api/src/modules/knowledge/knowledge-bus.service.ts`：动态导入获取 `sharedStore` 以保存审计事件

**下游依赖**
- `apps/api/src/index.ts`：启动时调用本模块的 `startAuditSubscriber`

### 注意事项

- `started` 标志确保订阅只注册一次，重复调用不生效
- 审计事件解析失败时仅记录错误，不抛出，防止影响其他流程
- 知识总线服务使用动态 `import()` 延迟加载，避免循环依赖或初始化顺序问题
- 存储的 `id` 使用时间戳 + 随机字符串保证唯一性


## apps/api/src/modules/auth

### 职责

负责 API 用户认证与会话管理，包括注册、登录、Guest Session 创建、认证状态查询及 JWT 令牌管理。同时集成 OAuth 认证流程（参见 oauth.routes.ts 与 oauth.service.ts）和邮件验证（email.service.ts），并支持可配置的认证模式（none / on）。

### 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `register` | service.ts | 用户注册，返回用户、会话及 JWT 令牌 |
| `getOrCreateSession` | service.ts | 根据 guestId 创建或复用 Guest Session |
| `getCurrentUser` | service.ts | 通过 sessionId 获取当前用户信息 |
| `UserData` / `SessionData` | service.ts | 用户与会话的数据结构类型 |
| `AuthResult` / `LoginInput` / `RegisterInput` | service.ts | 公共接口类型 |
| `JWT_SECRET` / `JWT_EXPIRES_IN_SECONDS` | service.ts | JWT 配置常量 |
| `router` (默认导出) | routes.ts | Express 路由实例，注册 /api/v1/auth/* 端点 |

### 依赖关系

**上游**
- `../../middleware/auth.js`（requireAuth、getAuthInfo、optionalAuth、requireRole）
- `../../middleware/rate-limit.js`（authRateLimit、refreshRateLimit）
- `@dommaker/studio-audit`（AuditService 用于审计日志）
- `@dommaker/studio-shared`（FileStore、logger）
- `jsonwebtoken`、`bcryptjs`、`node:crypto`、`node:path`、`node:os`

**下游**
- `apps/api/src/middleware/auth.ts`（可能使用本目录的认证中间件或类型）
- `apps/api/src/modules/agents/ops/ops.service.ts`（通过导入使用认证服务）
- `apps/api/src/route-registry.ts`（注册本目录路由）

### 注意事项

- 使用 `FileStore` 替代 Prisma 存储用户和会话数据（`users.json` / `sessions.jsonl`）
- `JWT_SECRET` 在生产环境必须通过环境变量设置，否则启动报错
- 密码使用 `bcryptjs` 哈希存储
- 注册操作需记录审计日志（SEC-010）
- 支持两种认证模式：`none`（直接返回本地管理员用户）和 `on`（完整认证流程）
- Guest Session 有效期 24 小时，JWT 令牌有效期 7 天
- 路由中应用了速率限制中间件（authRateLimit）
- **Guest session `userId=null`**（service.ts createGuestSession 不建用户记录）→ `findSessionWithUser` 查不到用户 → guest token 实际过不了 `requireAuth()`/Lurk Wall 大门，等同匿名（2026-07-24 生产实测确认）。Lurk Wall 的"guest 可围观"实际由 PUBLIC_API 白名单前缀承载（/channels、/requirements-docs 等，无需任何 token）
- 注册用户 role 恒为 `"User"`（service.ts:307）；`/auth/register` 不在 PUBLIC_API，生产上仅已过大门者（即 Admin）可创建用户
- 中间件分层（middleware/auth.ts，2026-07-24 收紧）：`requireAuth+requireNotGuest` = 内容写（User+Admin）；`requireAuth+requireAdmin` = 敏感/控制；`requireLocalhost` = 内部本机端点（/api/knowledge、/mcp/messages|sse）。三者 + requireRole 在 `STUDIO_AUTH=none` 下均放行，本地免登录不受影响。全量路由审查表见 `docs/plans/2026-07-api-auth-tightening.md`


## apps/api/src/modules/builtin-tools

### 职责

提供一组内置工具（文件操作、搜索、执行、通信）的元数据定义与 RESTful 路由，供上层服务注册和调用。工具列表静态注册在 `routes.ts` 中，每个工具包含名称、描述、分类、输入 schema 与启用状态。

### 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `router`（推测为默认导出） | `routes.ts` | Express 路由器，提供 `GET /builtin-tools` 接口返回内置工具列表。

### 依赖关系

上游：
- `../../utils/logger.js`：日志工具。

下游：
- `apps/api/src/route-registry.ts`：将 `builtin-tools` 路由挂载到应用主路由。

### 注意事项

- 工具分类（category）限定为 `file`、`search`、`execution`、`communication` 四种，新增分类需同步更新类型定义。
- `inputSchema` 遵循 JSON Schema 格式，`required` 字段必须与 properties 一致。
- `enabled` 字段目前硬编码为 `true`，未来可改为从配置中心动态加载。
- 文件操作类工具（`path` 参数）应进行路径安全检查，防止目录遍历，当前代码未实现该检查，需后续补充。
- **鉴权（2026-07-24 收紧）**：/api/v1/builtin-tools 挂载层已收 requireAuth+requireAdmin（PATCH 可启停工具；启停状态仅内存态不持久化）。


## apps/api/src/modules/capabilities

### 职责

提供能力注册表的读取与 API 暴露，包括从文件系统加载工具/技能定义，并通过 Express 路由对外提供服务。同时定义能力类型（Capability）和注册表（Registry）接口，支持缓存与阶段（Stage）识别。

### 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `router` (默认导出) | routes.ts | Express 路由对象，挂载能力注册表相关 API |
| `Capability` (interface) | routes.ts | 能力项类型，包含名称、类型、分类、描述、路径 |
| `Registry` (interface) | routes.ts | 注册表容器，包含工具列表 |
| `Stage` (type) | routes.ts | 责任链阶段类型（plan/develop/verify/deploy/fix/govern） |
| `loadRegistry()` | routes.ts | 加载并缓存能力注册表的函数 |

### 依赖关系

**上游依赖**：
- express（路由框架）
- @dommaker/harness（获取注册表路径与工具目录）
- @dommaker/studio-capability（CapabilityService）
- @dommaker/studio-shared（FileStore、logger）
- ../../middleware/auth.js（requireNotGuest、requireRole 中间件）
- ../../utils/services.js（createLazyService）

**下游引用**：
- apps/api/src/app.ts（挂载路由）
- ~~apps/api/src/modules/llm/intent-analyzer.ts~~（2026-07-28 随 llm 模块下线删除）
- apps/api/src/route-registry.ts（注册路由路径）

### 注意事项

- 注册表通过 `loadRegistry()` 同步读取文件系统，缓存 TTL 为 1 分钟，需注意文件变更未及时更新的情况。
- 使用 `createLazyService` 延迟初始化 `CapabilityService`，避免启动时加载无关资源。
- 所有能力 API 均需经过 `requireNotGuest` 和 `requireRole` 中间件鉴权（符合 SEC-001 / SEC-002）。
- `getStageFromYaml` 目前仅定义但未在已有代码片段中调用，需确认实际使用场景。
- 缓存变量 `cachedRegistry` 和 `lastLoadTime` 为模块级，多请求共享，需注意并发访问安全性（当前为同步读取，无锁）.
- **鉴权（2026-07-24 收紧）**：5 条写端点（POST /registry/refresh、/sync、/、/batch、PUT /:capabilityId）已收 requireAuth+requireNotGuest（requireNotGuest 从"仅 import 未使用"变为实际使用）；DELETE 原有 requireRole('Admin') 不变。GET /stages、/registry 响应含工具定义相对路径，属低危信息泄露（未修）。


## apps/api/src/modules/channels

### 职责

Channel 驱动管线入口：@Analyst 触发 → RequirementsDoc 生成 → Goal 创建 → 执行管线。
包含 Analyst 全流程（scout+synth / direct 两条路径）、ContractTest 验证、SDD 文件写入。

### 核心导出

| 模块 | 导出 | 职责 |
|------|------|------|
| analyst-trigger.service.ts | `AnalystTriggerService.trigger()` | 管线入口：DB 去重 → LLM 分析 → 验证 → SDD → 卡片 → 自动执行 |
| analyst-executor.ts | `runClaudeCode()`, `sanitizeJson()`, `validateAnalystOutput()` | Claude Code 执行 + 4 层 JSON 解析链 + 输出验证 |
| analyst-knowledge.ts | `perInvocationOutputFile()`, `loadKnowledge()`, `saveKnowledge()` | Analyst 输出路径 + knowledge.md 读写 |
| analyst-prompt.ts | `buildAnalystPrompt()`, `buildRevisionPrompt()` | Analyst prompt 构建（含 scout/synth/revision） |
| channel-message.service.ts | `channelMessageService` | 消息创建/更新/删除 + event 发布 |
| contract-test-validator.ts | `validateContractTests()` | Layer 1-3 契约测试质量检查（AC coverage / TS syntax / import path） |
| contract-test-red-check.ts | `verifyRedState()` | Layer 4 RED 状态验证 |
| channel.routes.ts | Express router | Channel API 端点（消息/start_execution/cancel 等） |

### 依赖关系

**本模块依赖**：
- `@dommaker/studio-shared` — FileStore（Channel / RequirementsDoc 等文件存储，已替代 studio-prisma DB）, logger, modelGateway, eventBus, toKebab
- `agents/monitor-agent` — 管线监控

**被依赖**：
- `cli/studio-cli.ts` — CLI 入口调用 trigger()

### 注意事项

- **输出文件路径**：`perInvocationOutputFile()` 返回绝对路径（ANALYST_DIR 基于 REPO_DIR）。scout 路径用相对路径，session-manager 有 worktree fallback
- **JSON 解析链**：4 层（sanitize → code-fence → regex → LLM repair），outputText = "DONE" 无 JSON，文件是唯一数据载体
- **DB 去重**：同 channel 24h 内有有效 RequirementsDoc → 直接复用（0 token）
- **outputFile 唯一性**：Claude 通过 Write tool 写文件，stdout 只有 "DONE"。文件丢失 = 数据丢失
- **鉴权分层（2026-07-24 收紧，姿态 A）**：`/api/v1/channels` 在 PUBLIC_API —— GET（`/`、`/:id`、`/:id/messages`）保持**匿名公开**（Lurk Wall 围观本体，不要再给 GET 加中间件）；9 条写端点（建频道/发消息/删频道/archive/restore/PATCH/members/convert-to-task×2）= `requireAuth()+requireNotGuest()`。注意 `POST /:id/messages` 经 @mention 派单/恢复挂起 WU 可直接触发 agent 执行与 LLM 消耗，是收紧前最危险的匿名入口。requirements-docs PUT 同为 requireNotGuest
- **消息路由优先级**（`message-routing.ts` routeMessage）：`replyToId` 线程回复（继承父消息 workUnitId）→ `@mention` 派单（建 WorkUnit，`metadata.creationMode='mention'`；§9.5 只匹配本频道 members，members 为空回退全量 active profile）→ 纯文本仅存储。mention = 纯文本 `@name`（无结构化 id），检测与 scope 剥离用 Unicode 正则 `[\p{L}\p{N}_-]+/u`；手打中文连写无空格（`@开发你好`）匹配不到——前端补全插入带尾随空格，主路径不受影响。归属解析出 PMO 项目时创建期落 `metadata.pmoId`（2026-08 归因统一 canonical key；原 `ownershipProjectId` 废弃不再写入，读取侧同级兼容）
- **成员绑定**：`channel.members`（config.json 内 JSON 字符串数组）是成员关系唯一事实源，`AgentProfile.channels` 已废弃（启动时幂等迁移）；PATCH `/:id/members` 合并 add/remove 后整体回写；删除 profile 时由 AgentProfileService 反向清理各频道 members 悬空引用
- **系统消息唯一发布路径（2026-08-06）**：`channelMessageService.createAgentMessage` 是唯一会发 `channel.message_sent`（eventBus + SSE）的入口；WU 线程系统消息（anchor + pmoId + atHuman）一律经 `workunit/wu-messenger.postWuSystemMessage` 委托到此——禁止再裸 `fileStore.appendMessage` 发系统消息（不发事件 = 通知铃不响、频道页不实时）。`message-routing` 的 @studio 改派/归属提问两处已迁移；`MessageRecord` 类型自本模块导出供 messenger 返回类型使用
- **删除频道兜底（B2-012）不再直触 WU 存储（2026-08-06，Card 9）**：DELETE `/:id` 的 WU 重挂委托 `WorkUnitService.rebindSourceChannel`（解析 metadata 按 `context.sourceChannelId` 字段相等匹配 + appendEvent 留痕）——原为路由内 `metadata.includes(channelId)` 子串匹配（可被其它字段误伤）+ 裸 `upsertSnapshot`（无事件、手置 updatedAt）。路由只保留：兜底 rnd 频道查找/创建、SDD frontmatter 迁移（non-blocking）、频道删除、响应形状 `{ deleted, fallbackChannelId }`


## apps/api/src/modules/companies

### 职责

公司（Company）记录的 CRUD REST API，FileStore 文件存储（`~/.studio/data/companies/*.json`），不依赖数据库。前端 PMO 页、Settings 页依赖本模块获取/创建默认公司，PMO 的 OKR/项目均以 companyId 作为归属维度。创建公司时会自动调用 `okrService.createDefaultOKR` 生成默认 OKR。

### 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `default router` | `routes.ts` | Express 路由器：`GET /` 列表、`POST /` 创建、`GET /:companyId` 详情、`PATCH /:companyId` 更新、`GET /sizes/config` 规模配置、`GET /:companyId/hall-stats` 大厅统计 |

### 依赖关系

**上游**:
- `@dommaker/studio-shared`（FileStore）
- `../../utils/logger`（日志）
- `../pmo/okr.service`（创建公司时自动生成默认 OKR，动态导入）

**下游**:
- `apps/api/src/route-registry.ts`：挂载于 `/api/v1/companies`（middleware: auth）。

### 注意事项

- 本模块在 008912d（db-removal）中被误删，导致前端 `/api/v1/companies` 404，后按 FileStore 版本恢复；与 Prisma 无任何关联。
- `GET /sizes/config` 必须在 `GET /:companyId` 之后不会冲突：`/:companyId` 只匹配单段路径。
- `hall-stats` 聚合 `~/.studio/logs/executions.jsonl` 的执行统计（测试环境隔离到 os.tmpdir()/studio-test-logs，见 utils/studio-log-path.ts），文件不存在时按 0 处理。


## apps/api/src/modules/dingtalk

### 职责

处理钉钉机器人交互回调，包括 ActionCard 按钮点击的健康检查和操作忽略提示。当前 Meeting 模块已移除，按钮点击仅返回占位响应。

### 核心导出

| 导出 | 文件 | 说明 |
| default | routes.ts | Express Router 实例，挂载 /api/v1/dingtalk 路径下的 /action 和 /health 路由 |

### 依赖关系

上游：
- `apps/api/src/utils/logger.js`（日志记录）

下游：
- **apps/api/src/route-registry.ts**：注册本路由模块到 Express 应用

### 注意事项

- 路由挂载于 /api/v1/dingtalk 前缀，由 route-registry 统一注册
- ActionCard 按钮点击（/action）仅返回静态 HTML，不再执行实际会议操作
- 健康检查（/health）返回 JSON 格式 { status: 'ok', service: 'dingtalk-callback' }


## apps/api/src/modules/discord

### 职责

处理 Discord 集成，包括命令行 (`studio run`) 和 Discord 斜杠命令 (`/studio run`) 共享的命令运行逻辑，以及 Discord 交互端点（按钮点击回调）的路由处理。

### 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `triggerRequirement` | `command-runner.ts` | 提交需求到 #研发 频道并创建 WorkUnit，返回确认消息 |
| `router` | `routes.ts` | Express Router，处理 `/interactions` POST 端点，含 Ed25519 签名验证 |

### 依赖关系

**上游（本目录依赖）：**
- `@dommaker/studio-shared`：提供 `FileStore`、`WorkUnitSnapshot`、`logger`
- `../channels/channel-message.service.ts`：`channelMessageService`
- `../workunit/workunit.service.ts`：`WorkUnitService`
- `../../utils/logger.ts`：logger
- `../../core/event-store.ts`：`eventStore`
- `express`、`crypto` 等标准库

**下游（引用本目录）：**
- `apps/api/src/route-registry.ts`：注册本模块提供的路由

### 注意事项

- 签名验证必须优先于任何业务逻辑，Discord 会通过无效签名请求检测服务器是否验证
- 必须配置环境变量 `DISCORD_PUBLIC_KEY`，否则交互端点返回 500
- `triggerRequirement` 依赖 `#研发` 频道存在，否则抛出错误
- WorkUnit 创建时 `creationMode` 标记为 `'discord'`，用于区分来源


## apps/api/src/modules/distill

### 职责

蒸馏主链路最小闭环（#143，spec #141 / 决策 #83 D1-D5）：把知识库里堆积的「矿石」（session-summary 自动沉淀条目）事件门槛驱动地提炼成蒸馏知识条目。链路 = WU 收尾钩子（`workunit.status_changed → done`）顺带跑门槛检测（纯确定性计数，零 LLM 成本）→ 命中发 `distill_proposal` 人审卡到 #系统 频道 → approve 后由 system-executor 执行一次蒸馏调用 → 产物入库（`sourceReferences` 指向全部原料 id）+ 原料 `maturity=archived` 移出主区 → 运行记录落数据区、全链路事件写 `studio-events.jsonl`。

GC 候选清单与人审归档（#144，D4）：每次蒸馏运行后按**蒸馏周期**计龄生成淘汰候选——reference/context 层条目连续 3 个周期 `lastReferenced` 未更新 → 进清单（每条附可读理由：哪几个周期零引用）发 `gc_proposal` 人审卡；approve 后候选 `maturity=archived`（可恢复：归档不搬文件）；reject = 人判保留，后续运行不再提案该条目。manual 过审（verified/proven）条目享 3 周期新生豁免；signal 层跳过（归蒸馏生命周期）、rule 层跳过（归 #139）；主区 >200 条无条件强制出清单（放宽周期门，有多少周期用多少）。判据不读墙钟：系统闲置 → 无蒸馏运行 → 无新周期 → GC 自然休眠。

产物三分落地分流（#145，D2 三分）：蒸馏 LLM 产出自带类型分类——skill（过程性知识）→ skills 库提案（skillStore draft + proposalStore pending + skill_review_request 卡，审批走既有 `/api/v1/skills/proposals/:id/*`）；constraint（边界性知识）→ `constraint-drafts.jsonl` 变更草案（add/override/retire 的具体 ymlSnippet，不直接改约束文件——#82 D6 派单通道未就绪的简化落盘形态，草案 status=pending 待派单接线）；preference/execution-knowledge → 角色记忆草稿（studio 系统角色，review=manual + memory_proposal 人审卡，复用 #99/#101 接线）。缺/未知类型、约束缺合法 change、通道未接线或落地失败 → 回落知识库条目（#143 行为，产物不丢）。三类通道产物都带原料指针（skill→metadata.sourceReferences、constraint→草案记录、memory→draft sourceRefs）。

存量约束审计（#146，#139 D1 触发形态落地）：蒸馏运行产出新约束（landings.constraint 非空）→ 顺带审计存量 custom 约束——LLM 按统一判据「是否还有可被违反的未来场景」出退役建议（证据 = custom-constraints.yml active 条目 + package.json 依赖清单），判据白名单闸门（target-gone / reintroduction-sealed，此外一律丢弃——防再引入型「技术存量清零 ≠ 风险消失」与「长期零违规」不可能进清单）→ 非零发 `constraint_audit_proposal` 人审卡（逐条附判据理由）；approve 走 retire 执行（复用 E1 applier `retireConstraintEntry`：custom-constraints.yml 条目内 retired 元数据段，#82 D6 统一落点，规则原文保留，可恢复——`POST /api/v1/harness/constraints/:id/rollback` 删段即恢复）；reject 零副作用且人判保留约束不再进审计输入。审计不另设 cron、零建议不发卡、pending 去重、预算耗尽跳过，永不阻塞蒸馏主链路。审计范围只覆盖 custom 约束（内置约束生命周期归 harness 发版治理）；checker 联动与 retire 落盘对齐等实现细节归 #139。

### 数据布局

```
<studioDir()>/distill/
  proposals.jsonl          # append-only：{kind:'proposal',...} 行 + {kind:'status',id,status,at} 墓碑行
  runs.jsonl               # 蒸馏运行记录：executedAt/outcome(executed|failed)/signals/materialIds/productIds/landings(#145)
  gc-proposals.jsonl       # GC 候选清单提案（#144）：候选附理由 + runId 回指触发运行 + 状态墓碑
  constraint-drafts.jsonl  # 约束变更草案（#145）：action/constraintId/ymlSnippet/rationale/sourceReferences，status=pending 待 D6 派单
  constraint-audits.jsonl  # 存量约束审计提案（#146）：suggestions(constraintId/category/rationale) + runId 回指 + 状态墓碑
```

- `runs.jsonl` 的 executedAt 序列有三个读法：熔断时钟 `lastRunAt`（任何 outcome——失败/空产出也烧了 token，同样熔断）、消费基线 `lastConsumedAt`（executed 且产物 ≥1——「新条目」判定基线，失败不推进，原料不被老化作废）、GC 蒸馏周期序列（outcome=executed 的运行——#144 计龄输入，失败运行不构成周期）。
- 知识库读写走 harness `FileKnowledgeStore`（`update(id,{maturity:'archived'})` 即归档，不搬文件）。

### 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `evaluateDistillThreshold` | `distill-threshold.ts` | 门槛检测纯函数：同 tag 新条目 ≥3 或 manual 过审（verified/proven）新条目 ≥5，且距上次运行 ≥7 天；「新」= created 严格晚于 lastConsumedAt（失败/空产出不推进）；archived/deprecated 不计 |
| `TOPIC_MIN_NEW` / `MANUAL_MIN_NEW` / `COOLDOWN_DAYS` / `MAX_MATERIALS` | `distill-threshold.ts` | 阈值常量（3 / 5 / 7 / 20） |
| `DistillService` | `distill-service.ts` | 编排：subscribeToEvents（done 钩子）/ maybePropose（门槛+发卡）/ approve（预算守卫+执行）/ reject（零副作用）/ getProposalStatuses |
| `DISTILL_SYSTEM_PROMPT` / `buildDistillPrompt` / `normalizeDistillProducts` | `distill-service.ts` | 蒸馏 prompt（#145 起要求产物带 type 分类）与产出解析（缺 title/content 丢弃，≤5 条；缺/未知 type、constraint 缺合法 change → 回落 knowledge） |
| `DistillProductType` / `NormalizedDistillProduct` / `DistillLanding` / `DistillLandings` | `distill-service.ts` | #145 类型化产物与落地通道接口（通道返回 null/抛错 → 回落知识条目） |
| `createSkillLanding` / `createConstraintLanding` / `createMemoryLanding` | `distill-landings.ts` | #145 三通道实现：skills 库提案 / 约束变更草案落盘 / 角色记忆草稿（studio 系统角色 + memory_proposal 卡） |
| `DistillStore` | `distill-store.ts` | proposals/runs JSONL 持久化（墓碑折叠、lastRunAt） |
| `postDistillProposalCard` | `distill-proposal-card.ts` | 发卡到 #系统；频道缺失/发卡失败返回 false（静默，#101 降级口径） |
| `generateGcCandidates` | `gc-candidates.ts` | GC 周期计龄纯函数（#144）：reference/context 层连续 3 周期 `lastReferenced` 未更新 → 候选（附可读理由）；manual 3 周期新生豁免；signal/rule 跳过；主区 >200 强制 |
| `GC_REQUIRED_CYCLES` / `GC_MAIN_AREA_LIMIT` | `gc-candidates.ts` | 阈值常量（3 / 200） |
| `GcStore` | `gc-store.ts` | gc-proposals.jsonl 持久化（墓碑折叠；rejectedEntryIds = 人判保留不再提案） |
| `postGcProposalCard` | `gc-proposal-card.ts` | gc_proposal 卡到 #系统（候选逐条附理由；失败静默同口径） |
| `DistillService.runGcCheck/approveGc/rejectGc` | `distill-service.ts` | #144：每次蒸馏运行后 GC 检查（永不抛）；approve → 候选 archived（可恢复）；reject → 零副作用 |
| `loadActiveCustomConstraints` / `normalizeAuditSuggestions` / `readPackageDeps` | `constraint-audit.ts` | #146 审计纯函数：active 存量约束读取（retired 段跳过）/ 判据白名单闸门（target-gone / reintroduction-sealed，此外丢弃）/ package.json 依赖证据 |
| `CONSTRAINT_AUDIT_SYSTEM_PROMPT` / `buildConstraintAuditPrompt` / `AUDIT_CATEGORY_LABELS` | `constraint-audit.ts` | #146 审计 prompt（判据 + 防再引入反例）与判据中文标签 |
| `ConstraintAuditStore` | `audit-store.ts` | #146 constraint-audits.jsonl 持久化（墓碑折叠；rejectedConstraintIds = 人判保留不再进审计输入） |
| `postConstraintAuditCard` | `constraint-audit-card.ts` | #146 constraint_audit_proposal 卡到 #系统（建议逐条附判据理由；失败静默同口径） |
| `DistillService.runConstraintAudit/approveAudit/rejectAudit` | `distill-service.ts` | #146：产出新约束的运行后审计（永不抛）；approve → retire 执行（复用 evolution/applier `retireConstraintEntry`，D6 落点可恢复）；reject → 零副作用 |
| `getDistillService` / `initDistillLoop` | `distill-runtime.ts` | 懒单例 + 启动订阅（唯一 import knowledge-singletons 的文件；onProductsSaved 接 scheduleVectorDbSync；#146 装配 constraintsFile/packageJsonFile） |
| `distill.routes` | `distill.routes.ts` | POST `/approve` `/reject`（`{proposalId}`）；GET `/proposal-status?ids=`（只读）；#144：POST `/gc/approve` `/gc/reject`（`{gcProposalId}`）、GET `/gc/proposal-status?ids=`；#146：POST `/audit/approve` `/audit/reject`（`{auditProposalId}`）、GET `/audit/proposal-status?ids=` |

### 设计决策

- **人审闸门**：LLM 批处理永远有人确认（#80 已判无人值守触发器死刑）。pending 提案存在期间不重复发卡；发卡失败标记 `card-failed`（终态，不阻塞后续提案）。
- **GC 周期计龄（#144）**：计龄单位 = 执行成功的蒸馏运行（runs.jsonl 中 outcome=executed 的 executedAt 序列；失败运行不构成周期，同消费基线「失败不推进」口径），不读墙钟——系统闲置三个月 → 无新运行 → 无新周期 → 无人过线冤案。manual 新生豁免锚在 `created`（promote 不留独立时间戳，承袭 #143 口径；「老条目新过审」场景覆盖不了，已知限制）。reject 的候选条目记入人判保留集，后续运行不再提案（防打扰，D4「人审历史作保护项」）；approve 归档可恢复（改回 active 即恢复，无独立恢复入口——语义可逆）。GC 检查挂在每次 executed 运行落盘后，runGcCheck 永不抛。
- **蒸馏即消费**：approve 成功且产物 ≥1 → 原料 `maturity=archived`；产物 `sourceReferences` 以类型化 `SourceRef.entryId` 回指全部原料 id（harness ≥0.18.0 落地该字段，#148 去掉 `as unknown as SourceRef[]` 强转；frontmatter YAML 往返由 harness#23 锁定）。LLM 空产出 → 不消费原料但落 executed 运行记录。
- **三分落地（#145）**：`productIds` 记全部落地产物 id（知识条目 + 三通道产物），保证「executed 且产物 ≥1 才推进消费基线」口径不因分流漏推进；运行记录带 `landings` 分布（knowledge/skill/constraint/memory 各桶产物 id，knowledge 桶含回落条目）。落地通道经 `deps.landings` 注入（service 保持 DI 纯净），单产物落地失败只回落该产物、不影响同批其它产物。约束草案是落盘简化形态（D6 派单未就绪），retire 草案只写操作说明（harness retire 落 config.yml 非 custom-constraints.yml，草案不替人执行）。memory 通道锚 studio 系统角色（`ensureStudioProfile` 幂等解析）——蒸馏是系统级沉淀，无具体 WU 承担者角色。
- **失败不阻塞**：LLM 异常 / JSON 解析失败 → 原料不动、提案 `failed`、落 failed 运行记录；maybePropose 永不抛（fire-and-forget + catch 记日志，同 WuCompletionExtractor）。失败运行推进熔断时钟（防烧钱循环）但不推进消费基线（原料可下轮再蒸馏）。
- **预算守卫**：approve 时查 daily-token-budget（与 #99 同口径）；耗尽 → 跳过执行（不报错、不消费），提案保持 pending 可次日重试。#146 审计 LLM 调用同守卫：耗尽 → 跳过审计（不提案不报错）。
- **存量约束审计（#146）**：触发 = 蒸馏运行 landings.constraint 非空（新约束入库才顺带审计，不另设 cron——#139 D1 / #83 D3）。判据白名单（target-gone / reintroduction-sealed）是防再引入型误判的确定性闸门：LLM 判断、白名单把关、人审终审三层；「技术存量清零」「长期零违规」等白名单外理由在 normalize 阶段丢弃（ADR-0001:12 零违规歧义）。approve 执行复用 E1 applier `retireConstraintEntry`（#82 D6 落点：yml 条目内 retired 段、原文保留、rollback 路由可恢复），人审期间已被其它路径退役的条目幂等跳过；reject 的约束进人判保留集，后续审计不再纳入输入。审计范围只覆盖 custom 约束（内置归 harness 发版治理）。
- **manual 过审口径**：maturity verified/proven（promote 路径 draft→verified→proven 是唯一人审通过通道）；promote 不留独立时间戳，故按「created 晚于上次运行」计新。
- **事件**：`knowledge:distill`，stage ∈ proposal-posted / card-failed / executed / failed / rejected / skipped(budget-exhausted) / gc-proposal-posted / gc-card-failed / gc-executed / gc-rejected（#144）/ audit-proposal-posted / audit-card-failed / audit-executed / audit-rejected（#146）；门槛未命中、GC 零候选与审计零建议不落事件（零噪音）。
- **前端**：`DistillProposalCard`（cardType `distill_proposal`）+ `GcProposalCard`（cardType `gc_proposal`，#144）+ `ConstraintAuditCard`（cardType `constraint_audit_proposal`，#146）+ ChannelDetailPage handleAction 分发；approve 返回 `success:false + skipped:'budget-exhausted'` 时卡片保持待审。

### 依赖关系

**上游**:
- `@dommaker/harness`（`FileKnowledgeStore` / `KnowledgeEntry` 类型）
- `@dommaker/studio-shared`（`FileStore`、`eventBus`、`studioPath`）
- `modules/knowledge/knowledge-singletons.ts`（sharedStore / scheduleVectorDbSync，仅 runtime 装配）
- `modules/agents/system-executor.ts`（LLM 调用）、`modules/agents/loop/daily-token-budget.ts`（预算守卫）
- `modules/channels/channel-message.service.ts`（发卡）、`utils/studio-events.ts`（统一事件入口）
- `modules/evolution/applier.ts`（#146 approveAudit 复用 `retireConstraintEntry` 文本级手术）、`modules/harness/constraints.routes.ts`（runtime 复用 `customConstraintsPath` 路径解析）

**下游**:
- #145 产物三分落地已落地（本模块 distill-landings；下游通道：modules/skills 提案、modules/role-memory 草稿）；#146 存量约束审计已落地（本模块 constraint-audit / audit-store / constraint-audit-card）；#144 GC 候选清单已落地（本模块 gc-*）

### 注意事项

- 测试注入临时目录（`new DistillService({store, fileStore, dataDir, eventsFile})`），不碰 `~/.studio`；LLM seam = mock `getSystemExecutor`（蒸馏调用与 #146 审计调用同一 seam，顺序 mockResolvedValueOnce 区分）。#146 审计的约束文件/依赖清单走 `deps.constraintsFile` / `deps.packageJsonFile` 临时文件。
- `store.list()` 每次门槛检测全量读索引（零 LLM 但有 IO）；知识库稳态百条级，可接受。
- approve 非事务：进程在「产物已存、原料归档中」崩溃会留下半成品（原料部分归档）——最小闭环接受，重跑由新提案覆盖。
- #146 approveAudit 写 custom-constraints.yml 后，CLAUDE.md 注入段不即时重渲染——mergeConstraints 已排除 retired 条目（harness 63059e6/8acac70），注入段随下一次 `harness sync-docs` 收敛；checker 联动与落盘对齐归 #139。


## apps/api/src/modules/events

### 职责

提供全局事件系统：StudioEvent CRUD（G30）、AgentEvent 批量写入（B9-014）、SSE 实时流（HZ-028）、Session 摘要生成（B9-015）。

### 核心导出

| 模块 | 路由 | 用途 |
|------|------|------|
| event.routes.ts | POST /api/v1/events | 创建 StudioEvent |
| event.routes.ts | GET /api/v1/events | 查询 StudioEvent（requireAuth；#180 起：type/since/until/level/keyword/workUnitId 过滤 + 尾部倒读游标分页 `cursor`→`nextCursor`，替代全文件线性扫 + 200 硬顶；level 缺省 ≥info，level=debug 看全部；倒读实现 `../../utils/studio-events-tail.ts`） |
| event.routes.ts | POST /api/v1/events/agent-events | 批量写入 AgentEvent[] |
| sse.routes.ts | GET /api/v1/events/stream | SSE 实时事件流 |
| sse.routes.ts | GET /api/v1/events/clients | SSE 客户端列表 (debug) |
| workunit-events-bridge.ts | initWorkunitEventsBridge() | eventBus 的 workunit.created/status_changed → 'events' 频道（前端 WU 列表/抽屉实时刷新）；index.ts 启动时调用，幂等 |
| lock-events-bridge.ts | initLockEventsBridge() | #169: eventBus 的 lock.stale_reclaimed/lock.acquire_timeout → 结构化字段落统一事件流 + dispatchMonitorAlerts 全管线（warning 级，不设 critical）；index.ts 启动时调用，幂等 |
| （agent-loop 直发） | workunit.execution.step | WU 执行步事件（思考/工具/skill/用量）：agent-loop 每步结束经 eventStore.publish 直发（不经过桥），`workunit.` 前缀自动落 workunits topic；落盘形态 `workunit:execution_step` 供 GET /events 回放 |
| （agent-loop 直发） | workunit.execution.stream | WU 步内流式 chunk（Layer B，2026-07-30）：step 执行中 CLI stdout 按行提炼 thinking/text/tool/result 直发，**SSE-only 不落盘**（行级体量防膨胀；步级归档走 execution.step）；同前缀落 workunits topic |
| session-summary-generator.ts | generateSessionSummary() | session:end → session:summary 聚合 |
| session-summary-generator.ts | classifyPattern() (内部) | 根据文件/工具序列分类模式 |

### 依赖关系

- `@dommaker/studio-shared` (FileStore) — jsonl 持久化
- `../../core/event-store.js` (EventStore) — SSE pub/sub
- `../agents/monitor/monitor-alerts.js` — lock-events-bridge 的告警全管线出口（#169）
- `../skills/skill-store.js` — 模式匹配 Skill 建议 (KE-001 P5)

### 测试

四个测试文件，43+ 个用例：

| 文件 | 用例数 | 覆盖内容 |
|------|--------|---------|
| `__tests__/event.routes.test.ts` | 30 | POST/GET/agent-events: 创建/查询/验证/空 payload 拒收（D18）/错误路径；#180 起 GET 用真临时文件 + STUDIO_EVENTS_FILE 缝（过滤/游标/鉴权栈） |
| `__tests__/session-summary-generator.test.ts` | 17 | classifyPattern 13种模式 + generateSessionSummary 边界情况 |
| `__tests__/workunit-events-bridge.test.ts` | 1 | workunit.* 事件转发 'events' 频道（信封形状） |
| `__tests__/lock-events-bridge.test.ts` | 1 | #169: lock.* 事件 → 结构化事件流 + dispatchMonitorAlerts 全管线（warning + notifyAlert）、init 幂等 |

### 注意事项

- StudioEvent 用 jsonl 文件存储（D18 起统一经 `../../utils/studio-events.js` 的 writeStudioEvent 写入；空 payload 拒绝落盘）
- POST /api/v1/events 的 payload 为空（{} / null / 缺失 / '{}'）→ 400（D18：空事件不产信号只产噪音，调用方自查）
- SSE 使用 EventBus pub/sub (B0-002)，不依赖数据库
- **SSE 帧格式（2026-07-29 修复）**：只写 `id:` + `data:` 匿名事件（不写 `event:` 命名行——EventSource.onmessage 只收匿名事件），且 data 是完整信封 `{event_type, event_id, timestamp, data}`（此前只发内层 payload，客户端按 event_type 分发恒失败，全站 SSE 实际不通）。topic 映射：execution./runtime.→executions、node.→nodes、task.→tasks、goal.→goals、knowledge.→knowledge、workunit.→workunits、channel.→channels、其余→all（客户端默认订阅 all 全收）
- session:summary 在 session:end 时触发，fire-and-forget
- patternType 分类规则：纯 deterministic，不调 LLM
- **鉴权（2026-07-24 收紧）**：event.routes 的 POST /、/agent-events 已收 requireAuth+requireNotGuest；GET /stream 保持公开（Lurk 设计有意放行，会广播内部事件总线）。#180（#60 决策 Q3a）起 GET / 也收 requireAuth。
- **事件检索（#180 / #60 决策 Q3a，2026-08-16）**：GET / 改走 `../../utils/studio-events-tail.ts` 尾部倒读（字节层切行，0x0A 切分防 UTF-8 跨块截断），过滤下推到倒读循环、limit 按匹配数计、扫满即停；游标 = 已扫区间下界字节偏移，无效游标容错重扫最新。读取侧默认 level≥info（envelope 缺省 info），`level=debug` 看全部。Web 消费面 = MonitoringPage「事件检索」Tab。
- **保留轮转（#173 / #60 决策 Q3b，2026-08-15）**：`apps/api/src/utils/studio-events-rotation.ts` 每日轮转 studio-events.jsonl——信号（level≥info）热 30 天，超期切 `archive/studio-events-YYYY-MM.jsonl.gz` 月度冷包永久保留；噪声（level=debug：knowledge:*、tool:call）7 天滚动删除。分类口径 = envelope level（显式字段优先，缺省走 type 默认分级）。挂载点：index.ts 启动后跑一次 + 每 24h；测试 `utils/__tests__/studio-events-rotation.test.ts`。
- **其余日志保留轮转（#213，2026-08-19）**：#173 机制泛化为 `apps/api/src/utils/studio-log-rotation.ts`（rotateJsonlLog 配置驱动，studio-events-rotation 委托之）。决议值：incidents.jsonl（信号）热 30 天→月 gzip、audit.jsonl（审计）热 90 天→月 gzip、notifications.jsonl（噪声）7 天滚删；遗留 tasks-*.jsonl 一族 + 残留 ~/.studio/events/incidents.jsonl 一次性 gzip 归档（archive/*-legacy.jsonl.gz）后删除。挂载点：index.ts 与 #173 同节奏；测试 `utils/__tests__/studio-log-rotation.test.ts`。#205 已并入本票。


## apps/api/src/modules/evolution

### 职责

E1 约束进化（vision §6 / docs/plans/2026-07-flywheel-repair.md §4）：从执行 traces/outcomes 中加载信号，生成约束进化提案，经频道人工审核后生效到 harness 约束配置。

### 核心导出

- `signals.ts` — 路径解析 + 信号加载（traces/outcomes）
- `generator.ts` — 提案生成器（信号 → 约束提案）
- `channel-review.ts` — 频道审核（提案卡片 → 人确认），卡片交互模式被其他频道确认流复用
- `applier.ts` — 提案生效器（审核通过后写入约束配置；iron-law/guideline diff 含 amend/shadow/extend_exceptions/new-entry/retire——retire 在既有 custom 条目内落 retired 元数据段，#82 D6 一处真相，内置退役不走 E1）
- `evolution.service.ts` — 聚合服务（扫描 → 生成 → 审核 → 生效编排）
- `evolution.routes.ts` — E1 约束进化 API

### 依赖关系

- 上游：`@dommaker/studio-shared`（eventBus、FileStore、logger）、channels 模块（审核卡片消息）
- 下游：apps/api 路由挂载；`evolution-daily-scan` trigger（agents/default-triggers）驱动每日扫描

### 注意事项

- 保守策略：信号不足时零提案；`EVOLUTION_ENABLED=false` 可整体关闭
- **harness 0.17.1 适配（2026-08-09，ADR-0001）**：E1 完整保留仅拆弹——generator (a) autoEvolve 链路挂起（report 数据层未从包 exports 导出，修复立项见 docs/plans/2026-08-flywheel-repair-e1.md），applier 写入 PROMPTS 桶（TIPS 已退役）；存量 source='harness-autoEvolve' 提案仅为兼容保留。harness 侧 /evolve /degrade /schedule 端点已删除（见本文 `apps/api/src/modules/harness` 锚点）
- 提案必须经人确认后才由 applier 生效，不做自动落地
- **鉴权（2026-07-24 收紧）**：`/api/v1/evolution` 挂载级 `requireAuth()+requireAdmin()` —— approve/reject/run 直接让约束变更生效，此前仅 requireAuth。


## apps/api/src/modules/executions

### 职责

提供执行（execution）相关的 REST API 路由，当前仅包含获取执行列表（GET /）。基于本地 JSONL 文件和 tasks 目录的 FileStore 实现，不依赖已删除的数据库。此模块为遗留接口（LEGACY surface），仍被前端调用，但计划迁移至 agent-profiles / workunit API，迁移前不建议扩展新功能。

### 核心导出

| 导出 | 文件 | 说明 |
|------|------|------|
| `router` (Express Router) | `routes.ts` | 注册了 GET / 路由，返回执行列表（支持分页、状态过滤，含进度计算）。

### 依赖关系

- **上游依赖**：
  - `express`：Router、Request、Response
  - `uuid`：生成唯一标识
  - `os`、`path`、`fs`：构建文件路径、读取目录
  - `@dommaker/studio-shared`：FileStore 和 logger
  - `../../core/event-store.js`（可能未直接使用，但 import 了 eventStore）
- **下游依赖**：
  - `apps/api/src/route-registry.ts`：引用本模块的路由器并挂载到 Express 应用。

### 注意事项

- 本模块标记为 LEGACY surface，迁移前请勿在此扩展新功能。
- 所有数据读写均基于本地文件系统（`~/.studio/logs/executions.jsonl` 和 `~/.studio/data/tasks/`），不依赖数据库。
- `findTaskByExecutionId` 辅助函数会遍历 `TASKS_DIR` 下的所有 JSON 文件，需注意文件数量较多时的性能。
- 路由 GET / 默认按 `createdAt` 降序排列，分页参数为 `page` 和 `limit`（默认 1/20）。
- 该模块的长期规划是废弃并被 agent-profiles / workunit API 替代（见 `docs/vision-2026.md`）。
- **已知风险（2026-07-24 记录）**：行为未变；POST /events 无任何鉴权/签名（内部 runtime 回调假设，全仓无调用方，生产靠大门兜底，建议后续 requireLocalhost 或共享密钥）；GET /:executionId 回显服务器绝对路径（POST /:executionId/archive 已随工单 20 删除）。


## apps/api/src/modules/harness

### 职责

Harness 监控与治理 API（FL-029 / T-015）：轨迹采集分析、约束生命周期、
安全护栏、知识引擎、会话/Agent 管理、错误分类与验证、仪表盘。

路由结构（T3 大文件拆分 5/N，2026-07-19）：`routes.ts` 为挂载门面，
处理器按资源拆分为子路由，共享运行时集中于 `runtime.ts`：

| 文件 | 职责 |
|------|------|
| `runtime.ts` | @dommaker/harness 懒加载、Collector/Analyzer/KnowledgeStore 单例、TTL 缓存 |
| `routes.ts` | 挂载门面（默认导出 Router，route-registry 挂 /api/v1/harness，2026-07 起 requireAuth+requireAdmin） |
| `traces.routes.ts` | 轨迹采集/分析/诊断（/traces、/analysis、/diagnose） |
| `proposals.routes.ts` | 约束提案（/proposals；/evolve 已随 harness 0.17.0 移除，execute 为 410） |
| `constraints.routes.ts` | 约束清单 + 质量门（/constraints*、/check-constraints；degrade/schedule 已随 0.17.0 移除；retired/rollback 双落点——config.yml 内置/历史 + custom-constraints.yml #82 D6 统一落点；导出 customConstraintsPath 供 distill #146 审计装配复用） |
| `guards.routes.ts` | 安全护栏（/check-input、/check-output、/sandbox） |
| `knowledge.routes.ts` | 知识引擎（/knowledge*） |
| `sessions.routes.ts` | 上下文管理（/estimate-tokens、/sessions*） |
| `agents.routes.ts` | Agent 生命周期（/agents*） |
| `diagnostics.routes.ts` | 错误分类/规格检查/验证（/classify、/failures、/check-spec、/verify*） |
| `dashboard.routes.ts` | 仪表盘/健康（/dashboard、/health） |
| `cso.routes.ts` | CSO 验证（/validate；2026-07 起 /api/v1/cso 只挂本文件，不再整挂 routes.ts 门面——否则 harness 的 Admin 收紧可被 /cso/* 双挂载绕过） |
| `iron-laws.routes.ts` | Iron Laws（独立子路由，挂 /api/v1/iron-laws） |

### 核心导出

- `routes.ts` default export：express Router（44 个端点，见门面注释）

### 依赖关系

- 依赖 `@dommaker/harness`（懒加载，不可用时端点降级 503）
- 依赖 `@dommaker/studio-shared`（logger）、`../knowledge/knowledge-bus.service.js`（UNIFIED_KNOWLEDGE_DIR）
- 被 `apps/api/src/route-registry.ts` 引用（/api/v1/harness = requireAuth+requireAdmin；/api/v1/cso 仅挂 cso.routes 的 /validate，公开不变）

### 注意事项

- 子路由路径首段字面前缀互不重叠；唯一前缀包含关系 /constraints/stats 先于
  /constraints/:id 注册（constraints.routes.ts 内保持顺序）。
- 提案持久化于 `process.cwd()/.harness/proposals/`；会话与 AgentLifecycle 为内存态。
- GET /knowledge 有 30s TTL 缓存（runtime.ts）。


## apps/api/src/modules/knowledge

> Updated: 2026-06-11 (GAP-7 元数据驱动注入 + error logging 修复)

### 职责

知识引擎：让系统越来越聪明。三层分离架构（Producer → Engine → Consumer）。

- **摄入（Ingest）**: 7 类 producer 往里写（preference/rule/env/decision/pattern/external/behavior）
- **消费（Consume）**: 2 条路径 — prompt 注入（knowledgeService.injectContext）+ 按需查询（search/UnifiedQuery）
- **质量（Quality）**: 去重、衰减、成熟度、low_quality 过滤
- **演化（Evolve）**: 重复知识 → Skill 化

### 核心导出

| 模块 | 路径 | 职责 |
|------|------|------|
| `knowledgeBus` | `knowledge-bus.service.ts` | 兼容层（thin compat，R4 收敛）— 共享知识总线 write/search API |
| `knowledge-singletons` | `knowledge-singletons.ts` | 共享单例唯一所有者（sharedStore 等）+ 向量库同步 + 统一质量门（R4） |
| `UnifiedQuery` | `engine/unified-query.ts` | 双存储统一查询（Prisma + KnowledgeStore），knowledgeService 的 query 引擎（R4 修复接线） |
| `knowledgeService.injectContext` | `knowledge-service.ts` | 统一 prompt 注入入口（absorbed from prompt-builder）；E2：有注入时附「何时查知识库」指引（`KNOWLEDGE_QUERY_GUIDANCE`）；#91：maxTokens 由 prompt-composer 按分段定额传入（knowledge 1000 + 池余量），`knowledge:inject-trimmed` 事件补 originalTokens/keptTokens 尺寸字段，返回值带 `usage` 供 `prompt:section_trimmed` 埋点 |
| `knowledgeService.semanticSearch` | `knowledge-service.ts` | mcp-local-rag 语义检索；E2：可用性探测（进程内缓存 5min）+ 失败降级关键词检索，不再静默返回 [] |
| `knowledge-types` | `knowledge-types.ts` | KnowledgeService 的 Studio 侧类型 + `KnowledgeServiceDeps` + `ENTRY_TYPE_MAP`（knowledge-service.ts 拆出，门面 re-export） |
| `knowledge-data-layer` | `knowledge-data-layer.ts` | 数据层：`writeTrendData`（data/trends 趋势写入）+ resolution 影子库 FileStore helpers + 共享 `fileStore`/`STUDIO_EVENTS_JSONL`（knowledge-service.ts 拆出） |
| `knowledge-forms` | `knowledge-forms.ts` | 知识形态门禁 `validateKnowledgeForm`（knowledge/data/skill/rule，代码层判断不调 LLM）（knowledge-service.ts 拆出，门面 re-export） |
| `inject-context` | `inject-context.ts` | injectContext 注入闸门与预算：R3 提案闸门（isInjectableMaturity）、来源凭证、2K `INJECT_TOKEN_BUDGET`、注入优先级、`KNOWLEDGE_QUERY_GUIDANCE`、stripFormat（knowledge-service.ts 拆出，门面 re-export） |
| `conversation-extraction` | `conversation-extraction.ts` | R3 会话提取：transcript 构建 + 单条入库 proposal 闸门 + 审核闭环 knowledge_proposal 提案卡（knowledge-service.ts 拆出） |
| `knowledge-metrics` | `knowledge-metrics.ts` | R1/M1 事件流度量纯函数：computeOutcomeMetrics（hitRate/improvement）+ scanKnowledgeEvents（审计计数）（knowledge-service.ts 拆出） |
| `knowledge-search-helpers` | `knowledge-search-helpers.ts` | 检索 helpers：关键词抽取（STOP_WORDS）/TYPE_WEIGHT + mcp-local-rag 探测与关键词降级映射（knowledge-service.ts 拆出） |
| `knowledgeRoutes` | `routes.ts` | REST API 挂载门面（挂载下方 6 个子路由，含 /unified 统一浏览） |
| `ImproverScheduler` | `improver-scheduler.service.ts` | 自文档化调度器（每小时刷新 stale CONTEXT.md + 生成架构文档） |

### 目录结构

```
knowledge/
├── engine/                    # 存储/查询层
│   └── unified-query.ts       # 双存储统一查询
├── knowledge-bus.service.ts   # 兼容层：KnowledgeBus 类 + 单例 re-export（R4）
├── knowledge-singletons.ts    # 共享单例/向量库同步/统一质量门（R4 收敛）
├── knowledge-service.ts       # 统一知识能力层（KnowledgeService 编排 + 单例接线；工单 29 拆分后聚焦编排）
├── knowledge-metrics.ts       # Measure 纯函数内核：飞轮度量/健康/审计 + 度量类型（工单 29 拆出）
├── trend-data.ts              # trends 数据层 writeTrendData（工单 29 拆出）
├── knowledge-form-gate.ts     # 知识形态门禁 validateKnowledgeForm（工单 29 拆出）
├── conversation-extractor.ts  # R3 会话提取管道 + knowledge_proposal 提案卡（工单 29 拆出）
├── knowledge-semantic-search.ts # mcp-local-rag 语义检索支撑：探测/CLI/降级映射（工单 29 拆出）
├── knowledge-types.ts         # KnowledgeService 类型 + ENTRY_TYPE_MAP（knowledge-service 拆出）
├── knowledge-data-layer.ts    # trends/resolutions 数据层 + 共享 fileStore（knowledge-service 拆出）
├── knowledge-forms.ts         # 知识形态门禁 validateKnowledgeForm（knowledge-service 拆出）
├── inject-context.ts          # injectContext 注入闸门/2K 预算/检索指引（knowledge-service 拆出）
├── conversation-extraction.ts # R3 会话提取 + 提案卡（knowledge-service 拆出）
├── knowledge-search-helpers.ts # 关键词/RAG 降级检索 helpers（knowledge-service 拆出）
├── knowledge-service.routes.ts # KnowledgeService HTTP API + SSE
├── knowledge-query.service.ts # 5 类缺口查询（query/getStats）
├── knowledge-sync.service.ts  # 自动同步 + 新鲜度检测
├── resolution.service.ts      # 解法库（独立子系统）
├── evolution-scheduler.ts     # 周期任务调度（G-005 模式挖掘 + eval spring cleaning）
├── improver-scheduler.service.ts # 自文档化调度器（refreshStaleContext + runArchDocs）
├── preference-observer.ts     # Producer: 用户偏好
├── rule-scanner.ts            # Producer: 业务规则
├── env-snapper.ts             # Producer: 环境快照
├── pattern-miner.ts           # Producer: 交互模式
├── decision-chain-extractor.ts # Producer: 决策链
├── eval-case-generator.ts     # Producer: 评估用例
├── routes.ts                  # API 路由门面（挂载子路由，导出 knowledgeRoutes/knowledgeInternalRoutes 不变）
├── files.routes.ts            # 子路由：文件浏览（/requirements /read-file /file）
├── entries.routes.ts          # 子路由：知识条目（/export /ask /gaps /unified）
├── search.routes.ts           # 子路由：检索与解法指标（/resolutions /search /resolution/*）
└── internal.routes.ts         # 子路由：内部端点（/sync-status /upsert，无 auth）
```

### 依赖关系

- **上游**: `@dommaker/harness`（KnowledgeStore/KnowledgeIngest/KnowledgeLifecycle）
- **上游**: `@dommaker/studio-shared`（FileStore / logger / modelGateway）
- **下游**: `agents/*`（通过 knowledgeService.injectContext 注入 prompt）
- **下游**: `channels/*`（conversation-handler）

### 注意事项

- **知识库边界（#93，2026-08-13）**：KB = 项目级共享知识（跨角色 rule/context/signal/reference）。角色记忆（#100 的 per-role `MEMORY.md` + topic 文件体系）**不进知识库、不走 injectContext**；守卫约定 = 角色记忆条目带 `role-memory` tag，注入闸门（`isRoleMemory`）一律拦截，回归测试见 `__tests__/knowledge-service-inject-wiring.test.ts`。
- **#93 注入修复（2026-08-13）**：rule/context 注入曾恒空——`unified-query.ts` 合成条目 `sourceReferences` 恒 `[]` 被 `hasSourceReferences` 闸门全拦。修复 = 合成端（preferenceToEntry/ruleToEntry/envToEntry）从 store 条目 id / snapshot 文件名派生真实出处；手动创建 API（entries.routes.ts POST /unified）stamp `manual:<user>` 出处。闸门语义不变：无凭证不注入。
- 另知：`inject-context.ts` 当前零 importer（knowledge-service.ts 底部自持同一份 R3 闸门/来源凭证/INJECT_TOKEN_BUDGET/injectPriority 拷贝），属拆分后未清理的死模块（未修，2026-08-11 发现）。
- **测试稳定性（2026-08-04 已修）**：`__tests__/knowledge-bus-sync.test.ts` 的「失败后恢复 → recovered」用例原为预存 flake，根因非定时器节奏——是该用例对 `@dommaker/studio-shared` 重复 `vi.doMock` 两次，import 偶发绑定先注册的 factory（`logger.info` 为不可见 `vi.fn()`），致 recovered/synced 断言抖动。已收敛为单一注册点（`mockDeps` 增 `loggerInfo` 参数），100 轮复跑零失败。
- **knowledge-service.ts 类体不再拆分（2026-08-04 决议，接受现状 1143 行）**：模块级代码已全部抽至上述 7 个模块；KnowledgeService 类体（约 1021 行）整体保留，因 `__tests__/knowledge-service.test.ts` 锁定 prototype 恰好 35 个方法（含 5 个 private，TS private 运行时挂 prototype），任何拆类都会打破该测试。后续若要拆类，须先获批准放宽该断言（如改为 ≥35 或只锁 public 集合）。
- Producer（preference-observer 等）直写 KnowledgeStore（FileStore 存储；Prisma 已全量移除）
- Resolution 和 Incident 是独立子系统，不纳入统一查询
- `knowledgeBus` 的 `formatIndexSummary()` 已删除（零调用方；替代者 `buildKnowledgeContext` 亦已于 2026-07-27 清理，现注入入口为 `knowledgeService.injectContext`）
- `applicableAgents` 存储在 tags 中（`agent:executor` 格式），KnowledgeEntry 无此字段
- **鉴权（2026-07-24 收紧）**：`/api/knowledge`（internal.routes，不在 /api/v1 大门内）2026-07-24 起挂载 requireLocalhost——此前全匿名：POST /upsert 可污染知识库、GET /sync-status 有 heal 写副作用；本机脚本经回环调用不受影响。（POST /extract-text-sync 已于 2026-07-28 删除：直连 DeepSeek HTTP API 时代的 debug 路由，绕过 CLI 且零调用方）
- **鉴权（2026-07-24 收紧）**：/api/v1/knowledge 子路由写端点（entries /ask+/unified、files /read-file）与 /api/v1/knowledge-service 写 11 条已收 requireAuth+requireNotGuest；knowledge-service GET /entries/stats 被 :id 遮蔽（未修）。
- **document-store 退役（#149，2026-08-15）**：`~/.studio/data/documents`（DocRecord FileStore）整体退役——角色已由业务仓 `.studio/` 与知识引擎 unified entries 接管，生产数据为零（24 个文件全是 p1/c1 测试夹具，已归档为 `~/.studio/data/documents.retired-20260815.tar.gz`）。摘除面：document-store.ts、documents.routes.ts（文档 CRUD/审核）、evolution.service.ts + evolution.routes.ts（知识进化引擎 §12.12，持久化只落在该目录；evolution-scheduler 保留模式挖掘/eval cleaning）、import.routes.ts（冷启动导入，execute 写该目录）、mcp/knowledge.tools.ts（5 个 MCP 知识工具全是该目录 CRUD）、internal /upsert 的 Document 投影、search 的 document 源；web 侧 KnowledgeDocGrid/DocReaderDrawer/KnowledgeImportPage/PMO 文档计数徽章同步摘除。
- **#90 outcome 事件 errorType（2026-08-13）**：`ExecutionOutcome` 增 `errorType?`（knowledge-service.ts 门面内联定义与 knowledge-types.ts 同构两处）；`recordOutcome` payload 携带 errorType（success 时 undefined 被 JSON.stringify 丢弃）。失败步（success=false + errorType=execution_failed）由 agent-loop `recordOutcomeEvent` 落 `knowledge:outcome:failure`，供失败分析/门禁消费。


## apps/api/src/modules/lark

### 职责

处理飞书机器人回调事件，包括 URL 验证（首次配置）、卡片按钮点击事件（card.action.trigger）以及其他未处理事件。提供健康检查端点。

### 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `default` (Router) | `routes.ts` | 飞书回调路由，包含 `/callback` 和 `/health` 两个端点 |

### 依赖关系

- 上游：`../../utils/logger.js`（日志工具）、`express`、`crypto`（Node.js内置）
- 下游：`apps/api/src/route-registry.ts`（注册路由）

### 注意事项

- 签名验证使用 HMAC-SHA256，需确保 `LARK_APP_SECRET` 环境变量正确配置
- 飞书回调需返回 `challenge` 字段以通过 URL 验证
- 按钮点击事件中 `action` 从 `event.action.value.action` 或 `event.action.value` 提取
- 已移除会议模块，按钮点击仅记录日志并返回成功


## apps/api/src/modules/mcp

> MCP（Model Context Protocol）模块 — 将 Studio 系统能力暴露为 MCP tools，供 Agent 和 UI 共享调用。

### 结构

| 文件 | 职责 |
|------|------|
| `tools.ts` | 注册门面：导入各域 tool 数组、组装 allTools、风险级别标注、注册、权限种子、导出 getToolSchemas/executeTool |
| `tool-store.ts` | 共享 FileStore 存取助手（数据目录惰性解析 getTasksDir 等 + 通用 JSON 实体读写） |
| `tool-registry.ts` | MCPToolRegistry：动态注册、健康检查、限流、调用追踪 |
| `server.ts` | MCP Server：JSON-RPC 2.0 协议处理（initialize / tools/list / tools/call） |
| `routes.ts` | HTTP 路由：POST /mcp、SSE transport、tools 列表+调用、health |
| `permission.service.ts` | MCP 权限服务：RBAC 授权 + 审计日志 |
| `admin.routes.ts` | 管理路由（需认证） |
| `*.tools.ts` | 各域 tool 定义（见下表） |

### 域 tool 文件

| 文件 | 数量 | Tools |
|------|------|-------|
| `pmo.tools.ts` | 3 | createProject / listProjects / getProjectStatus |
| `task.tools.ts` | 5 | getTaskBoard / createTask / assignTask / updateTaskStatus / getTaskStats |
| `economy.tools.ts` | 1 | getBalance |
| `spec.tools.ts` | 4 | createSpec / approveSpec / getSpecStatus / listSpecs |
| `safety.tools.ts` | 3 | checkConstraint / checkGuardrail / getSandboxLevel |
| `system.tools.ts` | 2 | systemHealth / emitEvent |
| `devops.tools.ts` | 1 | publishPackage |
| `skill.tools.ts` | 1 | loadSkill |
| `workunit.tools.ts` | 1 | createWorkUnit |
| **合计** | **21** | |

> #149（2026-08-15）：`knowledge.tools.ts`（5 个知识工具，全是 document-store CRUD）随 document-store 退役删除。
> #172（2026-08-15）：`loadSkill` 入参加可选 `workUnitId`（透传 skill-loader，skill_used 事件补 WU 归属，#60 决策 Q2）。

### 核心导出

- `getToolSchemas()` — 获取所有 tool 的 JSON schema（不含 handler）
- `executeTool(name, input, roleId?, traceCtx?)` — 按名称执行 tool（含权限检查 + 限流 + 审计）
- `MCPToolRegistry` / `toolRegistry` — Tool 注册与生命周期管理
- `mcpPermissionService` — 权限与审计

### 依赖关系

- 依赖：`@dommaker/studio-shared`（logger, FileStore）、`@dommaker/studio-skill`（skillLoader）、`../../utils/studio-events.js`（D18 统一事件写入，emitEvent / tool:call traces）
- 依赖：各业务模块（workunit, pmo, knowledge, skills）
- 被依赖：`routes.ts` / `server.ts`（HTTP 与 JSON-RPC 入口）

### 注意事项

- tools.ts 是门面，不包含 tool 定义。新增 tool 在对应域 *.tools.ts 中添加，并在 tools.ts 的 allTools 数组中展开（注册顺序即数组顺序）。
- 风险级别按工具名前缀自动分配（create/store/extract/approve/assign/update 等 → medium，delete/drop/truncate → high，其余 → low）。
- 权限模型默认 executor（本地 Agent）可调用所有 tool。
- **HTTP 端点鉴权分层（2026-07-24 收紧）**：`GET /tools`、`GET /health` 保持公开（Lurk）；`POST /tools/:name` → `requireAuth+requireAdmin`（roleId 自声明 + executor seed 默认全允许，此前在 PUBLIC_API 前缀下匿名可执行任意 tool 含 devops/git）；`POST /messages`、`GET /sse` → `requireLocalhost`（真实客户端为本机 agent，`STUDIO_MCP_URL` 默认 localhost SSE）；`/admin/*` → `requireAuth+requireAdmin`（此前裸奔，注释谎称由 route-registry 提供 requireAuth）。permission.service 的 RBAC 是 agent 角色维度，与 HTTP 用户鉴权是两层。


## apps/api/src/modules/monitoring

### 职责

负责聚合 Agent Network 的监控指标，包括 Agent 摘要、统计信息、飞轮指标（M1）和封装开销（M2），通过 HTTP 路由对外暴露。

### 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `default` (Router) | `monitoring.routes.ts` | Express 路由器，挂载 `/agents`、`/stats`、`/flywheel`、`/overhead`、`/overview`、`/efficiency` 六个 GET 端点 |
| `MonitoringService` | `monitoring.service.ts` | 监控服务类，封装聚合逻辑，依赖 `KnowledgeMetricsSource` 获取度量数据 |
| `MetricsService` | `metrics.service.ts` | D16 指标聚合服务：`getOverviewMetrics({windowDays})`，60s 内存缓存，`invalidateCache()` 测试用。工单 30 起类型区/纯函数区抽出（re-export 保持导出路径兼容，消费方 import 不变） |
| `aggregateOverview` (纯函数) | `metrics-aggregate.ts`（经 `metrics.service.ts` re-export） | D16 聚合核心（快照 + WU 事件 + 统一事件 + 人类消息 → 九组指标，含 F6 evidence 组），供 service 与单测直接调用 |
| `aggregateCacheHitRate` / `aggregateSectionTrim` (纯函数) | `metrics-aggregate.ts`（经 `metrics.service.ts` re-export） | #120 验证指标三件套之 1、2：输入缓存命中率（`cacheRead/(input+cacheRead)`，步/WU/角色/天四维度）+ 段 trim 率（`prompt:section_trimmed` 按 payload.section 动态分桶计数），纯事件流不新建采集 |
| `MetricsService.getEfficiencyMetrics` | `metrics.service.ts` | #120：加载统一事件 + WU index（角色归因）→ 组合 cacheHitRate + sectionTrim；60s 独立缓存（`efficiencyCache`），注入 `now` 跳过缓存 |
| `OverviewMetrics` 等 9 组指标接口 | `metrics.types.ts`（经 `metrics.service.ts` re-export） | D16 类型契约（Percentile + 9 个指标组接口 + OverviewAggregateInput 在 metrics-aggregate.ts） |
| `EvidenceMetrics` (接口) | `metrics.types.ts`（经 `metrics.service.ts` re-export） | F6 证据台账指标（决策 1）：l1/l2/l3 分层达成、selfReview 率、needsHuman、derivedMismatch 双轨偏差（持续为 0 才可停止手写 in_review）、派生列分布——派生一律过 deriveDisplayState |
| `INJECTED_TOKEN_BUDGET` (常量) | `monitoring.service.ts` | 知识/约束注入红线上限：2000 tokens/任务 |
| `OVERHEAD_RATIO_BUDGET` (常量) | `monitoring.service.ts` | 封装开销比红线：0.2（对应总 token 不超过直连 CLI 的 1.2x） |
| `KnowledgeMetricsSource` (接口) | `monitoring.service.ts` | 知识度量源接口，定义 `getFlywheelMetrics` 和 `getAuditReport` 方法 |
| `FlywheelStats` (接口) | `monitoring.service.ts` | M1 飞轮指标类型，包含 quality、hitRate、freshness 等字段 |
| `OverheadStats` (接口) | `monitoring.service.ts` | M2 封装开销指标类型，包含 injectedTokens、executionTokens 等字段 |
| `AgentSummary` (接口) | `monitoring.service.ts` | Agent 摘要类型；agents 数组含 `roleId`（= AgentProfile.id），前端 AgentDashboard 据此合并 profile 信息（provider 等）；2026-07 PMO-flow UX 起每项另含 `currentWorkUnit{id,title,type,status,claimedAt}` / `pmo{id,pmoNumber,title}` / `channelId`（均可 null，向后兼容） |
| `AgentCurrentWorkUnit` / `AgentPmoSummary` / `MonitoringServiceDeps` (接口) | `monitoring.service.ts` | /monitoring/agents 聚合的当前 WU 快照 / 归属 PMO 摘要 / 可注入依赖（`listProjects`，测试 stub 避免碰真实 ~/.studio/projects） |

### 依赖关系

上游依赖：`@dommaker/studio-shared` 的 `FileStore`；`../knowledge/knowledge-service` 的 `AuditReport` 和 `FlywheelMetrics`；以及 Node 内置 `os` 和 `path`。

下游依赖：`apps/api/src/route-registry.ts`（引用本目录的路由模块）。

### 注意事项

- 所有路由处理函数使用 `async/await`，异常统一捕获并返回 `{ error: { code: 'INTERNAL_ERROR', message } }` 格式。
- 成本红线常量 (`INJECTED_TOKEN_BUDGET`、`OVERHEAD_RATIO_BUDGET`) 与 vision §3 对齐，修改需同步文档。
- `KnowledgeMetricsSource` 接口设计为 DI 注入，默认 lazy 获取生产单例，避免模块加载期副作用。
- 监控数据窗口默认 30 天，由 `KnowledgeMetricsSource` 的 `windowDays` 参数控制。
- **D16 /overview（2026-07-27）**：聚合八组指标（任务流健康/入口转化/人工干预北极星/端到端周期/角色维度/工程质量/Token/告警），数据源 = WU index.json + workunits/events.jsonl + 统一事件文件（D18）+ 频道人类消息；窗口默认 7d（query 1-90 clamp），60s 缓存；数据不足显式 0/null + `source='insufficient-data'` 不编造；每组带 `description` 大白话。**2026-08-06 口径修复**：角色维度与 token 按角色归因改走 workunit `assignee-resolver.buildAssigneeProfileResolver`（`OverviewAggregateInput.instanceToProfile` map 入参随之换成 `resolveAssigneeProfile` 函数）——此前仅做 instance→profile map 查找，未认领指名 WU（assigneeId = profile id）静默归因为 null，与 token-usage 双形态口径不一致；修复后 profile-id 形态直通归因。
- **鉴权（2026-07-24 收紧）**：`/api/v1/monitoring` 挂载级 `requireAuth()+requireAdmin()`（route-registry）。GET 端点此前无挂载中间件、仅靠 Lurk Wall 大门兜底。
- **#120 /efficiency（2026-08-14）**：输入缓存命中率 + 段 trim 率（验证指标三件套之 1、2，父 #118）。命中率口径 = `ΣcacheReadTokens / Σ(inputTokens + cacheReadTokens)`（逐事件累加再相除，非逐事件取均值），仅统计同时带 `inputTokens` 与 `cacheReadTokens` 的 `workunit:tokens` 事件（CLI 回报 usage），其余只进 `coveragePct` 分母；维度：步（每事件一数据点 `steps`）/ WU（`byWorkUnit`）/ 角色（`byRole`，workUnitId→assigneeId→profileId 归因同 tokens.byRole）/ 天（`byDay`，createdAt YYYY-MM-DD）。段 trim 率按 `prompt:section_trimmed` 事件 `payload.section` 动态分桶（不硬编码段清单，兼容 #119 段序重排新增契约段），每段 trim 计数 + 平均原始/裁剪尺寸 + 平均裁减比例；「trim 次数/组装次数」因缺组装计数埋点暂不实现（最简口径 = 按段 trim 计数）。段 trim 率依赖埋点先行，命中率聚合无依赖。现序（重排前）数据即基线，留存可查。
- **/agents 聚合（2026-07-31 PMO-flow UX §6-1）**：`getAgentSummary` 每 agent 附 `currentWorkUnit`（WU 快照，title = metadata.title ?? scope 原样）+ `pmo`（归属链复用 pmo-branch-resolver 的 `resolvePmoProjectIdForWU`，2026-08 归因统一后两级：①创建期直读戳 metadata.pmoId（‖ deprecated legacy ownershipProjectId 同级）②reqId→Requirement.projectId（决策 4 别名镜像：REQ-\d+ 先查项目 reqAlias）；原 ③ metadata.pmoProjectId 级已移除）+ `channelId`。读取效率：WU index / requirements / projects 各读一次后内存 map 匹配（`loadCurrentWuContexts`），不逐 agent 串行读文件；projects 默认 lazy import projectService.list 大页，测试经 `MonitoringServiceDeps.listProjects` 注入。悬空 currentWorkUnitId（WU 已不存在）→ 三字段 null，裸 id 字段保持原样。


## apps/api/src/modules/notifications

### 职责

提供通知相关的 API 路由，包括获取通知列表、查询未读数量、标记单条已读和标记全部已读，作为后台消息通知模块的 HTTP 接口层。

### 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `router` | `routes.ts` | Express 路由器实例，注册了 /api/v1/notifications 下的四个端点 |

### 依赖关系

上游依赖：
- `@dommaker/studio-notification`（NotificationService）
- `@dommaker/studio-shared`（FileStore, logger）
- `../../utils/services.js`（createLazyService）

下游依赖：
- `apps/api/src/route-registry.ts`（导入并挂载路由）

### 注意事项

- 使用 `x-user-id` 请求头标识用户，默认回退为 `'default-user'`
- 通知服务通过 `createLazyService` 延迟初始化，底层依赖 `FileStore` 存储
- 错误统一返回 `{ error: { code: 'INTERNAL_ERROR', message: '...' } }` 结构
- 未读通知限制获取 50 条，可通过 `unreadOnly` 查询参数控制
- **鉴权（2026-07-24 收紧）**：POST /:id/read、/read-all 已收 requireAuth+requireNotGuest；userId 取自 x-user-id 请求头，存在 IDOR 已知局限（未修）。


## apps/api/src/modules/outbound-notify

### 职责

本模块提供基于 Discord 的通知发送服务，支持多种任务与会议相关通知类型。内部封装了对 `discordNotifier` 的调用，并通过 `eventStore` 将通知事件发布到消息总线。还暴露 HTTP 路由供内部模块通过 POST /api/v1/notify/send 触发通知。另提供用户通知渠道配置的保存与状态查询（持久化到 `~/.studio/notify-config.json`，重启自动恢复）：POST /api/v1/notify/config、GET /api/v1/notify/config/status，供 Settings 页同步用户 Webhook 配置并提示"已同步/需重存"。

### 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `NotifyService` | `notify.service.ts` | 通知发送服务类，提供 `send()`、`sendHighRiskNotification()`、`sendMediumRiskNotification()` 方法 |
| `notifyService` | `notify.service.ts` | `NotifyService` 的单例实例 |
| `NotifyMessage` | `notify.service.ts` | 通知消息的类型接口，定义支持的通知类型和字段 |
| `NotifyEvent` | `notify.service.ts` | 通知事件类型（TypeScript 类型导出） |
| `default router` | `routes.ts` | Express 路由器，处理 `/send`、`/config`（POST）、`/config/status`（GET）端点 |

### 依赖关系

**上游**:
- `../../utils/logger`（日志记录）
- `../../core/event-store`（事件存储，用于发布通知事件）
- `../../utils/discord-notifier`（Discord 消息发送工具）
- `@dommaker/studio-shared`（路由模块中使用的日志）

**下游**:
- `apps/api/src/route-registry.ts`：注册本模块暴露的路由。

### 注意事项

- `send()` 方法自动将 `components`（旧格式按钮）转换为 Discord 按钮格式；新调用应优先使用 `sendHighRiskNotification` 等方法。
- 高风险会议通知使用 `sendWithConfirmButtons` 生成带确认按钮的Discord消息，中风险使用普通文字通知。
- 路由 POST `/api/v1/notify/send` 要求请求体必须包含 `type`、`title`、`content`，否则返回 400。
- 用户渠道配置（`POST /config`、`GET /config/status`）持久化到 `~/.studio/notify-config.json`，模块加载时自动恢复，服务重启不丢（C5 修复，2026-08-06；此前仅存进程内存，重启即丢、Settings 页提示重新保存）。挂载点为 `/api/v1/notify`（middleware: admin）。
- `notifyService` 为单例，初始化时自动注入 `eventStore`，无需手动传入。
- 通知发布到事件总线频道为 `'notifications'`，其他模块可通过订阅该频道消费。


## apps/api/src/modules/pmo

### 职责

项目管理办公室（PMO）模块：OKR 管理 + 项目管理（CRUD、统一编号 PMO-<n> 自动生成）+ 交付守卫。PMO 是链条的脊椎（2026-07-28 分析文档 §4.5）：id = 分支名（gitBranch 默认 = pmoNumber）、需求文档挂载点（requirementsDocId）、状态 = WU 汇总 + 证据台账、交付策略（deliveryPolicy）挂在项目上。

### 核心导出

| 导出 | 文件 | 说明 |
|------|------|------|
| `getCurrentQuarter` | `okr.service.ts` | 获取当前季度字符串（如 2025-Q2） |
| `OKRService` 类 | `okr.service.ts` | OKR 核心服务类 |
| `okrService` 实例 | `okr.service.ts` | OKRService 的单例 |
| `OKRMetricQueries` 类 | `okr-metric-queries.ts` | B8 数据源查询基类（`OKRService` 的父类，2026-08-04 从 okr.service.ts 拆出）：路径常量（OKR_DIR/KR_HISTORY_JSONL/EXECUTIONS_JSONL/STUDIO_EVENTS_JSONL）+ `StudioEventRow` + `checkDataSourceHealth` + 22 个 `query*` metric 查询；`querySkillUsageRate` 例外留在 okr.service.ts（B59-003 测试按源码文本断言其位置） |
| `projectService` 实例 | `project.service.ts` | 项目服务单例（含 `getByReqAlias`/`getByPmoNumber`（数字归一）/`ensureChoreProject`/`findChoreProject`） |
| `generatePmoNumber` / `parsePmoSeq` | `project.service.ts` | 统一编号（决策 4：max(PM/PMO, REQ 两序列)+1，新格式 PMO-<n>） |
| `resolveDeliveryPolicy` | `project.service.ts` | 交付策略缺省解析（未设置 = branch-only） |
| `resolveDeliveries` / `PmoMap` / `DeliveryLeg` / `LEG_STATUS` | `project.service.ts` | #107 T1（#106 spec）：探路地图 `map`（destination/decisions/fog，缺省 null = 非探路型）+ 多交付腿 `deliveries`（缺省 = 读取时由 gitRepo/gitBranch 合成单腿、status 从 deliveredAt 派生、不落盘，老项目零迁移；get/list 等全部读取路径统一口径）。#113 T7：腿状态词表 LEG_STATUS（pending→active→in_review→completed→delivered）+ 腿级 deliveredAt/deliverCommit 落档字段 |
| `parsePmoNumberFromCommand` | `project.service.ts` | 从命令中解析 PMO 号 |
| `PROJECT_STATUS` 常量 | `project.service.ts` | 项目状态枚举 |
| `initPmoProgressRollup` / `syncProjectProgress` / `parseWuMetaPmoId`（re-export）/ `waitForPmoProgressRollupSettled`（#158 测试可观测性导出：等在途回写落定，纯增量；#228 起实现归并 studio-shared `createSettledTracker`） | `progress-rollup.ts` | B3a：订阅 workunit.status_changed，按项目下全部 Requirement（含决策 4 别名视图）关联 WU 的完结比例回写 progress（语义=「活干完了多少」，in_review 计入完结）；全部完结按证据翻转（2026-07-30 根因修复）：deliverable → completed，证据缺口 → active/pending 置 in_review（等证据验收，已 in_review 不动，completed/cancelled 不回退；skipValidation 直写）。同项目回写按 projectId 串行化（防相邻事件并发覆盖）；幂等补写证据不产生状态事件，靠 `GET /project/:id` 读取时重算纠偏。**#115 T9 派生链未落定不翻 completed**（`derivationPending`，e2e 走查根因修复）：analysis/spec 单 done 事件触发本回写时派生订阅器（挂载序晚于本订阅）尚未落哨兵/建下游 WU，「全部完结」是假相——命中 ①有 map 未 specSpawnedAt ②已完结 analysis 缺 analysisTasksSpawnedAt ③已完结 spec 缺 specTasksSpawnedAt 即跳过本次 completed/in_review 翻转（多腿含腿状态），progress 照写，待派生落定后下一事件或读取重算再评估。#113 T7 多腿：显式多腿项目走逐腿状态机（腿内全完结+证据齐→腿 completed、缺口→腿 in_review、有在途→腿 active（#115 起 completed/in_review 可回摆——派生物化/补单会让已完结腿出现在途 WU；delivered 腿终态不回写、零 WU 腿不动且不阻断）），腿状态回写 project.deliveries；项目整体翻转条件 = 全部腿 completed/delivered（零 WU 腿视为满足），否则同单腿语义置 in_review；progress 口径不变。单腿（无 deliveries/合成单腿）不走腿路径，行为与现状逐字节一致 |
| `selectProjectSnapshots` / `summarizeEvidence` / `matchWuToLeg` / `partitionSnapshotsByLeg` / `parseWuMetaPmoId`（deprecated 别名）/ `CODE_TYPES` | `evidence-summary.ts` | 共享证据口径（2026-07-30 抽取，delivery 台账与 progress-rollup 状态翻转共用）：归属（Requirement.projectId → reqId 集合，空则回退创建期归因戳）+ 逐快照 deriveDisplayState 派生 l1（仅代码类）/l2（豁免 review/analysis + #108 decision/spec——对齐 review-dispatcher 跳过集，验收闸=人工 L3）/l3 齐缺 + deliverable 判定。2026-08 归因统一：戳 parser 迁至 requirements/wu-pmo-attribution.ts（`parseWuPmoId`，零依赖叶子防循环），本模块仅保留 `parseWuMetaPmoId` 兼容别名；回退过滤口径放宽为 pmoId ‖ legacy ownershipProjectId 同级（pmoId 优先，ownershipProjectId 生产存量为零、实数据行为不变）。#113 T7：WU→腿归属最小口径 `matchWuToLeg`（①workspaceRoot===腿gitRepo ②worktreeBaseRepo===腿gitRepo ③pmoBranch===腿branch，两侧非空才比较，任一命中即归）+ `partitionSnapshotsByLeg`（归数组序首个命中腿；全部不命中=未分腿公共 WU，保守计入每条腿——证据缺口不允许从任何腿的交付闸逃逸） |
| `AnalysisHandoff` / `initAnalysisHandoff` / 实例方法 `waitForSettled`（#228 测试可观测性：等在途接力链落定，经 studio-shared createSettledTracker） | `analysis-handoff.ts` | PMO 分析接力：订阅 workunit.status_changed——analysis → in_review 按来源分流（#186 / #167 决议）：有频道 = 频道提示人工确认（ReviewDispatcher 对 analysis 不派自动评审，维持确认闸不变）；无频道 + trigger 来源（metadata.triggerId）+ 无 TASK = 免确认直转 done（留痕 metadata.autoConfirmedBy/At）；无频道其余情形 = 保留人闸，确认提示改投 Web「需要处理」收件箱（dispatchMonitorAlerts，source=analysis_confirm，修 channelId=null 早退吞提示断链）；→ done（人工确认或直转）按 metadata.analysisTasks 建未指派 task 子 WU 派工（#183 起哨兵清单化：analysisTasksSpawnedAt 时间戳 + analysisTasksSpawned 已建子 WU id 清单，updateMetadata 锁内合并写逐个子单追加；task 继承 analysis 的 workspaceRoot → 归属链接通 per-WU worktree + PMO 分支）；`listMissingSpawnScopes` / `respawnScopes` 为 #183 对账补差集原语（agents/dispatch-reconciliation.ts 消费，活体去重 + 人工关单不复活）；#177（#69 决议）人工确认处可选「默认执行角色」→ metadata.defaultTaskAssigneeId，全部派生 task 子 WU 落 assigneeId（留空=涌现，不做逐条指派、不做指名未认领自动回池） |
| `DecisionResolution` / `initDecisionResolution` | `decision-resolution.ts` | #110 T4 决策落地：订阅 workunit.status_changed——decision 单 → active（被认领）对应雾 open → in-discussion（幂等，resolved 不回摆，评审收尾补齐三态）；decision 单 → done（人工确认）把结论文本**原样**（无 LLM 摘要）追加 map.decisions[] + 对应 fog 置 resolved（按 metadata.pmoId 找 PMO、按 metadata.fogId 定位 fog 条目，缺戳/找不到不炸；decisions[] 按 wuId 去重幂等；结论文本 = attestations.l3.summary，未填落空串不拒写）；fog 全 resolved → 自动建未指派 spec 成文单（scope 带 PMO 引用 + metadata.pmoId 溯源，map.specSpawnedAt 哨兵防重、specWuId 回写）；同 PMO map 写按 projectId 串行化（照 progress-rollup） |
| `MapOpening` / `initMapOpening` / `parseMapOpening` / `MAP_OPENING_FOG_MAX` | `map-opening.ts` | #112 T6 开图机制：订阅 workunit.status_changed——analysis 单 → done（人工确认）且 l3.summary 含待决问题清单 → 初始化 map（destination + fog 逐条）→ 逐条建未指派 decision 单（metadata 落 pmoId/pmoNumber/fogId，#110 消费契约）→ 回写 fog[].wuId（互挂）。提取契约（只搬人填文本，无 LLM）：l3.summary 逐行 `DESTINATION: <目的地>`（首条生效，缺省回退项目 title）+ `FOG: <待决问题>`（每行一雾，兼容中文冒号，上限 12 条）。**清单来源（#106 M7 对齐，2026-08-12）**：agent COMPLETE 输出经同一 `parseMapOpening` 落 metadata.analysisFog/analysisDestination（见本文 `apps/api/src/modules/agents` 锚点），web 确认弹窗预填、人审改后回传 l3.summary——人 = 审清单而非手抄；幂等哨兵 metadata.mapOpenedAt（先落档再建单）；无 FOG 行不炸不落哨兵（F6-b 补确认重发 done 事件，补填仍可开图）；已有 map 不重建；同 PMO map 写按 projectId 串行化 |
| `SpecMaterialization` / `initSpecMaterialization` / `parseSpecTasks` / `SPEC_TASKS_MAX` | `spec-materialization.ts` | #115 T9 交稿物化（#106 验收标准 4）：订阅 workunit.status_changed——spec 成文单 → done（人工确认）且 l3.summary 含 TASK 物化清单 → 逐行解析批量建未指派 task 单（频道成员 loop 认领）。提取契约（只搬人填文本，风格照 map-opening）：逐行 `TASK: <标题> [\| AC: <验收>]... [\| BLOCKEDBY: <wuId,...>] [\| LEG: <gitRepo>]`，段内 KEY: value 兼容中文冒号（清单上限 12 条）；AC 多段 → metadata.ac[]（机制只存不解释）、BLOCKEDBY → metadata.blockedBy[]（#109 接单过滤消费）、LEG 命中项目交付腿 gitRepo → metadata.workspaceRoot（#113 matchWuToLeg 腿归属消费；不命中/缺省 → 不落 = 公共 WU）。幂等哨兵 metadata.specTasksSpawnedAt——spec done **恒落档**（形态照 analysis-handoff；确认通过即定稿，清单应在确认时填好），恒落档同时是 progress-rollup「派生链未落定不翻 completed」判定的输入；无 TASK 行不建单、发频道提示可手动拆任务；parentId=spec 单溯源；同 PMO 物化串行化（无 pmoId 按 WU id） |
| `projectService.publish` | `project.service.ts` | 发频道卡片 + 建 analysis WU（scope 含只读约束 + TASK 输出约定 + #106 M7 的 FOG:/DESTINATION: 待决清单输出约定；#112 T6 多腿：显式 deliveries > 1 时 scope 注入「多交付腿」段列全部仓库路径，只读约束不变、无 worktree 隔离，单腿/无 deliveries 不注入、scope 与现状逐字节一致）；metadata 落 pmoId/pmoNumber + workspaceRoot=project.gitRepo（B3a 归属链起点，2026-07-30 接通——此前 task WU 无归属根，直接在共享开发仓落地）；#177（#69 决议）入参与路由收可选 assigneeId（profile id，发布人显式指派 analysis 执行角色，留空=回池涌现，Web PublishProjectDialog 下拉候选=频道成员） |
| `getDeliveryStatus` / `deliverProject` | `delivery.ts` | PMO-b 交付守卫：台账（WU 汇总 + l1/l2/l3 证据齐缺 + deliverable，口径走 evidence-summary）与 auto-merge 交付（证据齐才本地合并 PMO 分支 → 默认分支，不 push；branch-only 只标记不碰链路）。台账新增 `tokens`（sumTokensForWorkUnits 按项目 WU id 集求和 studio-events.jsonl 的 workunit:tokens，best-effort 出错按 0）与 `gaps`（已完成但证据有缺口的 WU 明细：id/title（metadata.title 回退 scope）/type/missing 按 l1→l2→l3 有序）。#113 T7 多腿：显式多腿项目台账附 `legs[]`（逐腿独立汇总 wu/evidence/deliverable/missing/gaps/tokens + 腿状态与腿级交付落档），整体 deliverable = 全部腿 deliverable（已 delivered 腿豁免、零 WU 腿不阻断、全项目无 WU 仍不可交付），整体 missing 逐腿带 `[分支]` 前缀；auto-merge 逐腿独立合并/落档（已 delivered 腿幂等跳过、零 WU 腿 skipped-no-wu、一腿失败不阻断他腿、成功的腿照样翻 delivered），全腿交付才写项目级 deliveredAt。单腿不输出 legs 字段，行为与现状逐字节一致 |
| 默认导出 Express Router | `routes.ts` | 提供 `/project`、`/objective`、`/key-result` 等 REST 路由（含 `GET /project/:id/delivery`、`POST /project/:id/deliver`（human-only）） |

### 依赖关系

**上游（本目录依赖）**
- `@dommaker/studio-shared`（FileStore、logger、parseFrontmatter 等）
- `../../utils/logger.js`
- `../../middleware/auth.js`（requireNotGuest、requireRole）
- `../../middleware/api-cache.js`（apiCache）
- `../channels/channel-message.service.ts`
- `../workunit/workunit.service.ts`
- Node.js 内置 `os`、`path`、`fs`

**下游（依赖本目录）**
- `agents` 模块（`auditor-rules.ts`）
- `channels` 模块（`channel.routes.ts`）
- `mcp` 模块（`pmo.tools.ts`）
- 路由注册（`route-registry.ts`）

### 注意事项

- **测试稳定性候选（2026-08-04 记录，未修）**：`__tests__/analysis-handoff.test.ts` 存在一例时序 flake（全量跑偶发，重跑即过）。下批修法方向：与 knowledge-bus-sync flake 一并处理，断言改轮询等待替代固定时序假设。
- 项目数据存储在 `~/.studio/projects/{id}.json`，OKR 数据存储在 `~/.studio/okr/` 目录下的 JSONL 文件中。
- 项目路由已应用 `requireNotGuest` 和 `requireRole` 中间件进行权限控制。
- 统一编号（决策 4 修正版）：新 PMO 编号 = max(PM/PMO, REQ 两序列)+1，格式 PMO-<n>（即分支名）；`reqAlias` 与 pmoNumber 同号（REQ-XXXX 只读别名）；存量 PM-XXX/REQ-XXXX 不迁移（编号重叠；一次性映射脚本已随 2026-08 死代码清理移除）。
- 交付策略 `deliveryPolicy`：`branch-only`（默认，不碰合并/发布链路，只出台账标记）/ `auto-merge`（POST /project/:id/deliver 人工触发，缺证据 409 硬拒，主仓 checkout 非默认分支拒绝，合并冲突不自动 rebase 转人工）。
- 杂务 PMO（决策 2）：`isChore + channelId` 联合标识，`ensureChoreProject` find-or-create（POST /channels/:id/chore-pmo 登记）；热路径只查不建（findChoreProject）。
- **#114 T8 创建端点多工程入参**：`POST /project` 接受 `gitRepos: string[]`（必须字符串数组，否则 400）——每个选中工程落一条显式交付腿 `deliveries[]`（branch 按 pmoNumber 规则合成、显式 gitBranch 可覆盖全腿、status=pending；兼容字段 gitRepo 取首工程）；空白项剔除后为空 = 旧单选行为（不落 deliveries，读取时合成单腿），旧 `gitRepo` 入参行为不变。
- **发起讨论（publish）全链路（2026-07-29 接力补齐）**：pending 项目 publish → 频道发需求消息 + 建未指派 analysis WU（scope 含 TASK 输出契约 + 「只读分析」约束——2026-07-30 走查修复：分析阶段曾直接改目标仓库文件，现 prompt 层明确禁止 Edit/Write/删改命令，结论只以 markdown 回复不落盘）→ 频道成员 loop 认领分析 → COMPLETE 时 agent-loop 解析 `TASK: <任务描述>` 行落 metadata.analysisTasks（parseTaskBreakdown，≤8 条/条 ≤300 字符）→ in_review（不派自动评审，频道提示人工确认）→ 人工「通过」（reviewPassed）→ analysis-handoff 按 analysisTasks 建未指派 task 子 WU（频道成员涌现认领 = 派工）；确认时 summary 填 `FOG:`/`DESTINATION:` 逐行清单（#106 M7 对齐：agent COMPLETE 产出的清单已落 metadata.analysisFog/analysisDestination，web 确认弹窗预填、人审改后回传）→ map-opening 初始化探路地图并逐条建 decision 单（#112 开图机制，提取契约见核心导出表 map-opening 行）→ decision 单逐条确认（l3.summary = 结论）→ decision-resolution 落地 decisions[] + 雾消解，雾全清自动建 spec 成文单（#110）→ spec 确认（l3.summary 填 `TASK: ... | AC: ... | BLOCKEDBY: ... | LEG: ...` 清单）→ spec-materialization 批量物化任务单（#115，ac/blockedBy/腿归属齐全，提取契约见核心导出表 spec-materialization 行）。与交付策略 deliveryPolicy 无关（deliveryPolicy 只被 delivery.ts 交付守卫消费）。
- 所有服务都基于 FileStore（JSON 文件）而非数据库。
- 测试中使用了 mock，注意 mock 目录与测试数据的路径约定。
- **鉴权（2026-07-24 收紧）**：6 条写端点（POST /project、PUT /project/:id、PUT /project/:id/status、POST /project/:id/publish、POST /okr、PUT /okr/:id）已收 requireAuth+requireNotGuest（此前 import 的 requireNotGuest 只声明未使用）；DELETE project/okr 原有 requireRole('Admin') 不变。OKR 写的 roleId 为 body 自声明、checkPermission 据此校验，属已知局限（未修）。PUT /projects/:id/okr 无前端调用方，2026-08-04 删除。


## apps/api/src/modules/projects

### 职责

Project Discovery（AC-D1 + AC-D3）：发现已注册的工程（repo）信息并对外提供查询 API，供频道默认工程、WorkUnit 工程绑定等流程使用。

### 核心导出

- `project-discovery.service.ts` — Project Discovery Service（AC-D1+D3）
- `project.routes.ts` — Project Discovery API（AC-D3）

### 依赖关系

- 上游：workspaces 模块的工程注册数据（FileStore）
- 下游：apps/api 路由挂载；UI/频道派发流程查询工程列表

### 注意事项

- 只读发现层，不负责工程注册（注册在 workspaces 模块）
- **工程即叶子（2026-07-29）**：命中标记（CLAUDE.md / package.json / .git）的目录不再递归内部 —— monorepo 只列根目录，子包不重复出现；非工程中间目录（分组目录、无标记 packages/）仍继续下钻
- **D6 排除清单（第一层，2026-07-27）**：env `STUDIO_PROJECTS_EXCLUDE`（冒号分隔）或构造参数 `exclude` —— 规则命中目录名（精确）或绝对路径（目录边界前缀，不误伤同名前缀目录）即跳过且不递归
- **鉴权（2026-07-29 放宽）**：/api/v1/projects 挂载层为 requireAuth（登录即可；PMO 新建表单的工程下拉依赖 GET /discover）。曾收 requireAuth+requireAdmin（2026-07-24，顾虑：扫描服务器目录、回显绝对路径），但非 admin 部署下 PMO 新建不可用，故放宽。


## apps/api/src/modules/requirements

### 职责

REQ 需求编号体系（vision §5.3）：一个需求（`REQ-<序号>`）= 一组 WorkUnit。负责 REQ 的创建、绑定解析与状态汇总，需求文档/SDD/产物以编号关联，UI 按编号串联全链路。

PMO-a 别名层（2026-07-28 分析文档，决策 4）：REQ 退化为 PMO 的只读别名——get/list 先查统一编号 PMO（reqAlias 命中 → 投影为 REQ 视图，projectId = PMO 自身 id），查不到才回落 legacy REQ 记录；update/maybeRollUpToDone 对别名视图只读跳过（PMO 状态由 pmo/progress-rollup 拥有）。新代码只见 PMO；下个大版本删别名层。

### 核心导出

- `requirement.service.ts` — Requirement Service（REQ CRUD 与编号分配；B3a: projectId 挂接 PMO 项目；决策 4 别名层 get/list/update/getChain 别名感知；决策 2 createFromDispatch 杂务归集——频道已登记杂务 PMO 时小活归集其 REQ 别名，只查不建）
- `requirement.routes.ts` — Requirement API 路由
- `req-binding.ts` — REQ 绑定解析（显式 reqId > #REQ-XXXX token > #PMO-n/#PM-n token（决策 4 别名层解析，无别名存量拒绝歧义降级）> 自动新建），@mention 派发 / convert-to-task 共用
- `ownership-resolver.ts` — B3a 工程归属解析（决策 D2）：显式 workspaceId > Requirement.projectId → PMO gitRepo > 频道默认 > none
- `pmo-branch-resolver.ts` — PMO-b（决策 3）：WU → PMO 分支解析（2026-08 归因统一后两级链：①创建期直读戳 metadata.pmoId ‖ deprecated legacy ownershipProjectId（同级，pmoId 优先）②reqId→REQ→PMO；branch = gitBranch || pmoNumber，透出 deliveryPolicy），agent-loop worktree base 与 merge-on-review-pass 的目标分支来源；#113 T7 多腿：显式多腿项目（resolveDeliveries > 1）按 WU→腿归属解析腿分支——口径 = pmo/evidence-summary 的 `matchWuToLeg`（metadata.workspaceRoot/worktreeBaseRepo 命中腿 gitRepo，或 pmoBranch 命中腿 branch，两侧非空才比较，归数组序首个命中腿），未命中任何腿回落项目级 gitBranch || pmoNumber，单腿项目不走腿归属、行为不变；`resolvePmoProjectIdForWU`（2026-07 PMO-flow UX §6）：同链只出项目 id（与 resolvePmoBranchForWU 共享内部 resolveAttribution，项目存在校验逐级容错），monitoring /agents 聚合（map 版 deps 批量内存匹配）与里程碑消息 meta.pmoId（agent-loop/ReviewDispatcher/timeout-release/merge-on-review-pass）共用。原 ③ metadata.pmoProjectId 级 2026-08 移除（agent-loop 落档的冗余缓存，生产存量为零；修复 analysis 派生链仅 pmoId、reqId=null 的 task WU 解析不到 PMO 分支的 bug）
- `wu-pmo-attribution.ts` — 2026-08 归因统一：创建期 PMO 归因戳纯解析叶子（零 app 依赖，防 pmo/ → pmo-branch-resolver → project.service → workunit.service 循环）；`parseWuPmoId` = metadata.pmoId（canonical）→ metadata.ownershipProjectId（deprecated legacy 同位）容错同步解析，pmo-branch-resolver 与 pmo/evidence-summary（内存过滤）共用
- `rollup.ts` — REQ 状态汇总：订阅 `workunit.status_changed` 事件回写需求整体状态（别名视图跳过，PMO 侧 progress-rollup 拥有）

### 依赖关系

- 上游：`@dommaker/studio-shared`（eventBus、FileStore）、workunit 模块事件、pmo（projectService 项目存在性校验 / gitRepo 查询 / 别名扫描 / 杂务 find-or-create）
- 下游：channels（@mention 派发、convert-to-task）、pmo（progress-rollup 进度回写）、agents（agent-loop 经 pmo-branch-resolver 决定 worktree base）、apps/api 路由挂载、apps/web 需求页

### 注意事项

- 首次 @mention 派发时自动分配 REQ 编号（频道已登记杂务 PMO 时归集到杂务别名，不再每条消息新建 REQ）
- 状态汇总走事件驱动（`workunit.status_changed`），不做轮询
- **鉴权（2026-07-24 收紧）**：POST /、PATCH /:id 已收 requireAuth+requireNotGuest；GET 端点保持大门层鉴权不变。
- **B3a（决策 D2）**：Requirement 增 projectId 字段挂 PMO 项目（工程归属锚点）；studio-shared 的 RequirementData 暂未加该字段（本批改动限 apps/api/src），由本地 `RequirementWithProject` 扩展类型承载，FileStore 透传 JSON 运行时无差异。
- **决策 4（别名层）**：别名视图 createdBy='pmo-alias' 只读；`RequirementServiceDeps` 可注入 getProjectByAlias/findChoreProject/listAliasProjects/getProjectByPmoNumber——单测务必注入中性桩（默认实现读真实 ~/.studio/projects，并行测试会被 routes 测试的真实项目串扰）。


## apps/api/src/modules/role-memory

### 职责

角色记忆存储服务（#98，#88 spec §A）：per-role 目录落数据区（经 `studioDir()`/`studioPath()`），三件套——`MEMORY.md` 索引 + `topics/*.md` topic 正文 + `draft.jsonl` append-only 草稿区。`role-memory.ts` 只做存储层：读索引（供 #100 注入）、读/写草稿（供 #99 写、#101 读）、promote 合并（草稿 → topic/索引）、demote（reject 墓碑，#101）、容量检查；不实现注入（#100）。WU 收尾提取钩子（#99）在本目录 `completion-extraction.ts`；#101 人审卡 `memory-proposal-card.ts` + approve/reject 端点 `role-memory.routes.ts`。

### 数据布局

```
<studioDir()>/memory/<roleId>/
  MEMORY.md            # 索引：每 topic 一行 `- [slug](topics/slug.md) — 一句话摘要`（auto-generated）
  topics/<slug>.md     # topic 正文：frontmatter(title/summary/kind/updatedAt) + 正文（每条目一个 `## 标题` 段）
  draft.jsonl          # append-only 草稿：pending 行（含 review 档位）+ promote 墓碑行（promoted:true/promotedAt）+ reject 墓碑行（rejected:true/rejectedAt）
```

角色身份 = `AgentProfile.id`（agent-loop `this.role.id`）。测试环境经 `isTestEnv` 改写 `os.tmpdir()/studio-test-role-memory/<per-进程子目录>`（同 studio-log-path 约定，防测试写生产 `~/.studio/memory`；per-进程子目录防 vitest 并行测试文件整删互踩，#135）。**清理纪律演进**：#228 曾要求共享根上只按本文件 roleId 定向清理；#135 改 per-进程唯一根后互踩根因消除，定向清理约定仍保留。

### 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `RoleMemoryStore` | `role-memory.ts` | 存储服务类（`new RoleMemoryStore(limits?)`，可注入容量上限） |
| `roleMemoryStore` | `role-memory.ts` | 模块级单例（#99/#100/#101 共用同一互斥与缓存） |
| `readIndex` | `role-memory.ts` | 读 `MEMORY.md` 索引全文；不存在返回 `''`（供 #100 注入兜底） |
| `readTopic` | `role-memory.ts` | 读单个 topic 文档；不存在返回 `null` |
| `appendDraft` | `role-memory.ts` | 追加草稿（JSONL 一行）；kind 白名单外抛错；review 档位（auto/manual，缺省 manual）；可选 `sourceRefs` 原料指针（#145 蒸馏落地用） |
| `readDraft` | `role-memory.ts` | 读 pending 草稿（按 id 去重取最新行，排除已 promote / 已 rejected） |
| `getDraftStatus` | `role-memory.ts` | 按 id 查审核状态（pending/promoted/rejected/unknown，供 #101 卡片刷新后派生已审态） |
| `promote` | `role-memory.ts` | 草稿条目 → topic/索引 的唯一合并路径 + per-role 互斥；merge 幂等（topic 已含 `## 标题` 段落的条目跳过，墓碑丢失重试不产生重复段落） |
| `demote` | `role-memory.ts` | 拒绝草稿（#101 reject 闸口）：追加 rejected 墓碑行，readDraft 排除，不写 topic/索引 |
| `resolveTopicSlug` | `role-memory.ts` | 目标 topic slug（显式 topicSlug 优先，缺省由 title 推导；promote 与 #101 卡片共用口径） |
| `checkCapacity` | `role-memory.ts` | 容量检查：topic 数 / pending 草稿数超限 → 结构化提醒 |
| `roleMemoryDir` | `role-memory.ts` | per-role 目录路径（纯函数，含 `env` 注入测试） |
| `sanitizeRoleId` / `sanitizeTopicSlug` | `role-memory.ts` | 路径穿越防护（拒 `..` / 分隔符 / 空） |
| `MemoryKind` / `MemoryReview` / `MemoryDraftEntry` / `TopicDoc` / `CapacityCheck` / `PromoteResult` / `DemoteResult` 等 | `role-memory.ts` | 类型定义 |
| `postMemoryProposalCard` | `memory-proposal-card.ts` | #101 发 memory_proposal 卡到 #系统 频道（cardData.entries 指「文件 + 段落」） |
| `role-memory.routes` | `role-memory.routes.ts` | approve/reject 端点：POST `/promote` / `/demote`（`{roleId, entryIds[]}`）；GET `/draft-status?roleId&ids=a,b,c`（只读，卡片刷新派生已审态） |
| `WuCompletionExtractor` | `completion-extraction.ts` | #99 WU 收尾批量提取钩子：订阅 `workunit.status_changed` → done，读 transcript → LLM → `appendDraft`；可熔断/可审计，fire-and-forget |
| `initWuCompletionExtraction` | `completion-extraction.ts` | 单例工厂（懒初始化 + 订阅，index.ts 启动调用，形态同 `initAnalysisHandoff`） |
| `MEMORY_EXTRACTION_SYSTEM_PROMPT` | `completion-extraction.ts` | 角色记忆提取 prompt（产出 execution-knowledge/preference，适配 appendDraft） |
| `buildTranscriptText` / `normalizeDraftInput` | `completion-extraction.ts` | 纯函数：transcript 拼接截断 / LLM 条目 → appendDraft 入参 |

### 设计决策

- **内容纪律（spec §A）**：记忆只收两类——`execution-knowledge`（有效做法/踩坑/失败教训）与 `preference`（偏好/约定）；`appendDraft` 按 kind 白名单拒绝其它形态。决策不进角色记忆（留项目级决策日志，索引存指针）；persona/职责属静态 preset 不算记忆。
- **并发安全**：草稿 append-only（`FileStore.appendJsonl` 的 `O_APPEND`，多 WU 并行写不冲突）；promote 合并走**单一代码路径**（唯一写 topic + 索引的方法）且 per-role **进程内互斥**（`Map<roleId, Promise>` 链式锁，单进程模型，不引入 Redis）。
- **墓碑语义**：草稿 append-only，promote 追加 `{...entry, promoted:true}` 墓碑行、demote 追加 `{...entry, rejected:true, rejectedAt}` 墓碑行而非改写原行；读 pending 须按 id 去重取最新行，再排除 promoted + rejected（否则原 pending 行仍会被当作未 promote / 未 reject）。
- **两档人审路由（#101）**：草稿条目带 `review` 档位（`auto`=操作型事实，高置信零争议；`manual`=规律/教训/偏好）。提取收尾按档位分流：auto → 直接 `promote` 进索引（不产卡）；manual → `postMemoryProposalCard` 发 `memory_proposal` 卡，人在频道 approve→`promote` / reject→`demote`。promote 保持唯一合并路径（单代码路径），demote 与 promote 共用同一 per-role 互斥锁。
- **容量上限 + GC（最简）**：超限只提醒（`checkCapacity` 返回结构化 signal），**不落新人罪**（不拒绝写入）、**不自动删**。GC = 超限提醒人合并 topic / 淘汰草稿。
- **KnowledgeSync 零值 trend 止血**：已落地（#137，2026-08-16）。`knowledge-sync.service.ts` 的 cycle 事件仅在有 stale/unmonitored 时落库（severity=warning），全零 cycle 只写日志；存量零值条目（dedup 合并为 PRO-002）已一次性删除。历史背景：#88 时期曾 defer（grep「零值」无锚点），#137 复核定位到 cycle 事件无条件落库。
- **路径**：生产经 `studioPath()`（读 `STUDIO_HOME`，dev/prod 隔离）；禁硬编码 `~/.studio`。测试隔离走 `isTestEnv` 改写 tmpdir，不全局设 `STUDIO_HOME`（会破坏既有测试）。

### 依赖关系

**上游**:
- `@dommaker/studio-shared`（`FileStore` 的 `appendJsonl`/`readJsonl`、`parseFrontmatter`/`serializeFrontmatter`）
- `@dommaker/studio-shared/studio-dir`（`studioPath` 数据根解析）
- `apps/api/src/utils/studio-log-path.ts`（`isTestEnv` 测试隔离判定）

**下游**:
- #99 WU 收尾批量提取（`appendDraft` 写入方，已落地：本目录 `completion-extraction.ts`）
- #100 角色记忆索引常驻注入（`readIndex` 读取方）
- #101 记忆人审卡片（已实现：`memory-proposal-card.ts` 发卡 + `role-memory.routes.ts` approve→promote / reject→demote；manual 档走卡、auto 档直 promote）
- #145 蒸馏产物三分落地（preference/execution-knowledge 产物 → studio 系统角色草稿，经 `modules/distill/distill-landings.ts` 调 `appendDraft` 带 `sourceRefs` 原料指针 + `postMemoryProposalCard` source='distill'）

### 注意事项

- `readIndex`/`readDraft`/`readTopic` 对不存在文件返回 `''`/`[]`/`null`（不抛），供注入与召回兜底。
- `memory-proposal-card.ts` 用模块级 `new FileStore()`（非注入，指向默认 studioDir）——测试须 mock 整个发卡模块（completion-extraction / distill-landings 测试同做法）。
- `appendDraft` 写盘失败会抛出——调用方按 fire-and-forget 兜底（同 transcript-archive 约定）。
- promote 结果 `topicsUpdated` 已按 slug 排序（结果确定）。
- 测试经 `new RoleMemoryStore({ maxTopics, maxPendingDrafts })` 注入小上限验证容量提醒；`FileStore` 读穿缓存按绝对路径 + mtime 失效，append 后立即读一致。


## apps/api/src/modules/skills

### 职责

skills 模块负责技能（Skill）的完整生命周期管理，包括基于文件的技能元数据存储（SkillStore）、提案存储（ProposalStore）、技能目录扫描与加载（manifest-loader）、基于描述的技能匹配（skill-selector）、从 WorkUnit 执行中提取可复用模式（skill-extraction.service）以及对应的 REST API 路由（routes.ts、skill-proposal-routes.ts）。所有数据存储已从 Prisma 迁移至文件系统。

### 词汇表

- **Skill 加载（loaded）**：agent 经 MCP 工具 `loadSkill` 显式拉取 SKILL.md 正文。`knowledge:skill_used` 事件的唯一语义（#60 决策，2026-08-09；#172 落地）：发射点 = `skill-loader.ts` 的 `loadSkill`，payload 携带 `workUnitId`（调用方已知时），envelope level=debug。
- **Skill 曝光（exposed）**：已废除的概念。旧口径把「skill 索引条目进入 prompt」记为 skill_used，实测为常量集合（14/20 skill，零信息量），发射已删除（#60 决策，#172 落地，prompt-composer.ts）。基于曝光口径的降级提案统计无效，修复归知识飞轮 handoff。

### 核心导出

| 导出 | 文件 | 说明 |
|------|------|------|
| loadManifest, SkillEntry | manifest-loader.ts | 扫描技能目录，读取 SKILL.md frontmatter（name/description/agentTypes/status/triggers/consumers）构建技能条目；status 显式非 published 跳过 |
| generateManifest | manifest-generator.ts | 从 frontmatter 重新生成 SKILLS_DIR/MANIFEST.md（GENERATED 文件，best-effort 不 throw）；skill-store 写 SKILL.md 后自动调用 |
| ProposalStore 类, ProposalRecord, ProposalCreateInput, ProposalUpdateInput, ProposalListFilter | proposal-store.ts | 文件型 CRUD 操作技能提案 |
| router | routes.ts | 技能 CRUD + discover 路由，挂载至 /api/v1/skills |
| SkillExtractionService 类, ExtractedSkillProposal | skill-extraction.service.ts | 从 WorkUnit 中提取可复用模式并生成提案 |
| router | skill-proposal-routes.ts | 提案列表、扫描、提取、审批等路由，挂载至 /api/v1/skills/proposals |
| selectSkills | skill-selector.ts | 三层策略技能匹配：声明 triggers 时匹配 triggers（替代长 description），否则匹配 description（排除 NOT-for）；consumers 含 loop 的 skill 不参与 |
| selectSkillsWithDomain, parseSkillHintsFromScope | skill-selector.ts | 决策 7/8/11：相关度排序器（显式 +hints > 域匹配（阶段词表归一化）> scope 匹配 > 其余按热度/名称序），全量不封顶（调用方按预算截断）；+skill 从 scope 解析 |
| selectSkillsForInjection | skill-selector.ts | #92（#88）：skills 索引硬预裁剪 —— 只返回 hint（+skill 点名）+ 域匹配两类（按 name 去重、hint 置顶）；scope 文本匹配与 rest 热度不进注入段（段尾 MANIFEST 指针按需兜底）。复用 selectSkillsWithDomain 的 active/hint/域匹配口径（normalizeToStage 归一化） |
| SkillRecord, SkillCreateInput, SkillUpdateInput | skill-store.ts | 技能元数据的类型定义及文件型 CRUD |
| LoadedSkill, SessionSkillState, LoadSkillOptions | skill-loader.ts | 技能加载相关的类型定义 |
| aggregateSkillUsage, scanSkillDemotions, approveDemotion, rejectDemotion, DemotionProposalStore | skill-demotion.ts | §10.6 降级通路：skill_used 事件 + WU 终态聚合 → 降级提案（只提案不自动生效；approve 改 frontmatter status，正文逐字节保留）；提案存 ~/.studio/data/skills/demotion-proposals.json |
| router | skill-demotion-routes.ts | 降级提案列表（?scan=true 触发扫描）/ 审批路由，挂载至 /api/v1/skills/demotion-proposals（先于 /api/v1/skills 注册） |

### 依赖关系

**上游（本目录依赖）**
- `@dommaker/studio-shared`（多个文件：logger、FileStore、modelGateway、recordDecision）
- `@dommaker/studio-skill`（skill-loader.ts 中的 SkillTier 类型）
- `express`（routes.ts、skill-proposal-routes.ts 中的 Router）
- Node.js 内置模块：fs、path、os、crypto
- `../channels/channel-message.service.js`（skill-proposal-routes.ts 使用）
- `./skill-store.js`、`./proposal-store.js`（内部跨文件引用）

**下游（谁依赖本目录）**
- `apps/api/src/modules/agents`（auditor-execution.ts、auditor-rules.ts）
- `apps/api/src/modules/events`（session-summary-generator.ts）
- `apps/api/src/modules/knowledge`（pattern-miner.ts）
- `apps/api/src/modules/mcp`（skill.tools.ts）
- `apps/api/src/modules/workunit`（workunit.service.ts）
- `apps/api/src/route-registry.ts`

### 注意事项

- 所有数据存储已从 Prisma 迁移至文件系统（D-005），无数据库依赖
- SKILL.md 文件采用 frontmatter 格式，存放于 `~/.studio/skills/` 目录；技能索引存于 `~/.studio/skills-index.json`，提案存于 `~/.studio/proposals.json`
- `loadManifest()` 使用内存缓存，变更需重启进程或重新调用清除缓存
- 两个路由文件均导出 `Router` 实例，需分别挂载到 Express 应用的不同路径（/api/v1/skills 与 /api/v1/skills/proposals）
- skill-selector 匹配时会排除 `NOT-for` 子句，避免排除项关键词触发误匹配
- 技能加载器按 SKILL.md frontmatter 的 `tier` 字段记录技能层级（fast/standard/premium）
- 所有日志使用 `@dommaker/studio-shared` 的 logger 实例，统一日志格式
- SkillStore/ProposalStore 是模块级单例 + 固定 `~/.studio` 存储路径（无构造注入）——测试须 mock fs 或整个模块（distill-landings / skill-extraction-events 测试同做法）；蒸馏 skill 落地经 `modules/distill/distill-landings.ts` 调这两个单例（#145）。另知：skill-extraction 发 skill_review_request 卡直传字面 `system` 作 channelId，与查 #系统 频道取真 id 的口径不一致（未修）。
- **鉴权（2026-07-24 收紧）**：skills 7 条写（POST /、PATCH、DELETE、publish、deprecate、restore、usage）+ demotion-proposals approve/reject + proposals 5 条写已收 requireAuth+requireNotGuest。GET /api/v1/skills/proposals 被 skills 的 GET /:id 遮蔽，属路由顺序 bug（未修）。


## apps/api/src/modules/specs

### 职责

提供 Specs 模块的 HTTP API 路由，包括变更分析、变更历史查询和门禁验证（待实现）。遵循 SP-002 变更分级流程，通过调用外部 SDK 中的服务处理 Spec 变更相关的业务逻辑。

### 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `router` (默认导出) | `routes.ts` | Express 路由实例，包含 `/api/v1/specs` 路径下的变更分析和历史查询端点 |

### 依赖关系

- **上游依赖**：`@dommaker/studio-spec`（ChangeAnalyzerService、ChangeHistoryService、GateCheckerService）、`@dommaker/studio-shared`（logger）、`../../utils/pagination.js`（parsePagination、sendPaginated）
- **下游使用者**：`apps/api/src/route-registry.ts`（注册该路由模块）

### 注意事项

- 变更提交 API 已删除（对应 SpecChangeRequest 表已移除），但 `/changes/:changeId` 查询端点保留。
- 门禁验证 API（`GateCheckerService`）尚未实现，当前路由文件中仅有空注释块。
- 所有端点需统一处理错误并记录日志。
- 依赖的外部 SDK 服务需在运行时可用，否则路由会抛出 500 错误。
- **鉴权（2026-07-24 收紧）**：POST /changes/:changeId/validate（可触发 harness 检查点执行）、POST /:id/changes/import 已收 requireAuth+requireNotGuest。


## apps/api/src/modules/transcripts

### 职责

transcript 归档器（#97，#88 子票）：把会话原文落盘到数据区（经 `studioDir()`/`studioPath()`），供三个消费方共用——#99 WU 收尾批量提取（要全文）、handoff 摘要（要对话）、#85 执行质量评估（要执行痕迹）。本模块只建归档器 + 读取接口，不实现消费方提取逻辑。

另提供 HTTP 只读查看路由（#174，#60 C5）：`GET /api/v1/transcripts/:workUnitId`（认证，query `offset`/`limit` 分页，上限 50），经 `readTranscript` 读全文后 slice，文件不存在返回 200 空列表；workUnitId 拒绝含 `/`、`..` 的 id（防路径穿越）。注册见 `route-registry.ts`；前端查看器 `apps/web/src/components/workunit/TranscriptViewer.tsx`。

session:start/end 事件链路（#174）：agent-loop 把 `transcriptPath(wu.id)` 注入 task parameters，runner 发 session:start/end 时 payload 并入 `workUnitId` + `transcriptPath`（`packages/studio-agent` output-capture 的 extras 第 4 参）。

### 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `transcriptPath` | `transcript-archive.ts` | 归档文件路径：生产 `studioPath('transcripts', '<workUnitId>.jsonl')`，测试改写隔离目录（纯函数，按 workUnitId 确定性推导） |
| `transcriptsDir` | `transcript-archive.ts` | 归档根目录：测试 → `os.tmpdir()/studio-test-transcripts/<per-进程子目录>`（#135）；生产 → `studioPath('transcripts')` |
| `isTestEnv` | `transcript-archive.ts` | 测试环境判定（`VITEST`/`NODE_ENV=test`），同 studio-log-path |
| `appendTranscriptStep` | `transcript-archive.ts` | 追加一步原文（JSONL 一行）；调用方 fire-and-forget 兜底 |
| `readTranscript` | `transcript-archive.ts` | 按 workUnitId 读取全文 transcript；文件不存在返回 `[]` |
| `TranscriptEntry` | `transcript-archive.ts` | 单步条目类型（workUnitId/sessionId/step/action/rawOutput/createdAt） |
| `AppendTranscriptStepArgs` | `transcript-archive.ts` | 追加入参类型 |
| `TRANSCRIPTS_DIR` | `transcript-archive.ts` | 归档根目录名 `'transcripts'` |
| default（router） | `transcript.routes.ts` | #174: `GET /:workUnitId` 只读分页查看（认证） |

### 设计决策

- **数据源**：agent-loop 每步 `result.rawOutput`（raw CLI stdout，provider 无关）。单一来源同时满足三方：全文 + 执行痕迹，非摘要级截断，不依赖 provider 的 CLI session jsonl 路径（claude `~/.claude/projects/...` 等）。
- **归档时机**：每步成功执行后追加一行（会话结束即完整，天然可检索）。
- **格式**：JSONL，一行一步（append-friendly；损坏行由 FileStore 读时跳过）。
- **路径**：生产经 `studioPath()`（读 `STUDIO_HOME`，dev/prod 隔离）；测试经 `isTestEnv` 改写 `os.tmpdir()/studio-test-transcripts/<per-进程子目录>`（同 studio-log-path 约定，防测试写生产 `~/.studio/transcripts`，per-进程子目录见 #135）；禁硬编码 `~/.studio`。
- **会话定位**：每行携带 `sessionId`（`metadata.sessionId` 已维护 WU→session 映射；WU 内可能因重建/续用切换）。
- **保留策略**：不主动 GC（最简；后续由 ops 按需清理）。
- **不落 metadata、不建独立索引**：路径由 workUnitId 确定性推导，无需在 `WorkUnitMetadata` 冗余存 archive 路径。

### 依赖关系

**上游**:
- `@dommaker/studio-shared`（`FileStore` 读写原语）
- `@dommaker/studio-shared/studio-dir`（`studioPath` 数据根解析）
- `apps/api/src/modules/agents/loop/agent-loop.ts`（写入方：每步成功执行后 `appendTranscriptStep`）

**下游**:
- #99 WU 收尾批量提取（`readTranscript` 读取方，已落地：role-memory/completion-extraction.ts）、handoff 摘要、#85 执行质量评估（后续实现）

### 注意事项

- `appendTranscriptStep` 写盘失败会抛出——agent-loop 用 `void ... .catch(() => {})` fire-and-forget，绝不阻断任务流程。
- `readTranscript` 经 `FileStore.readJsonl`（mtime 读穿缓存），写入后立即读一致。
- 测试隔离走 `isTestEnv` 改写（`os.tmpdir()/studio-test-transcripts/<per-进程子目录>`，文件名不变，#135），与 `studio-log-path` 同约定；生产路径的 `STUDIO_HOME` 解析由 `studio-dir` 单测覆盖。


## apps/api/src/modules/triage

### 职责

实现错误的分类（triage）与严重度评估，提供策略路由（auto_retry / manual_fix / escalate / ignore），支持开发者错误和系统级事件的分类。

### 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `ErrorClass` | error-class.ts | 八类错误标签（syntax_error 等） |
| `Severity` | error-class.ts | 严重度等级（low / medium / high） |
| `TriageResult` | error-class.ts | 错误分类结果（含 class、severity、summary、strategy） |
| `classifyError` | error-class.ts | 根据错误消息返回匹配的 TriageResult |
| `TriageErrorClass` | error-class.ts | 系统级错误分类（timeout / test_failure 等） |
| `SystemTriageResult` | error-class.ts | 系统级分类结果（含 errorClass、severity、recommendedAction） |

### 依赖关系

**上游依赖**：无（不依赖其他目录模块）
**下游依赖**：
- apps/api/src/modules/agents/triage/triage.service.ts（agents 模块）
- apps/api/tests/b2-unit.test.ts（测试模块）

### 注意事项

- 错误模式匹配按数组顺序，先匹配优先，未匹配则归为 `unknown_error`
- `classifyError` 截取错误消息前 100 字符作为 summary
- `SystemTriageResult` 为另一套独立分类，与 `classifyError` 无直接关联
- 策略映射 `STRATEGY_MAP` 和模式数组 `ERROR_PATTERNS` 未对外导出


## apps/api/src/modules/triggers

### 职责

Trigger 子系统（AS-026，3.28c-4）：SCHEDULE（cron）+ EVENT（EventBus）两类条件的触发器调度与持久化，动作包括 CREATE WorkUnit / UPDATE / EXECUTE。系统默认 trigger 定义在 agents/default-triggers.ts（配置真相源 = 代码注册块，`getDefaultTriggerConfigs()` 已随 #102 删除，测试从 `TriggerScheduler.getStates()` 取数）。

### 核心导出

- `trigger.types.ts` — Trigger 类型定义（SCHEDULE + EVENT 判别联合）
- `cron-matcher.ts` — 最小 cron 表达式求值器
- `trigger-store.ts` — YAML 持久化
- `trigger-scheduler.ts` — SCHEDULE tick + EVENT EventBus 订阅
- `trigger-registry.ts` — 单例 TriggerScheduler（注入 eventBus）
- `trigger-action.ts` — CREATE 动作执行（从 trigger payload 创建 WorkUnit；#162 T8-E1：建单显式 `status='pending'` 人闸，按来源不按类型，人工确认 pending→unassigned 后才可认领）
- `trigger.routes.ts` — Trigger 管理 REST API

### 依赖关系

- 上游：`@dommaker/studio-shared`（eventBus、FileStore）、workunit 模块
- 下游：agents 模块（default-triggers 注册）、apps/api 路由挂载

### 注意事项

- EVENT 类型由 PMO-Channel-Agent-Flow SDD AC-1 重新引入；旧 subscribeEvent API 已删除
- 默认 trigger 清单变更需同步 agents/__tests__/default-triggers.test.ts 与 triggers/__tests__/trigger-cleanup.test.ts（两者均从 `TriggerScheduler.getStates()` 注册块取数，不再读 `getDefaultTriggerConfigs()`）
- **#102 触发器五删（2026-08-14）**：`knowledge-quality-audit`（闸口移写时两档人审）、`session-knowledge-extraction`（收尾钩子替代）、`zero-consumption-audit`（读率降格为 GC 打分输入）、`knowledge-synthesis`（蒸馏职能移交 #83）四者从代码注册块删除；`daily-health-check` LLM 形态数据区 yaml 删除，监控面归 agents/monitor/monitor-system-probes.ts 确定性探针。保留 6 个：workunit-timeout / agent-timeout / okr-metric-sync / workunit-input-reminder / evolution-daily-scan / doc-semantic-review（enabled:false，恢复归 #103）
- **鉴权（2026-07-24 收紧）**：`/api/v1/triggers` 挂载级 `requireAuth()+requireAdmin()` —— POST/DELETE 会热加载触发器直接驱动 AgentLoop 执行。另：`GET /status` 注册在 `GET /:id` 之后被遮蔽（历史 bug，未修）。
- **#163（T8-E2，2026-08-15）inspection-scan 巡检触发器**：`inspection-scan.ts` 事件闸挂 `trigger-scheduler.handleEvent` 分叉——判定链 = 嵌套 payload 自判（`payload.workunit.type==='bug' && status==='closed'`；**matchFilter 是顶层浅匹配，吃不了 `{workunit:{...}}` 嵌套形态，EVENT filter 对 WU 事件永不命中**）→ bug 关闭计数达 N（`INSPECTION_SCAN_THRESHOLD` 默认 3，<=0 关事件触发；计数 = 最近巡检单创建后关闭的 bug 数，从 FileStore 现算无独立计数器，建单即归零）→ 冷却（最近 `metadata.inspection===true` 单的 opportunities 有待处理条目 → 跳过落 `trigger:inspection_scan_skipped` 事件留痕含待处理条数，频道不打扰；无历史单放行）。**手动 fire 直调 executeCreateAction 不过闸**（T9 决策：人点按钮是显式意图）。`inspection-scan-schedule` = SCHEDULE 留位默认关闭（`INSPECTION_SCAN_SCHEDULE_ENABLED=true` 启用，tick 路径同过冷却闸 `checkInspectionCooldown`）。闸模块经 `trigger-action.getTriggerActionFileStore()` 共享 store（`setTriggerActionFileStore` 一处注入全覆盖）。本工程 tsconfig 非 strict：**union 判别窄化必须用显式判等（`verdict.fire === true`），真值窄化不能消除分支**


## apps/api/src/modules/library

### 职责

阅览室（#155 T5）：跨项目 `.studio/` 文档面的聚合只读层。缺省遍历全部有 `gitRepo` 的 PMO 项目，读各仓 `.studio/` 下的 `specs/`、`research/`、`adr/`、`CONTEXT.md`（`?project=` 收窄单项目）；`legacy-sdd/<slug>/` 三层遗产 SDD 文档打 `legacy: true` 标记只读展示。无写路径——文档随各仓演进，变更历史 = git 历史。

### 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `libraryRoutes` | `library.routes.ts` | Express 路由，注册 `/api/v1/library` 下的 GET 列表（query: project/search）、GET /:id 详情端点（只读，无 PUT/POST/DELETE） |
| `listLibraryDocs` | `library.service.ts` | 跨仓聚合文档列表（`{ projectId?, search? }`），返回 `LibraryListItem[]`（id = `projectId:relPath`，projectId 为 PMO 项目真值） |
| `getLibraryDoc` | `library.service.ts` | 按 `projectId:relPath` 取详情；防路径穿越（resolve 后必须落在该仓 `.studio/` 根内）；legacy 文档带 requirement/design/task 三段 |

### 依赖关系

上游：
- `@dommaker/studio-shared`（`logger`、`parseFrontmatter`、`listLegacySddDocs`、`readLegacySddDoc`）
- `@dommaker/studio-shared/studio-dir`（`legacySddDir`）
- `apps/api/src/modules/pmo/project.service.ts`（PMO 项目清单，只取 `gitRepo` 非空）
- `express`（Router）

下游：
- `apps/api/src/route-registry.ts`（引入 `libraryRoutes` 并挂载至 `/api/v1/library` 路径）

### 注意事项

- 只读层：无任何写端点；文档变更走各仓 git，不走 API
- title 兜底链：frontmatter title → 首个 H1 → 文件名；updatedAt 兜底链：frontmatter updatedAt → 文件 mtime
- 单仓读失败（目录不存在/权限）不炸整体，跳过并 `logger.warn`
- 前端 id 整段 `encodeURIComponent` 传入（含 `:` 与 `/`），路由侧 decode 后按首个冒号切分 projectId/relPath


## apps/api/src/modules/workspaces

> AS-020 P2/P4/P5/P6: Workspace 管理 + Daemon 通信 + 任务分发

### 职责

远程 Workspace 注册/心跳、Token 管理、WS 网关（Daemon 通信）。

### 核心导出

| 文件 | 职责 |
|------|------|
| workspace.routes.ts | Workspace CRUD + 注册/心跳 API |
| token.routes.ts | Token 生成/列表/撤销 API |
| local-workspace.ts | VPS 本地 Workspace 自动注册 + 本地 CLI 运行时扫描（`rescanLocalRuntimes` 供按需重扫） |

### 依赖关系

- 被依赖：`agents/`（任务分发）、`channels/`（Channel Workspace 设置）、`web/`（UI 组件）

> ws-gateway.ts（/ws/daemon 远程执行 WS 网关）已随远程节点方向放弃于 2026-08 删除：
> 生产 594 个 profile 无 nodeId、UI 创建角色不下发 nodeId、WS 客户端从未实现。

### 注意事项

- Token hash 用 SHA-256，原始 token 只在生成时返回一次
- WS 网关同端口 nginx upgrade（`location /ws/`）
- Local workspace token=NULL，Server 启动时自动创建
- **'VPS' 命名约定的唯一属主在 studio-shared（2026-08 seam 修复）**：判定"哪条记录是本机 VPS workspace"（name='VPS' 且无 tokenId）由 `@dommaker/studio-shared/node` 的 `resolveVpsWorkspace()` 统一定义；本模块的 `local-workspace.findLocalWorkspace` 与 studio-agent worktree-resolver 的执行隔离回退都委托给它，不再各自手扫 JSON。改写存储格式/重命名 VPS workspace 时需同步该函数。
- 本地 CLI 扫描链（2026-07 修复后）：`local-workspace.scanLocalRuntimes()` 复用 `daemon/cli-scanner.scanAllProviders()`（provider 注册表驱动：内置 claude/kimi/codex/opencode，用户可经 `~/.studio/providers.json` 扩展），结果**全量替换 local workspace 记录的 `runtimes` 数组**（与 daemon 注册同构）；每次启动重扫 + `GET /workspaces/runtimes` 聚合前 best-effort 重扫。扫描在 Server 所在机器执行：线上扫服务器，本地起服务扫本地。
- **鉴权级别（2026-07 安全修复）**：本模块所有面向 UI 的端点（workspace CRUD/runtimes、token.routes）= `requireAuth() + requireAdmin()` —— 生产环境必须 Admin 角色。⚠️ 前提修正（2026-07-24 实测）：guest session `userId=null` 查不到用户记录，guest token **实际过不了 `requireAuth()`/Lurk Wall 大门**（等同匿名）；requireAdmin 的真实防线意义在于防御未来 User 角色账号与大门逻辑回归（workspace 记录含 workspaceRoot/runtimes.path/仓库路径等服务器信息，token 管理泄露=节点被冒名）。daemon 专用端点（register/heartbeat）保持 `workspaceAuth()` token 鉴权不变。
- 历史坑（已修）：扫描结果曾写到 `~/.studio/workspace-runtimes/*.json` 且全仓库无读取方（断链），且硬编码列表漏扫 kimi、只在首次创建时扫一次 —— 2026-07 全部修正，旧目录写入已删除。


## apps/api/src/modules/workunit

### 职责

WorkUnit 核心域（AS-025 §3.28c-1, §5.16）：任务单元的 CRUD、认领（Claim）与状态机；F5 双向沟通的 NEED_INPUT 挂起/恢复与超时提醒。

### 核心导出

- `workunit.service.ts` — WorkUnit Service：CRUD + Claim + 状态机，`create()` 发布 `workunit.created` 事件；claim 进入 active 时写固定 5min 租约 `timeoutAt`（#178 租约化：废除按 type 30/60min 默认与 metadata.timeoutAt 显式值，持有方 loop 30s 心跳推前）。工单 30 起头部类型/常量/转换层抽出（re-export 保持导出路径兼容，消费方 import 不变）；2026-08-04 拆分起继承 workunit-crud.ts 的 `WorkUnitCrudService`，门面保留 metadata 契约 + 查询 + 状态机迁移 + 评审验收收口（reviewPassed/reviewRejected/attestation 幂等补写/recordL1Verification/markMergeConflict/blockForManualRelease）；**#228 测试可观测性导出 `waitForReviewPassSettled()`**（纯增量：reviewPassed 的自动合并/原型清理收尾是 fire-and-forget，登记在途 promise 供测试确定性等待，替代 waitFor 盲等——merge-on-review-pass 全量负载偶发红的修法，同 #158 progress-rollup 先例）
- `workunit.types.ts` — WU 类型契约 + 状态机表/租约常量（工单 30 抽自 workunit.service 头部，零服务依赖）：`WorkUnitMetadata` / 输入输出 DTO / `VALID_TRANSITIONS` / `TYPE_VALID_TRANSITIONS` + `resolveValidTransitions`（#108 按 type 覆盖）/ `DECISION_SPEC_TYPES` / `WU_LEASE_TTL_MS`（#178，5min 租约 TTL 唯一权威）/ `ANALYSIS_TASKS_MAX` / `INSPECTION_OPPORTUNITIES_MAX`（#163）
- `workunit.mappers.ts` — 快照 ↔ DTO 转换层（工单 30 抽出）：`snapshotToData` / `inputToSnapshot` / `patchSnapshot`
- `workunit-crud.ts` — `WorkUnitCrudService`（WorkUnitService 的基类，2026-08-04 自 workunit.service.ts 拆分的纯代码移动）：CRUD（create/update/delete/createFromMessage + 频道默认管线首跳展开）+ Claim（claim/unclaim，flock 悲观互斥锁）+ 快照转换函数；另含 `workunit.status_changed` 发布（publishStatusChanged）与父状态聚合（aggregateParentStatus）
- `workunit.routes.ts` — WorkUnit API 路由
- `waiting-input.ts` — F5 双向沟通 + #176 回复即复活：blocked WorkUnit 的恢复、「关闭」指令与超时提醒。**#176（决策 #57 D2/D3）起复活扩到全 blocked 类型**（不再限 waitingForInput）：线程内任何人类回复 → active + pendingReplies 注入，复活重置 consecutiveStuck/blockReason、resumeCount 累加（D5 不限次观测钩子）、timeoutReleaseCount 终身保留；回复「关闭」= 显式关闭指令（经 wu-closure 双出声，decision/spec 无 closed → 拒绝并频道说明）；提醒扫描 scanWaitingForInputReminders 扩面到全部 blocked（计时基准 blockedAt 回退 waitingSince/updatedAt，一次性 waitingReminded 标记，消息带 blocked-cta 统一 CTA）。**#185（决策 #87 D2）Web 按钮通道**：`resumeBlockedWorkUnitFromWeb`（纯授权 = 固定占位文案 WEB_RESUME_PLACEHOLDER 走同一复活原语 + Studio 里程碑消息补 #62 双出声；归属等待型按回复语义不被纯授权复活 → false）/ `closeBlockedWorkUnitFromWeb`（同一死信关闭路径，三态 WebCloseOutcome 供路由映射 200/409；closeOnHumanCommand 返回值同步三态化，回复「关闭」语义不变）。B3a：waitingReason='ownership' 的挂起按回复解析工程归属（project-discovery 唯一命中 → 绑定 metadata.workspaceRoot + 写回 Requirement.projectId + 置回 unassigned（保留 assigneeId=profile id，待指名 loop 认领；此类 WU 从未被认领，置 active 会对所有 loop 不可见而卡死）；多候选/无命中 → 继续等待列候选）；#162（T8-E1）：waitingReason='wu-token-budget' 的挂起（WU 级 tokenBudget 到线）按人三选分流（追加预算 → active / 收尾 → in_review / 放弃 → closed，未识别重述三选继续等待，频道文案不出现机制黑话）；频道系统消息经 `wu-messenger` 发送
- `blocked-cta.ts` — #176（决策 #57 D3-1）blocked 消息统一 CTA 模板（零依赖叶子）：`withBlockedCta`（blocked 里程碑/30min 提醒共用：headline + 失败原因摘要 + 「回复继续 / 回复『关闭』/ 24h 死信预告」行动召唤块）、`buildDeadLetterNotice`（24h 死信：已关闭 + 原因摘要 + 「如需继续请重新派发」）
- `wu-closure.ts` — #176（决策 #57 D4 + #62 §3 双出声）系统推 WU 向终态（closed）的统一出口 `closeWorkUnitWithNotice`：closed 快照（#170 锁内成对）+ `workunit:closed` 结构化事件（level=warning，payload 带 reason/closedBy/blockedAt；schema 归 #60，本票只定「要有」）+ 频道说明；closedBy ∈ auto-abandon-stale-blocked / total-time-kill / human-command；三步各自 best-effort（出声失败不阻断关闭）
- `wu-messenger.ts` — WU 频道系统消息统一出口 `postWuSystemMessage(wu, content, opts)`（2026-08 收敛此前 5 处重复实现：agent-loop/review-dispatcher/merge-on-review-pass/waiting-input/timeout-release——其中 4 处裸写 FileStore 不发事件）：统一走 `ChannelMessageService.createAgentMessage`（**append + eventBus `channel.message_sent` + SSE**，频道页实时可见、NotificationBell 可响）；默认 agentName='Studio'、挂 WU 线程 anchor（首条根消息，显式 `replyToId` 时跳过查找）；`milestone: true` → best-effort 解析 pmoId + `atHuman: true`（`opts.meta` 合并覆盖）；空 content / 无 channelId 返回 null 不发帖。pmo-branch-resolver 走 lazy import（本模块经 merge-on-review-pass 被 workunit.service 静态依赖，静态引入会经 project.service 成循环）
- `timeout-release.ts` — workunit-timeout-scan handler：执行超时 WU 释放回 unassigned（记 metadata.timeoutReleasedAt/timeoutReleaseCount + 频道系统消息），≥3 次转 blocked（**2026-07-31 起该转人工消息 meta 带 `{pmoId?, atHuman:true}`**，PMO-flow UX §6-3；经 wu-messenger 里程碑通道）；**#108 起 decision 单不进扫描**（决策可能等关键人多天；#63 租约落地后扫描逻辑不变，本跳过保持有效）；**#178（#63 决议 3，2026-08-16）释放即杀**：释放/转 blocked 后顺 assigneeId → 实例记录 → pid best-effort 杀原 holder 进程组（kill(-pid, SIGKILL)；ESRCH 跳过并回落单杀；holder=本进程跳过——在进程内的僵尸由 fencing 自收口；pid 复用按 /proc 启动时间与实例 startedAt ±10min 比对兜底）；**#179（#66 决议 3）`pidStartMatchesInstance` 导出复用**：agents/instance-timeout-scan terminate 前 pid 复核同款判定
- `delegation-gate.ts` — A2A 委派闸门（§4.1/§4.2，纯代码零 LLM）：成员/自派生/深度(P1=1)/宽度3/树8/环/重复委派校验，预算留桩（TODO §4.3 P2）
- `merge-on-review-pass.ts` — B3b-ii 评审通过后自动合并（决策 D1/D3 后半 + PMO-b 决策 3）：reviewPassed 收口触发（best-effort，不阻断 done 迁移），task/<wuId> --no-ff 合并回目标分支 → 冲突则 rebase 重试一次 → 仍冲突清理现场、取冲突文件清单、频道 Studio 系统消息转人工并置 blocked（metadata.mergeConflict/conflictFiles）；成功则移除 worktree、删 task 分支、记 metadata.mergedAt/mergeCommit 并发频道通知；mergedAt 为防重哨兵，无 worktree 落档的 WU 直接旁路。**PMO-b：metadata.pmoBranch 落档的 WU 目标 = PMO 分支**（`<worktreesDir>/pmo-<projectId>` 集成交合 worktree，不动 baseRepo 当前 checkout；集成交合建不起来直接转人工，不静默回落错目标）
- `wu-metadata.ts` — WU metadata 访问器（2026-08-06 Card 8，零依赖叶子，schema 知识单一出口）：`parseWuMetadata`（容错解析，null/坏 JSON/非对象 → `{}`）、`clearSessionBookkeeping`（**16 字段会话/执行簿记权威清单**——sessionId/startedAt/sessionResumes/sessionCount/lastSessionResumed/blockReason/blockedAt/resumeCount/stepCount/consecutiveStuck/errorType/errorDetail/errorAt/_cumulativeTokens/progressLog/sessionSummary，review 子 WU 不继承，事故实录见文件头；blockedAt/resumeCount 为 #176 死信计时基准/复活观测钩子，同理不继承；#171 删只写零消费方的 input_tokens 死字段（#67 决议，token 观测由 workunit:tokens 事件覆盖）；agent-loop 新增簿记字段必须同步该清单，否则静默泄漏进 review 子 WU）、`mergedWuView`（「持久化 + metadataUpdates」合并视图，agent-loop recordResult 口径；updates 显式 `undefined` 覆盖持久化值、序列化即清除——hint 消费清除依赖此语义）。窄接口不放宽：特殊取值形态（dotted key 兼容/跨实体 metadata/窄断言）就地保留
- `wu-dependencies.ts` — #109（T3，#106 子票）接单依赖判定（零依赖叶子）：`parseBlockedBy`（容错解析 metadata.blockedBy，字符串/对象皆可）/ `buildStatusById`（全局 id→status 映射，loop 与路由共用）/ `hasUnfinishedDeps`（任一依赖未了结 → 不可认领；了结口径 = done/closed——closed 终态不可能再 done，关闭即人工裁决；引用缺失 id 保守按未了结，笔误保护，UI 经 claimable 可见）/ `resolveClaimable`（列表 API 的 claimable 标记 = unassigned 且无未了结依赖，profile 无关）。消费方：agent-loop observe 的 unassigned 过滤 + workunit 路由 GET /
- `assignee-resolver.ts` — assigneeId 双语义**批量**解析器（2026-08-06 Wave-4，零依赖叶子）：`buildAssigneeProfileResolver({states, profileIds})` 一次建 instance→profile map，返回 `(assigneeId) => profileId | null`——实例形态经 state.roleId 反查、未认领指名形态（profile id 命中 profileIds）直通、未知/空 → null。消费方：agents/token-usage（两处）、monitoring/metrics（角色维度 + token 按角色归因，2026-08-06 起补齐 profile-id 直通——此前仅 map 查找，未认领指名 WU 静默归因为 null 的口径差已修）；单 WU 逐个查询变体仍在 agents/review-dispatcher resolveProfileId（getProfile → getState，语义相同）

### 依赖关系

- 上游：`@dommaker/studio-shared`（eventBus、FileStore）、projects（project-discovery 候选搜索）、requirements（Requirement projectId 写回）、pmo（projectService 查/建 gitRepo 锚点项目）
- 下游：agents（AgentLoop 认领执行）、requirements（状态汇总）、channels（@mention 派发）、triggers（CREATE 动作）

### 注意事项

- **assigneeId 双语义（§1.2-b，2026-07-28 全仓核对）**：同一字段两种含义按状态切换——**unassigned 时 = 被指名的 profile.id**（@mention 派发、A2A 委派、B3a 归属绑定复活；可见性由 AgentLoop.observe 的 unassigned 过滤保证：assigneeId 非空仅该 profile 的 loop 可见，null 走频道 members）；**认领后 = 认领方 loop 的 instance.id**（file-store.claimWorkUnit 只校验 status==='unassigned'，不校验既有 assigneeId，认领即改写；myActive/续跑按 instance.id 查询）。推论：active + assigneeId=profile.id 是卡死态（续跑查询与认领过滤都看不到）——channels/convert-to-task.service.ts 曾如此（UI 传 profile.id 直接建 active），L1（2026-07-28）已修为统一建 unassigned。claim 的锁是 flock **悲观互斥锁**（mkdir 原子目录跨进程互斥），非乐观锁（无版本号/读后再验）；token 归因按双语义解析（instance→state.roleId 反查，本身就是 profile.id 则直接命中——批量消费方统一走本模块 `assignee-resolver.buildAssigneeProfileResolver`，勿各自再建 map）
- 状态变更发布 `workunit.status_changed` 事件，requirements/rollup 据此汇总 REQ 状态。**2026-07-29 补齐**：claim（→active）、unclaim（→unassigned）、reviewRejected（→active/blocked）也补发该事件（此前只有 transitionStatus/reviewPassed/markMergeConflict 发，前端列表看不到认领/打回）；订阅方另有 events/workunit-events-bridge（→SSE）与 pmo/analysis-handoff（分析接力）
- `ANALYSIS_TASKS_MAX=8`：analysis TASK 拆分上限（agent-loop parseTaskBreakdown 与 pmo/analysis-handoff 共用）；metadata 增 `analysisTasks`（COMPLETE 时 agent-loop 解析 TASK: 行落档）/ `analysisTasksSpawnedAt`（派生幂等哨兵）/ `analysisFog`/`analysisDestination`（#106 M7 对齐：COMPLETE 时 agent-loop 用 pmo/map-opening 同一解析器解析 FOG:/DESTINATION: 行落档，web 确认弹窗预填消费）。**#183（2026-08-16，#159 决议 2）哨兵清单化**：增 `analysisTasksSpawned`（已建子 WU id 清单，对账补差集口径；人工关单留清单不复活；仅旧时间戳无清单 = 兼容跳过）+ `analysisRespawnAttempts`（对账补建连续失败计数，≥3 停跑升 critical）+ `reviewRedispatchAttempts`（review 对账同款计数）——扫描机制见 agents/CONTEXT.md 的 dispatch-reconciliation 行。**#186（2026-08-16，#167 决议 1）**：增 `autoConfirmedBy`/`autoConfirmedAt`（trigger 巡检单免确认直转 done 留痕，写入方 pmo/analysis-handoff）
- NEED_INPUT 挂起后由人在频道线程回复触发续跑
- B3a（决策 D2）：WU metadata 增 workspaceRoot / ownershipSource / waitingReason 字段承载工程归属；agent-loop 执行根目录解析 metadata.workspaceRoot 优先于 workspaceId 记录。**2026-08 归因统一**：创建期 PMO 归因戳 canonical key = `pmoId`（message-routing / project.service / analysis-handoff 创建时落档；pmo-branch-resolver 与证据归属过滤的唯一直读 key），原 `ownershipProjectId` 为 deprecated legacy 同位名，仅读取侧同级兼容（requirements/wu-pmo-attribution.ts），不再写入
- B3b-i（决策 D1/D3 前半）：WU metadata 增 worktreePath/worktreeBranch/worktreeBaseBranch/worktreeBaseRepo（代码类 WU 专属 worktree 落档，review 子 WU 经 `...parentMeta` 拷贝天然继承）与 verifyCommands/verifyReport/verifyFailCount/verifyFailHint（自动验证）；覆盖命令也可放在 workspace 记录的 verifyCommands 字段
- B3b-ii（决策 D1/D3 后半）：WU metadata 增 mergedAt/mergeCommit/mergeConflict/conflictFiles；reviewPassed 收口触发自动合并（merge-on-review-pass.ts，git 全走 execSh，冲突转人工置 blocked 走 `markMergeConflict` 直写快照——done→blocked 同 reviewRejected 先例绕过 VALID_TRANSITIONS）
- F6（2026-07-28 分析文档，决策 1）：WU metadata 增 `attestations`（l1 自动验证 / l2 agent 评审 / l3 人工确认台账）——写入方：l1=agent-loop 验证守卫；l2/l3=reviewPassed/reviewRejected 的 attestation 入参（agent-review→l2 含 selfReview/ref；human-confirm→l3，done 态幂等补写不改状态机）。**消费铁律：展示/指标只准过 studio-shared 的 `deriveDisplayState()`，禁止各自解释**
- **F6-c 证据断链修复（2026-07-30）**：①`POST /:id/verify`（human-only，断点 2）人工重跑 L1——仅代码类 WU（否则 400）+ worktree 落档（否则 409），body.commands 视为 metadata.verifyCommands 覆盖，无可跑命令 422 `{verified:false,reason:'no-commands',hint}`；全绿落 l1 approved + verifyReport，失败只落 l1 rejected（**绝不写 verifyReport**——metrics 按其存在计通过，失败写入会虚增通过率），不动 status/verifyFailCount；service 方法 `recordL1Verification`。②`POST /:id/dispatch-review`（human-only，断点 3）人工补派评审，委托 ReviewDispatcher.dispatchReviewNow（守卫见本文 `apps/api/src/modules/agents` 锚点），200 `{reviewWorkUnitId}`。③reviewPassed 新增 F6-c 幂等豁免：done + agent-review + l2 未达成（deriveDisplayState approved 口径，rejected 留痕不算）→ `writeAgentReviewAttestation` 只补写 l2（不动状态/completedAt、不触发合并；l2 已达成时重复回传仍抛 Cannot review）。**幂等补写证据后（l1/l2/l3 路径）均发 status_changed（状态值不变也发）**——pmo/progress-rollup 按证据齐备度重估；l3 人工确认路径（writeHumanConfirmation）2026-07-30 起同样补发（原为 F6-b 不发约定，rollup 证据感知化后 l3 常是最后一块证据，不发则项目状态无法即时翻转）
- PMO-b（决策 3）：WU metadata 增 pmoBranch（agent-loop 首 step 落档，worktree base 与合并目标从默认分支改 PMO 分支）。**2026-08 归因统一**：`pmoProjectId` 已废弃——原为同批落档的冗余缓存（生产存量为零），agent-loop 不再写入、解析链不再读取；merge-on-review-pass 合并时经 `resolvePmoProjectIdForWU` 从创建期戳重解析项目 id（lazy import 防循环，同 wu-messenger），解析不出 → 转人工不静默回落错目标
- **blockForManualRelease（2026-07-31 PMO-flow UX §4）**：terminate 语义修正配套——`AgentInstanceService.terminate` unclaim 后经本方法把 WU 置 blocked 转人工（unassigned→blocked 不在 VALID_TRANSITIONS，语义方法直写快照 + appendEvent('blocked') + publishStatusChanged，形态同 markMergeConflict；assigneeId/claimedAt 清空，metadata.manualRelease/manualReleaseReason 留痕；终态 done/closed 不动）。blocked 不在 loop 认领集合内，活 loop 不会回弹重领
- **#177（#69 决议，2026-08-16）reviewPassed 第三参 options**：`POST /:id/review-passed` 收可选 body.defaultAssigneeId（profile id，trim 后非空才透传）→ service.reviewPassed(id, attestation, { defaultTaskAssigneeId }) 在 in_review→done 主路径落 metadata.defaultTaskAssigneeId——analysis 确认处「默认执行角色」的落档点，pmo/analysis-handoff 派生 task 子 WU 时消费（消费侧见 pmo/CONTEXT.md）；F6-b/F6-c 补写路径不携带该语义
- **里程碑消息 meta（2026-07-31 PMO-flow UX §6-3 + §10）**：本模块 blocked 转人工系统消息（merge-on-review-pass 未提交改动/集成交合失败/合并冲突、timeout-release ≥3 次超时 blocked）meta 带 `{pmoId?, atHuman:true}`（pmoId 经 requirements `resolvePmoProjectIdForWU`，解析不到不携带）；§10 起**合并成功通知与 NEED_INPUT 挂起超时提醒（waiting-input）同口径带 meta**（通知铃铛可跳 PMO/WU 详情），仅释放回池等纯进度消息 meta 保持 `{}`。**2026-08 起上述消息统一经 `wu-messenger.postWuSystemMessage`（milestone: true）发送**——pmoId 解析与 anchor 查找均收敛在 wu-messenger 内（其 lazy import pmo-branch-resolver 避环，见该文件头部依赖说明）
- review-passed/review-rejected 拒绝 authorType=agent 的调用（403，A2A §4.4：验收权只在人；UI/人类调用不发送 authorType 或发送 'human'）
- **#237（2026-08-18）**：`POST /:id/status` 补上同一 human-only 约定（此前是唯一漏网端点——agent 可直推 in_review→done 绕过评审链且不落 attestation 台账）；复用 `resolveCallerAuthorType`，agent 任何目标状态一律 403，服务层 `transitionStatus` 不设限（agent 内部合法迁移不经 REST）。人工经 /status 直推 done 的口子属已知容忍（F6-c 补票），不在本票
- **Card 9（2026-08-06）写入路径收敛**：评审/验证 5 处写入（reviewPassed / writeHumanConfirmation / writeAgentReviewAttestation / recordL1Verification / reviewRejected）的台账条目 spread 规则与落库尾部（建快照 → appendEvent + upsertSnapshot + publishStatusChanged）收敛为私有 `buildAttestationEntry` / `persistSnapshot`，各方法只留自身策略（守卫/状态迁移/合并触发/blockReason/verifyReport），零行为变化；recordL1Verification 的 l1 条目仍内联构造（summary 恒写含空串截断，属该方法策略，不走条件 spread）
- **`rebindSourceChannel(from, to)`（2026-08-06，B2-012 存储归属收敛）**：频道删除兜底时 WU 重挂的唯一入口——解析 metadata 按 `context.sourceChannelId` **字段相等**匹配顶层 task WU（替代原 channel 路由的 raw JSON `includes` 子串匹配，杜绝其它字段含同 id 的误伤），空/损坏 metadata 跳过，返回重绑数量；metadata-only 更新沿用 `update()` 惯例（appendEvent('updated') + upsertSnapshot，不发 status_changed——状态与证据均未变）
- **#110（T4，2026-08-11）决策落地**：decision WU metadata 增 `fogId`（与既有 `pmoId` 配对，T6 开图机制建单时落档——订阅器按 pmoId 找 PMO、按 fogId 定位 map.fog[] 条目，落地机制见本文 `apps/api/src/modules/pmo` 锚点的 decision-resolution）；`POST /:id/review-passed` 增**可选** body.summary（人点通过时填写的结论文本），穿透进 reviewPassed 的 attestation.summary 落 l3 台账（`ReviewAttestationSource.summary` 为 F6 原有字段，本票仅接通端点入参；空串/缺省不传）。最小惊讶约定：事件侧拿不到 summary 时 decisions[] 落空串、不拒写（机制不阻塞雾消解）。
- **#112（T6，2026-08-11）开图机制**：analysis WU metadata 增 `mapOpenedAt`（pmo/map-opening 的幂等哨兵，先落档再建 decision 单）——analysis 人工确认（done）且 l3.summary 含 `FOG:`/`DESTINATION:` 逐行清单 → 初始化 PMO map + 逐条建未指派 decision 单（metadata 落 pmoId/pmoNumber/fogId 互挂契约），提取格式与落地机制见本文 `apps/api/src/modules/pmo` 锚点的 map-opening 行
- **#109（T3，2026-08-11）接单规则机制化**：metadata 增 `blockedBy: string[]`（阻塞本 WU 的 WU id，可跨 PMO）与 `ac: string[]`（验收标准，机制只存不解释）；M4 接单过滤 = blockedBy 任一未了结（非 done/closed）→ unassigned 对所有 loop 不可见（agent-loop observe 消费 `wu-dependencies.hasUnfinishedDeps`，全局 index 判定天然跨 PMO；引用缺失 id 保守按未了结）；GET / 列表项附 `claimable` 标记供 UI（profile 无关，认领侧门槛仍由 loop observe 执行；仅当页内含 unassigned 行才读 index 做依赖判定）
- **#115（T9，2026-08-11）交稿物化**：spec WU metadata 增 `specTasksSpawnedAt`（pmo/spec-materialization 的幂等哨兵，spec done **恒落档**——无 TASK 行也落，防重复派生 + 供 progress-rollup 派生未落定判定）——spec 人工确认（done）且 l3.summary 含 `TASK: <标题> | AC: ... | BLOCKEDBY: ... | LEG: ...` 逐行清单 → 批量建未指派 task 单（parentId=spec 单，metadata 落 pmoId/ac/blockedBy/LEG 命中腿的 workspaceRoot），提取格式与落地机制见本文 `apps/api/src/modules/pmo` 锚点的 spec-materialization 行；物化清单的 AC/BLOCKEDBY 段即 #109 字段的写入来源之一（机制只搬运人填文本）。另有两处同批修复：analysis WU 的 mapOpenedAt/analysisTasksSpawnedAt 哨兵写入改「写入前重读合并」（map-opening 与 analysis-handoff 同事件写同一 WU metadata，防 read-modify-write 互覆，e2e 实测踩中）
- **#99（2026-08-14）WU 收尾批量提取**：metadata 增 `memoryExtractedAt`（role-memory/completion-extraction 的幂等哨兵，done 触发一次，区别于 R3 的 `knowledgeExtractedAt`）——钩子订阅 `workunit.status_changed` → done，读归档 transcript → LLM → 角色记忆草稿区；哨兵写入同样走「写入前重读合并」（与同 done 事件的 mapOpenedAt/analysisTasksSpawnedAt/specTasksSpawnedAt 各订阅方互不覆写），机制见本文 `apps/api/src/modules/role-memory` 锚点
- **#170（2026-08-15，决策 #65）并发写收口**：全部快照写路径（create/update/delete/unclaim/transitionStatus/persistSnapshot/markMergeConflict/blockForManualRelease/rebindSourceChannel）改走 FileStore 锁内复合原语 `commitSnapshot`/`commitRemoval`（appendEvent+upsertSnapshot 同一把 workunits flock 成对，删除落 closed+deleted 墓碑）；metadata 增量写（recordResult 簿记、waiting-input 的 pendingReplies 三处）改走 `updateMetadata(id, mutator)`——mutator 基于锁内最新 metadata，stepCount/consecutiveStuck 锁内重计、progressLog/pendingReplies 锁内尾部追加（pendingReplies 三段合成：slice 精确移除本步已注入条目、保留 step 期间新到回复、追加新鲜度暂存），消读-改-写互覆（#58-M1 扫描计数回退一并消除）；`createGuarded(input, guard)` 支撑 review 建子 WU 的锁内 check-then-create（同父唯一性并发安全）；启动对账 `reconcileIndex` 接在 apps/api index.ts（不一致按事件流重建 + dispatchMonitorAlerts 告警，source=wu_index_reconcile）
- **#108（T2，2026-08-11）decision/spec 工单类型**：裁剪状态机 `unassigned → active ⇄ blocked（= waitingForInput 挂起）→ in_review → done`，无 closed（决策可等关键人多天，不进死信/关闭路径）——`TYPE_VALID_TRANSITIONS` 按 type 覆盖，`transitionStatus` 经 `resolveValidTransitions(type, status)` 查表，未列出 type 回落全局 `VALID_TRANSITIONS`；人工验收类：不在 CODE_WORKTREE_TYPES（无 worktree/无 L1 验证 → merge-on-review-pass 自然旁路），ReviewDispatcher 不派评审子 WU（见本文 `apps/api/src/modules/agents` 锚点），PMO 证据口径豁免 l2（见本文 `apps/api/src/modules/pmo` 锚点）
- **鉴权（2026-07-24 收紧）**：15 条写端点（CRUD/claim/unclaim/review/status/讨论区发消息/编辑消息/opportunities adopt·ignore/resume/close）= `requireAuth()+requireNotGuest()`；GET 只读保持大门层。注意 authorType/agentName 仍是自声明身份（不作凭证，已知局限）
- **WU 租约与代际令牌（2026-08-09 #63 决议，2026-08-16 #178 落地）**：`timeoutAt` 语义 = **租约（lease）**到期时刻——claim 写固定 5min 租约（`WU_LEASE_TTL_MS`，废除按 type 30/60min 默认/metadata 显式值/「已有列值不动」，任务预算归 maxTurns + token 记账），持有方 loop 每 30s 心跳推前为 now+5min（`agents/loop/lease-heartbeat.ts`，写经 FileStore `refreshWorkUnitLease` 锁内路径）；timeout-release 扫描逻辑不变。**代际令牌（fencing token）= `claimedAt`**：三处校验——每次心跳前（refreshWorkUnitLease 锁内原子比对 claimedAt+assigneeId，失配返回 lost 一字不写）、步结果回写前（recordResult 入口 `stillHoldsLease`）、状态迁移前（recordResult 全部迁移走 `transitionIfHeld`）；易主即杀自身 CLI 进程组（Executor.stopProcessGroup → agentRunner，kill(-pid) 杀整组）、停止心跳、静默退出该 WU（旧 holder 一字不再写）。释放即杀见 timeout-release 行；释放 ≥3 次转 blocked 维持不变
- **blocked 恢复路径（2026-08-09 #57 决议，2026-08-16 #176 落地）**：不做自动恢复（无自动回池/换角色/退避）；**回复即复活**——`resumeWaitingWorkUnit` 已扩到全 blocked 类型（waitingForInput 限制已移除），线程内任何人类回复 → active + pendingReplies 注入，回复「关闭」为显式关闭指令（decision/spec 无 closed → 拒绝并说明）；复活重置 consecutiveStuck/blockReason、记 resumeCount（不限次，观测钩子供 #62 趋势探测），**timeoutReleaseCount 终身保留**（不绕过 #63 的 3 次上限）；按钮通道（纯授权交互）为迭代方向、依赖 #61。**CTA 文案即交互**：blocked 里程碑（agent-loop stuck/verify-failed、timeout-release 达上限）/ 30min 提醒 / 24h 死信通知三处统一 `blocked-cta` 模板，提醒扫描已扩面全 blocked、每次 blocked 只发一次。**死信**：24h 自动关闭，计时基准 = metadata.blockedAt（transitionStatus/markMergeConflict/blockForManualRelease/reviewRejected×3 各 blocked 迁移点统一落档；无 blockedAt 存量回退 createdAt；decision/spec 豁免），关闭经 `wu-closure.closeWorkUnitWithNotice` 双出声（workunit:closed 事件 + 频道通知），checkTotalExecutionTime 2.5h 强杀同出口。**#94（2026-08-11）起复活不再清零 sessionCount**——复活后凭档案 metadata.sessionId 优先续用旧会话（续用判定见 agents/loop/session-resume.ts），不靠清零预算放行。**#185（决策 #87，2026-08-16）按钮通道落地**：`POST /:id/resume` / `POST /:id/close`（requireAuth+requireNotGuest，对齐发消息端点）——resume 与回复路径共享同一复活原语（固定占位文案注入 pendingReplies + Studio 里程碑消息补双出声；归属等待型不被纯授权复活 → 409），close 复用死信显式关闭路径（decision/spec 无 closed → 409 NO_CLOSED_STATE）；Web 侧 `BlockedActions` 组件抽屉/详情页复用（「继续执行」仅卡住型显示、「关闭任务」全类型 + 二次确认）
- **#95（2026-08-13）handoff 前序进展**：metadata 增 `progressLog: Array<{step,action,summary,at}>`（recordResult 只记成功步 progress/complete，summary 截 200 字符、环形保留最近 5 条；失败步不落 log，由注入侧按 errorType 附「上一步失败」行）；内容源 = agents/loop/prompt-composer.ts 的「前序进展」段（续用不命中 + stepCount>0 时注入，挂 base 后/hint 前、800 软定额）。`progressLog` 入 clearSessionBookkeeping 清单（子 WU 从零记自己的进展史）
- **#96（2026-08-13）CLI 上下文溢出滚动摘要**：metadata 增 `sessionSummary?: string`（溢出时由 agents/loop/context-overflow.ts `buildRollingSummary` 从 wu.scope + progressLog 构建并落盘，不递归摘要；溢出重试失败转 NEED_INPUT 后保留供人工参考）。`sessionSummary` 入 clearSessionBookkeeping 清单（子 WU 从零记自己的会话）
- **#126（T4，2026-08-15）待确认人闸（pending 状态）**：扩范围类型 `PENDING_CONFIRM_TYPES = feature/task/spec` 创建未显式给 status → 落 `pending`（状态机仅 `pending → unassigned|closed`，spec 走裁剪机仅 `→ unassigned`），人工确认（POST /:id/status → unassigned，web WorkUnitDrawer 有确认按钮）才进 frontier——claim 锁内 status!=='unassigned' 拒绝、loop observe 与 `resolveClaimable` 的 unassigned 过滤天然屏蔽，两处零改动；圈内类型（bug/implement/review/analysis/decision）创建即可认领；已过人工闸的机制建单（spec-materialization/analysis-handoff 派生 task、管线展开 implement）显式传 `status:'unassigned'` 不吃默认（单层人闸）。feature 落 pending 时**不展开**频道默认管线，确认时由 `transitionStatus` 补展开（`expandDefaultPipelineHead` 改 protected + 幂等：父单已有任意子单即跳过）；`aggregateParentStatus` 对 pending 父单短路（人闸只能人解，子单聚合不覆盖）。打回回流与 ≥3 熔断为既有机制不新建：reviewRejected 原单回 active 返工（保留 assigneeId/上下文/熔断计数，范围=原需求，不过人闸）、`_consecutiveReviewRejections >= 3 → blocked`（含 blockReason，测试见 block-reason.test.ts），故「打回→修复单」语义由返工载体覆盖，未新增 fix 类型建单点。`resolveInitialStatus(type, explicit?)` 是初始状态唯一决策入口（workunit.types.ts）


## apps/web/src

### 职责

该目录是 Agent Studio Web 前端应用的主源码目录，负责管理路由、全局状态、API 客户端、UI 组件和样式。它通过 React 应用入口 (App.tsx) 组织页面懒加载，并通过 axios 封装与后端 RESTful API 及 SSE 通信，提供认证、通道、工作单元、监控、需求等模块的交互界面。

### 核心导出

| 导出 | 文件 | 说明 |
|------|------|------|
| `App` | `App.tsx` | 根组件，包含路由定义、主题、全局布局（TopNav、Sidebar）及懒加载页面；频道工作区路由为满高三栏（各栏独立滚动） |
| `api` (axios 实例) | `api/index.ts` | 统一 API 客户端，含 Bearer token 注入和 401 自动刷新 |
| `channelApi` | `api/channel.ts` | 频道（list/get/create/update/members）、消息、Agent 配置相关 API |
| `monitoringApi` | `api/monitoring.ts` | 监控、飞轮指标、开销 API + `getEfficiency`（#120 输入缓存命中率/段 trim 率）+ `terminateInstance`（强制停止实例，AgentDashboardPage/AgentDetailPage 共用） |
| `memoryApi` | `api/memory.ts` | #101 角色记忆人审闸口（promote/demote）+ `draftStatus`（GET /role-memory/draft-status，MemoryProposalCard 刷新后按草稿墓碑状态派生已审态） |
| `distillApi` | `api/distill.ts` | 蒸馏人审闸口（#143 approve/reject + proposal-status）、GC 候选清单（#144 gcApprove/gcReject/gcProposalStatus）、存量约束审计（#146 auditApprove/auditReject/auditProposalStatus）；卡片刷新后按提案状态派生已审态 |
| `requirementApi` | `api/requirements.ts` | 需求（REQ）CRUD 及关联工作单元链 API（B2-009 requirementsDocApi 已随 #155 SDD 写侧退役删除） |
| `knowledgeApi` | `api/knowledge.ts` | 知识审核闭环（promote/demote）+ 知识库浏览（listResolutions/listGaps/listUnified/createUnifiedEntry/search，KnowledgePage）。#149（2026-08-15）document-store 退役：项目文档（listByProject/getDetail/archive）与冷启动导入（importScan/importExecute）已摘除 |
| `companyApi` | `api/company.ts` | 公司 CRUD（list/get/create/update；Settings 页 / PMOPage 共用，list 取 [0] 为默认公司） |
| `okrApi` | `api/pmo.ts` | PMO OKR 列表/创建（/pmo/okr；PMOPage、PMOCard。PMO 项目 CRUD 仍在 api/index.ts 的 projectApi） |
| `notifyApi` | `api/notify.ts` | 用户通知渠道配置（getConfigStatus/saveConfig，进程内存；Settings 页「已同步/需重存」指示与保存） |
| `harnessApi` | `api/harness.ts` | /harness/* 质量门（checkConstraints，RequirementsDocCard 执行前确认） |
| `workunitApi` | `api/workunit.ts` | 工作单元（WorkUnit）全生命周期 API + token 度量事件查询/解析 + 执行步事件查询/解析（`listExecutionStepEvents`/`parseExecutionStepEvents`，WU 过程可视化；#172 起解析失败步字段 status/errorType/errorDetail，缺省 success）+ 流式 chunk→文案共享格式化 `formatExecutionStreamChunkText`（chunk→text 映射全站唯一出处：useAgentRoster 卡片动态与 ExecutionSteps 实时区共用；默认截断，传 false 不截断） |
| `transcriptsApi` | `api/transcript.ts` | WU transcript 只读查看（#174，#60 C5）：get(workUnitId, {offset,limit}) → GET /transcripts/:id（认证、分页）；TranscriptViewer 消费 |
| `eventsApi` | `api/events.ts` | #180 事件检索（#60 Q3a）：search(params) → GET /events（level/type/keyword/until 过滤 + nextCursor 游标分页）；MonitoringPage「事件检索」Tab（`components/monitoring/EventSearchPanel`）与「需要处理」区（NeedsAttentionSection）消费 |
| `NeedsAttentionSection` | `components/monitoring/NeedsAttentionSection.tsx` | #184 监控页概览 Tab 顶部「需要处理」区（#62 D4 + #60 IA 行动信号优先）：告警收件箱（monitor:alert 近 24h，message 大白话逐行）+ 卡住计数（阻塞 total / 待认领滞留 >2h 客户端筛 / 执行中停滞 timeoutAt 过期客户端筛，非零才显示，Link 下钻 /workunits?status=）+ 近 24h 失败趋势一行（workunit:failed + 失败步 / 成功步，近 24h vs 前 24h 箭头 ↑↓→）；三部分独立加载各自容错，全清零告警 → 「现在没有需要你处理的事」 |
| `useWebSocket` / `WebSocketProvider` | `api/websocket.tsx` | SSE 客户端 hook 及 Context Provider；应用根部唯一 EventSource（/events/stream），事件经 `useWebSocketContext().onEvent` 分发 |
| `useWorkUnitEvents` | `hooks/useWorkUnitEvents.ts` | workunit.created/status_changed/execution.step（SSE）订阅 hook（防抖合并）；WorkUnitListPage 列表与 WorkUnitDrawer 详情据此实时刷新（execution.step 驱动执行过程近实时更新） |
| `useWorkUnitStreamEvents` | `hooks/useWorkUnitStreamEvents.ts` | workunit.execution.stream（Layer B 步内流式，SSE-only）订阅 hook：按 workUnitId 过滤、内存保留当前步 ≤50 条、新步 step-start 清空；WorkUnitDrawer「执行过程」实时区块消费 |
| `useAgentRoster` | `hooks/useAgentRoster.ts` | Agent 作战视图数据 hook（从 AgentDashboardPage 抽取）：名册合并（listAllAgents × getAgentSummary 按 roleId）+ SSE 事件路由（agent.instance.status_changed / workunit.status_changed / workunit.execution.step\|stream，按 currentWorkUnitId 反查归属、增量补查 WU 详情）+ 30s 轮询兜底 + 每 agent 动态 ≤10 条内存上限 + terminate；返回 `{ roles, activities, lastDone, channelNames, loading, error, refresh, terminate }`。已知 N+1：空闲角色逐个 workunitApi.list 查最近完成（GET /workunits 仅支持单 assigneeId，后端无批量接口） |
| `useChannelList` | `hooks/useChannelList.ts` | 频道列表数据 hook（ChannelListPage 与 ChannelRail 共用：列表/未读 SSE/新建） |
| `useChannelLiveExecutions` | `hooks/useChannelLiveExecutions.ts` | 频道 live 执行状态条数据源（#242）：初始 workunitApi.list(status:'active') + SSE status_changed 增删执行中集合 + execution.step 更新步号（步事件无 channelId，展示层按本频道集合过滤）；展示模型推导在 execution-rows.ts `deriveLiveExecutions`（#240 推导层复用），id 截短共用 `utils/id.ts` shortWuId |
| `ProjectMap` / `NextActionCard` | `components/pmo/ProjectMap.tsx` | #114 T8 PMO 地图区（目标 / 待决问题清单带状态徽章 / 结论时间线可点进决策单 / 任务单依赖图）+ 顶部「下一个该干什么」卡；纯逻辑（徽章口径 / 排序细则 / 依赖图拼装）在 `components/pmo/mapUtils.ts` |
| `useDetectedProviders` / `buildProviderOptions` | `hooks/useDetectedProviders.ts` | 运行环境已装 agent CLI 探测（GET /workspaces/runtimes，服务端聚合前 best-effort 重扫本机）；provider 下拉统一数据源（FirstRoleSetupModal / StudioRoleSetupModal / ChannelMemberManager 创建表单），一个都没扫到时回退 4 个内置全量可选 |
| `ChannelRail` | `components/channel/ChannelRail.tsx` | Mission Control 左栏：频道列表（未读 badge、agent 在线数）+ Agent 状态 |
| `WorkUnitDrawer` | `components/channel/WorkUnitDrawer.tsx` | 右抽屉：WorkUnit 详情（证据台账 L1/L2/L3 + 人工确认入口（in_review=审查硬门/done 缺 l3=L3 留痕不阻断）、执行过程（步级时间线 + 步内实时流区块，REST 卡片落位后实时区自动让位；#182 起传 wu 置顶「当前状态速览」节：状态/第 N 步·上限 M/最近进展/失败原因/累计 token，≥80% 步数预算给平实提示，失败步卡片标 ✗，与详情页同组件复用）、token 开销与全局开销红线）/ REQ 全链路，只展示真实 API 数据 |
| `EvidenceLedger` | `components/workunit/EvidenceLedger.tsx` | F6 证据台账 L1/L2/L3 共享组件（2026-08 从 WorkUnitDrawer / WorkUnitDetailPage 双份实现合并）：props = `{ attestations, variant: 'drawer' \| 'card' }`；共享层标签/行格式（`{kind} · {by 前 8 位} · {时间}`）/存量空态文案/l2.summary 评审结论行，variant 只承载外层标记（mc-kv vs card）与 verdict 呈现（✓/✗ 前缀 vs 通过/拒绝徽章）差异 |
| `BlockedByList` | `components/workunit/BlockedByList.tsx` | #116 依赖（blockedBy）清单共享组件（WorkUnitListPage 被阻塞行展开 / WorkUnitDetailPage「依赖与验收」卡复用）：逐个 best-effort `workunitApi.get` 拉依赖状态，done/closed 了结走 u-ok、其余 u-warn，拉不到显示「找不到这张单」按未了结（#109 保守阻塞口径）；解析复用 `pmo/mapUtils.parseBlockedBy`，blockedBy 为空不渲染 |
| `AuthModal` | `components/AuthModal.tsx` | 隐身认证模态框（双击手势触发） |

### 依赖关系

上游：依赖同目录下的子模块（`pages/`、`components/`、`stores/`、`hooks/`、`contexts/`、`styles/`）以及外部库（`react`, `react-router-dom`, `axios` 等）。
下游：暂无。

### 注意事项

- 路由使用 `React.lazy` 进行代码分割，懒加载页面组件需通过 `Suspense` 包裹。
- API 客户端（`api/index.ts`）的认证 token 直接从 `localStorage` 读取，避免与 `authStore` 的循环依赖。
- **API seam（2026-08 Wave-4）**：端点知识只存在于 `api/*` 适配模块，页面/hooks 不直接拼 URL。死命名空间已清除：`taskApi`（零调用，与 workunitApi 重复）、`stepApi`（零调用）整体删除；`agentApi` 只留 `list`（agentStore）；`superpowersApi` 已随唯一调用方 IronLawWarningBanner 整体删除（2026-08-06，工单 21）。本轮收编的原始调用：useChannelList 的 `/channels` list/create → `channelApi`（新增 `create`）；ChannelDetailPage 的 `GET /channels/:id` → 新增 `channelApi.get`、promote/demote → `knowledgeApi.promote/demote`；`useAgentRoster`/`AgentDetailPage` 的 terminate → 新增 `monitoringApi.terminateInstance`；ProjectDetailPage 归档 → 新增 `knowledgeApi.archive`；Settings 角色执行配置 → `runtimeWorkflowApi.updateConfig`（类型扩展 maxConcurrent/tokenWarningThreshold/showTokenUsage）。Wave-5（2026-08）收尾剩余原始调用：PMOPage/useCompanyId/Settings 的 `/companies` → 新模块 `companyApi`（api/company.ts）；PMOPage/PMOCard 的 `/pmo/okr` → 新模块 `okrApi`（api/pmo.ts）；PMOPage/KnowledgeImportPage 的 `/pmo/project` 列表 → 复用 `projectApi.list`；Settings 的 `/notify/config(/status)` → 新模块 `notifyApi`（api/notify.ts），`/runtime-config/reload` → `runtimeWorkflowApi.reloadConfig`；KnowledgePage 的 `/knowledge/resolutions|gaps|unified|search` 与 KnowledgeImportPage 的 `/knowledge/import/scan|execute` → `knowledgeApi` 新方法；RequirementsDocCard 的 `PUT /requirements-docs/:id` → 新 `requirementsDocApi`（api/requirements.ts）、`/harness/check-constraints` → 新模块 `harnessApi`（api/harness.ts）；PMOCard 的 `/executions` → 复用 `runtimeWorkflowApi.listExecutions`。**死链清理（2026-08-06）**：DeployApprovalCard 已删除——其 `/harness/deploy/approve|reject` 后端无路由、生产端无建卡消息、存量数据为零，整条审批链为不可达死代码；ChannelMessageItem 的 deploy_approval 分支同步移除。**runtime-config 下线（2026-08-06，工单 19）**：后端 `/runtime-config` 模块随 TaskWorker（studio-task 队列）整体下线，`runtimeWorkflowApi` 的 `getConfig/updateConfig/reloadConfig` 与 Settings 页「角色执行配置」「上下文监控」两个 section 同步删除（两者配置均无后端消费方，死写链路）。
- 实时通信使用 SSE（EventSource）代替 WebSocket。**单一连接不变量**：全应用仅 `App.tsx` 根部的 `WebSocketProvider` 建立一个 EventSource（/events/stream），所有实时消费走 `useWebSocketContext().onEvent`（domain hooks：useWorkUnitEvents/useWorkUnitStreamEvents/useChannelEvents/useChannelList + 页面级订阅），TopNav 连接状态点也读该 context；禁止再单独调用 `useWebSocket()` 开第二条连接。旧 realtime 链路（hooks/useWebSocket.ts、useWebSocketHandlers、ThinkingStream、GlobalModals 的 ExecutionResult 分支）已于 2026-08 随后端停发 legacy 事件（pipeline.*/thinking.stream/runtime.step.* 等）一并删除；2026-08 复查确认 `useGlobalModals.handleViewDetails` 无任何调用方（`selectedProject` 恒为 null，弹窗分支永不渲染），GlobalModals 死链整体删除：`components/GlobalModals.tsx`、`hooks/useGlobalModals.ts`、`components/ExecutionResult.tsx`、`components/ProjectDetail.tsx`（注意 ≠ 活体 `pages/ProjectDetailPage.tsx`）及 App.tsx 接线（含顺带清理的未使用 `runtimeExecutions` 解构）。
- 视觉体系（2026-07 T1b，方向 A「Mission Control」）：`styles/theme.css` 深色 `:root` 变量组 = A 方向 token（近纯黑 #050507、磷光青绿 #2ee6a8、终端黄 #e6c85c、全等宽、12.5px 基准）；`[data-theme="light"]` 浅色机制保留（ThemeContext 不变）。`styles/mission-control.css` 承载三栏布局（mc-*）与语义工具类（u-*）；页面禁止写死浅色 Tailwind 类（bg-white/text-gray-*），一律消费变量或 u-* 类。**样式规范唯一权威来源：`docs/specs/ui/style-guide.md`**（token、组件类、弹框标准结构、禁用规则）。2026-08 增补：`--chart-1…9` 图表分类色（深/浅两套，数据可视化专用）、`--fs-stat` 统计大数字字号、`--info-dim/border`；弹框唯一合法结构 = `.modal-overlay` + `.modal` + `modal-header/body/footer`（style-guide §4.3），禁止自写 `bg-black/NN` 遮罩。

- 频道工作区（`pages/ChannelDetailPage.tsx`）= 左 ChannelRail / 中对话流 / 右 WorkUnitDrawer；REQ 全链路原 Modal 形态（`components/requirement/RequirementChainPanel.tsx`）保留给其他页面使用。**悬空 WU 容错（#241，2026-08-19）**：抽屉 `WuDetail` 对 workunitApi.get 404 单列友好态「该任务不存在或已被清理（id）」（axios.isAxiosError + response.status，惯例同 BlockedActions）；`ChannelMessageItem` footer WU 链接长 id（>12 字符）截短为前 8 位+…，title 留全量。**大屏断点（#239，2026-08-18）**：≥1440px 时 mc-stream-inner/mc-inputbar-inner 760→1000px、mc-card 560→1000px、正文 mc-msg-body 克制在 760px；动作图标（mc-msg-actions/mc-icon-btn/mc-wu-link）常显弱化态（opacity .55，hover/focus-within 强化）+ fs-sm，不再 hover 才出现。
- **WU 详情页（`/workunits/:id`，`pages/WorkUnitDetailPage.tsx`，2026-07 agents-pmo-flow-ux §5.4）**：全站跳转枢纽——Header（类型/状态/标题/时间/failureType）→ 归属条（PMO chip → `/pmo/project/:id`，解析顺序 metadata.pmoId（2026-08 归因统一 canonical 创建期戳，‖ legacy ownershipProjectId 同级）→ reqId→requirement.projectId；REQ chip 开 RequirementChainPanel；频道 chip → `/channels/:id`；认领 agent chip 按 instance id 匹配 /monitoring/agents → `/agents/:roleId`，匹配不到显示 id 前 8 位不可点）→ 证据台账 L1/L2/L3（同 WorkUnitDrawer 数据路径：deriveDisplayState/parseAttestations）→ 复用 ExecutionSteps（自带 REST 回放+实时流，页面不接 SSE；#182 起传 wu 启用置顶「当前状态速览」节，与抽屉同组件）→ TranscriptViewer（#174 会话原文只读查看器，默认折叠按需分页加载，走 transcriptsApi）→ 复用 DiscussionPanel。`/workunits` 列表行标题已改为详情页链接（行其余区域点击仍为行内展开）。
- 频道消息流滚动约定（2026-07，仿 QQ/微信）：打开/切换频道定位到最新一条；新消息仅当人在底部附近（≤80px）或是自己发送时跟随到底；"加载更早的消息"前插后按 scrollHeight 差值补偿，视口不跳。实现在 `ChannelDetailPage.tsx` 的 streamRef + useLayoutEffect。
- **ExecutionSteps 分层 loading（#240，2026-08-19）**：工具行四态推导纯函数 `components/workunit/execution-rows.ts`（`deriveLiveToolRows` 按 toolUseId 配对 tool/tool-result——缺 id 位置兜底、孤儿 result 跳过、步结束未配对合成 stopped；`derivePersistedToolRows` 按步状态合成 ok/stopped——Layer A 无逐工具结果）；渲染侧工具行 = 折叠单行卡 `mc-toolrow`（mc-dot 四态点 + 工具名 + summary，点击整行展开，输出在 `mc-toolrow-output` 内部滚动 ≤200px），thinking 独立行 `mc-exec-thinking`，执行级状态条 `mc-exec-statusbar` 常驻不随步闪烁。
- 角色（AgentProfile）创建入口时间线：进 App 时 `App.tsx` 检测（studio 角色 provider=null → StudioRoleSetupModal 补 CLI；**无任何 provider 非空的 active 用户角色** → FirstRoleSetupModal 建首个角色——F2 2026-07-28，原"无用户角色"条件被内置 seed 废掉后改为此口径）；常规入口 = Agent 管理页"创建角色"按钮 → `/setup/roles` 向导（勾选扫描到的 runtime 批量建）；频道内快捷入口 = 成员面板"+ 创建新 Agent"（name + 描述 + CLI 下拉）。所有入口共用 `channelApi.createAgent` → `POST /agent-profiles`（服务端 F1：provider 缺省打戳为扫描到的默认 CLI）。
- `AgentDashboardPage`（侧边栏 Agent 菜单，2026-07-31 agents-pmo-flow-ux §5.2 重构为作战视图；2026-08 抽取为薄页面）= 纯组合与渲染：数据/实时全部委托 `useAgentRoster`（名册合并、SSE 路由、轮询、terminate 见 hooks 表），本页只剩统计行 + 三段式卡片（左=状态 pill（`utils/agentStatus.ts` 的 `deriveAgentStatus`）/角色名（→`/agents/:profileId`）/CLI badge，中=当前 WU·PMO/频道链接·最近一条动态（空闲时"等待派活"+最近完成），右=运行时长+「强制停止」（确认"转人工处理"）；展开=最近 10 条动态+静态字段），无手动刷新按钮。`AgentDetailPage`（`/agents/:profileId`，§5.3）= Header（角色/CLI/状态/频道/ID/强制停止）→「正在执行」大卡（当前 WU + PMO/频道链接 + 嵌入 ExecutionSteps 实时执行流；无 WU 空态"当前空闲"）→ 统计行 →「历史任务」（assigneeId=instance.id 最近 20 条，每行 →`/workunits/:id`）。
- 频道 @提及（`components/channel/ChannelInput.tsx`）：候选 = `GET /agent-profiles?status=active&channelId=`（服务端按频道成员过滤）；选中插入纯文本 `@name `（带尾随空格，无结构化 id），发送走 `POST /channels/:id/messages`，mention 解析在服务端 message-routing 完成。成员弹框 `ChannelMemberManager` 的 memberIds 必须经 useEffect 从 props membersJson 同步（channel 异步加载，useState 初始值只跑一次）。
- 下拉选择约定（2026-07-29 起）：原生 `<select>` **弃用**（弹出面板由 OS 绘制、无法适配主题），一律用 `components/ui/Select`（options 数组传入；触发器视觉对齐 `.input`，面板 portal 到 body、fixed 定位、z-index 100，键盘导航 + listbox ARIA，零动画全 token；样式类 `.select-*` 在 theme.css，规范见 style-guide §4.6）。theme.css 的 `color-scheme` 声明保留（滚动条等原生控件仍需按主题渲染）。
- 所有 API 模块返回的响应数据结构需与后端约定一致（如 `{ success, data }` 或 `{ data, total }`）。
- **F6 派生口径铁律（决策 1，2026-07-28 分析文档）**：WU 状态/证据的展示一律过 `@dommaker/studio-shared` 的 `deriveDisplayState()`（列表页徽章/计数/按钮、抽屉详情/REQ 链路节点、RequirementChainPanel；进度统计用 `workFinished` 所有权口径）——禁止各自读 `metadata.attestations` 自行解释。#126（T4）起 `pending`（待确认人闸）透传为第七列且 needsHuman=true。列表页「待人工」pill = 派生过滤（done ∧ ¬l3 + 手写 in_review）；done 缺 l3 显示「确认」按钮（服务端幂等补写 l3）；`SelfReviewBadge`（components/workunit/）标记自评（评审 WU 自身 selfReview / 父 WU 台账 l2.selfReview）。MonitoringPage「证据台账」区块读 `/monitoring/overview` 的 evidence 段。
- **analysis 确认弹窗（#106 M7 对齐，2026-08-12；同日抽共享件）**：analysis 单的「通过/确认」走共享弹窗 `components/pmo/AnalysisApproveDialog`（三入口共用：WorkUnitListPage 行按钮 / WorkUnitDrawer 确认按钮 / DeliveryPanel 缺口「人工确认」）——`mapUtils.buildMapOpeningPrefill` 把 agent COMPLETE 落档的 metadata.analysisDestination/analysisFog 还原为 `DESTINATION:`/`FOG:` 逐行预填（DeliveryPanel 的 gaps 无 metadata，开弹窗时 best-effort 拉 WU 详情取），人审改后作为 `reviewPassed(id, summary)` 第二参穿透 l3 台账（api 层 trim 后为空 → 不带 summary 字段，行为同原一键通过）；清空清单直接通过 = 非探路型不开图。非 analysis 类型保持一键通过。**#177（#69 决议，2026-08-16）**：弹窗带 channelId 时加可选「默认执行角色」下拉（候选=频道成员，经共享件 `components/pmo/channelResponders.ts` resolveChannelResponders 解析，与 AgentLoop.observe 同口径；默认留空=涌现，不阻塞主交互），选中值作为 reviewPassed 第三参 defaultAssigneeId 穿透 → 应用于确认后全部派生 task 子 WU（三入口均已接线 channelId：列表行/抽屉直取 wu.channelId，DeliveryPanel 拉 WU 详情时一并取）；同批 `PublishProjectDialog` 加同构「指定分析角色」下拉 → projectApi.publish 第三参 assigneeId 落 analysis WU。
- **pending 确认入口（#126 T4，2026-08-15）**：扩范围单（feature/task/spec）创建落 `pending`（待确认人闸，引擎语义见本文 `apps/api/src/modules/workunit` 锚点），WorkUnitDrawer 对该状态显示「确认（进待认领）」按钮（`workunitApi.transitionStatus(id,'unassigned')`）；PMO 进度管道新增「待确认」泳道（pipelineUtils `PipelineLane` 第七值，列首），列表页状态过滤 `STATUS_OPTIONS` 增 pending；各处状态标签/配色表（WorkUnitDrawer/WorkUnitListPage/ProjectPipeline/ProjectActivity/mapUtils）均补 pending=待确认（u-warn 系）。**#184**：WorkUnitListPage 支持 URL query 初始化状态筛选（`/workunits?status=blocked`，首载读一次经 useSearchParams → setStatusFilter，合法值限 STATUS_OPTIONS），供监控页「需要处理」区下钻。
- **PMO 页（决策 2/4 + PMO-b）**：PMOPage 有「新建 PMO」表单（标题/需求描述/工程多选/交付策略，projectApi.create）；卡片显示杂务徽章与交付策略。**工单 33 拆分（2026-08-07）**：PMOPage 只留列表+两个 tab（约 400 行）；三个自包含弹窗抽至 `components/pmo/`——`CreateProjectDialog`（新建 PMO，含工程扫描，open 时触发 discover；**#114 T8 工程改 checkbox 多选**——≥2 个选中走 `gitRepos` 多工程入参（每工程一条交付腿），单个选中仍走旧 `gitRepo` 入参）、`CreateOkrDialog`（创建 OKR + KR 编辑）、`PublishProjectDialog`（发起需求讨论，选频道+响应 Agent 解析，props = open/projectId/channels/onClose/onPublished）；OKR 度量纯函数与常量（getCurrentQuarter/parseIdArray/KR/METRIC_TYPE_OPTIONS/METRIC_META/validateKRTarget）抽至 `components/pmo/okrMetric.ts`。ProjectDetailPage 头部显示 REQ 别名/分支/交付策略，「📦 交付」区块 = `components/pmo/DeliveryPanel`（Card 7 抽取；props = projectId / delivery / onRefresh 回调）：台账（WU 完成度 + 三层证据缺口 + missing 清单）、auto-merge 显示交付合并按钮（human-only，409 缺口/冲突内联展示）、branch-only 只显示自行合并说明；缺口行动（重跑 L1 / 派发 L2 / L3 人工确认）的状态码→toast 矩阵集中在面板内（verify 422→hint / verify 409→无 worktree / dispatchReview 409→info，单测覆盖）。
- **PMO 驾驶舱（2026-07-31，§5.5/§5.6/§10）**：ProjectDetailPage 自上而下 = 头部卡（原始需求可折叠块 + 状态 stepper 讨论→进行中→待验收→已交付 + channelId「去频道」）→「🚦 进度管道」（`components/pmo/ProjectPipeline`：总进度条 x/y（workFinished 口径）+ 待确认/待认领/执行中/评审中/阻塞/已完成六泳道（待确认 = #126 pending 人闸，扩范围单创建落点）；数据 = `requirementApi.getChain(reqAlias)`（§10 起条目自带 id/title/status/assigneeId/metadata + type/createdAt/claimedAt/completedAt，原逐 WU `workunitApi.get` N+1 补全已移除）+ `monitoringApi.getAgentSummary()` 名册解析认领人（assigneeId=instance.id → name，点击 →`/agents/:roleId`）；泳道/徽章走 deriveDisplayState 派生列，纯函数在 `components/pmo/pipelineUtils.ts`）→ 交付台账（`components/pmo/DeliveryPanel`，gaps 每行加「查看 WU ›」→`/workunits/:id`）→「📈 项目进展」（进度条取 project.progress + WU 链路六卡统计，仅 delivery 存在时渲染）→「🕐 项目动态」（`ProjectActivity`，buildProjectTimeline 拼 chain WU 时间戳 + deliveredAt，倒序 ≤20 条）。**Card 7（2026-08）**：老 Task 看板 / 执行历史 / 双轨统计（tasks 五卡 vs WU 六卡 if/else）已从页面删除，WU 链路为唯一口径；`/tasks?projectId=` 前端 fetch 一并移除——后端 `/tasks` API 与存量数据（16 条 legacy task，11 条 pending）刻意保留，仍可从 API 访问。§10 去重：「📈 项目进展」卡内旧四节点 stepper 已移除（与头部 stepper 重复，进度条/统计卡保留）。PMOPage 卡片徽章（§5.6）：列表加载后对可见项目并行 getChain（WU x/y），allSettled 失败静默、0 值不显示。**#149（2026-08-15）document-store 退役**：页面原「📚 知识库」文档区（KnowledgeDocGrid 三列网格 + DocReaderDrawer 抽屉 + 「归档知识」/「模式识别」按钮）、PMOPage 📄 文档计数徽章、KnowledgeImportPage 冷启动导入向导一并摘除。
- **MarkdownBody 统一渲染（2026-07-31，§10 任务 4b）**：`components/knowledge/MarkdownBody.tsx` = react-markdown + remark-gfm（新依赖；默认不渲染原始 HTML，agent 产出按不可信输入免 DOMPurify），components 映射到 u-* 类/CSS 变量（--bg-tertiary/--border-subtle）适配暗色，不引 typography 插件；`[[wiki 链接]]` 预处理为 /library/<title> 站内 router Link（#155 起指向阅览室），外链 target=_blank。现消费方 = LibraryDocPage 正文（React.lazy 按需加载，fallback = 原 plain-text pre-wrap 形态；另一消费方 DocReaderDrawer 已随 #149 document-store 退役删除）。
- **工单 35 拆分（2026-08-07）**：Settings 8 个 section 组件化抽至 `components/settings/`——`ComputeSection`（算力接入：WorkspaceStatusBar + 加入算力 + TokenManager，JoinComputeDialog 开关状态内化）、`NotifyChannelSection`（Discord/企微/Telegram 三段合并为数据驱动 fields 数组，enabled 推导逻辑留在页面 props）、`NotifySyncStatusHint`（已同步/需重存提示）、`CompanySection`（公司名自动保存 + 无公司时创建，Company 类型由此导出）、`KnowledgeEntrySection`、`ThemeSettings`，页面只剩 secrets/通知/公司加载链路与 handleSave（244 行）。ProjectDetailPage 抽 `components/pmo/IdeGuideDialogs`（VS Code/Cloud IDE 两个指南弹窗 + steps 常量 + copyStep 内化）、`components/knowledge/KnowledgeDocGrid`（三列数据驱动：需求/设计规范/执行归档；已随 #149 document-store 退役删除）、`components/pmo/ProjectProgressCard`（进度条 + WU 六卡 + 证据警告条，evidenceGapSummary 内化），页面剩 381 行。**硬编码生产 IP 已消除**：IDE 地址走既有 vite env 配置通道（同 `VITE_API_URL` 惯例）——`VITE_IDE_SSH_HOST` / `VITE_IDE_CLOUD_IDE_URL`，缺省回退按 `window.location.hostname` 推导（`root@<host>` / `http://<host>:8443`）。
- **工单 34 拆分（2026-08-07）**：KnowledgePage 底部六类 Gap 展示卡片（Preference/BusinessRule/EnvSnapshot/DecisionChain/InteractionPattern/Resolution）抽至 `components/knowledge/GapCards.tsx`（纯展示，页面剩约 370 行）；KnowledgeGraphView 的图谱数据类型（KnowledgeNode/KnowledgeEdge/Layer/KnowledgeGraph）、简化 dagre 布局 `applySimpleLayout`、diff 影响分析 `analyzeDiffImpact` 与构建工具 `buildKnowledgeGraphFromAnalysis` 抽至 `components/knowledge/graphUtils.ts` 纯函数模块，视图组件（约 280 行）只留渲染并 re-export 类型门面（图谱唯一消费方 WikiPage 已随 #155 退役，组件暂留备用；函数 re-export 已于 lint B8 移除，无消费方，直接从 graphUtils 导入）。**#191（2026-08-16）孤儿清理**：零引用确认后 `KnowledgeGraphView.tsx` 与 `graphUtils.ts` 一并摘除（无专属测试文件，web vitest 570 全绿 + tsc-gate 无新错）。
- **PMO 发起讨论弹窗（2026-07-29）**：选频道后实时解析「会响应的 Agent」（与 AgentLoop.observe 同口径——channel.members 非空取成员交集；空则回退 profile.channels，空 channels = 全频道可见；数据源 listAllAgents 客户端过滤 active/非 studio），0 人可响应时显示 ⚠ 警示（不阻断发起）；确认后跳转该频道闭环。
- **频道线程内过程消息折叠（2026-07-29）**：ChannelDetailPage 线程回复里连续 ≥3 条「过程消息」聚合为一组默认折叠（`collapseProcessReplies`）；里程碑不折叠 = 人类消息 / 卡片消息 / NEED_INPUT 等待回复 / 最后一条回复（最新状态恒可见）。频道只留里程碑、过程可展开——防止 agent 每步 summary 淹没讨论。
- **通知/消息可点击跳转（2026-07-31，§5.7）**：NotificationBell 从 SSE payload 取 `message.workUnitId` + `message.meta.pmoId`（老消息缺 pmoId → null，防御），每条通知右侧「WU」「PMO」直跳小按钮（stopPropagation + 标记已读 + 收起）；点本体优先级 WU 详情 `/workunits/:id` > PMO 详情 `/pmo/project/:id` > 频道。ChannelMessageItem 的 WU chip（仍开右抽屉）旁加「↗」直跳 `/workunits/:id`；`meta.pmoId` 存在时渲染「PMO ›」chip 直跳 `/pmo/project/:id`。
- **WU 进度状态面形态（2026-08-10，#61 决议，待实现）**：Web 是唯一进度状态面（CLI 不做）；频道消息只作「通知+入口」（`ChannelMessageItem` 的 WU chip 开抽屉已成立）。两档分工：WorkUnitDrawer 在 ExecutionSteps 之上加「当前状态速览」置顶节（状态/第 N 步·上限 M 步/最近 progress 摘要/失败原因/累计 tokens，大白话标签不渲染进度条，≥80% 预算给平实提示），WorkUnitDetailPage 保持全量步历史，同组件复用。实时=SSE 流式只看直播不落盘，追溯=步粒度事件流（失败态事件依赖 #60），两层不求等价。MonitoringPage 只做全局/趋势/检索，与单 WU 面只链接下钻、不互嵌组件。**WU blocked 复活/关闭按钮通道（#185，决策 #87，2026-08-16 落地）**：共享件 `components/workunit/BlockedActions`（抽屉速览档 + 详情页全量档同一组件）——「继续执行」仅卡住型 blocked 显示（waitingForInput 缺省/false；NEED_INPUT 型维持 waitingQuestion 引导回复），调 `POST /workunits/:id/resume`（与频道回复共享复活原语，纯授权占位文案）；「关闭任务」全 blocked 类型显示 + ui/ConfirmDialog 二次确认（danger），调 `POST /workunits/:id/close`（decision/spec 无 closed → 409 内联错误文案）；动作成功经 onChanged 回调重拉详情。
- **PMO 地图区（#114 T8，#106 子票）**：ProjectDetailPage 在头部与进度管道之间插「👉 下一个该干什么」（`NextActionCard`），管道后插「🗺️ 地图」区（`ProjectMap`：目标 / 待决问题清单 / 结论时间线 / 任务单依赖图；project.map 缺省=非探路型不渲染）。**「下一个该干什么」排序细则**（`mapUtils.pickNextAction`，改动须同步此处）：候选 = 列表 API `claimable=true`（未指派+依赖已清）且 metadata.pmoId 属本 PMO 的单；① 决策单（type=decision）优先，按地图待决问题顺序（fogId 不在图中排末尾、创建时间兜底）；② 其余按创建时间升序。**待决问题徽章口径**（`mapUtils.resolveFogBadge`，以实际数据为准）：已定 = fog resolved；待确认 = 决策单 in_review（结论已提待人工拍板，页面按 fog.wuId 逐个 best-effort 拉 WU 状态，拉不到按待认领兜底）；讨论中 = fog in-discussion 或决策单 active/waitingForInput；待认领 = 未建单（wuId=null）或单未认领。依赖图只列有依赖（metadata.blockedBy 非空）的任务单，依赖对象跨 PMO/已删显示「找不到这张单」。文案不用行话（fog=待决问题、blockedBy=依赖、decision=决策单，#53/#74 偏好）。
- **claimable 列表/详情 UI 消费（#116，2026-08-18）**：WorkUnitListPage 对 `status==='unassigned' && claimable===false` 的行置灰（opacity 0.55）+「被阻塞」徽标（u-warn 系，悬停 title 列依赖 id，行内展开渲染 `BlockedByList`）——**坑：服务端对非 unassigned 行 claimable 恒 false**（workunit.routes.ts 口径），UI 必须叠加存储状态判定否则全表误标。WorkUnitDetailPage 在巡检机会清单后插「依赖与验收」卡（`BlockedByList` + metadata.ac 验收标准清单，两者皆无不渲染）。PMO 侧无改动：PMOPage 本体无内嵌任务单列表（仅项目卡片），ProjectMap 依赖图已覆盖依赖可见性。
- **工单 36：ui 通用件 + 确认/跳转改造（2026-08-07）**：`components/ui/` 新增 `Button`（loading 态：禁用 + aria-busy + `.btn-spinner` 内联转圈，类体系对齐 theme.css `.btn/.btn-{variant}/.btn-sm`）与 `ConfirmDialog`（复用 ui/Modal + Button；danger 危险态、`cancelLabel={null}` 单按钮 alert 模式、loading 防重复提交），替代原生 `window.confirm`/`alert`——AgentDashboardPage 与 AgentDetailPage 的「强制停止」、ChannelListPage 创建失败提示均已接入。SPA 内 `window.location.href` 整页跳转全量改 `useNavigate`（LandingPage 登录重定向、AuthModal 登录成功、KnowledgeEntrySection 知识库入口、PmoNumberLink）；唯一保留的 `location.href` = AuthModal 的 OAuth 提供方授权跳转（站外地址，必须整页离开，已注释）。


## packages/studio-agent

> 最后更新: 2026-08-15
> Agent 执行器 — session loop 模型 + git worktree 隔离 + 文件桥上下文传递

### 职责

Sub-agent 的完整生命周期管理：创建隔离 worktree → spawn Claude Code → session loop 监控 → 完成判定。

### 核心导出

| 导出 | 说明 |
|------|------|
| `AgentRunner` | 统一执行器：session loop（execute）+ 轻量单 session（executeLightweight）+ stop |
| `agentRunner` | 单例实例；stop() 所有权唯一在此（runningProcesses 只在本类注册，Discord /studio stop 与 monitor-probes 都调它） |

> 2026-08：旧 `AgentExecutor`/`agentExecutor`（services/session-manager.ts）为 runner-* 拆分前的死代码双胞胎，无生产调用方，已删除；`AgentTask`/`ExecutionResult` 等类型移至 `src/services/types.ts`。
> 2026-08：`AgentCompleter`/`agentCompleter`（services/agent-completer.ts，229 行）整模块零引用，已删除；`AgentConfig`/`AgentCapabilities` 等无人消费的类型导出同步移除（apps 各自本地重定义同名 interface，未从包导入）。

### 执行模型

#### Session Loop

不信任 Claude Code exit code。改读 `.progress.json` 判断完成：

```
execute(task):
  git worktree add → REQUIREMENTS.md → loop:
    spawn Claude Code → wait (30 min timeout) → read .progress.json
    allComplete=true ∧ testsPass → 成功退出
    allComplete=false → 自动 re-spawn
    session≥5 → 失败，Level 3 告警
```

#### Worktree 文件布局

```
worktree/
  REQUIREMENTS.md        ← AC + 约束（session 间不变，文件桥）
  .progress.json         ← 进度快照（session 间唯一变化）
  .review-report.json    ← 审查报告
  .prompt.md             ← 当前 session prompt
  .agent.log             ← Claude Code 输出日志
  src/                   ← 代码变更
```

#### .progress.json 格式

```json
{
  "taskId": "xxx",
  "allComplete": false,
  "sessionCount": 2,
  "currentStep": "implement-ac-2",
  "completedSteps": ["ac-1"],
  "testResults": { "passed": 8, "failed": 2, "total": 15 },
  "notes": "working on null check"
}
```

#### Session Prompt

- Session 1: 全量 prompt（约束注入 + TDD 指令 + 读 REQUIREMENTS.md）
- Session 2+: 极短续接（"读 REQUIREMENTS.md + .progress.json，继续从 {currentStep}"）

#### Spawn env 约定（2026-07-30）

`buildSessionEnv`（runner-params.ts）在 `process.env` 基础上补 `IS_SANDBOX=1`（host 已设则尊重 host）：cwd 的 `.claude/settings.json` 声明 `bypassPermissions` 时，claude `--resume` 续用会话会自注入 `--dangerously-skip-permissions`，而 root guard（`getuid()===0 && IS_SANDBOX!=="1"`）直接 exit 1 —— root 机器上同 WU 第 2+ step 曾全部秒败（2026-07-29 review WU 三连败实锤 + 最小复现验证）。IS_SANDBOX=1 是 CLI 预留的沙箱声明，不放宽任何权限（settings 本就声明 bypassPermissions）。

`buildSessionEnv` 另按 provider 补 env（#147，2026-08-15）：provider=kimi 且 `<worktree>/.kimi-code/config.toml` 存在时注入 `KIMI_CODE_HOME=<worktree>/.kimi-code`（kimi 多 WU 隔离：per-worktree home 由 provider-hooks 生成，凭证软链复用 host，不动 HOME——PIT-019 教训）。home 未生成（kimi 未装/生成失败）则不注入，回落全局 home。

### 步内前置拦截层（#147，2026-08-15）

`services/provider-hooks.ts` = per-provider 执法配置生成器（#138 §4.3「执法面=写 provider 配置的一方」），由 `propagateHarnessConfig` 每次 worktree 创建时调用，幂等：

| provider | 执法面 | 载体 | 语义 |
|----------|--------|------|------|
| claude | `permissions.deny`（`--print` 下 hook 不触发、deny 已实测生效） | `.claude/settings.json`（幂等合并，保留既有字段） | 3 条静态命令（rm -rf * / git push --force* / git reset --hard*）+ 越界写（`~/.studio/**`、主仓库 repoDir 绝对路径） |
| codex | 原生 PreToolUse hook | `.codex/hooks.json`（项目级，per-worktree） | CommandGate block 级 exit 2 阻断（`exec --json` 生效，需 trust 门 bypass，见下） |
| kimi | 原生 PreToolUse hook | `<worktree>/.kimi-code/config.toml`（host 配置复制 + hook 追加；credentials/oauth 软链复用 host）+ spawn env `KIMI_CODE_HOME` | 同上（`-p` 生效） |

hook 统一指向 `@dommaker/harness` 包内出厂 shim `dist/pretool-use-hook.js`（require.resolve 解析，#154 起不再生成 worktree 内脚本；stdin JSON → CommandGate.isAllowed → exit 2）。`.codex/`、`.kimi-code/` 已入 `GIT_EXCLUDE_PATTERNS`；`.studio/` 自 #154 移出 exclude（纯文档正本整体进 git）。黑名单规则本身不在此改（harness 仓另议）。已知限制：agent 运行中可改写自己 worktree 内的执法配置（deny-only 执法面边界，worktree 重建时 propagate 幂等自愈）。

**codex trust 门（0.147.0 实测，D7）**：非 managed command hook 须先 review+trust 才运行，exec 无人值守下未信任一律静默跳过（trust 按 hook hash 持久化，worktree 路径每 WU 不同，无法预信任）→ codex spawn 模板（studio-shared providers.ts）携带 `--dangerously-bypass-hook-trust`（官方定位：已自行审查 hook 来源的自动化）。本机实证：无 flag 时 SessionStart marker 不跑、有 flag 即跑；PreToolUse exit 2 端到端真拦。

### 依赖

| 依赖 | 说明 |
|------|------|
| `@dommaker/harness` | buildConstraintPrompt() + checkBeforeExecution() + CommandGate（#147 前置拦截 hook 脚本引用其 dist） |
| `@dommaker/studio-shared` | logger |

### 事件

| 事件 | 说明 |
|------|------|
| `agent.progress` | 每个 session 开始时发布，含 phase/session/maxSessions |
| `agent.heartbeat` | 每 5 分钟发布，含 runningDuration/currentStep |
| `agent.completed` | 全部完成时发布 |
| `agent.failed` | 会话耗尽时发布 |

### 关键配置

| 配置 | 默认值 | 说明 |
|------|:---:|------|
| `sessionTimeoutMinutes` | 30 | 单次 session 超时 |
| `maxSessions` | 5 | 最大 session 循环次数 |
| `heartbeatIntervalMinutes` | 5 | 心跳间隔 |
| `dockerImage` | claude-code:fast | Claude Code Docker 镜像 |


## packages/studio-agent/src

### 职责

提供 Agent 执行引擎的核心能力，包括统一执行器（AgentRunner）与 Agent 注册中心（AgentRegistry）。负责将 provider 抽象参数转化为 CLI 参数（cli-adapter），管理 session 循环与轻量执行路径，并收集输出与指标。

### 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `AgentRegistry` | services/agent-registry.ts | Agent 注册中心，支持注册、发现、缓存、Schema 校验 |
| `AgentRunner`, `agentRunner` | services/agent-runner.ts | 统一执行器（execute / executeLightweight / stop / stopProcessGroup / stopAllProcessGroups），支持流式 JSON 输出；stop() 所有权唯一（runningProcesses 只在此注册）；#178 `stopProcessGroup` = kill(-pid) 杀整进程组（fencing 易主/租约场景，ESRCH 跳过、非 ESRCH 回落单杀）；#179（#66 决议 2）`stopAllProcessGroups` = 优雅关闭时 SIGTERM 杀全部注册进程组并清表（不等 step 落盘，api shutdown 调用） |
| `buildSpawnArgs` | cli-adapter.ts | 纯函数，为指定 provider 构建 CLI spawn 参数（command + args） |
| 类型 `Provider`, `SpawnParams`, `SpawnArgs` | cli-adapter.ts | CLI 适配相关类型 |
| 类型 `AgentMetadata`, `JSONSchema` 等 | types.ts | Agent 元数据、JSON Schema 等类型定义 |
| 类型 `AgentTask`, `ExecutionResult`, `ExecutorConfig`, `PrerequisiteCheck` | services/types.ts | 任务、执行结果与执行器配置类型（原 session-manager.ts） |

### 依赖关系

**上游（本目录依赖）**:
- `@dommaker/studio-shared`（核心库：logger, eventBus, FileStore, parseStreamEvents, resolveProviderDefinition, buildArgsFromTemplate 等）
- `@dommaker/studio-shared/node`（execSh, resolveSessionId, readSessionIdFile, resolveVpsWorkspace）
- `@dommaker/studio-shared/harness`（parseSessionMetrics、extractProviderUsage）
- `@dommaker/studio-shared/harness/hooks`（beforeAgentExecute）
- `uuid`（生成唯一标识）
- `ajv`、`ajv-formats`（JSON Schema 校验）

**下游（依赖本目录的模块）**:
- `apps/api` 的 daemon 层（session-manager.ts）和 modules/agents、modules/discord 等路由/循环模块

### 注意事项

- **零行为变更原则（已完成）**：runner-* 拆分（runner-params / runner-output / runner-execution / runner-lightweight）全程保持公共 API 不变；2026-08 删除死去的 AgentExecutor 双胞胎（session-manager.ts，821 行，execute() 为 executeSessionLoop 的重复实现、无生产调用方）完成该重构。唯一行为变化：Discord `/studio stop` 之前调 `agentExecutor.stop`（独立空 map，静默 no-op），现指向 `agentRunner.stop`，停止真正生效。
- **类型归属**：`ExecutorConfig`/`AgentTask`/`ExecutionResult`/`PrerequisiteCheck` 定义在 services/types.ts，由 agent-runner.ts 门面 re-export；外部经 `@dommaker/studio-agent` 包入口导入不变。
- **worktree 拆分明细（2026-08-04）**：scaffolding 写入（writeRequirementsMd/writeContractTests/ensureDeps）位于 worktree-scaffolding.ts，经 worktree-resolver.ts re-export，消费方导入路径不变；prompt 构建与执行前置检查拆为 prompt-builder.ts / prerequisite-checks.ts。
- **避免循环依赖**：拆分后的子模块（runner-params、runner-output、runner-execution、runner-lightweight、prompt-builder、prerequisite-checks）不得反向依赖 agent-runner.ts 的类；状态通过 `RunnerExecutionState` 接口传入，公共类型一律从 types.ts 导入。
- **Session 循环与轻量路径**：AgentRunner 提供两套执行路径：多 session 循环（runner-execution.ts）和轻量单 session（runner-lightweight.ts），后者跳过 SDD 解析、REQUIREMENTS.md、contract tests、Iron Laws、依赖缓存等，适用于简单任务。**#171（#54 决议 A1）**：runner-lightweight 的 execSh 调用恒开 `killProcessGroup`（杀步 = 杀进程组，#68 实测 SIGTERM 杀不死孙进程），并按 AgentTask `silenceWarnMs/silenceKillMs/onSilenceWarn` 透传静默看门狗（判据 = 距最后一次输出间隔；agent-loop 配 300s warn / 600s kill + 1800s 墙钟兜底）。
- **runner-briefing（Wave-4 拆分）**：`buildCachePrefix`（CACHE_PREFIX.md）、`writeRequirementsMd`（REQUIREMENTS.md）、`writeContractTests`（__tests__/ 契约测试）从 worktree-resolver 移至 services/runner-briefing.ts——"agent 被告知的内容"的文件桥，与 runner-params.ts 的 buildPrompt 配套（prompt 文本直接引用 REQUIREMENTS.md）。worktree-resolver 现在只保留 git/依赖生命周期（resolveWorkspace / createWorktree / ensureWuWorktree / ensureDeps / propagateHarnessConfig）。唯一调用方是 runner-execution.ts。
- **runner-output spawn 尾部管线（Wave-4 抽取）**：`processSessionOutput(stdout, ctx)` 收敛了 runner-execution 与 runner-lightweight 两处近乎逐字的尾部序列——写 .agent.log → stream-json 解析（extractResult/extractUsage）→ tool:call/file:change 事件 → recordSessionMetrics → session:end。两处差异经 ctx 传入（agentRole/stage/sessionCount/isFirstSession/promptSize/sessionMs）；isError 告警与分支保留在调用方（execution 告警后续接循环、lightweight 返回失败），execution 的跨 session token 累计基于返回的 streamUsage 完成。**#134：ctx 增 `provider`，非 claude provider 的 streamUsage 改走 `extractProviderUsage`（opencode/codex 事件形态 extractUsage 吃不下），claude/缺省行为不变。**同文件另有 hasRecentActivity（stuck 延期判定）与 queryResolutionHints（RKB）。
- **VPS workspace 解析（2026-08 seam 修复）**：worktree-resolver 的 resolveWorkspace Priority 2 不再手扫 `~/.studio/workspaces/*.json`，改调 `@dommaker/studio-shared/node` 的 `resolveVpsWorkspace()`——'VPS' 命名约定（name='VPS' 且无 tokenId）的唯一属主在 studio-shared（apps/api workspaces 模块的 local-workspace 也走它），重命名 VPS workspace 的行为变化只影响该函数。
- **provider-hooks（#147 步内前置拦截层，2026-08-15；#154 改指 harness shim）**：`services/provider-hooks.ts` = per-provider 执法配置生成器，由 propagateHarnessConfig 调用（幂等）。claude 走 `.claude/settings.json` permissions.deny（--print 下 hook 不触发、deny 实测生效）；codex 走项目级 `.codex/hooks.json` PreToolUse；kimi 走 `KIMI_CODE_HOME` per-worktree 隔离 + config.toml [[hooks]]。codex/kimi 的 hook 统一指向 `@dommaker/harness` 包内 `dist/pretool-use-hook.js`（#154：harness 包出厂 shim，studio-agent 不再生成脚本；旧版 `<worktree>/.studio/command-gate-hook.js` 由 removeLegacyHookScript 自愈清理，kimi 旧配置按 fragment 全串匹配重写迁移）。buildSessionEnv 按 provider=kimi 且 home 已生成时注入 KIMI_CODE_HOME（runner-execution / runner-lightweight 传 worktree）。codex spawn 模板的 trust 门 bypass flag 见本文 `packages/studio-shared` 锚点。
- **Cache 与性能**：AgentRegistry 使用外部 CacheStore（如 Redis），注意 TTL 和缓存键约定（`agent:` 前缀）。


## packages/studio-audit/src

### 职责

提供审计日志的记录、查询、统计与导出功能。通过 `AuditService` 进行持久化日志操作（JSONL 存储）。

### 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `AuditService`, `AuditActions`, `AuditResources` | `services/audit-service.ts` | 核心审计服务，提供日志记录、查询、统计功能 |
| `AuditLogInput`, `AuditLogQuery`, `AuditLogStats` | `services/audit-service.ts` | 审计日志输入/查询/统计类型 |

### 依赖关系

**上游**：依赖 `@dommaker/studio-shared`（FileStore, logger）和 Node 内置模块（path, os, fs）。

**下游**（以模块归并）：
- `apps/api/src/middleware/audit-logger.ts`：API 中间件，使用审计服务。
- `apps/api/src/modules/audit-logs/routes.ts`：审计日志路由模块。
- `apps/api/src/modules/auth/routes.ts`：认证路由模块。
- `apps/api/tests/security/audit-log.test.ts`：审计日志相关的测试。

### 注意事项

- 服务层 `AuditService` 默认将日志写入 `~/.studio/logs/audit.jsonl` JSONL 文件，依赖文件系统写入权限。


## packages/studio-capability/src

### 职责

本目录负责能力管理（CapabilityService）。CapabilityService 提供能力的 CRUD、同步、统计，并基于 FileStore JSON 文件存储实现（替代 Prisma）。

### 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| CapabilityService | services/capability.service.ts | 能力管理服务，负责能力的增删改查、同步与统计 |

### 依赖关系

**上游（本目录依赖）**
- `@dommaker/studio-shared`：提供 `FileStore`（JSON 文件存储基础）和 `logger`
- `@dommaker/harness`：提供 `getRegistryPath`（获取注册表路径）
- 标准库：`fs`, `path`, `os`

**下游（依赖本目录）**
- `apps/api/src/modules/capabilities/routes.ts`：API 路由模块，使用 CapabilityService

### 注意事项

- 能力数据存储在 `~/.studio/capabilities/{name}.json`，文件命名需唯一
- 所有时间戳使用 ISO 字符串格式（`createdAt`/`updatedAt`）


## packages/studio-notification/src

### 职责

本目录提供 studio-notification 包的核心代码，包含通知的创建、查询、标记，服务层基于 FileStore 实现持久化通知管理。

### 核心导出

| 导出 | 文件 | 说明 |
|------|------|------|
| `NotificationService`, `notificationService`, `CreateNotificationInput` | `services/notification-service.ts` | 通知服务类，支持创建、查询、标记（基于文件存储） |
| 全部导出 | `index.ts` | 导出 `services` 的所有内容 |

### 依赖关系

上游：依赖 `@dommaker/studio-shared`（FileStore, logger）、`node:path`、`node:os`。
下游：被 `apps/api` 模块引用，具体文件：`apps/api/src/modules/agents/auditor-execution.ts`、`apps/api/src/modules/notifications/routes.ts`。

### 注意事项

- 服务层 `NotificationService` 使用 JSONL 文件存储，路径固定为 `~/.studio/logs/notifications.jsonl`，注意文件锁和并发写入问题。
- `CreateNotificationInput` 的 `type` 为 `review_request | review_approved | review_rejected | system | auditor_suggestion`。


## packages/studio-shared

### 职责

跨 apps/packages 的共享层：provider 注册表（agent CLI 定义与 spawn 模板）、FileStore（全部运行时数据的文件存储）、eventBus、共享类型与工具、 harness 运行时。Node-only 能力经 `@dommaker/studio-shared/node` 子路径导出（读 fs，前端不可引）。

### 核心导出

| 导出 | 文件 | 说明 |
|------|------|------|
| `BUILTIN_PROVIDERS` / `ProviderDefinition` | `src/providers.ts` | 内置 4 个 agent CLI 定义（claude/kimi/codex/opencode；openclaw 为 config-only legacy）：binaries、versionArgs、healthProbeArgs、spawn 模板。**codex spawn 模板带 `--dangerously-bypass-hook-trust`（#147 D7：0.147.0 trust 门下非交互 exec 不跑未信任 hook；studio 经 propagateHarnessConfig 自行审查 hook 来源，详见本文 `packages/studio-agent` 锚点「步内前置拦截层」）** |
| `listScanProviders()` / `resolveProviderDefinition()` / `buildArgsFromTemplate()` / `buildHealthProbeCommand()` | `src/providers.ts` | 扫描清单、定义解析（含 GENERIC 兜底）、CLI argv 构建、健康探针命令 |
| `loadProviderRegistry()` / `resetProviderRegistryCache()` | `src/providers.ts` | 内置 + 用户覆盖（`~/.studio/providers.json`）深合并，带缓存；**新增 CLI 扩展点 = 写 providers.json，不改代码** |
| `FileStore` | `src/file-store.ts` | 全部运行时数据的文件存储（原子写 tmp+rename + mkdir 锁 withLock），baseDir 默认 `~/.studio/data`。门面包：类型在 `file-store-types.ts`，JSON/锁原语在 `file-store-base.ts`，WorkUnit 事件溯源在 `file-store-workunit.ts`，channels 编解码在 `channels-codec.ts`，frontmatter 在 `frontmatter.ts`，全部经 file-store.ts re-export。**#170（决策 #65）WorkUnit 锁内复合原语**：`commitSnapshot`（appendEvent+upsertSnapshot 同锁成对）/ `commitRemoval`（墓碑事件+移除同锁；closed+data.deleted=true 墓碑，rebuild 不复活）/ `updateMetadata`（锁内读最新 metadata→mutator→成对落盘，消读-改-写竞态）/ `createSnapshotGuarded`（锁内 check-then-create）/ `reconcileIndex`（events vs index 对账，不一致按事件流重建）。**#210 锁语义**：withLock 获锁窗口内 owner.json 写入 ENOENT = 锁目录被并发回收，自动重试获取（非致命错）；已知缺口：释放锁（finally rm）无属主校验，超时被回收方可能误删新持有者目录（待单） |
| `AgentProfileData` / `RuntimeStateData` | `src/file-store.ts` | Agent 身份模型（`{id,name,description,channels(废弃),status,provider,nodeId}`，**无 systemPrompt 字段**）与运行时实例模型 |
| `eventBus` | `src/event-bus*` | 进程内事件总线（agent-profile.created 等触发 AgentLoopRegistry mount） |
| `extractProviderUsage()` / `ProviderUsage` | `src/harness/provider-usage.ts` | #134 per-provider usage 提取器（harness 子路径导出）：claude modelUsage 优先 / opencode step_finish.part.tokens / codex turn.completed.usage / kimi stdout 无出口 → null；未知 provider 按 claude schema 兜底 |
| `deriveDisplayState()` / `parseAttestations()` / `withAttestation()` | `src/attestation.ts` | F6 信任证据模型（决策 1）：l1 自动验证 / l2 agent 评审 / l3 人工确认 + 唯一派生口径 |

### 约束

- **F6 派生口径铁律**：WU 状态/证据的所有展示与指标只准调 `deriveDisplayState()`（src/attestation.ts），禁止 UI/API/指标各自读 `metadata.attestations` 自行解释——口径分叉 = 可读性崩坏。改派生规则只能改这一个函数。
- **WorkUnit 写路径铁律（#170，决策 #65）**：events/index 写必须经锁内复合原语——快照写走 `commitSnapshot`（事件+索引同锁成对，禁止锁外分两步），删除走 `commitRemoval`（必须落 closed+deleted 墓碑，否则对账/重建会复活已删 WU），metadata 增量写走 `updateMetadata`（mutator 基于锁内最新值，禁止读时快照全量回写），带前置条件的建单走 `createSnapshotGuarded`。

### 依赖关系

上游：`@dommaker/harness`、`yaml`。
下游：apps/api 各模块、packages/studio-agent、apps/web（仅类型，不可引 `/node` 子路径）。

### 注意事项

- **类型消费走 dist**：package.json `types` 指向 `dist/*.d.ts`（runtime 入口才是 src），改本包类型后须 `pnpm --filter @dommaker/studio-shared build` 重建 dist，否则下游 tsc-gate 报 TS2339（新字段不可见）。
- **FileStore 目录布局**（`~/.studio/data/`）：`agents/{id}/profile.json` + `agents/{id}/state.json`（Agent 身份与运行时实例，永久存在仅可显式 DELETE）；channels/workunits 等同理按域分目录。其他相关路径：`~/.studio/providers.json`（provider 覆盖）、`~/.studio/workspaces/{id}.json`（workspace 记录，内嵌 runtimes）。
- provider 注册表是"装了哪些 CLI"的唯一权威定义：daemon 扫描（`apps/api/src/daemon/cli-scanner.ts`）、本地扫描（`local-workspace.ts`）、spawn（`cli-adapter.ts`）、健康探针（`agent-loop.ts`）全部从这里取定义，新增 CLI 只需 `~/.studio/providers.json`。
- FileStore 写操作全部原子写（tmp+rename），跨进程并发经 `withLock()`（mkdir 锁）。


## packages/studio-shared/src

### 职责

本目录是 Agent-Studio 的前后端共享库，提供 CLI 框架、配置管理、常量定义、事件总线与文件存储等通用基础设施，为 apps/api 等多个上层模块提供复用的工具与类型。

### 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `Parser`, `ParsedArgs` | cli/parser | 命令行参数解析，支持短参数、长参数、JSON 等 |
| `formatOutput`, `Format` | cli/formatter | 输出格式化 (table/json/csv) |
| `loadConfig`, `getConfig`, `StudioConfig` | cli/config | CLI 配置文件 (.studio/config.yaml) 加载与访问 |
| `registerCommand`, `getCommand`, `runCommand`, `Command` | cli/command | 命令注册与执行框架 |
| `formatError`, `createCliError`, `CliError`, `ERROR_CODES` | cli/error | 统一错误处理与格式化为字符串 |
| `loadConfigEnv`, `AgentStudioConfig` | config | 系统级配置加载 (~/.studio/config.env) 及类型定义 |
| `LEVEL_CONFIG`, `getLevelConfig`, `getLevelSalary` 等 | constants/levels | 全局统一的职级配置与辅助函数 |
| `eventBus`, `StudioEventBus` | event-bus | 内存事件总线，支持通配符订阅 |
| `AgentProfileData`, `RuntimeStateData`, `ChannelData`, `ChannelMessageData` 等 | file-store | 文件存储基础数据类型 |
| `EvolutionProposalData`（constraintChange: message/exception/new-entry/retire——retire 为 #82 D6 退役落点） | file-store-types | E1 进化提案类型 |
| `resolveVpsWorkspace`, `resolveWorkspacesDir` | vps-workspace（仅 /node 入口） | 'VPS' 工作区命名约定与 ~/.studio/workspaces 扫描的唯一属主（2026-08 起；worktree-resolver 与 local-workspace 均委托到此，禁止第三处手扫） |
| `studioDir`, `studioPath`, `defaultStudioDir`, `warnIfNonProdUsesProdRoot` | config/studio-dir（`./studio-dir` 子路径入口） | 数据根解析单入口（issue #89）：STUDIO_HOME 优先，缺省 ~/.studio；全部数据区读写必须经此，禁止新增 `os.homedir() + '.studio'` 硬编码 |
| `createSettledTracker` / `SettledTracker` | utils/settled-tracker.ts | #228 确定性等待原语（#158 先例抽取）：fire-and-forget 异步链（事件订阅消费 / best-effort 收尾）的在途登记 `track` + `waitForSettled` 等待（while 循环兜底级联），供测试替代盲等；消费方：pmo/progress-rollup、workunit.service（reviewPassed 收尾）、agents/loop/review-dispatcher、pmo/analysis-handoff |

### 依赖关系

**上游（本目录依赖）**
- Node.js 内置模块: `fs`, `path`, `os`, `events`, `crypto`
- 第三方库: `yaml`

**下游（依赖本目录的模块）**
- `apps/api` 全套模块（daemon、middleware、modules、index、cli 等）广泛引用本目录的 CLI 框架、配置管理、事件总线及 file-store 类型

### 注意事项

- CLI 命令注册表为全局单例，测试后需调用 `clearCommands()` 清理
- 配置优先级：环境变量 > `~/.studio/config.env` > 默认值，且仅当环境变量未设置时才加载 config.env
- 数据根：`studioDir()`（config/studio-dir）= `STUDIO_HOME` 或 `~/.studio`；config.env 与 `STUDIO_DATA_DIR ??=` 钉值均走它。dev 启动（scripts/dev/start.sh、apps/api dev script）默认 `STUDIO_HOME=~/.studio-dev`，prod systemd 显式 `/root/.studio`；非 production 指向缺省根时 `warnIfNonProdUsesProdRoot()` 落 warning（config/index.ts 初始化 + apps/api 入口显式调用，幂等）
- `studioDir()` 内含 vitest 内建模块双视图兼容层（resolveHomedir）：仓库测试对 `os.homedir` 有四种互不兼容的 mock 风格，该层保证迁移后的 SUT 在旧 mock 下仍被隔离；生产两视图恒等。测试收敛到 env 隔离后可删除（见 code-review follow-up）
- `FileStore` 使用 `flock` 目录锁（`mkdir` 原子操作）保障 claim 原子性；#169 起 withLock 持锁写 `owner.json`（pid/hostname/acquiredAt），EEXIST 时按双判据回收 stale 锁（同机死 pid / acquiredAt 或锁目录 mtime 超 30s），回收发 `lock.stale_reclaimed`、超时发 `lock.acquire_timeout`（均 warning，logger + eventBus，经 apps/api lock-events-bridge 走 dispatchMonitorAlerts 全管线）；同进程并发由进程内 per-lockDir mutex 排队不打到 mkdir
- `file-store-workunit.ts` 锁内复合原语（#170 起）：`commitSnapshot`/`commitRemoval`/`updateMetadata`/`createSnapshotGuarded`/`reconcileIndex`；#178 增 `refreshWorkUnitLease(wuId, expectedAssigneeId, expectedClaimedAt, timeoutAt)`——WU 租约心跳的锁内 fencing 写（claimedAt 代际令牌 + assigneeId 双比对与 timeoutAt 推前同锁原子），返回 'ok'/'lost'/'missing'，事件 data 走增量（reduce 合并语义）
- `FileStore` 的 readJson/readJsonl/readdir 走模块级读穿缓存（stat mtime 校验 + 写/删精确失效，工单 26 A1）；缓存命中返回结构克隆，调用方 mutate 返回值不会污染缓存；`readIndexFile` 保持无缓存（锁内跨进程正确性）
- `FileStore` 的 Requirement/Evolution 段共用泛型「序号分配型条目存储」实现（`SeqEntryStoreConfig`，工单 26 A2），新增同类存储应加配置而非复制段
- 事件总线支持通配符（`*`）模式订阅，Handler 异常不会影响其他监听器
- 级别常量为单一数据源，其他模块不应重复定义
- `constants/` 下各文件应保持无外部依赖（仅内部引用），便于前端复用
- `attestation.ts` 的 `deriveDisplayState()` 是 WU 展示状态唯一派生口径（F6 铁律，前后端共用）；#126（T4）起 `pending`（待确认人闸）为第七个看板列——按所有权状态原样透传且 `needsHuman=true`（人工确认才进 frontier），未知状态仍兜底 active
- `utils/process-io.ts` 的 `execSh`（仅 /node 入口）：#171（#54 决议）起支持 `killProcessGroup`（detached spawn + `kill(-pid, SIGKILL)` 整组直杀，墙钟/静默/maxBuffer 三条杀路径同走；#68 实测 SIGTERM 杀不死孙进程）与 `silence` 静默看门狗（判据 = 距最后一次 stdout/stderr 输出间隔，warn 每段静默恰报一次、输出复位；超 killMs 杀并 reject）。未开选项的调用方行为不变


## packages/studio-skill/src

### 职责

本目录是 Studio Skill 的核心模块，负责 Skill 的定义类型、从磁盘加载 Skill 定义（支持 frontmatter 解析和缓存）。为 Agent prompt 注入可加载的能力单元。内置 skill 库正本随包分发（`../skills/`，#223 起正本从数据区翻回仓库，`~/.studio/skills/` 降级为实例化副本），`seed.ts` 负责首启播种与 hash 升级。

### 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `SkillDefinition` | `types.ts` | Skill 类型定义，包含 id、name、description、agentTypes、requires、tools、prompt |
| `LoadOptions` | `loader.ts` | `load()` 的参数接口：agentType、exclude |
| `SkillLoader` | `loader.ts` | 技能加载器类，支持缓存（5 分钟 TTL）和懒加载 |
| `skillLoader` | `loader.ts` | `SkillLoader` 的单例实例 |
| `seedBuiltinSkills` | `seed.ts` | 内置 skill 同步：缺→拷贝、未改→覆盖升级、无台账且与正本一致→收养写台账（#225）、用户改过/无台账不一致→不动；best-effort 不 throw |
| `hashSkillDir` | `seed.ts` | skill 目录树内容 hash（sha256，排序相对路径+逐文件内容） |

### 依赖关系

上游：`@dommaker/studio-shared`（frontmatter 解析复用其 `parseFrontmatter`、`studioPath`）、Node 内置模块（`fs`、`path`、`os`、`crypto`、`url`）及同目录 `types.ts`（提供类型 `SkillDefinition`）。

下游：
- `apps/api` 模块：`review-agent.service.ts`、`prompt-builder.ts`、`skill.tools.ts`、`skill-loader.ts`、`index.ts`（启动 seed 钩）
- `packages/studio-agent` 模块：`runner-params.ts`

### 注意事项

- `SkillLoader.load()` 为同步方法，首次调用时扫描 `~/.studio/skills/<skillName>/SKILL.md` 目录，结果缓存 5 分钟后自动刷新。
- 技能目录路径可通过环境变量 `SKILLS_DIR` 覆盖，便于测试隔离。
- Frontmatter 解析统一委托 `@dommaker/studio-shared` 的 `parseFrontmatter`（简易行正则，不依赖 YAML 库），本包仅做 `SkillFrontmatter` 类型适配。
- `SkillLoader` 实例 `skillLoader` 是全局单例，导出时直接实例化，内部 `customSkillsProvided` 标记未在源码完整展现，但用于区分是否已手动注册自定义技能。
- seed 升级台账 = `<SKILLS_DIR>/.builtin-hashes.json`（name→内容 hash 中央文件，skill 目录与仓库逐字节一致）；seed 时机 = API 启动（`apps/api/src/index.ts`，有变更才重生成 MANIFEST）；仓库移除的 skill 本地留置转用户自有，用户删除的内置 skill 下次启动重建。


## packages/studio-spec/src

### 职责

本目录提供 Spec 的变更分析与门禁检查能力，是 Studio 中 Spec 质量管控与变更管理的核心模块。支持变更分级（L1-L4）与自动审批推荐，并实现门禁检查以管控变更上线。

### 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| ChangeAnalyzerService | services/change-analyzer.service.ts | 变更分析服务，检测变更类型、计算风险、确定级别、推荐审批流程 |
| ChangeHistoryService | services/change-history.service.ts | 变更历史服务，存储与查询变更记录 |
| GateCheckerService | services/gate-checker.service.ts | 门禁检查服务，执行检查点验证并管理分级策略 |
| isHarnessCheck, HARNESS_CHECK_TYPES | types/gate.types.ts | Harness 检查判断函数与类型常量 |
| 各类 TypeScript 类型（ChangeLevel, CheckpointType, GatePolicy 等） | types/*.ts | 变更、门禁等模块的类型定义 |

### 依赖关系

**上游依赖**：
- `@dommaker/studio-shared`（提供 logger）
- `@dommaker/harness`（动态导入，用于 Harness CheckpointValidator，可选）

**下游依赖**：
- `apps/api/src/modules/specs/routes.ts`（API 路由模块，调用本目录的变更与门禁服务）

### 注意事项

- 变更历史服务使用内存存储（`Map`），属于临时方案，后续需接入持久化存储（如 Prisma 或 FileStore）
- Harness 模块采用动态导入（`await import(...)`）以避免循环依赖，失败时降级跳过通用检查
- 类型定义中 `SpecContent` 没有定义所有字段（如 `api.schemas` 中的具体 schema 结构），需保持与解析器对齐
