/**
 * lark 域契约测试（/callback 为协议面例外；GET /health 走统一壳）。
 * 正本 = apps/api/src/modules/lark/routes.ts。
 */

import { describe, it, expect } from 'vitest';
import { larkChallengeResponseSchema, larkCallbackAckSchema, larkHealthResponseSchema } from '../lark.js';
import * as contractIndex from '../index.js';

describe('lark 出参', () => {
  it('url_verification 回显 challenge；ack { code: 0, msg }（code 恒 0）', () => {
    expect(larkChallengeResponseSchema.parse({ challenge: 'c-1' }).challenge).toBe('c-1');
    expect(larkCallbackAckSchema.parse({ code: 0, msg: 'success' }).code).toBe(0);
    expect(() => larkCallbackAckSchema.parse({ code: 1, msg: 'x' })).toThrow();
  });

  it('GET /health → { data: { status, service } }（统一壳）', () => {
    const body = { data: { status: 'ok', service: 'lark-callback' } };
    expect(larkHealthResponseSchema.parse(body).data.service).toBe('lark-callback');
  });
});

describe('index.ts 出口', () => {
  it('lark 域 schema 经 index 导出', () => {
    expect(contractIndex.larkCallbackAckSchema).toBeDefined();
  });
});
