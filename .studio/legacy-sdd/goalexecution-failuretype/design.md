---
id: "sdd-1784371310197-ly16a5"
slug: "goalexecution-failuretype"
title: "GoalExecution.failureType — 持久化失败分类 + 确定性路由 + 查询过滤"
status: "stale"
version: 42
designVersion: 42
parentId: "sdd-1784369777355-wypmbu"
changeType: "L3"
sourceChannelId: "cmq6eqh3u000k10qwg7tup7lj"
tags: ["goal-execution", "failure-classification", "persistence", "prisma", "filtering"]
createdAt: "2026-06-10T10:49:19.151Z"
updatedAt: "2026-07-18T10:41:50.196Z"
---

# GoalExecution.failureType — 持久化失败分类 + 确定性路由 + 查询过滤

在 GoalExecution 模型添加 failureType 字段，持久化 classifyFailureAction() 的分类结果，handleGoalFailed() 读取该字段做确定性路由，goal-crud.ts 支持按 failureType 过滤

<!-- TASK_TIER {"tier":"standard","reason":"Schema 变更(Prisma 包) + API 层(lifecycle+CRUD+routes) 跨 6 文件，需 migration"} -->

## Architecture Context

### schema-migration

**Types in Scope**
- GoalExecution @ schema.prisma:L261-L281 — 当前字段: id, goalId, planId, stepIndex, status, agentType, input, output, error, retryCount, startedAt, completedAt, createdAt

**Danger Zones**
- L275 Goal relation — 不要移动或修改
- L276 GoalPlan relation — 不要移动或修改
- migration 必须是 additive only (nullable字段+索引)，不会破坏现有数据

### lifecycle-persist-and-route

**Functions**
- handleGoalFailed(goalId: string): Promise<void> @ goal-lifecycle.ts:L367
- classifyFailureAction(error: string): { action: FailureAction; failureClass: FailureClass } @ failure-classifier.ts:L85
- retryGoalExecution(executionId: string): Promise<any> @ goal-lifecycle.ts:L83

**Call Chain**
checkGoalCompletion(goalId) → [if status=failed] → handleGoalFailed(goalId) → classifyFailureAction(errorMsg) → retry/triage/mark-blocked

**Imports**
- import { classifyFailureAction } from './failure-classifier.js' — 已存在于 L11
- import type { FailureClass, FailureAction } from './failure-classifier.js' — 需新增类型导入

**Types in Scope**
- FailureClass = 'retryable' | 'not-retryable' | 'infrastructure' | 'unknown' @ failure-classifier.ts:L11
- FailureAction = 'retry-execution' | 'mark-blocked' | 'triage-agent' @ failure-classifier.ts:L12
- GoalExecution { id, goalId, status, error, failureType?, retryCount, ... } @ schema.prisma:L261

**Test Mocks**
- vi.mock('@dommaker/studio-prisma', () => ({ prisma: { goal: { findUnique: vi.fn() }, goalExecution: { findFirst: vi.fn(), update: vi.fn() }, failureEvent: { findFirst: vi.fn() }, project: { update: vi.fn() } } }))
- vi.mock('./failure-classifier.js', () => ({ classifyFailureAction: vi.fn() }))
- vi.mock('../agents/triage-agent.service.js', () => ({ triageAgent: { handleAlert: vi.fn() } }))
- vi.mock('../channels/channel-message.service.js', () => ({ channelMessageService: { createAgentMessage: vi.fn() } }))

**Danger Zones**
- L399-L412 retry-execution 分支 — 不要改变 retryGoalExecution 调用逻辑
- L414-L425 triage-agent 分支 — 不要改变 triageAgent.handleAlert 调用
- L429-L445 channel notification — 不要碰
- L449-L457 project status update — 不要碰
- L378-L379 errorRaw 解析逻辑 — 不要碰

### crud-route-filter

**Functions**
- listGoals(companyId: string, status?: string): Promise<any[]> @ goal-crud.ts:L91
- GoalService.listGoals(companyId: string, status?: string): Promise<any[]> @ goal.service.ts:L55
- GET /api/v1/goals handler @ routes.ts:L56

**Call Chain**
GET /api/v1/goals?failureType=X → routes.ts:L58 req.query → goalService.listGoals(companyId, status, failureType) → goal-crud.ts listGoals → prisma.goal.findMany({ where: { GoalExecution: { some: { failureType } } } })

**Imports**
- import { prisma } from '@dommaker/studio-prisma' — 已存在于 goal-crud.ts:L1

**Types in Scope**
- GoalExecution relation on Goal — Prisma 自动生成（Goal 模型无显式 GoalExecution[] 字段，但 FK 存在，Prisma client 自动生成）

**Test Mocks**
- vi.mock('@dommaker/studio-prisma', () => ({ prisma: { goal: { findMany: vi.fn().mockResolvedValue([]) } } }))

**Danger Zones**
- L97-L99 现有 include: { GoalPlan: ... } — 不要删除或修改
- L100 orderBy: { createdAt: 'desc' } — 不要删除或修改
- routes.ts L59-L63 companyId 校验逻辑 — 不要碰

## AC Groups

### schema-migration

#### 实现指南
在 error 字段后(line 270)插入 failureType 行，保持字段对齐。索引放在现有 @@index([status]) 之后。migration 由 prisma CLI 自动生成。

#### 参考模式
- schema.prisma L270: `error String?` — 在此行后插入 failureType
- schema.prisma L278-L280: 现有 @@index 模式 — 在 L280 后追加

#### ⚠️ 注意事项
- ⚠️ failureType 必须是 String? (nullable) — 现有执行记录无此字段值
- ⚠️ 不要改 status 字段的类型或默认值
- ⚠️ migration 文件名必须符合 YYYYMMDDHHMMSS_description 格式

### lifecycle-persist-and-route

#### 实现指南
步骤: 1) L375 select 添加 failureType。2) L396 后插入 prisma.goalExecution.update 写入 failureType。3) L396-L427 路由逻辑改为: 优先读 failedExec.failureType → 映射到 action，为空则 fallback classifyFailureAction。注意 L378 errorRaw 已读取，failureType 同级读取。

#### 参考模式
- goal-lifecycle.ts:L33 prisma.goalExecution.update 现有模式 — 复用相同写法
- goal-lifecycle.ts:L373-L377 findFirst select 模式 — 添加 failureType 到 select
- failure-classifier.ts:L85-L98 classifyFailureAction switch 模式 — 路由映射复用

#### ⚠️ 注意事项
- ⚠️ handleGoalFailed L378 errorRaw 的类型是 any — 不要改这个，保持兼容
- ⚠️ failureType 为空(null)必须 fallback 到 classifyFailureAction — 历史数据无此字段
- ⚠️ 写入 failureType 必须在路由判断之前 — 先写后读，保证一致性
- ⚠️ classifyFailureAction 返回的 failureClass 和 failureType 存储的值是同一个 FailureClass union

### crud-route-filter

#### 实现指南
Prisma relation filter语法: `{ GoalExecution: { some: { failureType: 'not-retryable' } } }`。listGoals 已 include GoalPlan，需注意 GoalExecution 