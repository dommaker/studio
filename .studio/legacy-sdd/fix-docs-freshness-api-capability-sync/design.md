---
id: "sdd-1781753801003-4eswsu"
slug: "fix-docs-freshness-api-capability-sync"
title: "修复 docs-freshness API capability_sync 过滤器不匹配"
status: "done"
tier: "fast"
version: 2
requirementVersion: 1
designVersion: 2
taskVersion: 1
parentId: "cmqiwz8mp015dmekjsh6nbhi5"
changeType: "L3"
createdAt: "2026-06-18T03:02:14.393Z"
updatedAt: "2026-06-18T03:36:41.003Z"
---

## Design

### AC-1

**Implementation Notes**
单行修改：将第 40 行 operation 值从 'file_modification' 改为 'module_modification'。不涉及任何导入、类型或函数签名变更。验证方式：对比 docs_freshness trigger 数组 ['file_modification', 'module_creation', 'module_modification'] 和 capability_sync trigger 数组 ['module_creation', 'module_modification', 'module_deletion', 'module_extension']，两者交集包含 module_modification。

**Architecture Context**
- Functions: checkConstraints(context: ConstraintContext): Promise<ConstraintCheckResult> — @dommaker/harness 入口，三层约束检查, matchesTrigger(constraint: Constraint, operation: ConstraintTrigger): boolean — 私有方法，检查 trigger 数组是否包含 operation, checkDocsFreshness(): Promise<FreshnessResult> — 私有函数，检查 CLAUDE.md 新鲜度
- Call Chain: GET /api/v1/admin/docs-freshness → checkDocsFreshness() → checkConstraints({ operation: 'module_modification' }) → ConstraintChecker.checkConstraints() → matchesTrigger() 过滤 → guidelines 数组包含 capability_sync
- Imports: import { checkConstraints } from '@dommaker/harness', import { Router, Request, Response } from 'express', import { logger } from '@dommaker/studio-shared'
- Danger Zones: operation 值拼写错误 — 必须严格使用 'module_modification'（下划线分隔），任何偏差会导致 trigger 不匹配
- Verified At: harness/src/core/constraints/definitions.ts:330-339 (docs_freshness trigger), harness/src/core/constraints/definitions.ts:531-539 (capability_sync trigger)

**Code Patterns**
- 现有代码模式：try/catch 包裹 checkConstraints 调用，失败时 logger.warn 而非崩溃
- 过滤模式：relevantIds = ['docs_freshness', 'capability_sync']，从 ironLaws + guidelines 中按 id 过滤

**Gotchas**
- 仅改 operation 值，不要修改 try/catch 结构
- 不要添加新的 import 或类型
- capability_sync 在 guidelines 数组而非 ironLaws 数组中（level: 'guideline'）
- docs_freshness 在 ironLaws 数组中（level: 'iron_law'），通过 filter(r => relevantIds.includes(r.id)) 跨数组匹配

### AC-2

**Implementation Notes**
新建测试文件 __tests__/docs-freshness.routes.test.ts。mock @dommaker/harness 的 checkConstraints 函数，返回包含 capability_sync 的 guidelines。使用 supertest 调用 GET / 端点，解析响应 JSON，断言 harnessCheck.details 包含 { id: 'capability_sync', passed: false } 或 { id: 'capability_sync', passed: true }。同时验证 docs_freshness 仍在 details 中。

**Architecture Context**
- Functions: jest.mock('@dommaker/harness') — 模块级 mock, checkConstraints.mockResolvedValue(result) — 控制返回, supertest(app).get('/api/v1/admin/docs-freshness') — 集成测试
- Call Chain: supertest GET → Express Router → checkDocsFreshness() → checkConstraints({ operation: 'module_modification' }) → mock 返回 → 过滤 relevantIds → harnessCheck.details
- Imports: import request from 'supertest', import { checkConstraints } from '@dommaker/harness'
- Danger Zones: 需正确获取 Express app 实例 — 检查 src/app.ts 或 src/index.ts 的路由挂载方式, supertest 需安装（检查 package.json devDependencies）
- Verified At: apps/api/src/modules/admin/docs-freshness.routes.ts:33-54 (路由 handler 逻辑)

**Code Patterns**
- 项目中大量使用 jest.mock() + supertest 模式进行路由测试
- mock 路径使用 @dommaker/harness 包名（与源码 import 一致）

**Gotchas**
- 测试文件不存在 — 新建，需创建 __tests__ 目录
- 需正确导入 express app（可能通过 createApp() 或直接导入 app）
- docs_freshness 返回 ironLaws，capability_sync 返回 guidelines — 过滤代码已正确处理 cross-array 匹配