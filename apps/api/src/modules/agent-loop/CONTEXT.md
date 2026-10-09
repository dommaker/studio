# apps/api/src/modules/agent-loop

### 职责

决策循环与 WU 执行链（P2-d 刀5 自 modules/agents/loop 提升为顶层模块）：AgentLoop 循环编排（observe → 过滤 → claim → agentStep → recordResult → 回帖）、prompt/上下文组装、WU 租约与心跳、步级守卫链与重试策略、完成收割与验证、评审派发、派工断链对账。

### 目录结构

- `agent-loop.ts` — 门面（导出面 = AgentLoop + StepResult；#544 拆除 re-export 门面；#363：原 start() 同角色 terminated 启动清理已拆除，回收归 instance-timeout-scan）：#668 按职责切五段后只留构造接线 + runLoop 主循环编排 + 对外/测试 seam 薄委托；段间共享状态与跨段调用经 `loop-host.ts` 的 AgentLoopHost 接口显式化（模块内部面，不经 index.ts 出模块）
- `loop-lifecycle.ts` — 生命周期段：start/stop/waitForStop + 实例状态 SSE（publishInstanceStatus/recordStartupFailure）+ #179 心跳连败自裁。start() 健康探针（`buildHealthProbeCommand` + 失败 recordStartupFailure）走 `core/exec-async.execAsync` 异步链（2026-10-03 D 批——原 execSync 在 listen 后 mount 链/profile.created 事件路径按角色串行阻塞事件循环）
- `loop-observe.ts` — 观察段：observe（§9.5 频道成员过滤 / #221 认领陈旧守卫 / 决策 10 显式认领 / B5 字节水位增量回复检测）+ 事件唤醒三件套（#330/#493/#523：idleSleep / onChannelMessageSent / onWorkUnitClaimable，只放行不裁决）
- `loop-claim.ts` — 认领段：claimAndAnnounce（#175 认领即发声，#445 委托 workunit/claim-announce）+ 决策 14 适任判断链（ensureClaimFit → recordClaimUnfit → blockIfAllMembersUnfit）
- `loop-step.ts` — 步执行段：agentStep 编排（step-guards → worktree/PMO 分支基线 → 会话续用 #94/#637/#639 → prompt-composer → Executor 执行 → step-retry-policy 重试 → token 记账/tool:call/transcript/步事件/R3 提取/#542 收割）+ #90 outcome 落账
- `loop-record-result.ts` — 结果记录段：recordResult（#178 fencing → completion-gates → delegate 分支 → §4.2 新鲜度 → result-bookkeeping 簿记 → F6-c 强制收口补验 → 原子写 → 状态迁移与频道通知）+ postToDiscussionSpace（频道系统消息唯一出口，经 host seam 供 claim/step 段共用）
- `execution-cwd.ts` — 执行目录解析三规则（#481 workspaceRoot 唯一来源 / B3b-i 父 worktree 继承 / 收口守卫 git cwd），deps 注入纯函数（`__tests__/execution-cwd.test.ts` 直测）
- `agent-loop.types.ts` — 类型契约（纯类型零运行时）
- `agent-loop-registry.ts` — profileId→running AgentLoop 注册表（profile 生命周期事件驱动挂载/卸载；#634 provider 变更重挂）
- `agent-loop-parsers.ts` / `agent-loop-events.ts` / `agent-loop-guards.ts` — 输出解析+prompt 模板纯函数 / tokens/tool:call 落盘 / 测试 WU 守卫+excludeAssignee
- `step-guards.ts`（#541 入口守卫链：B2 测试 WU / #585 需求+AC / C3 日预算 / #162 WU 预算 / #471 plan 额度）、`step-retry-policy.ts`（#543 重试策略：#94 续用丢失降级 + #96 上下文溢出收敛为 runStepRetry 一份）
- `claim-fitness.ts`（认领前适任判断，决策 14；2026-09-25 起落 `agent:claim_fitness` 台账事件）
- `daily-token-budget.ts`（每日 token 预算熔断，C3）、`delegate-branch.ts`（A2A DELEGATE 分支委派）
- `prompt-composer.ts`（prompt/上下文组装编排：composeStepPrompt 段序与池共享 runSection、hint 读取/消费清除、base prompt 选择、knowledge 段、files 截断播报；#671 按组装段拆分后 318 行，拆分前公共面经 re-export 保持不变）、`prompt-quota.ts`（SECTION_QUOTAS 九段软定额 + BuiltSection + sliceToTokenBudget 截断共享件）、`prompt-section-{persona,roster,skill,map,memory,files,contract,handoff}.ts`（八个注入段组装各居其文件；段模板正本 CONTRACT_TEMPLATES/INSPECTION_CONTRACT 居 contract 段文件）、`session-resume.ts`（#94）、`context-overflow.ts`（溢出识别+滚动摘要）
- `wu-lease.ts` / `lease-heartbeat.ts`（WU 租约/fencing 追踪器 #209 / 心跳 30s）
- `executor.ts`（Executor 接口，LocalExecutor 委托 agentRunner）、`execution-step-events.ts`（步级事件落盘+步内流式 SSE；#665 起 payload 类型与 studio-contract/sse-events.ts 同源——ExecutionStepEventPayload/ExecutionStreamChunk 是契约类型别名，改形状先改契约；#687 起 EXECUTION_STREAM_SSE_TYPE 常量正本亦收编契约（本文件 re-export 保持既有 import 路径），wire parity 见 events/__tests__/sse-payload-contract.test.ts）
- `wu-verification.ts`（自动验证可复用实现）、`completion-gates.ts`（收口守卫链）、`completion-harvest.ts`（#542 per-WU-type COMPLETE 收割注册表）、`result-bookkeeping.ts`（#655 recordResult 簿记段）、`review-contract.ts`（verdict 语义单一来源）
- `review-dispatcher.ts`（F4 review 派发）、`dispatch-reconciliation.ts`（派工/评审断链 5min 对账，P2-d 刀5 自 agents 根随迁——依赖 review-dispatcher + monitor-alerts，留 agents 会拉成 agents↔agent-loop 环）
- `__tests__/` — 60 个测试文件（agents root __tests__ loop 系 48 + 原 loop/__tests__ 9 + #668 新增 2：execution-cwd 直测 / loop-segments 段接线钉线 + #671 新增 1：prompt-composer-snapshot 全九段产出快照钉线（拆分前后逐字节等价兜底）；段行为由既有测试网兜底）

