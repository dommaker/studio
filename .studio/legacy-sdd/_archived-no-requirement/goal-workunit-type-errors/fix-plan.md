# Goal/WorkUnit 类型错误修复计划

> 生成时间: 2026-06-27
> 触发: `npx tsc --noEmit --project apps/api/tsconfig.json` 报 53 个错误
> 根因: Goal 和 WorkUnit 拆分后，部分 goals 模块文件未迁移，仍用 WorkUnit 字段查询 GoalExecution

## 背景

### 架构演进

1. **初始设计（~2026-06 前）**: Pipeline 系统使用 `Goal` + `GoalExecution` 表驱动。Scheduler 调度 GoalExecution，Executor 执行。
2. **WorkUnit 引入（2026-06-23）**: `ce6ba5c3` — Phase 2 将 Goal 查询迁移为 WorkUnit 查询，两个架构共用 work_unit 表。
3. **发现冲突（2026-06-26）**: 共用导致 Scheduler 把 AgentLoop 的 WorkUnit 当 Goal 处理。用户明确要求 Goal 和 Agent Network 彻底分离。
4. **回退 + 重新拆分（2026-06-26）**:
   - `bc7fd33b` — Phase 1: Goal 系统回退到 Goal + GoalExecution 表
   - `8a2c17dd` — Phase 2: 跨模块隔离（7 个源文件，72 处查询改回 Goal + GoalExecution）
   - `c5b926a1` — Phase 3: 测试文件更新（10 个测试文件，42 处 mock）
   - `64a980fb` / `c8a76e1e` — Phase 3.5: scheduler-dispatch.ts 迁移完成

### 遗留问题

Phase 1-3.5 迁移了大部分文件，但以下 6 个文件**未被触及**，仍使用 WorkUnit 字段查询 GoalExecution：

| 文件 | 上次修改 | 迁移状态 |
|------|---------|---------|
| `scheduler-integration.ts` | bc7fd33b (Phase 1) | ❌ 未迁移 |
| `scheduler-prompt.ts` | bc7fd33b (Phase 1) | ❌ 未迁移 |
| `event-handler.ts` | bc7fd33b (Phase 1) | ❌ 未迁移 |
| `stale-recovery.ts` | bc7fd33b (Phase 1) | ❌ 未迁移 |
| `goal-lifecycle.ts` | bc7fd33b (Phase 1) | ❌ 部分问题 |
| `goal.service.ts` | — | ❌ deprecated 函数签名不匹配 |

此外，本会话提交的 `342e326e` 引入了 auth.ts 的 workspace ownership case 错误（Workspace 无 creatorId/createdBy 字段）。

### 分离后的架构

- **Pipeline (Goal 系统)**: `Goal` + `GoalPlan` + `GoalExecution` — 目标驱动，Scheduler 调度
- **Agent Network (WorkUnit 系统)**: `WorkUnit` — Agent 自主 claim/execute/review，去中心化
- 两个系统**不共用表**，各有独立的状态枚举和字段定义

## Schema 基准

**GoalExecution** 字段: `id, goalId, planId, stepIndex, status, agentType, input, output, error, failureType, retryCount, startedAt, completedAt, timeoutAt, createdAt`

**WorkUnit** 字段: `id, parentId, type, scope, assigneeId, status, failureType, retryCount, timeoutAt, channelId, metadata, createdAt, updatedAt, claimedAt, completedAt`

**Goal** 字段: `id, title, description, status, priority, constraints, context, companyId, createdBy, createdAt, updatedAt, completedAt`

**Workspace** 字段: `id, name, tokenId, workspaceRoot, hasDocker, os, arch, status, currentTask, lastHeartbeat, createdAt, updatedAt`

核心区别:
- GoalExecution 没有 `parentId`, `metadata`, `scope`, `type`, `claimedAt`, `updatedAt`
- Workspace 没有 `creatorId`, `createdBy`
- Goal 有 `createdBy`, `constraints`, `context`

---

## 问题一: auth.ts — workspace ownership case 引用不存在的字段

