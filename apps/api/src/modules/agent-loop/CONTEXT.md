# apps/api/src/modules/agent-loop

> Updated: 2026-10-17（Phase 3 后端刀1/刀3：`agentStep` 四段与 `recordResult` 三阶段纯平移拆分，执行顺序与导出面不变）

### 职责

决策循环与 WU 执行链（P2-d 刀5 自 modules/agents/loop 提升为顶层模块）：AgentLoop 循环编排（observe → 过滤 → claim → agentStep → recordResult → 回帖）、prompt/上下文组装、WU 租约与心跳、步级守卫链与重试策略、完成收割与验证、评审派发、派工断链对账。

### 目录结构

- `agent-loop.ts` — 门面（导出面 = AgentLoop + AgentLoopOptions + StepContext + StepResult）：构造接线 + runLoop 主循环 + 公共用例薄委托。ARCH-05 删除 `loop/loop-host.ts` 可变 God Host；生产与测试走同一 interface。`AgentLoopOptions.instance` 是构造恢复输入，`currentInstance` 与 StepContext.instance 均为防御快照；`currentExecutionId/hasLease` 仅提供只读观测。
- `loop/loop-deps.ts` — 各段窄依赖端口：LifecycleDeps / ObserverDeps / ClaimDeps / StepDeps / ResultRecorderDeps，以及 WorkUnit/Discussion/Lease 小接口；不含可变共享状态。
- `loop/loop-lifecycle.ts` — 生命周期 owner：start/stop/waitForStop + 实例状态 SSE + #179 心跳连败自裁；instance/alive/订阅/心跳连败均由本类独占。start() 健康探针仍走 `core/exec-async.execAsync`。
- `loop/loop-observe.ts` — 观察段：observe 与事件唤醒；回复水位、pendingWake/wakeIdle 由本类独占，实例与 alive 仅经窄 getter 读取。
- `loop/loop-observation-coordinator.ts` — PERF-03 调度专用共享观察：按 FileStore 单例，同一 index version 的 WU/channel 读取、依赖 fold、全局排序只做一次，向 LoopObserver 分发角色过滤视图；claimable 事件失效与 15s 兜底共用 single-flight，不是通用系统状态快照。
- `loop/loop-claim.ts` — 认领段：claimAndAnnounce + 决策 14 适任判断链，仅依赖 ClaimDeps。
- `loop/loop-step.ts` — 步执行编排：`agentStep(StepContext)` 串起 step-guards / 频道版本锚点与下述四段，返回 StepResult；实例身份由 AgentLoop 在调用边界快照，currentExecutionId 由 StepRunner 独占。#705 起 Executor 前经 ExecutionJournal 持久化 running Assignment，StepResult 携带 assignmentId 供结果 fencing。
- `loop/loop-step-worktree.ts` / `loop-step-session.ts` / `loop-step-prompt.ts` / `loop-step-execution.ts` — worktree、会话、prompt、Executor 四段，统一只收 StepDeps；执行段经窄 callback 更新 currentExecutionId。session 丢失/上下文溢出的换会话重试同时 supersede 旧 Assignment、创建 session-replacement 链接轮次并更换 executionId；token、transcript、execution_step 均带 assignmentId，且写入前复核 currentAssignmentId，换代后的迟到产物不落 WU 公开历史。
- `loop/loop-record-result.ts` — 结果记录编排：recordResult 串起 skipped/fencing、合并视图、completion-gates 与三阶段；listUnfinishedChildren + postToDiscussionSpace 留本文件。
- `loop/loop-record-reply.ts` / `loop-record-persistence.ts` / `loop-record-events.ts` — DELEGATE/回帖、簿记原子写、写后事件与状态迁移；ARCH-03 的 WorkUnit `ExecutionJournal.recordStepResult` 语义命令不变，fencing 归 WuLeaseTracker。
- `execution-cwd.ts` — 执行目录解析三规则，deps 注入纯函数。
- `agent-loop.types.ts` — 类型契约：StepResult / StepContext（Target + 调用边界 instance 快照）/ Observations / Target / RuntimeInstanceRow。
- `agent-loop-registry.ts` — profileId→running AgentLoop 注册表（profile 生命周期事件驱动挂载/卸载；#634 provider 变更重挂）
- `agent-loop-parsers.ts` / `agent-loop-events.ts` / `agent-loop-guards.ts` — 输出解析+prompt 模板纯函数 / tokens/tool:call 落盘 / 测试 WU 守卫+excludeAssignee
- `step-guards.ts`（#541 入口守卫链：B2 测试 WU / #585 需求+AC / C3 日预算 / #162 WU 预算 / #471 plan 额度）、`step-retry-policy.ts`（#543 重试策略：#94 续用丢失降级 + #96 上下文溢出收敛为 runStepRetry 一份）
- `claim-fitness.ts`（认领前适任判断，决策 14；2026-09-25 起落 `agent:claim_fitness` 台账事件）
- `daily-token-budget.ts`（每日 token 预算熔断，C3）、`delegate-branch.ts`（A2A DELEGATE 分支委派）
- `prompt-composer.ts`（prompt/上下文组装编排：composeStepPrompt 段序与池共享 runSection、hint 读取/消费清除、base prompt 选择、knowledge 段、files 截断播报；#671 按组装段拆分后 318 行，拆分前公共面经 re-export 保持不变）、`prompt-quota.ts`（SECTION_QUOTAS 九段软定额 + BuiltSection + sliceToTokenBudget 截断共享件）、`prompt-sections/prompt-section-{persona,roster,skill,map,memory,files,contract,handoff}.ts`（八个注入段组装各居其文件；段模板正本 CONTRACT_TEMPLATES/INSPECTION_CONTRACT 居 contract 段文件）、`session-resume.ts`（#94）、`context-overflow.ts`（溢出识别+滚动摘要）
- `wu-lease.ts` / `lease-heartbeat.ts`（WU 租约/fencing 追踪器 #209 / 心跳 30s）
- `executor.ts`（Executor 接口，LocalExecutor 委托 agentRunner）、`execution-step-events.ts`（步级事件落盘+步内流式 SSE；#665 起 payload 类型与 studio-contract/sse-events.ts 同源——ExecutionStepEventPayload/ExecutionStreamChunk 是契约类型别名，改形状先改契约；#687 起 EXECUTION_STREAM_SSE_TYPE 常量正本亦收编契约（本文件 re-export 保持既有 import 路径），wire round-trip 行为校验见 events/__tests__/sse-payload-contract.test.ts）
- `wu-verification.ts`（兼容 re-export；ARCH-02 起独立实现下沉 `core/wu-verification.ts`，AgentLoop 与 WorkUnit 共用；SEC-01 固定模板 + WU worktree provenance 不变）、`completion-gates.ts`（收口守卫链）、`completion-harvest.ts`（#542 per-WU-type COMPLETE 收割注册表）、`result-bookkeeping.ts`（#655 recordResult 簿记段）、`review-contract.ts`（verdict 语义单一来源）
- `review-dispatcher.ts`（F4 review 派发）、`dispatch-reconciliation.ts`（派工/评审断链 5min 对账，P2-d 刀5 自 agents 根随迁——依赖 review-dispatcher + monitor-alerts，留 agents 会拉成 agents↔agent-loop 环）
- `__tests__/` — 62 个测试文件（agents root __tests__ loop 系 48 + 原 loop/__tests__ 9 + #668 新增 2：execution-cwd 直测 / loop-segments 段接线钉线 + #671 新增 1：prompt-composer-snapshot 全九段产出快照钉线 + ARCH-05 新增 1：loop-deps 窄依赖契约 + PERF-03 新增 1：共享观察协调/规模读取回归；段行为由既有测试网兜底）

