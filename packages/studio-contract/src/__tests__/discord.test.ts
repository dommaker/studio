/**
 * discord 域契约测试（协议面例外：express.raw Ed25519 签名面，路由保持原样）。
 * 正本 = apps/api/src/modules/discord/routes.ts。
 */

import { describe, it, expect } from 'vitest';
import { discordInteractionResponseSchema } from '../discord.js';
import * as contractIndex from '../index.js';

describe('discordInteractionResponseSchema', () => {
  it('PONG（type 1，无 data）与 CHANNEL_MESSAGE_WITH_SOURCE（type 4 + content）', () => {
    expect(discordInteractionResponseSchema.parse({ type: 1 }).type).toBe(1);
    const msg = { type: 4, data: { content: '✅ Stopped' } };
    expect(discordInteractionResponseSchema.parse(msg).data?.content).toBe('✅ Stopped');
    expect(() => discordInteractionResponseSchema.parse({ data: { content: 'x' } })).toThrow();
  });
});

describe('index.ts 出口', () => {
  it('discord 域 schema 经 index 导出', () => {
    expect(contractIndex.discordInteractionResponseSchema).toBeDefined();
  });
});
