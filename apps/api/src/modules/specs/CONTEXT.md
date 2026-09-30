# apps/api/src/modules/specs

### 职责

提供 Specs 模块的 HTTP API 路由，包括变更分析、变更历史查询和门禁验证。遵循 SP-002 变更分级流程，通过调用外部 SDK 中的服务处理 Spec 变更相关的业务逻辑。

### 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `router` (默认导出) | `routes.ts` | Express 路由实例，包含 `/api/v1/specs` 路径下的变更分析和历史查询端点 |

### 依赖关系

- **上游依赖**：`@dommaker/studio-spec`（ChangeAnalyzerService、ChangeHistoryService、GateCheckerService）、`@dommaker/studio-contract`（specs 域 schema）、`../../core/http.js`（defineRoute/HttpError/paginated；utils/pagination.js 依赖已随契约迁移内化）
- **下游使用者**：`apps/api/src/route-registry.ts`（注册该路由模块）

### 注意事项

- 变更提交 API 已删除（对应 SpecChangeRequest 表已移除），但 `/changes/:changeId` 查询端点保留。
- 门禁验证 API 已实现：POST `/changes/:changeId/validate` 调 `GateCheckerService.validate`（通用检查走 harness CheckpointValidator，studio#644），GET `/gates/:level` 与 `/gates` 查询 L1-L4 策略。
- 所有端点需统一处理错误并记录日志。
- 依赖的外部 SDK 服务需在运行时可用，否则路由会抛出 500 错误。
- **鉴权（2026-07-24 收紧）**：POST /changes/:changeId/validate（可触发 harness 检查点执行）、POST /:id/changes/import 已收 requireAuth+requireNotGuest。
- **契约驱动（2026-10 批次 3/7）**：全部端点走 core/http.ts defineRoute（契约 packages/studio-contract/src/specs.ts，studio-spec 类型重声明不 import）。oldVersion/newVersion/import data 手写 guard 收进 zod（BAD_REQUEST）；GET /gates/:level 非法 level 原 200 空体边缘收紧为 zod 400；GET /:id/changes 分页壳形状不变（sendPaginated ≡ `{ data, pagination }`）；export 附件下载 handler 自写 res 不进壳；无前端消费方。
