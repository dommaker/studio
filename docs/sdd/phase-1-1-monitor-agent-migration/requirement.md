---
status: completed
version: "1.2"
created: 2026-06-30
updated: 2026-06-30
dependencies:
  - docs/issues/2026-06-29-pipeline-deprecation-analysis.md
---

# Phase 1.1: MonitorAgent Pipeline 查询迁移

## 执行拆分与完成状态

Phase 1.1 拆为两步，均已完成：

### Phase 1.1a ✅：直接替换 + no-op（2026-06-30 完成）
**直接表替换（4 处）**：checkReviewQuality、checkTokenBudget、autoAbandonStaleBlocked、TTL GC。
**no-op（5 处）**：checkStuckGoals、checkSessionEscalation、checkHeartbeatLoss、autoAbandonStaleRunning、checkPipelineLatency。WorkUnit 系统已有等价能力（workunit-timeout trigger / retryCount / updatedAt 心跳）。

### Phase 1.1b ✅：适配重写（2026-06-30 完成）
3 处方法深度耦合 GoalExecution 的 worktree/tmux/.progress.json 模型，已重新设计监控逻辑：
- `checkProgressStagnation`：移除 worktree/.progress.json 依赖，改用 `WorkUnit.updatedAt` 检测停滞
- `checkTotalExecutionTime`：`GoalExecution.startedAt` → `WorkUnit.claimedAt`，tmux kill → `agentRunner.stop()`，status `failed` → `closed`
- `evaluateTrajectory`：`GoalExecution` → `WorkUnit`，`progressSnapshots` → `retryCount` 字段

**最终验证**：`grep "prisma.goal" monitor-agent.service.ts` → 0 matches。MonitorAgent 零 Pipeline 查询。

## 目标

将 MonitorAgent 的 17 处 Pipeline 表查询（Goal + GoalExecution）迁移到 WorkUnit 表，使 MonitorAgent 不再依赖 Pipeline 表。

## AC Group 1: GoalExecution 查询迁移（13 处）

### AC-1.1 ~~checkStuckGoals~~ → no-op [Phase 1.1a]
**原因**：WorkUnit `workunit-timeout` trigger（每 5min）已覆盖超时检测
**改动**：移除 `prisma.goalExecution.findMany` 查询，方法 return []
**Files**：`monitor-agent.service.ts` L263

### AC-1.2 checkProgressStagnation → 适配重写 [Phase 1.1b]
**触发条件**：MonitorAgent 定期扫描超时执行
**预期行为**：查询 `WorkUnit.status='active' AND WorkUnit.claimedAt < now-30min`，替代 `GoalExecution.status='running' AND startedAt < now-30min`
**边界情况**：WorkUnit 有 `timeoutAt` 字段可直接使用 `timeoutAt < now`，比计算更高效
**不做**：不改变超时策略（仍是释放重做，非标记失败）
**Files**：`apps/api/src/modules/agents/monitor-agent.service.ts` L263, L286, L346, L386, L420, L463

### AC-1.2 blocked 自动放弃迁移
**触发条件**：MonitorAgent 扫描 blocked >24h 的 WorkUnit
**预期行为**：查询 `WorkUnit.status='blocked' AND WorkUnit.createdAt < cutoff`，替代 `GoalExecution.status='blocked'`
**边界情况**：WorkUnit 无父 Goal 关联，直接查 WorkUnit 即可
**不做**：不改变放弃策略
**Files**：`apps/api/src/modules/agents/monitor-agent.service.ts` L506, L515

### AC-1.3 orphan 清理迁移
**触发条件**：MonitorAgent 清理 running >2.5h 且父 Goal 已终态的孤儿执行
**预期行为**：查询 `WorkUnit.status='active' AND WorkUnit.claimedAt < cutoff`，通过 `parentId` 查 parent WorkUnit 状态
**边界情况**：WorkUnit 用 `parentId` 关联父级，需用 `parent: { status: in [...] }` Prisma 关系查询
**不做**：不改变孤儿判定逻辑
**Files**：`apps/api/src/modules/agents/monitor-agent.service.ts` L534, L565

### AC-1.4 管线延迟指标迁移
**触发条件**：MonitorAgent 计算管线延迟指标
**预期行为**：查询 `WorkUnit.status='done' AND WorkUnit.parentId=goalId`，读取 `claimedAt, completedAt`，替代 `GoalExecution.status='succeeded'` 的 `startedAt, completedAt`
**边界情况**：一个 Goal 对应多个子 WorkUnit，需用 `parentId` 聚合
**不做**：不改变指标计算逻辑
**Files**：`apps/api/src/modules/agents/monitor-agent.service.ts` L999

