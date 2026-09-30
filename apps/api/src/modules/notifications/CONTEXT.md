# apps/api/src/modules/notifications

### 职责

提供通知相关的 API 路由，包括获取通知列表、查询未读数量、标记单条已读和标记全部已读，作为后台消息通知模块的 HTTP 接口层。

### 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `router` | `routes.ts` | Express 路由器实例，注册了 /api/v1/notifications 下的四个端点 |

### 依赖关系

上游依赖：
- `@dommaker/studio-notification`（NotificationService）
- `@dommaker/studio-shared`（FileStore, logger）
- `../../utils/services.js`（createLazyService）

下游依赖：
- `apps/api/src/route-registry.ts`（导入并挂载路由）

### 注意事项

- 使用 `x-user-id` 请求头标识用户，默认回退为 `'default-user'`
- 通知服务通过 `createLazyService` 延迟初始化，底层依赖 `FileStore` 存储
- **契约驱动迁移（2026-10 批次 5/7）**：四端点 defineRoute 化——响应统一 `{ data }` 壳（GET / 裸数组、unread-count 与写端点平铺全进壳），错误统一 `{ error: { code, message } }`（code 由 'INTERNAL_ERROR' 归一为 ERROR_CODES.INTERNAL；service 错误文案由固定串变为实际错误消息，「Authenticated user missing」显式拒绝保留原文案）；契约正本 = `packages/studio-contract/src/notifications.ts`（通知行与 action-center 同源复用）
- 未读通知限制获取 50 条，可通过 `unreadOnly` 查询参数控制
- **鉴权（2026-07-24 收紧）**：POST /:id/read、/read-all 已收 requireAuth+requireNotGuest；userId 取自 x-user-id 请求头，存在 IDOR 已知局限（未修）。
