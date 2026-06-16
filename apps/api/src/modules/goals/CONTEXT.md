## 本目录
Goal 生命周期核心模块。CRUD → Plan → Scheduler → Executor → Review → Deploy。

⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/goals/goal.service.ts, apps/api/src/modules/goals/goal-scheduler.ts, apps/api/src/modules/goals/agent-event-listener.ts, apps/api/src/modules/goals/CONTEXT.md

⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/goals/goal.service.ts, apps/api/src/modules/goals/goal-scheduler.ts, apps/api/src/modules/goals/agent-event-listener.ts, apps/api/src/modules/goals/CONTEXT.md

⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/goals/goal-scheduler.ts, apps/api/src/modules/goals/goal.service.ts, apps/api/src/modules/goals/CONTEXT.md, apps/api/src/modules/goals/agent-event-listener.ts

⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/goals/goal-review.ts

⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/goals/goal-lifecycle.ts, apps/api/src/modules/goals/goal-review.ts, apps/api/src/modules/goals/scheduler-dispatch.ts, apps/api/src/modules/goals/scheduler-integration.ts, apps/api/src/modules/goals/scheduler-prompt.ts

⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/goals/goal-lifecycle.ts

⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/goals/goal-review.ts, apps/api/src/modules/goals/pipeline-utils.ts

⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/goals/scheduler-dispatch.ts

⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/goals/scheduler-integration.ts, apps/api/src/modules/goals/scheduler-prompt.ts

⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/goals/goal-lifecycle.ts, apps/api/src/modules/goals/goal-review.ts, apps/api/src/modules/goals/scheduler-queue.ts

⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/goals/scheduler-prompt.ts

⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/goals/CONTEXT.md

⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/goals/goal-lifecycle.ts, apps/api/src/modules/goals/goal.service.ts, apps/api/src/modules/goals/scheduler-dispatch.ts

⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/goals/goal-review.ts

⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/goals/goal-review.ts

<!-- STALE_SINCE: 2026-06-16 -->
⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/goals/scheduler-prompt.ts

## 核心导出
- `goal.service.ts` → GoalService (Goal CRUD + 审查 + 完成判定)
- `goal-scheduler.ts` → GoalScheduler (10s 轮询调度，恢复，集成)
- `agent-event-listener.ts` → AgentEventListener (监听 agent 完成事件)
- `routes.ts` → Express Router (REST API)

## 消费方
- `channel.routes.ts` → 调用 Goal creation
- `agent-router.ts` → 依赖 goalService
- `review-agent.service.ts` → 依赖 goalService

## 禁区
- `index=999` (integration step) → 三处同步: L459, L1052, L1200
- `updateStepExecution().error` → 必须 JSON.stringify({message, timestamp})
- `createGoalDocument` → 需要有效 projectId FK

verifiedAt: 61f2ab3006736b235471b06ade93f1292584940f

## 修复历史

<!-- SESSION_SUMMARY_FIXES -->
- ✅ `fe88e333`: Deploy 仓库选择 #19 — REPO_DIR env 优先于 DB WorkspaceRepo
- ✅ `4a70a2e6`: reviewer 400 — remove --model flag + pipelineReview upsert
- ✅ `e59e6f4f`: review persistence — PipelineReview write + StudioEvent + catch approved:false
- ✅ `5e3b3726`: wire failureType into scheduler-dispatch failure paths
- ✅ `3281bd80`: P6.5): Skill 元数据注入合规 + MCP SSE transport + fileKnowledge 移除
- ✅ `dd0ddbcb`: 包管理器探测替代硬编码 pnpm
- ✅ `95778b5e`: 统一 pnpm test 替代 npm test
- ✅ `df0cb4aa`: Fix #5: PostEval completeness < 50% → 回滚 goal 为 failed
- ✅ `c0beddbd`: B38 错误日志修复 + GAP-7 元数据驱动注入
- ✅ `36a91ee2`: O2-KR1 注入命中率接线 — consumption 事件 + metric query
- ✅ `309f6061`: review pipeline — diff scope + discoveredIssues exposure
- ✅ `201f84c9`: goals): cascade dependency-blocked failures in checkGoalCompletion
- ✅ `bf4ad33d`: LLM architecture debt — 3-key routing + P0-P2 fixes
- ✅ `9dec006c`: 管线自举根因修复 — AC 质量 + Gate 加固 + OKR v3
- ✅ `f80cfeae`: 203 TypeScript 错误全部清零
- ✅ `7d5b0fda`: Phase 0 — 7 Critical bugs in pipeline quality gates and concurrency
