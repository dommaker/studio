/**
 * notify-channels 域契约——正本以 apps/api/src/modules/notify-channels/
 * routes.ts 实测 wire 为准（#525 P2-6，/settings「通知渠道」配置区服务端支撑；
 * route-registry 挂 admin）。
 *
 * 七个端点：
 *   GET  /                     双段状态总览（企微脱敏 + ClawBot 绑定态脱敏）
 *   PUT  /wecom                保存/清除 webhook（空串清除；非 qyapi 前缀 400）
 *   POST /wecom/test           经「配置存储优先、env 兜底」发测试 markdown
 *   POST /clawbot/bind/start   取扫码二维码
 *   GET  /clawbot/bind/status  轮询扫码状态；confirmed 持久化凭据
 *   POST /clawbot/unbind       清除绑定
 *   POST /clawbot/test         向已绑定用户发测试文本
 *
 * 脱敏（硬约束）：任何响应不得出现完整 webhookUrl / botToken / ilinkUserId
 * （maskValue 脱敏后下发）。
 *
 * wire 形状（defineRoute 统一壳后）：
 * - `{ success, data }` 壳的 success 标志退役 → 全部 `{ data: T }`；
 *   原裸 `{ success: true }`（wecom/test、unbind、clawbot/test）→ `{ data: { success } }`
 * - 错误统一 `{ error: { code, message } }`（原 `{ success: false, error: string }`
 *   退役；400 未配置/未绑定与 webhookUrl 前缀校验文案保留，502 上游失败文案保留
 *   实际错误消息、code = BAD_GATEWAY）
 */

import { z } from 'zod';
import { dataBodySchema } from './envelope.js';

// ── 实体：渠道状态段（脱敏后形状）──

/** 手写 interface（前端 NotifyChannelsSection 按必填消费）；parity 测试见 __tests__ */
export interface WecomChannelState {
  configured: boolean;
  maskedUrl: string | null;
  /** 配置来源：settings = 配置存储 / env = 仅环境变量（部署默认） */
  source: 'settings' | 'env' | null;
}
export const wecomChannelStateSchema = z.object({
  configured: z.boolean(),
  maskedUrl: z.string().nullable(),
  source: z.enum(['settings', 'env']).nullable(),
});

/** 手写 interface（前端 NotifyChannelsSection 按必填消费）；parity 测试见 __tests__ */
export interface ClawbotChannelState {
  bound: boolean;
  /** 脱敏后的 ilinkUserId（maskValue） */
  ilinkUserId: string | null;
  boundAt: string | null;
}
export const clawbotChannelStateSchema = z.object({
  bound: z.boolean(),
  ilinkUserId: z.string().nullable(),
  boundAt: z.string().nullable(),
});

/** GET / 响应 data（手写：含手写实体子树） */
export const notifyChannelsStateSchema = z.object({
  wecom: wecomChannelStateSchema,
  clawbot: clawbotChannelStateSchema,
});
export interface NotifyChannelsState {
  wecom: WecomChannelState;
  clawbot: ClawbotChannelState;
}

// ── 派生读形状 ──

/** ClawBot 绑定轮询状态机：wait（未扫）→ scaned（已扫未确认）→ confirmed（绑定完成） */
export const clawbotBindStatusSchema = z.enum(['wait', 'scaned', 'confirmed']);
export type ClawbotBindStatus = z.infer<typeof clawbotBindStatusSchema>;

/** POST /clawbot/bind/start 响应 data（qrcodeUrl = 上游 qrcode_img_content，前端渲染二维码） */
export const clawbotBindStartResultSchema = z.object({
  qrcode: z.string(),
  qrcodeUrl: z.string(),
});
export type ClawbotBindStartResult = z.infer<typeof clawbotBindStartResultSchema>;

/** GET /clawbot/bind/status 响应 data（confirmed 时凭据已持久化，bound:true） */
export const clawbotBindStatusResultSchema = z.object({
  status: clawbotBindStatusSchema,
  bound: z.boolean(),
});
export type ClawbotBindStatusResult = z.infer<typeof clawbotBindStatusResultSchema>;

/** POST /wecom/test、/clawbot/unbind、/clawbot/test 响应 data */
export const notifyChannelsSuccessResultSchema = z.object({ success: z.boolean() });
export type NotifyChannelsSuccessResult = z.infer<typeof notifyChannelsSuccessResultSchema>;

// ── 请求 ──

/** PUT /wecom（webhookUrl 必填——原手写 400 收进 zod；空串 = 清除，
 * 非 https://qyapi.weixin.qq.com/ 前缀 400 在 handler 判） */
export const putWecomBodySchema = z.object({
  webhookUrl: z.string(),
});
export type PutWecomBody = z.infer<typeof putWecomBodySchema>;

/** GET /clawbot/bind/status（qrcode 必填——原手写 400 收进 zod） */
export const clawbotBindStatusQuerySchema = z.object({
  qrcode: z.string().min(1),
});
export type ClawbotBindStatusQuery = z.infer<typeof clawbotBindStatusQuerySchema>;

// ── 响应（统一 `{ data }` 壳）──

export const notifyChannelsStateResponseSchema = dataBodySchema(notifyChannelsStateSchema);
export const wecomChannelStateResponseSchema = dataBodySchema(wecomChannelStateSchema);
export const clawbotBindStartResponseSchema = dataBodySchema(clawbotBindStartResultSchema);
export const clawbotBindStatusResponseSchema = dataBodySchema(clawbotBindStatusResultSchema);
export const notifyChannelsSuccessResponseSchema = dataBodySchema(notifyChannelsSuccessResultSchema);
