---
id: "cmq7y53qs00cmdj0xawtmlt4h"
workUnitId: "cmq7y572500dcdj0xvsvefwos"
slug: "goalexecution-failuretype"
title: "GoalExecution.failureType — 持久化失败分类 + 确定性路由 + 查询过滤"
status: "implemented"
version: 1
sourceChannelId: "cmq6eqh3u000k10qwg7tup7lj"
tags: ["goal-execution", "failure-classification", "persistence", "prisma", "filtering"]
createdAt: "2026-06-10T10:49:19.151Z"
updatedAt: "2026-06-10T10:49:23.566Z"
---

# GoalExecution.failureType — 持久化失败分类 + 确定性路由 + 查询过滤

在 GoalExecution 模型添加 failureType 字段，持久化 classifyFailureAction() 的分类结果，handleGoalFailed() 读取该字段做确定性路由，goal-crud.ts 支持按 failureType 过滤

<!-- TASK_TIER {"tier":"standard","reason":"Schema 变更(Prisma 包) + API 层(lifecycle+CRUD+routes) 跨 6 文件，需 migration"} -->
## Schema First Verification

<!-- INTERFACE_VERIFICATION {"verified":["GoalExecution model — schema.prisma L261-L281","classifyFailureAction(error) — failure-classifier.ts:85, returns {action, failureClass}","handleGoalFailed(goalId) — goal-lifecycle.ts:367","listGoals(companyId, status?) — goal-crud.ts:91","GET /api/v1/goals — routes.ts:56, query: companyId, status","GoalService.listGoals(companyId, status?) — goal.service.ts:55","prisma.goalExecution.update — lifecycle.ts:33 (existing pattern)","prisma migrations dir — packages/studio-prisma/prisma/migrations/ (4 existing migrations)"],"unverified":[],"newRequired":[]} -->

### Verified
- ✅ GoalExecution model — schema.prisma L261-L281
- ✅ classifyFailureAction(error) — failure-classifier.ts:85, returns {action, failureClass}
- ✅ handleGoalFailed(goalId) — goal-lifecycle.ts:367
- ✅ listGoals(companyId, status?) — goal-crud.ts:91
- ✅ GET /api/v1/goals — routes.ts:56, query: companyId, status
- ✅ GoalService.listGoals(companyId, status?) — goal.service.ts:55
- ✅ prisma.goalExecution.update — lifecycle.ts:33 (existing pattern)
- ✅ prisma migrations dir — packages/studio-prisma/prisma/migrations/ (4 existing migrations)

## AC Groups

### schema-migration
<!-- MODEL_TIER {"tier":"fast","reason":"纯 schema additive change，2 文件，无逻辑变更"} -->

#### 验收标准
- [ ] AC A.1: 在 schema.prisma GoalExecution 模型 L270(error 字段后) 添加 `failureType String?` 字段，注释为 `// 失败分类: retryable|not-retryable|infrastructure|unknown`
- [ ] AC A.2: 在 GoalExecution 模型 L280(@@index([status]) 后) 添加 `@@index([failureType])` 索引
- [ ] AC A.3: 运行 `npx prisma migrate dev --name add_goal_execution_failure_type` 生成 migration 文件，确认 migration 包含 ALTER TABLE ADD COLUMN + CREATE INDEX

#### 涉及文件
- packages/studio-prisma/prisma/schema.prisma
- packages/studio-prisma/prisma/migrations/20260610000000_add_goal_execution_failure_type/migration.sql

### lifecycle-persist-and-route
<!-- MODEL_TIER {"tier":"standard","reason":"跨 2 文件，需理解路由逻辑 + fallback 兼容 + 测试"} -->

#### 验收标准
- [ ] AC B.1: 在 goal-lifecycle.ts handleGoalFailed() L396 后，将 failureClass 持久化到失败执行记录: `await prisma.goalExecution.update({ where: { id: failedExec.id }, data: { failureType: failureClass } })`；failureClass 为 null/undefined 时不写入
- [ ] AC B.2: 在 goal-lifecycle.ts handleGoalFailed() L399-L427 的路由逻辑中，改用 `failedExec.failureType` 做确定性路由——从 DB 读取 failureType 值映射到 action（infrastructure/retryable→retry-execution, not-retryable→mark-blocked, unknown→triage-agent），不再重新调用 classifyFailureAction()；failureType 为空时 fallback 到 classifyFailureAction(errorMsg) 兼容历史数据
- [ ] AC B.3: 更新 goal-lifecycle.ts handleGoalFailed() L373-L377 的查询，select 中添加 failureType 字段: `select: { id: true, error: true, stepIndex: true, failureType: true }`
- [ ] AC B.4: 在 goal-lifecycle.ts __tests__/goal-lifecycle.test.ts 中添加测试: 验证 handleGoalFailed 读取 failureType 字段做路由（failureType='not-retryable'→mark-blocked, failureType='retryable'→retry-execution, failureType=null→fallback classifyFailureAction）

