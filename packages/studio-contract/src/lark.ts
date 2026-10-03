/**
 * lark 域契约（批次 7/8）——回调为**协议面例外**，仅 health 走统一壳。
 *
 * POST /api/v1/lark/callback 是机器对机器协议面：飞书事件订阅回调
 * （URL 验证 / card.action.trigger 卡片按钮），验签 = verification token 比对
 * （v1 body.token / v2 header.token，timingSafeEqual；非 raw body HMAC，
 * body 已 JSON 解析，token 读取依赖原始键位置，zod 预解析无增益），
 * 响应形状由飞书协议定（url_verification 回 `{ challenge }`、ack 回
 * `{ code: 0, msg: 'success' }`），envelope 不适用，路由保持原样。
 *
 * GET /health 无协议约束 → defineRoute 统一壳：
 * `{ status, service }` → `{ data: { status, service } }`（无消费方）。
 */

import { z } from 'zod';
import { dataBodySchema } from './envelope.js';

/** url_verification 响应（回显 challenge） */
export const larkChallengeResponseSchema = z.object({
  challenge: z.string(),
});
export type LarkChallengeResponse = z.infer<typeof larkChallengeResponseSchema>;

/** 飞书回调 ack（成功接收确认） */
export const larkCallbackAckSchema = z.object({
  code: z.literal(0),
  msg: z.string(),
});
export type LarkCallbackAck = z.infer<typeof larkCallbackAckSchema>;

/** GET /health 响应 data */
export const larkHealthResultSchema = z.object({
  status: z.string(),
  service: z.string(),
});
export type LarkHealthResult = z.infer<typeof larkHealthResultSchema>;

export const larkHealthResponseSchema = dataBodySchema(larkHealthResultSchema);
