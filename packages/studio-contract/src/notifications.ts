/**
 * notifications 域契约——正本以 packages/studio-notification
 * NotificationService.getUserNotifications 返回行与 apps/api/src/modules/
 * notifications/routes.ts 实测 wire 为准（studio-notification 带 Node 依赖不
 * import；通知行 wire 与 action-center.ts 的 actionCenterNotificationSchema
 * 同源，本文件 import 复用不重复声明）。
 *
 * 四个端点（route-registry /api/v1/notifications 挂 auth；端点级自持
 * requireAuth + requireNotGuest，身份取登录态 JWT claims req.user.id）：
 *   GET  /              通知列表（unreadOnly 过滤，limit 50）
 *   GET  /unread-count  未读数
 *   POST /:id/read      标记已读（跨用户/不存在 id 静默成功——service 内部归属校验）
 *   POST /read-all      全部已读
 *
 * wire 形状（defineRoute 统一壳后）：
 * - GET / 裸数组 → `{ data: NotificationItem[] }`；GET /unread-count 平铺 → `{ data: { count } }`；
 *   两个写端点平铺 → `{ data: { success } }`
 * - 错误统一 `{ error: { code, message } }`（原手写 500 已同形，code 由
 *   'INTERNAL_ERROR' 归一为 ERROR_CODES.INTERNAL；service 错误文案由固定串变为实际
 *   错误消息，「Authenticated user missing」显式拒绝保留原文案）
 */

import { z } from 'zod';
import { dataBodySchema } from './envelope.js';
import { actionCenterNotificationSchema } from './action-center.js';

// ── 实体：通知行（NotificationService wire，与 action-center 同源复用）──

export const notificationItemSchema = actionCenterNotificationSchema;
export type NotificationItem = z.infer<typeof notificationItemSchema>;

// ── 派生读形状 ──

/** GET /unread-count 响应 data */
export const unreadCountResultSchema = z.object({ count: z.number() });
export type UnreadCountResult = z.infer<typeof unreadCountResultSchema>;

/** POST /:id/read 与 /read-all 响应 data */
export const notificationReadResultSchema = z.object({ success: z.boolean() });
export type NotificationReadResult = z.infer<typeof notificationReadResultSchema>;

// ── 请求 ──

/** GET /（unreadOnly === 'true' 生效；limit 固定 50 在 handler） */
export const listNotificationsQuerySchema = z.object({
  unreadOnly: z.string().optional(),
});
export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;

export const notificationIdParamsSchema = z.object({ id: z.string().min(1) });
export type NotificationIdParams = z.infer<typeof notificationIdParamsSchema>;

// ── 响应（统一 `{ data }` 壳）──

export const notificationListResponseSchema = dataBodySchema(z.array(notificationItemSchema));
export const unreadCountResponseSchema = dataBodySchema(unreadCountResultSchema);
export const notificationReadResponseSchema = dataBodySchema(notificationReadResultSchema);