**严重程度**: 高（编译错误，3 个 TS 错误）
**引入 commit**: `342e326e`（本会话刚提交的改动）
**文件**: `apps/api/src/middleware/auth.ts:259-262`

### 现状代码

```typescript
case 'workspace': {
  const r = await prisma.workspace.findUnique({ where: { id: resourceId }, select: { creatorId: true, createdBy: true } });
  return r?.creatorId ?? r?.createdBy ?? undefined;
}
```

### 问题

Workspace 模型没有 `creatorId` 和 `createdBy` 字段。select 会报 TS2353，属性访问报 TS2339。

### 修复方案

需要确认 Workspace 的所有权关系。可能的方案:
1. **Workspace 无所有权概念** — 删除这个 case，或通过 `tokenId` 关联 WorkspaceToken 间接判断
2. **需要新增字段** — 在 Workspace schema 中添加 `createdBy` 字段并迁移
3. **改用其他关联** — 如通过 WorkspaceRuntime 或 WorkspaceTask 的 assignee 判断

**需要决策**: Workspace 的"创建者"语义是什么？

### TS 错误

```
auth.ts(259,90): TS2353 — 'creatorId' does not exist in Workspace select type
auth.ts(260,17): TS2339 — Property 'creatorId' does not exist on Workspace type
auth.ts(260,33): TS2339 — Property 'createdBy' does not exist on Workspace type
```

---

## 问题二: scheduler-integration.ts — GoalExecution 查询混用 WorkUnit 字段

**严重程度**: 高（编译错误，19 个 TS 错误）
**文件**: `apps/api/src/modules/goals/scheduler-integration.ts`

### 错误清单

| 行号 | 操作 | 问题字段 | 错误类型 |
|------|------|---------|---------|
| 133 | findMany where | `type: 'task'`, `parentId: null` | TS2353 — 不在 GoalExecutionWhereInput |
| 176 | findMany where | `parentId: goalId` | TS2353 |
| 186 | findMany where | `parentId: goalId` | TS2353 |
| 203 | 访问结果 | `.metadata` | TS2339 — GoalExecution 无 metadata |
| 235 | findMany select | `parentId: true` | TS2353 — 不在 GoalExecutionSelect |
| 240 | 访问结果 | `.metadata` | TS2339 |
| 328 | findMany where | `parentId: goalId` | TS2353 |
| 329 | findMany select | `metadata: true` | TS2353 |
| 343, 352, 356 | 传参 | 期望 `{ metadata: string }` | TS2345 |
| 366 | create data | `parentId`, `scope`, `type`, `metadata` | TS2353 — 不在 GoalExecutionCreateInput |
| 440 | 访问结果 | `.metadata` | TS2339 |
| 495 | findMany where | `claimedAt` | TS2353 — 不在 GoalExecutionWhereInput |
| 498 | findMany select | `parentId: true` | TS2353 |
| 519 | 访问结果 | `.toISOString()` on `never` | TS2339 |

### 修复方案

**核心判断**: 这些查询的语义是操作"执行单元"（有 parentId 层级、metadata 扩展、scope 范围），应该全部改为查询 `prisma.workUnit`。

需要逐行修改:
- L133: `prisma.goalExecution.findMany` → `prisma.workUnit.findMany`
- L176, 186, 235, 328, 329, 498: 同上
- L366: `prisma.goalExecution.create` → `prisma.workUnit.create`
- L203, 240, 440: 结果访问 `.metadata` 已在 WorkUnit 上存在，改查询后自动修复
- L495: `claimedAt` 是 WorkUnit 字段，改查询后自动修复
- L343, 352, 356: 改查询后类型匹配，自动修复
- L519: `claimedAt` 在 WorkUnit 上是 `DateTime?`，需确认非空再调 `.toISOString()`

### 状态值混用（需同步修复）

本文件中 status 值**已经混用**了两套枚举:
- WorkUnit 值（查询条件，已正确）: `active`, `done`, `unassigned`, `closed`
- GoalExecution 值（更新操作，需修改）: `succeeded`, `pending`, `failed`

