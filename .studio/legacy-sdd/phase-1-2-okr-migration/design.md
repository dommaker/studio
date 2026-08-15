---
status: "done"
version: "1.0"
created: 2026-06-30
updated: 2026-06-30
---

# Design: Phase 1.2 OKR Service Pipeline 查询迁移

## 文件映射

| 方法 | 文件路径 | 改动类型 |
|------|---------|---------|
| checkDataSourceHealth | `apps/api/src/modules/pmo/okr.service.ts` L346-358 | MODIFY — goal+goalExecution.count → workUnit.count |
| queryPipelineDurationP90 | `apps/api/src/modules/pmo/okr.service.ts` L663-693 | MODIFY — GoalExecution fallback → WorkUnit |
| queryExecutionSuccessRate | `apps/api/src/modules/pmo/okr.service.ts` L737-738 | MODIFY — goal.count ×2 → workUnit.count |
| queryReviewPassRate | `apps/api/src/modules/pmo/okr.service.ts` L748-749 | MODIFY — goal.findMany + context → workUnit.findMany + metadata |
| querySessionDurationAvg | `apps/api/src/modules/pmo/okr.service.ts` L911-912 | MODIFY — goalExecution → workUnit |
| queryQueueDurationAvg | `apps/api/src/modules/pmo/okr.service.ts` L978-983 | MODIFY — goal+goalExecution → workUnit 父子 |
| queryConflictRate | `apps/api/src/modules/pmo/okr.service.ts` L1162 | MODIFY — goalExecution.count → workUnit.count |

## 查询重写详情

### 1. checkDataSourceHealth
```
Before: prisma.goal.count() + prisma.goalExecution.count()
After:  prisma.workUnit.count() — 合并为单一 work_unit 检查
```

### 2. queryPipelineDurationP90 (Source 3 fallback)
```
Before: prisma.goalExecution.findMany({ status:'succeeded', startedAt, completedAt, goalId })
After:  prisma.workUnit.findMany({ status:'done', claimedAt, completedAt, parentId })
```

### 3. queryExecutionSuccessRate
```
Before: prisma.goal.count({ status:{not:'pending'} }) + prisma.goal.count({ status:'succeeded' })
After:  prisma.workUnit.count({ status:{not:'unassigned'} }) + prisma.workUnit.count({ status:'done' })
```

### 4. queryReviewPassRate
```
Before: prisma.goal.findMany({ status:['succeeded','failed'], select:{context} })
After:  prisma.workUnit.findMany({ status:['done','closed'], select:{metadata} })
```
JSON 读取：`g.context` → `w.metadata`

### 5. querySessionDurationAvg
```
Before: prisma.goalExecution.findMany({ status:'succeeded', startedAt, completedAt })
After:  prisma.workUnit.findMany({ status:'done', claimedAt, completedAt })
```

### 6. queryQueueDurationAvg
```
Before: prisma.goal.findMany + prisma.goalExecution.findMany({ goalId: {in: goals} })
After:  prisma.workUnit.findMany({ parentId: {not: null} }) — 直接查父子 WorkUnit
```
简化：不再需要先查父再查子，一次查询过滤 parentId != null。

### 7. queryConflictRate
```
Before: prisma.goalExecution.count({ goalId: {not: null} })
After:  prisma.workUnit.count({ parentId: {not: null} })
```

## 模块边界

- **不改**：OKR CRUD（create/list/get/update/delete）
- **不改**：StudioEvent/PipelineRun 查询（这些已经是正确数据源）
- **只改**：goal/goalExecution → workUnit 的查询
