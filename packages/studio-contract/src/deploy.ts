/**
 * deploy 域契约（批次 7/8）——**协议面例外，只做形状声明，路由保持原样**。
 *
 * POST /api/v1/deploy/webhook 是机器对机器协议面：GitHub push webhook，
 * 入站经 express.raw 保留原始 body 做 HMAC-SHA256 校验（X-Hub-Signature-256），
 * raw body 无法预解析，zod 入参校验不适用；行为 = 202 立即返回后异步触发部署
 * 脚本（幂等可重入）。响应为简单机器串约定（非 envelope），路由保持原样。
 * 正本 = apps/api/src/modules/deploy/webhook.routes.ts。
 */

import { z } from 'zod';

/** 202 接受（push 到 refs/heads/master，部署已异步触发） */
export const deployWebhookAcceptedSchema = z.object({
  accepted: z.literal(true),
});
export type DeployWebhookAccepted = z.infer<typeof deployWebhookAcceptedSchema>;

/** 202 忽略（非 push 事件 → 'not a push event'；非 master 分支 → 回显 ref） */
export const deployWebhookIgnoredSchema = z.object({
  ignored: z.string(),
});
export type DeployWebhookIgnored = z.infer<typeof deployWebhookIgnoredSchema>;

/** 拒绝体（401 签名无效 / 400 raw body 缺失或 payload 非法 / 503 未配置） */
export const deployWebhookErrorSchema = z.object({
  error: z.string(),
});
export type DeployWebhookError = z.infer<typeof deployWebhookErrorSchema>;