具体行号:
```
L437: status: 'succeeded'  → 应改为 'done'
L448: status: 'pending'    → 应改为 'unassigned' 或其他 WorkUnit 值
L458: status: 'failed'     → 应改为 'blocked' 或 'closed'
L466: status: 'failed'     → 同上
L403: status: 'failed'     → 同上
```

**注意**: L293 `prisma.goalExecution.count({ where: { status: 'active' } })` — 这里 `active` 是 WorkUnit 值，GoalExecution 没有 `active` 状态。改为 `prisma.workUnit.count` 后正确。

---

## 问题三: scheduler-prompt.ts — GoalExecution 查询混用 WorkUnit 字段

**严重程度**: 高（编译错误，16 个 TS 错误）
**文件**: `apps/api/src/modules/goals/scheduler-prompt.ts`

### 错误清单

| 行号 | 操作 | 问题字段 | 错误类型 |
|------|------|---------|---------|
| 198 | findMany where | `parentId: goalId` | TS2353 |
| 199 | findMany select | `metadata: true` | TS2353 |
| 240 | findMany where | `parentId: goalId` | TS2353 |
| 241 | findMany select | `metadata: true` | TS2353 |
| 255 | 访问结果 | `.metadata` (×2) | TS2339 |
| 293 | findUnique select | `metadata: true` | TS2353 |
| 294 | 访问结果 | `.metadata` (×2) | TS2339 |
| 441 | findMany where | `parentId: goalId` | TS2353 |
| 445 | 访问结果 | `.metadata` (×2) | TS2339 |
| 465 | 访问结果 | `.metadata` (×2) | TS2339 |
| 477 | 访问结果 | `.metadata` (×2) | TS2339 |

### 修复方案

同问题二，全部改为 `prisma.workUnit`。本文件 status 值已全部是 WorkUnit 值（`done`, `active`），无需修改。

---

## 问题四: event-handler.ts — GoalExecution 查询混用 WorkUnit 字段

**严重程度**: 高（编译错误，3 个 TS 错误）
**文件**: `apps/api/src/modules/goals/event-handler.ts`

### 错误清单

| 行号 | 操作 | 问题字段 |
|------|------|---------|
| 140 | findUnique select | `metadata: true` |
| 141 | 访问结果 | `.metadata` (两处) |

### 修复方案

L140 的查询应改为 `prisma.workUnit.findUnique`。需确认该处的 `goalExecutionId` 实际是 WorkUnit ID 还是 GoalExecution ID。如果是 WorkUnit ID，直接改查询；如果是 GoalExecution ID，需要先查 GoalExecution 拿到关联的 WorkUnit 再查 metadata。

---

## 问题五: stale-recovery.ts — GoalExecution 查询使用 WorkUnit 字段

**严重程度**: 中（编译错误，1 个 TS 错误）
**文件**: `apps/api/src/modules/goals/stale-recovery.ts:31`

### 错误

```typescript
// L31: where 条件用了 claimedAt，这是 WorkUnit 字段
{ timeoutAt: null, claimedAt: { lt: fallbackThreshold } }
```

### 修复方案

改为 `prisma.workUnit.findMany`。同时需修改 status 值:

```
L28:  status: 'running'   → 'active'
L71:  status: 'running'   → 'active'
L91:  status: 'succeeded' → 'done'
L101: status: 'pending'   → 'unassigned'
L112: status: 'failed'    → 'blocked' 或 'closed'
L121: status: 'failed'    → 'blocked' 或 'closed'
```

---

## 问题六: goal-lifecycle.ts — updatedAt 和 goalMeta

**严重程度**: 高（编译错误，10 个 TS 错误）
**文件**: `apps/api/src/modules/goals/goal-lifecycle.ts`

### 错误 6a: updatedAt 不存在 (L464)

```typescript
// L464: GoalExecution 没有 updatedAt
.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
```

**修复**: 改为 `b.createdAt.getTime() - a.createdAt.getTime()` 或 `b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0)`（取决于排序意图——按创建时间还是完成时间排序）。

### 错误 6b: goalMeta 未定义 (L696, L719)

