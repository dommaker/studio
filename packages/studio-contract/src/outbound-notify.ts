/**
 * outbound-notify 域契约——正本以 apps/api/src/modules/outbound-notify/
 * routes.ts 与 notify.service.ts（NotifyMessage）实测 wire 为准。
 *
 * 单端点 POST /api/v1/notify/send（route-registry 挂 admin；DD-009 出站推送，
 * 供内部模块调用——无前端消费方，仅后端迁移）。
 *
 * wire 形状（defineRoute 统一壳后）：
 * - 平铺 `{ success, message }` → `{ data: { success, message } }`
 * - 错误统一 `{ error: { code, message } }`（原 `{ error: string }` 退役；
 *   必填 guard 文案变 zod 格式；500 文案由固定串变为实际错误消息）
 */

import { z } from 'zod';
import { dataBodySchema } from './envelope.js';

/** NotifyMessage.type 词表（service 层联合类型的 wire 正本） */
export const notifyMessageTypeSchema = z.enum([
  'task-failed', 'timeout', 'crash', 'zombie', 'human-needed',
  'meeting-started', 'meeting-message', 'meeting-completed', 'meeting-cancelled',
  'user-intervention-needed',
]);
export type NotifyMessageType = z.infer<typeof notifyMessageTypeSchema>;

/** POST /send（type/title/content 必填——原手写 400 收进 zod；
 * priority 原仅缺省回填 'medium'、非法值透传，迁移后收进词表校验） */
export const notifySendBodySchema = z.object({
  type: notifyMessageTypeSchema,
  taskId: z.string().optional(),
  meetingId: z.string().optional(),
  title: z.string().min(1),
  content: z.string().min(1),
  priority: z.enum(['low', 'medium', 'high']).optional(),
});
export type NotifySendBody = z.infer<typeof notifySendBodySchema>;

/** POST /send 响应 data */
export const notifySendResultSchema = z.object({
  success: z.boolean(),
  message: z.string(),
});
export type NotifySendResult = z.infer<typeof notifySendResultSchema>;

export const notifySendResponseSchema = dataBodySchema(notifySendResultSchema);