### 核心导出

- `index.ts` — 模块公共出口 barrel：`agentLoopRegistry`、`getReviewDispatcher`、`getDailyTokenUsage`/`resolveDailyTokenBudget`/`tokenBudgetGuardEnabled`、`EXECUTION_STREAM_SSE_TYPE`、`CODE_WORKTREE_TYPES`/`resolveVerifyCommands`/`runWuVerification`、`reconcileDispatchBreaks`

### 依赖关系

- 上游：`modules/agents`（barrel：getSystemExecutor / MonitorAlertSource）、`modules/ops`（barrel：dispatchMonitorAlerts / loadCurrentWuContexts，#683 起 monitoring/agent-monitor 并入 ops）、`modules/workunit`、`modules/pmo`、`modules/channels`、`modules/skills`、`modules/knowledge`（ARCH-06 起 prompt-composer 经 `knowledgePorts.consume`，loop-step 经 `knowledgePorts.produce/track`）、`modules/requirements`、`modules/role-memory`、`modules/transcripts`、`modules/triggers`、`core/`（store/system-role/exec-async/host-execution-policy）、`utils/`、`@dommaker/studio-agent`、`@dommaker/studio-shared`
- 下游：`bootstrap/`（agent-loop/bridges/handlers/lifecycle 装配）、`modules/events`（sse.routes）、`modules/distill`、`modules/role-memory`（动态）。ARCH-02 起 WorkUnit 经 verification/review 端口调用，不再构成模块出边。

