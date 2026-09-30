/**
 * dingtalk 域契约测试（/action 为浏览器跳转 HTML 面例外；GET /health 走统一壳）。
 * 正本 = apps/api/src/modules/dingtalk/routes.ts。
 */

import { describe, it, expect } from 'vitest';
import { dingtalkHealthResponseSchema } from '../dingtalk.js';
import * as contractIndex from '../index.js';

describe('dingtalk 出参', () => {
  it('GET /health → { data: { status, service } }（统一壳）', () => {
    const body = { data: { status: 'ok', service: 'dingtalk-callback' } };
    expect(dingtalkHealthResponseSchema.parse(body).data.status).toBe('ok');
  });
});

describe('index.ts 出口', () => {
  it('dingtalk 域 schema 经 index 导出', () => {
    expect(contractIndex.dingtalkHealthResponseSchema).toBeDefined();
  });
});
