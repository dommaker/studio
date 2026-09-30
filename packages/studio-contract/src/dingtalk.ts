/**
 * dingtalk 域契约（批次 7/8）——action 为**协议面例外**，仅 health 走统一壳。
 *
 * GET /api/v1/dingtalk/action 是浏览器跳转面：钉钉 ActionCard 按钮经 URL 跳转
 * 触发，响应为 HTML 页面（人在浏览器看），非 JSON API，envelope 不适用，
 * 路由保持原样。
 *
 * GET /health 无协议约束 → defineRoute 统一壳：
 * `{ status, service }` → `{ data: { status, service } }`（无消费方）。
 */

import { z } from 'zod';
import { dataBodySchema } from './envelope.js';

/** GET /health 响应 data */
export const dingtalkHealthResultSchema = z.object({
  status: z.string(),
  service: z.string(),
});
export type DingtalkHealthResult = z.infer<typeof dingtalkHealthResultSchema>;

export const dingtalkHealthResponseSchema = dataBodySchema(dingtalkHealthResultSchema);
