# notifications

> 此文件描述 apps/api/src/modules/notifications 目录的职责和上下文

<!-- STALE_SINCE: 2026-08-03 -->
⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/notifications/CONTEXT.md, apps/api/src/modules/notifications/routes.ts

## 职责

提供通知相关的 API 路由，包括获取通知列表、查询未读数量、标记单条已读和标记全部已读，作为后台消息通知模块的 HTTP 接口层。

## 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `router` | `routes.ts` | Express 路由器实例，注册了 /api/v1/notifications 下的四个端点 |

## 依赖关系

上游依赖：
- `@dommaker/studio-notification`（NotificationService）
- `@dommaker/studio-shared`（FileStore, logger）
- `../../utils/services.js`（createLazyService）

下游依赖：
- `apps/api/src/route-registry.ts`（导入并挂载路由）

## 注意事项

- 使用 `x-user-id` 请求头标识用户，默认回退为 `'default-user'`
- 通知服务通过 `createLazyService` 延迟初始化，底层依赖 `FileStore` 存储
- 错误统一返回 `{ error: { code: 'INTERNAL_ERROR', message: '...' } }` 结构
- 未读通知限制获取 50 条，可通过 `unreadOnly` 查询参数控制
- **鉴权（2026-07-24 收紧）**：POST /:id/read、/read-all 已收 requireAuth+requireNotGuest；userId 取自 x-user-id 请求头，存在 IDOR 已知局限（未修）。

## 修复历史

<!-- SESSION_SUMMARY_FIXES -->
- ✅ `782ac0a9`: 路由层防御纵深 — 写操作端点加 requireAuth+requireNotGuest/requireAdmin
- ✅ 2026-07-24: 写端点收 requireAuth+requireNotGuest
