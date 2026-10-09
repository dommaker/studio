/**
 * action-center 域契约——正本以 apps/api/src/modules/action-center/
 * action-center.service.ts（ActionCenterPayload）与 studio-notification
 * NotificationService.getUserNotifications 返回行为准。源带 Node 依赖且
 * 通知返回为匿名 ReturnType 无导出名，contract 不 import，schema 即 wire 正本。
 *
 * 单端点 GET /api/v1/action-center（requireAuth + requireNotGuest），三类待办
 * 三段返回：stateItems（状态派生：reply/review/confirm，无已读概念）+
 * notifications（事件持久）+ unreadCount。
 *
 * wire 形状（defineRoute 统一壳后）：
 * - `{ data: ActionCenterPayload }`（原平铺裸对象进壳）
 * - 错误统一 `{ error: { code, message } }`（原 `{ error: { code, message } }`
 *   手写 500 已与壳同形，message 文案不变）
 */

import { z } from 'zod';
import { dataBodySchema } from './envelope.js';

// ── 实体：StateItem（状态派生待办）──

export const actionCenterStateItemKindSchema = z.enum(['reply', 'review', 'confirm']);
export type ActionCenterStateItemKind = z.infer<typeof actionCenterStateItemKindSchema>;

export const actionCenterStateItemSchema = z.object({
  kind: actionCenterStateItemKindSchema,
  wuId: z.string(),
  /** 展示口径 = metadata.title ?? scope（后端 parseWuTitle 单一出口） */
  scope: z.string(),
  channelId: z.string().nullable(),
  waitingQuestion: z.string().optional(),
  /** D-2/#533：「WU 当前提问消息」唯一派生点——频道页回复区/提升/chip 定位全消费
   * 本字段；无 channelId / 热层无匹配 / 查询失败 → 缺省（前端 fail-closed） */
  messageId: z.string().optional(),
  since: z.string(),
});

/** 状态派生待办项（前端 notificationStore/needInputViewOf 按必填消费 kind/wuId/scope/channelId/since） */
export type ActionCenterStateItem = z.infer<typeof actionCenterStateItemSchema>;

// ── 实体：通知 ──

/**
 * 通知条目——wire 与 service 内存型有意不同构（createdAt/readAt: Date → ISO 串/null，
 * JSON 序列化）；源为 NotificationService.getUserNotifications 匿名 ReturnType，
 * 无导出名，不同源：schema 即正本。
 */
export const actionCenterNotificationSchema = z.object({
  id: z.string(),
  userId: z.string(),
  type: z.string(),
  title: z.string(),
  content: z.string(),
  link: z.string().nullable(),
  /** #468 结构化直链（老数据行无此字段 → null，前端回退 link 正则解析） */
  wuId: z.string().nullable(),
  channelId: z.string().nullable(),
  createdAt: z.string(),
  read: z.boolean(),
  readAt: z.string().nullable(),
});
export type ActionCenterNotification = z.infer<typeof actionCenterNotificationSchema>;

// ── 响应 ──

/** GET / 响应 data（三段整体替换） */
export const actionCenterPayloadSchema = z.object({
  stateItems: z.array(actionCenterStateItemSchema),
  notifications: z.array(actionCenterNotificationSchema),
  unreadCount: z.number(),
});
export type ActionCenterPayloadWire = z.infer<typeof actionCenterPayloadSchema>;

export const actionCenterResponseSchema = dataBodySchema(actionCenterPayloadSchema);