### 核心导出

- `index.ts` — 模块公共出口 barrel：`agentLoopRegistry`、`getReviewDispatcher`、`getDailyTokenUsage`/`resolveDailyTokenBudget`/`tokenBudgetGuardEnabled`、`EXECUTION_STREAM_SSE_TYPE`、`CODE_WORKTREE_TYPES`/`resolveVerifyCommands`/`runWuVerification`、`reconcileDispatchBreaks`

### 依赖关系

- 上游：`modules/agents`（barrel：getSystemExecutor / MonitorAlertSource）、`modules/ops`（barrel：dispatchMonitorAlerts / loadCurrentWuContexts，#683 起 monitoring/agent-monitor 并入 ops）、`modules/workunit`、`modules/pmo`、`modules/channels`、`modules/skills`、`modules/knowledge`、`modules/requirements`、`modules/role-memory`、`modules/transcripts`、`modules/triggers`、`modules/workspaces`、`core/`（store/system-role/exec-async）、`utils/`、`@dommaker/studio-agent`、`@dommaker/studio-shared`
- 下游：`bootstrap/`（agent-loop/bridges/handlers/lifecycle 装配）、`modules/workunit`（routes/service/merge-on-review-pass 动态 import）、`modules/events`（sse.routes）、`modules/distill`、`modules/role-memory`（动态）

### 注意事项

- **worktrees 目录口径（P2-e，契约 §8 双口径收编）**：`resolveWorktreesDir` fallback 为 `WORKTREES_DIR > studioPath('worktrees')`（原 `~/worktrees`），与 bootstrap/config.ts 注入值同源；merge-on-review-pass / monitor-system-probes / system-health / discord / studio-agent agent-runner 同口径。
> 详细运行口径（派单链/唤醒加固/三层超时/租约心跳/#585 需求守卫/prompt 注入/会话术语等）随 agents/CONTEXT.md 注意事项区维护；以下为本模块强相关条目摘要。

- **多实例单活**：`STUDIO_AGENT_LOOP_ENABLED=false` 实例 standby；`AgentLoop.start()` 内置同角色单活守卫
- **#635 stop 语义收窄**：`AgentLoop.stop()` 只置退出意图（alive=false），不停租约心跳、不清租约轨道——在飞 step 全程租约保护；停心跳收尾统一在 runLoop 主循环退出点
- **step-guards 需求/AC 前置守卫（#585）**：仅实现类系统派生 WU 受检；豁免 = from-message/manual、metadata.triggerSource、requirementOverride=true；判定 = reqId + metadata.ac[] 缺一即 need_input 挂起；总开关 `STUDIO_REQUIREMENT_GUARD=false`（测试环境默认关）
- **认领门槛**：纯显式三门槛（assigneeId 排他+excludeAssignee+blockedBy）+ 决策 14 适任判断；#579 总开关 `STUDIO_CLAIM_FITNESS=false`
- **completion-gates 零同步子进程（#374 口径延伸）**：全部走 `core/exec-async.ts` 的 execFileAsync，fail-open 语义不变
- **执行根目录（#481）**：`resolveExecutionWorkspaceRoot` 唯一来源 = `metadata.workspaceRoot`；`wu.workspaceId` 无执行语义
- **会话术语（#637/#639）**：档案会话号（metadata.sessionId）vs CLI 会话号（metadata.cliSessionId）；续用一律按 CLI 会话号 id 形态点名（无则新建；失效走 #94 降级 + #95 前序进展段交接）
- **子 WU 不继承会话簿记**：clearSessionBookkeeping 清除 14 字段；新增簿记字段必须同步
- **#467 裁决轮 / #567 方向锁定协议**：RULING/DIRECTION 行 → StepResult.rulings/directions → metadata.planRulings/planDirections；提交落地在 pmo/plan-ruling.ts、pmo/plan-direction.ts
- **观察/唤醒口径（#330/#493/#523 + B5）**：唤醒只放行不裁决，归属裁决归 observe；B5 回复检测改 `readChannelMessagesDelta` 字节水位增量读
- **F4 review 派发 / P7 总开关**：`STUDIO_AUTO_REVIEW=false` 闸两条自动路径；事件链失败 30s 进程内重试一次
