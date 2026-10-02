# apps/api/src/modules/agent-loop

### 职责

决策循环与 WU 执行链（P2-d 刀5 自 modules/agents/loop 提升为顶层模块）：AgentLoop 循环编排（observe → 过滤 → claim → agentStep → recordResult → 回帖）、prompt/上下文组装、WU 租约与心跳、步级守卫链与重试策略、完成收割与验证、评审派发、派工断链对账。

### 目录结构

- `agent-loop.ts` — 循环编排（导出面 = AgentLoop + StepResult；#544 拆除 re-export 门面；#363：原 start() 同角色 terminated 启动清理已拆除，回收归 instance-timeout-scan）
- `agent-loop.types.ts` — 类型契约（纯类型零运行时）
- `agent-loop-registry.ts` — profileId→running AgentLoop 注册表（profile 生命周期事件驱动挂载/卸载；#634 provider 变更重挂）
- `agent-loop-parsers.ts` / `agent-loop-events.ts` / `agent-loop-guards.ts` — 输出解析+prompt 模板纯函数 / tokens/tool:call 落盘 / 测试 WU 守卫+excludeAssignee
- `step-guards.ts`（#541 入口守卫链：B2 测试 WU / #585 需求+AC / C3 日预算 / #162 WU 预算 / #471 plan 额度）、`step-retry-policy.ts`（#543 重试策略：#94 续用丢失降级 + #96 上下文溢出收敛为 runStepRetry 一份）
- `claim-fitness.ts`（认领前适任判断，决策 14；2026-09-25 起落 `agent:claim_fitness` 台账事件）
- `daily-token-budget.ts`（每日 token 预算熔断，C3）、`delegate-branch.ts`（A2A DELEGATE 分支委派）
- `prompt-composer.ts`（prompt/上下文组装，分段软定额截断）、`session-resume.ts`（#94）、`context-overflow.ts`（溢出识别+滚动摘要）
- `wu-lease.ts` / `lease-heartbeat.ts`（WU 租约/fencing 追踪器 #209 / 心跳 30s）
- `executor.ts`（Executor 接口，LocalExecutor 委托 agentRunner）、`execution-step-events.ts`（步级事件落盘+步内流式 SSE）
- `wu-verification.ts`（自动验证可复用实现）、`completion-gates.ts`（收口守卫链）、`completion-harvest.ts`（#542 per-WU-type COMPLETE 收割注册表）、`result-bookkeeping.ts`（#655 recordResult 簿记段）、`review-contract.ts`（verdict 语义单一来源）
- `review-dispatcher.ts`（F4 review 派发）、`dispatch-reconciliation.ts`（派工/评审断链 5min 对账，P2-d 刀5 自 agents 根随迁——依赖 review-dispatcher + monitor-alerts，留 agents 会拉成 agents↔agent-loop 环）
- `__tests__/` — 56 个测试文件（agents root __tests__ loop 系 47 + 原 loop/__tests__ 9）

### 核心导出

- `index.ts` — 模块公共出口 barrel：`agentLoopRegistry`、`getReviewDispatcher`、`getDailyTokenUsage`/`resolveDailyTokenBudget`/`tokenBudgetGuardEnabled`、`EXECUTION_STREAM_SSE_TYPE`、`CODE_WORKTREE_TYPES`/`resolveVerifyCommands`/`runWuVerification`、`reconcileDispatchBreaks`

### 依赖关系

- 上游：`modules/agents`（barrel：getSystemExecutor / dispatchMonitorAlerts（刀6 后归 agent-monitor）/ MonitorAlertSource）、`modules/workunit`、`modules/pmo`、`modules/channels`、`modules/skills`、`modules/knowledge`、`modules/requirements`、`modules/role-memory`、`modules/transcripts`、`modules/triggers`、`modules/workspaces`、`modules/monitoring`、`core/`（store/system-role/exec-async）、`utils/`、`@dommaker/studio-agent`、`@dommaker/studio-shared`
- 下游：`bootstrap/`（agent-loop/bridges/handlers/lifecycle 装配）、`modules/workunit`（routes/service/merge-on-review-pass 动态 import）、`modules/events`（sse.routes）、`modules/distill`、`modules/role-memory`（动态）

### 注意事项

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
