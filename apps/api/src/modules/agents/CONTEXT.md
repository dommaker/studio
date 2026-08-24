# apps/api/src/modules/agents

### 职责

Agent 配置（profile）、运行实例（instance）、决策循环（loop）及内部审计 Agent（Auditor/Monitor/Knowledge/Triage/Ops）编排。REST API CRUD + 事件驱动自动挂载/运行/终止。

### 目录结构

- `loop/` - 决策循环与 WU 执行链（agent-loop 拆分、executor、completion-gates、wu-verification、execution-step-events、review-contract、lease-heartbeat、context-overflow）
- `auditor/` - Auditor Agent（service/rules/execution/reports）
- `monitor/` - Monitor Agent（service/probes/system-probes/alerts/reports/lifecycle）
- `ops/` - 进程级守护（ops.service/ops-rules/system-health）
- `knowledge/` - 知识维护 Agent（curator/cold-start/extraction/maintenance）
- `triage/` - Triage Agent（triage.service；incident-store = incidents.jsonl append-only）
- 根目录 - 共享与 CRUD：routes、types、agent-profile/*、agent-instance/*、token-usage/*、default-provider、default-triggers、system-executor、session-summary.service、requirement-gate

### 核心导出

- `monitor/` - monitor.service（门面，5min 轮询健康监控+渐进告警）、monitor-probes（WU 级探测：失败趋势/停滞/超时/池停滞/评审停滞/僵尸认领守卫）、monitor-system-probes（系统/知识级探测与自修复）、monitor-alerts（告警分发/Triage 升级，指纹冷却去重 w4h/c1h）、monitor-reports（轨迹评估/每日洞察/交互观察）、monitor-lifecycle（知识沉淀闸门+每日 TTL 清理）
- `auditor/` - auditor.service（门面，24h 日审跨任务审计）、auditor-rules（错误归类/技能建议/用户模型质量/知识健康）、auditor-execution（低风险自动应用/确认卡片/Resolution/Triage 升级）、auditor-reports（行为趋势/七日趋势/tier 反馈）
- `knowledge/` - knowledge-curator.service（门面，冷启动+每日维护）、knowledge-extraction（提取 prompt 单一来源）、knowledge-cold-start（四源导入 docs/code/git/manual）、knowledge-maintenance（语义去重/质量评估/过期验证/矛盾审查）
- `loop/` - agent-loop（循环编排，拆分后仅保留类逻辑+re-export）、agent-loop.types（类型契约，纯类型零运行时）、agent-loop-parsers（输出解析+prompt 模板纯函数）、agent-loop-events（tokens/tool:call 落盘，provider 分流 usage）、agent-loop-guards（测试 WU 守卫+excludeAssignee）、lease-heartbeat（WU 租约心跳 30s，fencing 校验）、context-overflow（溢出识别+滚动摘要）、executor（Executor 接口，LocalExecutor 委托 agentRunner）、execution-step-events（步级事件落盘+步内流式 SSE）、wu-verification（自动验证可复用实现）、completion-gates（收口守卫链：提交/子任务/验证/软观测）、review-contract（verdict 语义单一来源 pass/reject/needs-info）
- 根目录 - default-triggers（9 个系统 trigger：inspection-scan/dispatch-reconciliation/doc-semantic-review 等）、agent-loop.ts（门面，决策循环编排+re-export）、agent-output-parser（ACTION 协议解析/审查结论/任务拆分/动态间隔）、prompt-composer（prompt 组装，分段软定额截断）、agent-loop-workspace（worktree 解析/归属链/PMO 分支）、session-resume（续用判定+上限 MAX_SESSIONS_PER_WU=5）、agent-targeting（Observations->Target 解析）、default-provider（provider 默认选取）、instance-timeout-scan（心跳过期 5min 扫描+pid 复核）、dispatch-reconciliation（派工/评审断链 5min 对账）、workunit-token-events（tokens/tool:call 事件写入）、agent-loop-utils（进程存活/git 根/worktrees 工具）、wu-test-guards（测试特征 WU 判定）、agent-loop-instance-state（实例状态：启动失败/idle 心跳/忙闲 SSE）、agent-loop-record-result（recordResult：提交/子任务/验证+状态迁移+里程碑）、agent-loop-step-guards（前置守卫：测试 WU 关闭/token 预算熔断）

### 依赖关系

- 上游：`@dommaker/studio-shared`（eventBus/FileStore/logger）、`@dommaker/studio-agent`（agentRunner/AgentTask）、`../workunit`/`../knowledge`/`../triggers`/`../workspaces`/`../../core/event-store`、子模块 auditor/*
- 下游：`apps/api/src`（路由挂载+启动初始化）、`modules/knowledge`（依赖 knowledge-agent.service）、`modules/workunit`（waiting-input.ts 引用 agent 实例）

### 注意事项

- **AgentProfile 持久化**：`~/.studio/data/agents/{id}/profile.json` + `state.json`；原子写+mkdir 锁，仅可显式 DELETE；保留名 `studio`
- **prompt 注入 = index-on-demand**：skills 只注入 name+description+triggers+指针，正文不注入；知识分层（rule/context 全量、signal 索引、reference 报条数）；分段软定额+池内余量共享截断（persona 300/roster 400/skills 600/map 800/memory 300/knowledge 1000/files 400/contract 200/handoff 800）；段序 persona->roster->skills->map->memory->knowledge->files->base->contract->handoff->hint
- **三层超时**：步墙钟 1800s 兜底+静默看门狗（300s warn/600s 杀进程组）+maxTurns=50
- **Idle 心跳 45s**，超时扫描 5min；**isOnline** = loop 存活+心跳新鲜（≤5min）
- **多实例单活**：`STUDIO_AGENT_LOOP_ENABLED=false` 实例 standby；`AgentLoop.start()` 内置同角色单活守卫
- **SSE 负载含 channelId（2026-08-24 SSE 负载加深，批 1）**：`workunit.execution.step` / `workunit.execution.stream`（含 step-start）负载与 `workunit.tokens` SSE 信封 data 均携带 `channelId`（wu.channelId 透传，无频道 WU 缺省该键）——前端按频道过滤 step/token 事件的数据源；`workunit:tokens` 落盘后顺带经 eventStore.publish 发 SSE（best-effort，不落盘二次）
- **派单链**：WorkUnitService.create -> workunit.created -> TriggerScheduler -> AgentLoop.observe（15s 轮询兜底）-> 过滤 -> claim -> agentStep -> LocalExecutor -> spawn CLI -> recordResult -> 回帖（EventBus/SSE）
- **F4 review 派发**：父 in_review -> 建未指派 review 子 WU 走 claim 涌现；excludeAssignee 禁自领；同父唯一性 flock 锁
- **R3 评审契约**：评审子 WU scope = diff-only+`+code-review`；needs-info -> 转人工
- **不派评审类型**：decision/spec/analysis 走人工 in_review
- **F6 台账**：COMPLETE 前验证守卫写 l1；`POST /workunits/:id/verify` 人工重跑；`POST /workunits/:id/dispatch-review` 人工补派
- **WU 租约心跳**：每 30s 推前 timeoutAt（now+5min），锁内 fencing（claimedAt 代际令牌+assigneeId 双比对）；易主 -> 停跳+onLost
- **CLI 上下文溢出**：纯反应式 -> 滚动摘要落盘 -> 新会话带摘要重试 -> 再败 NEED_INPUT
- **子 WU 不继承会话簿记**：clearSessionBookkeeping 清除 14 字段（sessionId/startedAt/sessionResumes/sessionCount/lastSessionResumed/blockReason/stepCount/consecutiveStuck/errorType/errorDetail/errorAt/_cumulativeTokens/progressLog/sessionSummary）；新增簿记字段必须同步
- **鉴权**：POST/PUT = requireAuth()+requireNotGuest()；terminate = requireAuth()+requireAdmin()
- **频道发声**：里程碑+异常+每步简报+认领消息+步失败消息；认领/失败消息不过新鲜度检查
- **认领门槛**：纯显式，三门槛：assigneeId 排他+excludeAssignee+blockedBy 依赖门禁
- **失败步埋点**：recordOutcomeEvent 落 knowledge:outcome:failure/success
- **Auditor 零执行早退**：24h 零执行不 push 不记录不升级
- **WU 收尾提取**：订阅 done -> 读 transcript -> LLM -> 角色记忆草稿区；与 R3 并行独立
- `AgentLoopRegistry.mount()` 幂等不抛错；Agent 数据均 FileStore 存储；审计日志写 `~/.studio/logs/studio-events.jsonl`
- instance 忙闲 SSE：agent.instance.status_changed，内存去重
- A2A：ACTION: DELEGATE:@<profileName>:<scope> 建子单+发 delegate 卡片