```typescript
// L696, L719: 引用了不存在的 goalMeta 变量
const goalContextForSummary = goalMeta?.context ? ...
const goalContextForPostEval = goalMeta?.context ? ...
```

**修复**: 需要在上方定义 `goalMeta`。查看上下文，应该是从 Goal 表读取的 `constraints` 或 `context` 字段:
```typescript
const goalMeta = await prisma.goal.findUnique({ where: { id: goalId }, select: { constraints: true, context: true } });
```

---

## 问题七: goal.service.ts — listGoalsImpl 参数过多

**严重程度**: 低（编译错误，1 个 TS 错误）
**文件**: `apps/api/src/modules/goals/goal.service.ts:65`

### 错误

```typescript
// L65: listGoals 只接受 2 个参数，传了 3 个
return listGoalsImpl(companyId, status, failureType);
// 而 export async function listGoals(companyId: string, status?: string)
```

### 修复方案

方案 A: 扩展 `listGoals` 签名接受 `failureType` 参数
方案 B: 在 `listGoalsImpl` 内部处理 `failureType` 过滤
方案 C: 如果 `failureType` 过滤已在别处实现，删除多余参数

---

## 修复优先级

| 优先级 | 问题 | 文件 | TS 错误数 | 风险 |
|--------|------|------|----------|------|
| P0 | 二 scheduler-integration | 1 个文件 | 19 | 高 — 运行时查询错误 |
| P0 | 三 scheduler-prompt | 1 个文件 | 16 | 高 — 运行时查询错误 |
| P0 | 四 event-handler | 1 个文件 | 3 | 高 — 运行时查询错误 |
| P0 | 五 stale-recovery | 1 个文件 | 1 | 高 — 运行时查询错误 |
| P1 | 六 goal-lifecycle | 1 个文件 | 10 | 中 — 逻辑错误 |
| P1 | 一 auth.ts workspace | 1 个文件 | 3 | 中 — 新引入的 bug |
| P2 | 七 goal.service.ts | 1 个文件 | 1 | 低 — 已标记 deprecated |

**总计**: 7 个文件, 53 个 TS 错误

---

## 修复策略

### 第一批 (P0): GoalExecution → WorkUnit 查询替换

涉及 4 个文件，核心改动是将 `prisma.goalExecution.findMany/findUnique/create` 中使用 WorkUnit 字段的查询改为 `prisma.workUnit`。

需要逐个确认:
1. 每处查询的 ID 参数实际是 GoalExecution ID 还是 WorkUnit ID
2. 如果是 GoalExecution ID，是否需要先查 GoalExecution 拿到关联信息
3. 查询结果的下游使用是否依赖 GoalExecution 特有字段（如 `goalId`, `planId`, `stepIndex`）

### 第二批 (P1): 逻辑修复

- goal-lifecycle.ts: 修复 `updatedAt` → `createdAt`/`completedAt`，补充 `goalMeta` 定义
- auth.ts: 确认 Workspace ownership 语义后修复

### 第三批 (P2): 参数修复

- goal.service.ts: 确认 `failureType` 过滤需求后修复签名

---

## 注意事项

1. **不要盲目全局替换** — 同一个文件中可能有些 GoalExecution 查询是正确的（如 `where: { goalId }`），只有使用 WorkUnit 字段的才需要改
2. **状态值映射** — GoalExecution 和 WorkUnit 的 status 枚举不同:
   - GoalExecution: `pending | running | succeeded | failed`
   - WorkUnit: `unassigned | active | in_review | done | closed | blocked`
   替换查询后，where 条件中的 status 值也需要同步修改。详见问题二、五的状态值混用章节
3. **goalMeta 修复模式** — 问题六的 `goalMeta` 不是查询混用，而是函数作用域内缺少变量定义。参考同文件 L456 `handleGoalFailed()` 中的相同模式
4. **测试覆盖** — 修改后需确保 goals 模块测试全部通过（目标: 273/273）
5. **运行时验证** — 除了 tsc --noEmit 清零，还需验证实际查询不会因字段不存在而报错
6. **不要引入 `as any`** — 修复过程中禁止用 `as any` 绕过类型检查，必须正确定义查询类型
