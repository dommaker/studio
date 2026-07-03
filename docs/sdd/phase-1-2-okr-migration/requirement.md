---
status: completed
version: "1.0"
created: 2026-06-30
updated: 2026-06-30
dependencies:
  - docs/issues/2026-06-29-pipeline-deprecation-analysis.md
---

# Phase 1.2: OKR Service Pipeline 查询迁移

## 范围

`okr.service.ts` 中 10 处 `prisma.goal.*` / `prisma.goalExecution.*` 查询迁移到 `prisma.workUnit.*`。

## 完成状态

✅ 全部完成（2026-06-30）

## 迁移策略

**策略 A：直接替换（8 处）**：Goal/GoalExecution → WorkUnit，字段映射。
**策略 B：合并简化（2 处）**：Goal + GoalExecution 双表查询 → 单 WorkUnit 表查询。

## 字段映射表

| Pipeline 字段 | WorkUnit 字段 | 说明 |
|--------------|--------------|------|
| `goal.status: 'succeeded'` | `workUnit.status: 'done'` | |
| `goal.status: 'failed'` | `workUnit.status: 'closed'` | |
| `goal.status: 'pending'` | `workUnit.status: 'unassigned'` | |
| `goalExecution.status: 'running'` | `workUnit.status: 'active'` | |
| `goalExecution.startedAt` | `workUnit.claimedAt` | |
| `goalExecution.completedAt` | `workUnit.completedAt` | |
| `goalExecution.goalId` | `workUnit.parentId` | |
| `goal.context` (JSON) | `workUnit.metadata` (JSON) | |