### 注意事项

- **worktrees 目录口径（P2-e，契约 §8 双口径收编）**：`resolveWorktreesDir` fallback 为 `WORKTREES_DIR > studioPath('worktrees')`（原 `~/worktrees`），与 bootstrap/config.ts 注入值同源；merge-on-review-pass / monitor-system-probes / system-health / discord / studio-agent agent-runner 同口径。
> 详细运行口径（派单链/唤醒加固/三层超时/租约心跳/#585 需求守卫/prompt 注入/会话术语等）随 agents/CONTEXT.md 注意事项区维护；以下为本模块强相关条目摘要。

- **多实例单活**：`STUDIO_AGENT_LOOP_ENABLED=false` 实例 standby；`AgentLoop.start()` 内置同角色单活守卫
- **#635 stop 语义收窄**：`AgentLoop.stop()` 只置退出意图（alive=false），不停租约心跳、不清租约轨道——在飞 step 全程租约保护；停心跳收尾统一在 runLoop 主循环退出点
- **#703 merge 交付防重**：ReviewDispatcher 对已有 mergeIntent/mergeReceipt 的 in_review 进度不派评审；对账 redispatch 与人工 dispatchReviewNow 同样拒绝 merge 交付中的 WU，避免 queued/running 或 unavailable 补 L3 时重复建评审子单。
- **#700/#701 plan 收割、分腿与 review 血缘**：plan COMPLETE 使用 spec TASK codec 收割逐任务 LEG/AC/BLOCKEDBY 到 `analysisTaskDetails`；prompt 输出约定要求非空 TASK 显式携带三项，归属不明先 NEED_INPUT。ReviewDispatcher 的子 WU reqId 优先继承父 WU 一等列，metadata.reqId 仅作 legacy 回退。代码 WU 已声明 `pmoBranch` 时腿解析失败、或任何 PMO 建支失败，均返回 `worktree_creation_failed`，不退默认 base。
- **step-guards 需求/AC 前置守卫（#585）**：仅实现类系统派生 WU 受检；豁免 = from-message/manual、metadata.triggerSource、requirementOverride=true；判定 = reqId + metadata.ac[] 缺一即 need_input 挂起；总开关 `STUDIO_REQUIREMENT_GUARD=false`（测试环境默认关）
- **#706 Mandate 预算与恢复重验**：WU token 与 plan 步数预算优先读 `wu.mandate.budget`，metadata 仅兼容旧单；claim、beginStep、会话替换与 NEED_INPUT 回复恢复前经 WorkUnit `assertExecutionMandate` 检查策略版本、撤销和当前仓库/腿，失败不得创建新 Assignment 或启动 Executor。
- **认领门槛**：纯显式三门槛（assigneeId 排他+excludeAssignee+blockedBy）+ 决策 14 适任判断；#579 总开关 `STUDIO_CLAIM_FITNESS=false`
- **completion-gates 零同步子进程（#374 + SEC-04）**：全部走 `core/exec-async.ts` 的 execFileAsync。dirty/HEAD 在 recordResult 同一 `withDirectoryCapability` 回调内完成；rev-list/git log/analysis report 同样走通用 capability（服务端 WORKTREES_DIR 下 worktree 不受 PMO 允许根限制）。capability 创建失败向外抛出、危险替换 fail-closed；capability 内普通 Git 故障保持原 fail-open 口径。
- **执行根目录（#481 + SEC-04/05）**：`resolveExecutionWorkspaceRoot` 唯一来源 = `metadata.workspaceRoot`；`wu.workspaceId` 无执行语义。worktree 创建/PMO 建支经统一 `withExecutionRepo` 持 repo fd；LocalExecutor 在 runner/CLI 全周期经 `withDirectoryCapability` 持最终工作目录 fd，返回的 worktree/logFile/outputFiles 恢复原路径，capability 不落 metadata。自动验证在 `assertTrustedWuWorktree` 后同样持 capability 完成 package.json 读取、模板选择与 `runHostCheck`，校验后替换 fail-closed 且零 spawn/零越界读取。SEC-05 起 capability 内的 provider CLI 另经 shared sandbox：目录 capability 负责宿主侧路径 provenance，`bwrap`+低权限身份+egress broker 负责不可信 CLI 步内边界，两层不互相替代。
- **会话术语（#637/#639）**：档案会话号（metadata.sessionId）vs CLI 会话号（metadata.cliSessionId）；续用一律按 CLI 会话号 id 形态点名（无则新建；失效走 #94 降级 + #95 前序进展段交接）
- **子 WU 不继承会话簿记**：clearSessionBookkeeping 清除 19 字段（含 #699 补入的 cliSessionId）；四种 provider 的 review 建单回归均断言真实 CLI 会话号不继承，新增簿记字段必须同步清单与测试
- **#467 裁决轮 / #567 方向锁定协议**：RULING/DIRECTION 行 → StepResult.rulings/directions → metadata.planRulings/planDirections；提交落地在 pmo/plan-ruling.ts、pmo/plan-direction.ts
- **观察/唤醒口径（#330/#493/#523 + B5）**：唤醒只放行不裁决，归属裁决归 observe；B5 回复检测改 `readChannelMessagesDelta` 字节水位增量读
- **PERF-01 token 写侧契约**：`writeWorkunitTokenEvent` 必须把 appendJsonl 的同一 event 对象传给 `noteTokenLedgerWritten`；账本只在旧 offset 到文件尾精确等于该 event 完整字节时 direct-apply，否则按 byte offset 补扫。direct 保留已有首尾内容锚点，读侧 `syncTokenLedger` 以 size + `dev:ino` + O(1) 首尾 SHA-256 锚点复核；copytruncate/轮转/截断后从事件流重建，调用方不得另传重序列化副本或用最终文件 size 冒充已处理 watermark。
- **F4 review 派发 / P7 总开关**：`STUDIO_AUTO_REVIEW=false` 闸两条自动路径；事件链失败 30s 进程内重试一次
- **PERF-02 step 簿记读取复杂度**：`loop-record-persistence → ExecutionJournal → WorkUnitMetadataRepository → updateMetadata` 调用链与 fencing 语义不变；FileStore 锁内改读 per-WU current projection + 精确匹配的 per-WU head，不再随 index 历史行全量 fold。租约 flush 同样逐 WU 点查 projection，zombie/非 active 丢弃纪律不变；events 半行时写路径 fail-closed，不粘连新事件。
- **PERF-03 共享观察（2026-10-29）**：`getLoopObservationCoordinator(fileStore)` 是调度器内唯一 WU/channel 观察源；本进程 index 写版本经 `FileStore.getIndexVersion()` O(1) 检查，claimable 唤醒主动失效，跨进程写与 channel 配置变更最迟由 15s 共享兜底刷新发现。全局 createdAt 双序、blockedBy fold 与 active 回复边界按观察各算一次；加载中 invalidate/indexVersion 推进会让新调用立即改挂新 single-flight，旧加载完成不得覆盖新 cache；assignee/channel.members/excludeAssignee/unfitRoles 仍在角色视图过滤，唤醒只放行语义不变。回复消息 delta 与水位不进共享缓存，仍属各 LoopObserver。10/50/200 角色 × 1千/1万 WU 回归断言同版空闲读取为 1、事件推进后总读取为 2，并记录 CPU/event-loop/唤醒峰值诊断；统一性能硬门留 PERF-07。