### AC-1.5 轨迹评估迁移
**触发条件**：MonitorAgent 评估最近 24h 完成的执行
**预期行为**：查询 `WorkUnit.status in [done,closed] AND WorkUnit.completedAt > 24h ago`，替代 `GoalExecution.status in [succeeded,failed]`
**边界情况**：WorkUnit 终态是 `done/closed`，GoalExecution 是 `succeeded/failed`
**不做**：不改变轨迹评估逻辑
**Files**：`apps/api/src/modules/agents/monitor-agent.service.ts` L1098

### AC-1.6 TTL GC 迁移
**触发条件**：MonitorAgent 定期清理 >90d 的执行记录
**预期行为**：删除 `WorkUnit.createdAt < 90d ago`，替代 `GoalExecution.createdAt < 90d ago`
**边界情况**：WorkUnit 无 TTL 字段，直接用 `createdAt`
**不做**：不改变 GC 策略
**Files**：`apps/api/src/modules/agents/monitor-agent.service.ts` L2083

## AC Group 2: Goal 查询迁移（4 处）

### AC-2.1 审查质量指标迁移
**触发条件**：MonitorAgent 检查 succeeded Goal 的 reviewScore
**预期行为**：查询 `WorkUnit.status='done' AND WorkUnit.updatedAt > 7d`，从 `WorkUnit.metadata.reviewScore` 读取分数，替代 `Goal.context.reviewScore`
**边界情况**：需在 WorkUnit 创建时将 reviewScore 写入 metadata
**不做**：不改变审查质量判定逻辑
**Files**：`apps/api/src/modules/agents/monitor-agent.service.ts` L659

### AC-2.2 Token 预算监控迁移
**触发条件**：MonitorAgent 检查 Goal 累计 token 超阈值
**预期行为**：查询 `WorkUnit.status in [active,done,blocked]`，从 `WorkUnit.metadata._cumulativeTokens` 读取 token 数，替代 `Goal.context._cumulativeTokens`
**边界情况**：需在 WorkUnit 创建/更新时将 _cumulativeTokens 写入 metadata
**不做**：不改变 token 预算判定逻辑
**Files**：`apps/api/src/modules/agents/monitor-agent.service.ts` L699, L1390

### AC-2.3 管线延迟（外层）迁移
**触发条件**：MonitorAgent 计算最近完成的 Goal 计时
**预期行为**：查询 `WorkUnit.status in [done,closed] AND WorkUnit.completedAt > 1h ago`，读取 `createdAt, completedAt`，替代 `Goal.status in [succeeded,failed]`
**边界情况**：WorkUnit 完成时间戳是 `completedAt`，Goal 也是 `completedAt`，直接等价
**不做**：不改变管线延迟计算逻辑
**Files**：`apps/api/src/modules/agents/monitor-agent.service.ts` L990

## 状态枚举映射

| Goal/GoalExecution | WorkUnit | 说明 |
|--------------------|----------|------|
| `running` | `active` | 执行中 |
| `succeeded` | `done` | 成功完成 |
| `failed` | `closed` | 失败关闭 |
| `blocked` | `blocked` | 阻塞（相同） |
| `executing` | `active` | Goal 执行中 |
| `pending` | `unassigned` | 待处理 |

## 字段映射

| Goal/GoalExecution | WorkUnit | 说明 |
|--------------------|----------|------|
| `Goal.id` | `WorkUnit.parentId` | 子 WorkUnit 指向父级 |
| `Goal.status` | `WorkUnit.status` | 枚举值需映射 |
| `Goal.createdAt` | `WorkUnit.createdAt` | 直接等价 |
| `Goal.completedAt` | `WorkUnit.completedAt` | 直接等价 |
| `Goal.context` (JSON) | `WorkUnit.metadata` (JSON) | 需约定 schema |
| `GoalExecution.goalId` | `WorkUnit.parentId` | 子 WorkUnit 关联父级 |
| `GoalExecution.startedAt` | `WorkUnit.claimedAt` | claim = 开始执行 |
| `GoalExecution.completedAt` | `WorkUnit.completedAt` | 直接等价 |
| `GoalExecution.status` | `WorkUnit.status` | 枚举值需映射 |
| `GoalExecution.failureType` | `WorkUnit.failureType` | 直接等价 |
| `GoalExecution.createdAt` | `WorkUnit.createdAt` | 直接等价 |

## 风险

1. **双层模型→单层**：Goal + GoalExecution 是父子关系，WorkUnit 用 `parentId` 自引用。查询逻辑需重写，不是简单替换表名。
2. **metadata schema 未约定**：`reviewScore` 和 `_cumulativeTokens` 需写入 WorkUnit.metadata，但当前无 schema 约定。需在迁移时定义。
3. **历史数据断裂**：迁移后历史指标查询依赖 WorkUnit 数据，Goal/GoalExecution 历史数据不再可用。需接受断裂或保留只读视图。
