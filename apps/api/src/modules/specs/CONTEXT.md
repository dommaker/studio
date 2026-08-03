# specs

> 此文件描述 apps/api/src/modules/specs 目录的职责和上下文

<!-- STALE_SINCE: 2026-08-03 -->
⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/specs/CONTEXT.md, apps/api/src/modules/specs/routes.ts

## 职责

提供 Specs 模块的 HTTP API 路由，包括变更分析、变更历史查询和门禁验证（待实现）。遵循 SP-002 变更分级流程，通过调用外部 SDK 中的服务处理 Spec 变更相关的业务逻辑。

## 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `router` (默认导出) | `routes.ts` | Express 路由实例，包含 `/api/v1/specs` 路径下的变更分析和历史查询端点 |

## 依赖关系

- **上游依赖**：`@dommaker/studio-spec`（ChangeAnalyzerService、ChangeHistoryService、GateCheckerService）、`@dommaker/studio-shared`（logger）、`../../utils/pagination.js`（parsePagination、sendPaginated）
- **下游使用者**：`apps/api/src/route-registry.ts`（注册该路由模块）

## 注意事项

- 变更提交 API 已删除（对应 SpecChangeRequest 表已移除），但 `/changes/:changeId` 查询端点保留。
- 门禁验证 API（`GateCheckerService`）尚未实现，当前路由文件中仅有空注释块。
- 所有端点需统一处理错误并记录日志。
- 依赖的外部 SDK 服务需在运行时可用，否则路由会抛出 500 错误。
- **鉴权（2026-07-24 收紧）**：POST /changes/:changeId/validate（可触发 harness 检查点执行）、POST /:id/changes/import 已收 requireAuth+requireNotGuest。

## 修复历史

<!-- SESSION_SUMMARY_FIXES -->
- ✅ `782ac0a9`: 路由层防御纵深 — 写操作端点加 requireAuth+requireNotGuest/requireAdmin
- ✅ 2026-07-24: 写端点收 requireAuth+requireNotGuest
