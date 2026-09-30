/**
 * notify-channels 域契约测试：双段状态 parity + 绑定状态机 + 请求边界 + 响应壳。
 * 正本 = apps/api/src/modules/notify-channels/routes.ts（脱敏后形状）。
 */

import { describe, it, expect } from 'vitest';
import {
  wecomChannelStateSchema,
  type WecomChannelState,
  clawbotChannelStateSchema,
  type ClawbotChannelState,
  notifyChannelsStateSchema,
  type NotifyChannelsState,
  clawbotBindStatusSchema,
  clawbotBindStartResultSchema,
  clawbotBindStatusResultSchema,
  notifyChannelsSuccessResultSchema,
  putWecomBodySchema,
  clawbotBindStatusQuerySchema,
  notifyChannelsStateResponseSchema,
  wecomChannelStateResponseSchema,
  clawbotBindStartResponseSchema,
  clawbotBindStatusResponseSchema,
  notifyChannelsSuccessResponseSchema,
} from '../notify-channels.js';
import * as contractIndex from '../index.js';

const wecomConfigured: WecomChannelState = {
  configured: true, maskedUrl: 'http...1234', source: 'settings',
};
const clawbotBound: ClawbotChannelState = {
  bound: true, ilinkUserId: 'ilin...4321', boundAt: '2026-09-12T00:00:00.000Z',
};

describe('wecomChannelStateSchema / clawbotChannelStateSchema', () => {
  it('parity：配置态与未配置态（null 三件套）均通过', () => {
    expect(wecomChannelStateSchema.parse(wecomConfigured)).toEqual(wecomConfigured);
    const wecomEmpty: WecomChannelState = { configured: false, maskedUrl: null, source: null };
    expect(wecomChannelStateSchema.parse(wecomEmpty)).toEqual(wecomEmpty);
    // source 词表：settings / env / null
    expect(wecomChannelStateSchema.parse({ ...wecomConfigured, source: 'env' }).source).toBe('env');
    expect(() => wecomChannelStateSchema.parse({ ...wecomConfigured, source: 'bogus' })).toThrow();

    expect(clawbotChannelStateSchema.parse(clawbotBound)).toEqual(clawbotBound);
    const clawbotEmpty: ClawbotChannelState = { bound: false, ilinkUserId: null, boundAt: null };
    expect(clawbotChannelStateSchema.parse(clawbotEmpty)).toEqual(clawbotEmpty);
  });
});

describe('notifyChannelsStateSchema', () => {
  it('parity：NotifyChannelsState fixture（wecom + clawbot 双段）', () => {
    const state: NotifyChannelsState = { wecom: wecomConfigured, clawbot: clawbotBound };
    expect(notifyChannelsStateSchema.parse(state)).toEqual(state);
    expect(notifyChannelsStateResponseSchema.parse({ data: state }).data.wecom.configured).toBe(true);
    expect(() => notifyChannelsStateSchema.parse({ wecom: wecomConfigured })).toThrow();
  });

  it('PUT /wecom 响应 = 单段 wecom 壳', () => {
    expect(wecomChannelStateResponseSchema.parse({ data: wecomConfigured }).data.source).toBe('settings');
  });
});

describe('ClawBot 绑定流程', () => {
  it('bind/status 状态机词表：wait → scaned → confirmed', () => {
    for (const s of ['wait', 'scaned', 'confirmed']) {
      expect(clawbotBindStatusSchema.parse(s)).toBe(s);
    }
    expect(() => clawbotBindStatusSchema.parse('scanned')).toThrow();
  });

  it('bind/start 响应 { qrcode, qrcodeUrl }；bind/status 响应 { status, bound }', () => {
    const start = { qrcode: 'qr-key-1', qrcodeUrl: 'https://example.com/qr/abc' };
    expect(clawbotBindStartResultSchema.parse(start)).toEqual(start);
    expect(clawbotBindStartResponseSchema.parse({ data: start }).data.qrcode).toBe('qr-key-1');
    const status = { status: 'confirmed', bound: true };
    expect(clawbotBindStatusResultSchema.parse(status)).toEqual(status);
    expect(clawbotBindStatusResponseSchema.parse({ data: status }).data.bound).toBe(true);
  });

  it('bind/status query qrcode 必填（原手写 400 收进 zod）', () => {
    expect(clawbotBindStatusQuerySchema.parse({ qrcode: 'qr-1' }).qrcode).toBe('qr-1');
    expect(() => clawbotBindStatusQuerySchema.parse({})).toThrow();
    expect(() => clawbotBindStatusQuerySchema.parse({ qrcode: '' })).toThrow();
  });
});

describe('putWecomBodySchema / success 结果', () => {
  it('webhookUrl 必填 string（空串 = 清除合法；前缀校验在 handler）', () => {
    expect(putWecomBodySchema.parse({ webhookUrl: '' }).webhookUrl).toBe('');
    expect(putWecomBodySchema.parse({ webhookUrl: 'https://qyapi.weixin.qq.com/x' }).webhookUrl).toContain('qyapi');
    expect(() => putWecomBodySchema.parse({ webhookUrl: 42 })).toThrow();
    expect(() => putWecomBodySchema.parse({})).toThrow();
  });

  it('test/unbind 响应 { success } 壳', () => {
    expect(notifyChannelsSuccessResultSchema.parse({ success: true })).toEqual({ success: true });
    expect(notifyChannelsSuccessResponseSchema.parse({ data: { success: true } }).data.success).toBe(true);
  });
});

describe('index.ts 出口', () => {
  it('notify-channels 域 schema 经 index 导出', () => {
    expect(contractIndex.notifyChannelsStateSchema).toBeDefined();
    expect(contractIndex.clawbotBindStatusSchema).toBeDefined();
    expect(contractIndex.putWecomBodySchema).toBeDefined();
  });
});
