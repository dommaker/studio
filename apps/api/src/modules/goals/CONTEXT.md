## 本目录
Goal 生命周期核心模块。CRUD → Plan → Scheduler → Executor → Review → Deploy。

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
