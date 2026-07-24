# audit-logs

> 此文件描述 apps/api/src/modules/audit-logs 目录的职责和上下文

## 职责

提供审计日志的查询与统计 API 端点，支持按用户、角色、公司、操作类型、资源、状态、时间范围等条件过滤，并支持分页查询和统计汇总。

## 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `router` (默认导出) | routes.ts | Express 路由对象，包含 `GET /api/audit-logs`（查询日志）和 `GET /api/audit-logs/stats`（获取统计）两个端点。 |

## 依赖关系

- **上游依赖**：`../../utils/logger.js`（日志）、`../../utils/pagination.js`（分页格式化）、`../../utils/services.js`（惰性服务工厂）、`@dommaker/studio-audit`（审计服务与枚举）、`@dommaker/studio-shared`（FileStore）、`express`。
- **下游依赖**：`apps/api/src/route-registry.ts` 注册此模块的路由。

## 注意事项

- 查询参数 `anonymousId` 为 SEC-009 新增字段，需确保前端传递正确。
- 所有错误场景统一返回 `{ error: { code, message } }` 格式，内部日志使用 `logger.error`。
- 审计服务通过 `createLazyService` 延迟初始化，避免启动时加载依赖。
- 分页默认值为 page=1, limit=50，调用方不应依赖默认值以外的行为。
- **鉴权（2026-07-24 收紧）**：`/api/v1/audit-logs` 挂载级 `requireAuth()+requireAdmin()` —— 日志含 IP/UA/email（PII），且 `POST /`（伪造审计）、`POST /cleanup`（销毁证据）此前无角色限制。另：`GET /export` 注册在 `GET /:id` 之后被遮蔽不可达（历史 bug，未修）。

## 修复历史

<!-- SESSION_SUMMARY_FIXES -->
- ✅ 2026-07-24: API 鉴权收紧 — 挂载收 requireAuth+requireAdmin（审计完整性 + PII）