#### 涉及文件
- apps/api/src/modules/goals/goal-lifecycle.ts
- apps/api/src/modules/goals/__tests__/goal-lifecycle.test.ts

#### 依赖: schema-migration

### crud-route-filter
<!-- MODEL_TIER {"tier":"standard","reason":"跨 3 文件 + relation filter 需验证 Prisma 生成"} -->

#### 验收标准
- [ ] AC C.1: 在 goal-crud.ts L91 listGoals 签名中添加可选参数 `failureType?: string`；L93 where 条件中添加: `...(failureType ? { GoalExecution: { some: { failureType } } } : {})` — 使用 Prisma relation filter
- [ ] AC C.2: 在 routes.ts L56-L71 GET /api/v1/goals 中，从 req.query 解构 failureType，传递给 goalService.listGoals(companyId, status, failureType)
- [ ] AC C.3: 在 goal.service.ts L55 GoalService.listGoals 签名中添加可选参数 `failureType?: string`，透传给 listGoalsImpl(companyId, status, failureType)
- [ ] AC C.4: 在 __tests__/ 中添加契约测试: 验证 listGoals(companyId) 不传 failureType 正常返回；传 failureType='not-retryable' 返回 GoalExecution.failureType 匹配的目标

#### 涉及文件
- apps/api/src/modules/goals/goal-crud.ts
- apps/api/src/modules/goals/routes.ts
- apps/api/src/modules/goals/goal.service.ts
- apps/api/src/modules/goals/__tests__/goal-crud.test.ts

#### 依赖: schema-migration
## 约束
- failureType 存储 FailureClass 值: 'retryable' | 'not-retryable' | 'infrastructure' | 'unknown'
- failureType 为 nullable — 现有执行记录无此字段
- handleGoalFailed 路由逻辑必须向后兼容: failureType 为空时 fallback 到 classifyFailureAction()
- 不改变现有 retryGoalExecution / triageAgent.handleAlert / channel notification 逻辑
- 不改变 classifyFailureAction 函数本身（只在调用方持久化结果）
- migration 必须是 additive only — 不删列、不改列类型

## AC Groups

