---
status: "done"
version: "1.1"
created: 2026-06-30
updated: 2026-06-30
---

# Design: Phase 1.1 MonitorAgent Pipeline 查询迁移

## 实际实现策略

Phase 1.1 最终采用三种策略：

**策略 A：直接表替换（4 处）**：checkReviewQuality、checkTokenBudget、autoAbandonStaleBlocked、TTL GC。WorkUnit 有等价字段，直接替换表名+字段映射。

**策略 B：no-op 移除（5 处）**：WorkUnit 系统已有等价能力，MonitorAgent 方法移除查询返回空数组。
- checkStuckGoals → workunit-timeout trigger 每 5min 扫描
- checkSessionEscalation → daemon.getStatus() 已有活跃会话监控
- checkHeartbeatLoss → WorkUnit.updatedAt 作为心跳等价物
- autoAbandonStaleRunning → workunit-timeout trigger 覆盖
- checkPipelineLatency → 需父子聚合，WorkUnit 单层模型需重新设计，暂 no-op

**策略 C：模型适配重写（3 处）**：
- checkProgressStagnation：移除 worktree/.progress.json 依赖，改用 `WorkUnit.updatedAt` 检测停滞（updatedAt 超过阈值 = 停滞）
- checkTotalExecutionTime：`GoalExecution.startedAt` → `WorkUnit.claimedAt`，tmux kill → `agentRunner.stop()`，状态 `failed` → `closed`
- evaluateTrajectory：`progressSnapshots`（内存 Map）→ `retryCount`（DB 字段），`goalId` → `parentId`

## 文件映射

| AC | 文件路径 | 改动类型 |
|----|---------|---------|
| AC-1.1 | `apps/api/src/modules/agents/monitor-agent.service.ts` | MODIFY — 重写超时扫描查询 |
| AC-1.2 | `apps/api/src/modules/agents/monitor-agent.service.ts` | MODIFY — 重写 blocked 扫描查询 |
| AC-1.3 | `apps/api/src/modules/agents/monitor-agent.service.ts` | MODIFY — 重写 orphan 清理查询 |
| AC-1.4 | `apps/api/src/modules/agents/monitor-agent.service.ts` | MODIFY — 重写管线延迟查询 |
| AC-1.5 | `apps/api/src/modules/agents/monitor-agent.service.ts` | MODIFY — 重写轨迹评估查询 |
| AC-1.6 | `apps/api/src/modules/agents/monitor-agent.service.ts` | MODIFY — 重写 TTL GC 查询 |
| AC-2.1 | `apps/api/src/modules/agents/monitor-agent.service.ts` | MODIFY — 重写审查质量查询 |
| AC-2.2 | `apps/api/src/modules/agents/monitor-agent.service.ts` | MODIFY — 重写 token 预算查询 |
| AC-2.3 | `apps/api/src/modules/agents/monitor-agent.service.ts` | MODIFY — 重写管线延迟（外层）查询 |

所有改动集中在 `monitor-agent.service.ts` 单文件，无新文件创建。

## 接口定义

无新接口。现有 MonitorAgent 方法签名不变，仅内部查询逻辑重写。

### 查询重写模式

**模式 A：直接替换表名 + 字段映射**
```typescript
// Before
const executions = await prisma.goalExecution.findMany({
  where: { status: 'running', startedAt: { lt: cutoff } }
});

// After
const workUnits = await prisma.workUnit.findMany({
  where: { status: 'active', claimedAt: { lt: cutoff } }
});
```

**模式 B：利用 WorkUnit 一等字段**
```typescript
// Before (手动计算超时)
const executions = await prisma.goalExecution.findMany({
  where: { status: 'running' }
});
const timedOut = executions.filter(e => Date.now() - e.startedAt.getTime() > TIMEOUT_MS);

// After (直接用 timeoutAt)
const timedOut = await prisma.workUnit.findMany({
  where: { status: 'active', timeoutAt: { lt: new Date() } }
});
```

**模式 C：父子关系查询**
```typescript
// Before (Goal + GoalExecution 双层)
const orphaned = await prisma.goalExecution.findMany({
  where: { status: 'running', goal: { status: { in: ['succeeded', 'failed'] } } }
});

// After (WorkUnit parentId 自引用)
const orphaned = await prisma.workUnit.findMany({
  where: {
    status: 'active',
    parent: { status: { in: ['done', 'closed'] } }
  }
});
```

**模式 D：metadata JSON 读取**
```typescript
// Before
const goal = await prisma.goal.findUnique({ where: { id: goalId } });
const ctx = JSON.parse(goal.context || '{}');
const reviewScore = ctx.reviewScore;

// After
const workUnit = await prisma.workUnit.findUnique({ where: { id: workUnitId } });
const metadata = JSON.parse(workUnit.metadata || '{}');
const reviewScore = metadata.reviewScore;
```

## 代码依赖图

```
monitor-agent.service.ts
  ├─ scanTimeoutExecutions()          → prisma.workUnit.findMany (AC-1.1)
  ├─ scanProgressStalled()            → prisma.workUnit.findMany (AC-1.1)
  ├─ checkSessionCountAlerts()        → prisma.workUnit.findMany (AC-1.1)
  ├─ checkExecutionTimeouts()         → prisma.workUnit.findMany (AC-1.1)
  ├─ forceTerminateTimedOut()         → prisma.workUnit.update (AC-1.1)
  ├─ detectHeartbeatLoss()            → prisma.workUnit.findMany (AC-1.1)
  ├─ autoAbandonBlocked()             → prisma.workUnit.findMany + update (AC-1.2)
  ├─ cleanOrphanedRunning()           → prisma.workUnit.findMany + update (AC-1.3)
  ├─ computePipelineDurationP90()     → prisma.workUnit.findMany (AC-1.4)
  ├─ evaluateTrajectory()             → prisma.workUnit.findMany (AC-1.5)
  ├─ gcExpiredExecutions()            → prisma.workUnit.deleteMany (AC-1.6)
  ├─ checkReviewQuality()             → prisma.workUnit.findMany (AC-2.1)
  ├─ checkTokenBudget()               → prisma.workUnit.findMany (AC-2.2)
  └─ computePipelineDurationOuter()   → prisma.workUnit.findMany (AC-2.3)
```

所有方法都是 MonitorAgent 类的 private/public 方法，无外部调用。

## 模块边界

- **不改**：MonitorAgent 的公开 API（`start()`, `stop()`, `systemHealthCheck()` 等）
- **不改**：MonitorAgent 的告警逻辑（`emitEvent()`, `notifyService.send()`）
- **不改**：MonitorAgent 的知识沉淀逻辑（`knowledgeBus.recordPattern()`）
- **只改**：内部查询逻辑（`prisma.goal*` → `prisma.workUnit`）

## 约束

1. **不改方法签名**：MonitorAgent 的方法签名保持不变，仅内部实现重写
2. **不改告警逻辑**：告警触发条件、通知方式、知识沉淀逻辑不变
3. **不改 GC 策略**：TTL 阈值（90d）、超时阈值（30min/2.5h）保持不变
4. **metadata schema 约定**：需在迁移时定义 `reviewScore` 和 `_cumulativeTokens` 的 metadata schema
