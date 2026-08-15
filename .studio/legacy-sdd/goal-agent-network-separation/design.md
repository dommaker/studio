---
status: "done"
version: "1.0"
---

# 设计文档：Goal 与 Agent Network 彻底分离

## 1. 文件映射表

### AC Group 1：Goal 系统回退到 Goal + GoalExecution 表

| AC | 文件 | 改动类型 |
|----|------|---------|
| AC-1.1 | `apps/api/src/modules/goals/goal-crud.ts` | 修改 16 处查询 |
| AC-1.2 | `apps/api/src/modules/goals/goal-lifecycle.ts` | 修改 19 处查询 |
| AC-1.3 | `apps/api/src/modules/goals/goal-review.ts` | 修改 14 处查询 |
| AC-1.4 | `apps/api/src/modules/goals/scheduler-integration.ts` | 修改 13 处查询 |
| AC-1.4 | `apps/api/src/modules/goals/scheduler-prompt.ts` | 修改 4 处查询 |
| AC-1.1 | `apps/api/src/modules/goals/routes.ts` | 修改 5 处查询 |
| AC-1.2 | `apps/api/src/modules/goals/event-handler.ts` | 修改 1 处查询 |
| AC-1.2 | `apps/api/src/modules/goals/stale-recovery.ts` | 修改 2 处查询 |
| AC-1.2 | `apps/api/src/modules/goals/execution-alarm.ts` | 修改 1 处查询 |
| AC-1.2 | `apps/api/src/modules/goals/integration-rollback.ts` | 修改 9 处查询 |

### AC Group 3：跨模块隔离

| AC | 文件 | 改动类型 |
|----|------|---------|
| AC-3.1 | `apps/api/src/modules/agents/monitor-agent.service.ts` | 修改 19 处查询 |
| AC-3.2 | `apps/api/src/modules/pmo/okr.service.ts` | 修改 28 处查询 |
| AC-3.3 | `apps/web/src/stores/goalStore.ts` | 修改 10 处引用 |
| AC-3.1 | `packages/studio-agent/src/services/session-manager.ts` | 修改 6 处引用 |
| AC-3.1 | `packages/studio-agent/src/services/agent-runner.ts` | 修改 2 处引用 |
| AC-3.4 | `apps/api/src/modules/pipeline-dashboard/pipeline-dashboard.routes.ts` | 修改 5 处查询 |
| AC-3.5 | `apps/api/src/modules/pmo/routes.ts` | 修改 2 处查询 |

## 2. 接口定义

### 2.1 Goal 表查询接口

```typescript
// Goal CRUD
interface GoalRepository {
  create(data: GoalCreateInput): Promise<Goal>;
  findById(id: string): Promise<Goal | null>;
  findMany(where: GoalWhereInput): Promise<Goal[]>;
  update(id: string, data: GoalUpdateInput): Promise<Goal>;
  delete(id: string): Promise<void>;
  count(where: GoalWhereInput): Promise<number>;
}

// GoalExecution CRUD
interface GoalExecutionRepository {
  create(data: GoalExecutionCreateInput): Promise<GoalExecution>;
  findById(id: string): Promise<GoalExecution | null>;
  findMany(where: GoalExecutionWhereInput): Promise<GoalExecution[]>;
  update(id: string, data: GoalExecutionUpdateInput): Promise<GoalExecution>;
  delete(id: string): Promise<void>;
  count(where: GoalExecutionWhereInput): Promise<number>;
}
```

### 2.2 状态映射

```typescript
// Goal 状态映射（从 WorkUnit 状态回退到 Goal 状态）
const goalStatusMap = {
  'unassigned': 'draft',
  'active': 'executing',
  'done': 'succeeded',
  'closed': 'failed',
  'blocked': 'blocked',
};

// GoalExecution 状态映射
const executionStatusMap = {
  'unassigned': 'pending',
  'active': 'running',
  'done': 'succeeded',
  'closed': 'failed',
};
```

### 2.3 字段映射

```typescript
// Goal → GoalExecution 字段映射
interface GoalExecutionMapping {
  // GoalExecution.goalId → Goal.id
  goalId: string;
  // GoalExecution.stepIndex → 步骤顺序
  stepIndex: number;
  // GoalExecution.status → 执行状态
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  // GoalExecution.agentType → 执行器类型
  agentType?: string;
  // GoalExecution.failureType → 失败类型
  failureType?: 'retryable' | 'not_retryable' | 'infrastructure' | 'unknown';
  // GoalExecution.retryCount → 重试次数
  retryCount: number;
  // GoalExecution.timeoutAt → 超时时间
  timeoutAt?: Date;
}
```

## 3. 代码依赖图

```
goal-crud.ts
  ├── prisma.goal
  └── prisma.goalExecution

goal-lifecycle.ts
  ├── prisma.goal
  ├── prisma.goalExecution
  └── goal-crud.ts

goal-review.ts
  ├── prisma.goal
  ├── prisma.goalExecution
  └── goal-lifecycle.ts

scheduler-integration.ts
  ├── prisma.goal
  ├── prisma.goalExecution
  └── goal-lifecycle.ts

scheduler-prompt.ts
  ├── prisma.goal
  └── prisma.goalExecution

routes.ts
  ├── prisma.goal
  ├── prisma.goalExecution
  └── goal-crud.ts

event-handler.ts
  ├── prisma.goal
  └── prisma.goalExecution

stale-recovery.ts
  ├── prisma.goal
  └── prisma.goalExecution

execution-alarm.ts
  ├── prisma.goal
  └── prisma.goalExecution

integration-rollback.ts
  ├── prisma.goal
  └── prisma.goalExecution

monitor-agent.service.ts
  ├── prisma.goal
  └── prisma.goalExecution

okr.service.ts
  ├── prisma.goal
  └── prisma.goalExecution

goalStore.ts
  └── Goal + GoalExecution API

session-manager.ts
  └── GoalExecution（session 管理）

agent-runner.ts
  └── Goal（SDD 查找）

pipeline-dashboard.routes.ts
  ├── prisma.goal
  └── prisma.goalExecution

pmo/routes.ts
  ├── prisma.goal
  └── prisma.goalExecution
```

## 4. 模块边界和约束

### 4.1 Goal 系统边界

- **只查询**：Goal + GoalExecution 表
- **不查询**：WorkUnit 表
- **事件**：使用 goal.* 事件，不使用 workunit.* 事件

### 4.2 Agent Network 边界

- **只查询**：WorkUnit 表
- **不查询**：Goal + GoalExecution 表
- **事件**：使用 workunit.* 事件，不使用 goal.* 事件

### 4.3 跨模块约束

- **MonitorAgent**：只查询 Goal + GoalExecution 表
- **OKR 服务**：只查询 Goal + GoalExecution 表
- **GoalStore**：只使用 Goal + GoalExecution API
- **session-manager**：只使用 GoalExecution（session 管理）
- **agent-runner**：只使用 Goal（SDD 查找）
- **Dashboard**：只查询 Goal + GoalExecution 表
- **PMO 健康检查**：只查询 Goal + GoalExecution 表