```json
[
  {
    "id": "schema-migration",
    "acs": [
      "AC A.1: 在 schema.prisma GoalExecution 模型 L270(error 字段后) 添加 `failureType String?` 字段，注释为 `// 失败分类: retryable|not-retryable|infrastructure|unknown`",
      "AC A.2: 在 GoalExecution 模型 L280(@@index([status]) 后) 添加 `@@index([failureType])` 索引",
      "AC A.3: 运行 `npx prisma migrate dev --name add_goal_execution_failure_type` 生成 migration 文件，确认 migration 包含 ALTER TABLE ADD COLUMN + CREATE INDEX"
    ],
    "files": [
      "packages/studio-prisma/prisma/schema.prisma",
      "packages/studio-prisma/prisma/migrations/20260610000000_add_goal_execution_failure_type/migration.sql"
    ],
    "dependencies": [],
    "implementationNotes": "在 error 字段后(line 270)插入 failureType 行，保持字段对齐。索引放在现有 @@index([status]) 之后。migration 由 prisma CLI 自动生成。",
    "architectureContext": {
      "functions": [],
      "callChain": "",
      "imports": [],
      "typesInScope": [
        "GoalExecution @ schema.prisma:L261-L281 — 当前字段: id, goalId, planId, stepIndex, status, agentType, input, output, error, retryCount, startedAt, completedAt, createdAt"
      ],
      "testMock": [],
      "dangerZones": [
        "L275 Goal relation — 不要移动或修改",
        "L276 GoalPlan relation — 不要移动或修改",
        "migration 必须是 additive only (nullable字段+索引)，不会破坏现有数据"
      ],
      "verifiedAt": "306f4c1"
    },
    "codePatterns": [
      "schema.prisma L270: `error String?` — 在此行后插入 failureType",
      "schema.prisma L278-L280: 现有 @@index 模式 — 在 L280 后追加"
    ],
    "gotchas": [
      "⚠️ failureType 必须是 String? (nullable) — 现有执行记录无此字段值",
      "⚠️ 不要改 status 字段的类型或默认值",
      "⚠️ migration 文件名必须符合 YYYYMMDDHHMMSS_description 格式"
    ],
    "modelTier": "fast",
    "modelTierReason": "纯 schema additive change，2 文件，无逻辑变更"
  },
  {
    "id": "lifecycle-persist-and-route",
    "acs": [
      "AC B.1: 在 goal-lifecycle.ts handleGoalFailed() L396 后，将 failureClass 持久化到失败执行记录: `await prisma.goalExecution.update({ where: { id: failedExec.id }, data: { failureType: failureClass } })`；failureClass 为 null/undefined 时不写入",
      "AC B.2: 在 goal-lifecycle.ts handleGoalFailed() L399-L427 的路由逻辑中，改用 `failedExec.failureType` 做确定性路由——从 DB 读取 failureType 值映射到 action（infrastructure/retryable→retry-execution, not-retryable→mark-blocked, unknown→triage-agent），不再重新调用 classifyFailureAction()；failureType 为空时 fallback 到 classifyFailureAction(errorMsg) 兼容历史数据",
      "AC B.3: 更新 goal-lifecycle.ts handleGoalFailed() L373-L377 的查询，select 中添加 failureType 字段: `select: { id: true, error: true, stepIndex: true, failureType: true }`",
      "AC B.4: 在 goal-lifecycle.ts __tests__/goal-lifecycle.test.ts 中添加测试: 验证 handleGoalFailed 读取 failureType 字段做路由（failureType='not-retryable'→mark-blocked, failureType='retryable'→retry-execution, failureType=null→fallback classifyFailureAction）"
    ],
    "files": [
      "apps/api/src/modules/goals/goal-lifecycle.ts",
      "apps/api/src/modules/goals/__tests__/goal-lifecycle.test.ts"
    ],
    "dependencies": [
      "schema-migration"
    ],
    "implementationNotes": "步骤: 1) L375 select 添加 failureType。2) L396 后插入 prisma.goalExecution.update 写入 failureType。3) L396-L427 路由逻辑改为: 优先读 failedExec.failureType → 映射到 action，为空则 fallback classifyFailureAction。注意 L378 errorRaw 已读取，failureType 同级读取。",
    "architectureContext": {
      "functions": [
        "handleGoalFailed(goalId: string): Promise<void> @ goal-lifecycle.ts:L367",
        "classifyFailureAction(error: string): { action: FailureAction; failureClass: FailureClass } @ failure-classifier.ts:L85",
        "retryGoalExecution(executionId: string): Promise<any> @ goal-lifecycle.ts:L83"
      ],
      "callChain": "checkGoalCompletion(goalId) → [if status=failed] → handleGoalFailed(goalId) → classifyFailureAction(errorMsg) → retry/triage/mark-blocked",
      "imports": [
        "import { classifyFailureAction } from './failure-classifier.js' — 已存在于 L11",
        "import type { FailureClass, FailureAction } from './failure-classifier.js' — 需新增类型导入"
      ],
      "typesInScope": [
        "FailureClass = 'retryable' | 'not-retryable' | 'infrastructure' | 'unknown' @ failure-classifier.ts:L11",
        "FailureAction = 'retry-execution' | 'mark-blocked' | 'triage-agent' @ failure-classifier.ts:L12",
        "GoalExecution { id, goalId, status, error, failureType?, retryCount, ... } @ schema.prisma:L261"
      ],
      "testMock": [
        "vi.mock('@dommaker/studio-prisma', () => ({ prisma: { goal: { findUnique: vi.fn() }, goalExecution: { findFirst: vi.fn(), update: vi.fn() }, failureEvent: { findFirst: vi.fn() }, project: { update: vi.fn() } } }))",
        "vi.mock('./failure-classifier.js', () => ({ classifyFailureAction: vi.fn() }))",
        "vi.mock('../agents/triage-agent.service.js', () => ({ triageAgent: { handleAlert: vi.fn() } }))",
        "vi.mock('../channels/channel-message.service.js', () => ({ channelMessageService: { createAgentMessage: vi.fn() } }))"
      ],
      "dangerZones": [
        "L399-L412 retry-execution 分支 — 不要改变 retryGoalExecution 调用逻辑",
        "L414-L425 triage-agent 分支 — 不要改变 triageAgent.handleAlert 调用",
        "L429-L445 channel notification — 不要碰",
        "L449-L457 project status update — 不要碰",
        "L378-L379 errorRaw 解析逻辑 — 不要碰"
      ],
      "verifiedAt": "306f4c1"
    },
    "codePatterns": [
      "goal-lifecycle.ts:L33 prisma.goalExecution.update 现有模式 — 复用相同写法",
      "goal-lifecycle.ts:L373-L377 findFirst select 模式 — 添加 failureType 到 select",
      "failure-classifier.ts:L85-L98 classifyFailureAction switch 模式 — 路由映射复用"
    ],
    "gotchas": [
      "⚠️ handleGoalFailed L378 errorRaw 的类型是 any — 不要改这个，保持兼容",
      "⚠️ failureType 为空(null)必须 fallback 到 classifyFailureAction — 历史数据无此字段",
      "⚠️ 写入 failureType 必须在路由判断之前 — 先写后读，保证一致性",
      "⚠️ classifyFailureAction 返回的 failureClass 和 failureType 存储的值是同一个 FailureClass union"
    ],
    "modelTier": "standard",
    "modelTierReason": "跨 2 文件，需理解路由逻辑 + fallback 兼容 + 测试"
  },
  {
    "id": "crud-route-filter",
    "acs": [
      "AC C.1: 在 goal-crud.ts L91 listGoals 签名中添加可选参数 `failureType?: string`；L93 where 条件中添加: `...(failureType ? { GoalExecution: { some: { failureType } } } : {})` — 使用 Prisma relation filter",
      "AC C.2: 在 routes.ts L56-L71 GET /api/v1/goals 中，从 req.query 解构 failureType，传递给 goalService.listGoals(companyId, status, failureType)",
      "AC C.3: 在 goal.service.ts L55 GoalService.listGoals 签名中添加可选参数 `failureType?: string`，透传给 listGoalsImpl(companyId, status, failureType)",
      "AC C.4: 在 __tests__/ 中添加契约测试: 验证 listGoals(companyId) 不传 failureType 正常返回；传 failureType='not-retryable' 返回 GoalExecution.failureType 匹配的目标"
    ],
    "files": [
      "apps/api/src/modules/goals/goal-crud.ts",
      "apps/api/src/modules/goals/routes.ts",
      "apps/api/src/modules/goals/goal.service.ts",
      "apps/api/src/modules/goals/__tests__/goal-crud.test.ts"
    ],
    "dependencies": [
      "schema-migration"
    ],
    "implementationNotes": "Prisma relation filter语法: `{ GoalExecution: { some: { failureType: 'not-retryable' } } }`。listGoals 已 include GoalPlan，需注意 GoalExecution 是 Goal 的 relation（schema.prisma 未显式定义 Goal→GoalExecution 反向 relation，但 Prisma 自动生成）。需验证 Prisma client 已生成 GoalExecution relation。",
    "architectureContext": {
      "functions": [
        "listGoals(companyId: string, status?: string): Promise<any[]> @ goal-crud.ts:L91",
        "GoalService.listGoals(companyId: string, status?: string): Promise<any[]> @ goal.service.ts:L55",
        "GET /api/v1/goals handler @ routes.ts:L56"
      ],
      "callChain": "GET /api/v1/goals?failureType=X → routes.ts:L58 req.query → goalService.listGoals(companyId, status, failureType) → goal-crud.ts listGoals → prisma.goal.findMany({ where: { GoalExecution: { some: { failureType } } } })",
      "imports": [
        "import { prisma } from '@dommaker/studio-prisma' — 已存在于 goal-crud.ts:L1"
      ],
      "typesInScope": [
        "GoalExecution relation on Goal — Prisma 自动生成（Goal 模型无显式 GoalExecution[] 字段，但 FK 存在，Prisma client 自动生成）"
      ],
      "testMock": [
        "vi.mock('@dommaker/studio-prisma', () => ({ prisma: { goal: { findMany: vi.fn().mockResolvedValue([]) } } }))"
      ],
      "dangerZones": [
        "L97-L99 现有 include: { GoalPlan: ... } — 不要删除或修改",
        "L100 orderBy: { createdAt: 'desc' } — 不要删除或修改",
        "routes.ts L59-L63 companyId 校验逻辑 — 不要碰"
      ],
      "verifiedAt": "306f4c1"
    },
    "codePatterns": [
      "goal-crud.ts:L95 `...(status ? { status } : {})` — failureType 用相同条件展开模式",
      "goal-crud.ts:L92-L101 prisma.goal.findMany 结构 — 在 where 中追加条件"
    ],
    "gotchas": [
      "⚠️ Prisma relation filter 需要 Goal 模型有 GoalExecution 反向关系 — 验证 prisma client 已生成",
      "⚠️ listGoals 返回类型是 Promise<any[]> — 不改返回类型，只加过滤",
      "⚠️ failureType 参数是可选的 — 不传时不过滤，保持向后兼容"
    ],
    "modelTier": "standard",
    "modelTierReason": "跨 3 文件 + relation filter 需验证 Prisma 生成"
  }
]
```

## Files

- apps/api/src/modules/goals/__tests__/goal-crud.test.ts
- apps/api/src/modules/goals/__tests__/goal-lifecycle.test.ts
- apps/api/src/modules/goals/goal-crud.ts
- apps/api/src/modules/goals/goal-lifecycle.ts
- apps/api/src/modules/goals/goal.service.ts
- apps/api/src/modules/goals/routes.ts
- packages/studio-prisma/prisma/migrations/20260610000000_add_goal_execution_failure_type/migration.sql
- packages/studio-prisma/prisma/schema.prisma