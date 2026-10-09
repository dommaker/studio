# apps/api/src/modules/notifications

### 职责

通知域：通知的创建、查询、标记已读（服务层 `NotificationService`，JSONL 持久化，#684 自 packages/studio-notification 下沉并入本模块）+ 对应 HTTP API 路由（获取通知列表、查询未读数量、标记单条已读和标记全部已读）。

### 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `router` | `routes.ts` | Express 路由器实例，注册了 /api/v1/notifications 下的四个端点 |
| `NotificationService` / `getNotificationService` / `CreateNotificationInput` | `notification-service.ts` | 通知服务类（创建/查询/标记，写 `~/.studio/logs/notifications.jsonl`）；`getNotificationService` 为进程级单例入口（#684，createLazyService 首次调用时才取 getStore()；测试自行 `new NotificationService(显式 store)`） |

### 依赖关系

上游依赖：
- `@dommaker/studio-shared`（FileStore, logger, foldJsonlById）
- `../../utils/services.js`（createLazyService）
- `../../core/store.js`（getStore）

下游依赖：
- `apps/api/src/route-registry.ts`（导入并挂载路由）
- 跨模块消费方（经本模块 index.ts 公共面）：utils/notifier、action-center、workunit（wu-messenger/gate-escalation）、agent-auditor、pmo/delivery-notify、triage/incident-notification

### 注意事项

- 使用 `x-user-id` 请求头标识用户，默认回退为 `'default-user'`
- 通知服务通过 `createLazyService` 延迟初始化，底层依赖 `FileStore` 存储
- `CreateNotificationInput` 的 `type` 为 `review_request | review_approved | review_rejected | system | auditor_suggestion | wu_milestone | monitor_alert | incident | gate_reminder`（wu_milestone/monitor_alert/incident 为 #468 行动中心追加，gate_reminder 为 #523 人闸催办/认领滞留 tier1 提醒）；数据行可选 `wuId/channelId` 结构化直链字段，查询透出（无则 null）。
- #468：`createForAllUsers(input)` 把「遍历全用户写入」从 auditor-execution 的 readdir 先例收敛为服务方法（data/users/*.json 文件名，截顶 10，目录缺失返回 0 不抛错）；studio 事实单用户，多用户精确归属另票。
- append-only 折叠口径（#360）：私有 `foldRows` 建在共享 `foldJsonlById` 上（studio-shared）。墓碑行 `{ id, deleted: true, deletedAt }` 是「已读标记」非删除——已读通知保留可见，全墓碑（孤儿墓碑行）不可见；数据载体 = 最新非 deleted 行，readAt = 首个墓碑的 deletedAt（多次 markAllAsRead 取首个）。四个读方法（getUserNotifications/markAsRead/markAllAsRead/getUnreadCount）共用 foldRows，改口径只改一处。
- **契约驱动迁移（2026-10 批次 5/7）**：四端点 defineRoute 化——响应统一 `{ data }` 壳（GET / 裸数组、unread-count 与写端点平铺全进壳），错误统一 `{ error: { code, message } }`（code 由 'INTERNAL_ERROR' 归一为 ERROR_CODES.INTERNAL；service 错误文案由固定串变为实际错误消息，「Authenticated user missing」显式拒绝保留原文案）；契约正本 = `packages/studio-contract/src/notifications.ts`（通知行与 action-center 同源复用）
- 未读通知限制获取 50 条，可通过 `unreadOnly` 查询参数控制
- **鉴权（2026-07-24 收紧；P2-e 声明式统一）**：全端点（含 GET）姿态 = requireAuth+requireNotGuest，统一挂 route-registry entry，路由内不再挂载；userId 取自 x-user-id 请求头，存在 IDOR 已知局限（未修）。
