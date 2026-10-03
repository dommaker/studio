/**
 * action-center 域契约——正本以 apps/api/src/modules/action-center/
 * action-center.service.ts（ActionCenterPayload）与 studio-notification
 * NotificationService.getUserNotifications 返回行为准（studio-notification
 * 带 Node 依赖不 import，wire 形状在此重声明）。
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

/** 手写 interface（前端 notificationStore/needInputViewOf 按必填消费 kind/wuId/
 * scope/channelId/since；z.infer 在本仓退化全可选）；parity 测试见 __tests__ */
export interface ActionCenterStateItem {
  kind: ActionCenterStateItemKind;
  wuId: string;
  scope: string;
  channelId: string | null;
  waitingQuestion?: string;
  messageId?: string;
  since: string;
}

// ── 实体：通知（NotificationService.getUserNotifications wire 重声明）──

/** createdAt/readAt 为 Date 实例经 JSON 序列化为 ISO 串（wire 即 string） */
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

/** GET / 响应 data（三段整体替换；手写：stateItems 为手写实体数组） */
export const actionCenterPayloadSchema = z.object({
  stateItems: z.array(actionCenterStateItemSchema),
  notifications: z.array(actionCenterNotificationSchema),
  unreadCount: z.number(),
});
export interface ActionCenterPayloadWire {
  stateItems: ActionCenterStateItem[];
  notifications: ActionCenterNotification[];
  unreadCount: number;
}

export const actionCenterResponseSchema = dataBodySchema(actionCenterPayloadSchema);
