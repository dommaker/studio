/**
 * discord 域契约（批次 7/8）——**协议面例外，只做形状声明，路由保持原样**。
 *
 * POST /api/v1/discord/interactions 是机器对机器协议面：Discord 交互回调
 * （PING/斜杠命令/按钮点击），入站经 express.raw 保留原始 body 做 Ed25519
 * 签名校验（x-signature-ed25519 + x-signature-timestamp），raw body 无法预解析，
 * zod 入参校验不适用；响应形状由 Discord Interactions 协议定（type + data.content），
 * envelope 不适用。正本 = apps/api/src/modules/discord/routes.ts。
 */

import { z } from 'zod';

/** Discord Interaction 响应（PONG / CHANNEL_MESSAGE_WITH_SOURCE） */
export const discordInteractionResponseSchema = z.object({
  /** 1 = PONG；4 = CHANNEL_MESSAGE_WITH_SOURCE */
  type: z.number(),
  data: z.object({
    content: z.string(),
  }).optional(),
});
export type DiscordInteractionResponse = z.infer<typeof discordInteractionResponseSchema>;
