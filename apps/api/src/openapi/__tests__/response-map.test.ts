/**
 * response-map.ts 单元测试：映射表自身卫生（键格式 / 值形状 / 关键域在场）。
 * 「映射键 ⊆ 实际路由」的防漂移断言在 openapi.probe.ts（需真实路由表，tsx 子进程）。
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { RESPONSE_MAP } from '../response-map.js';

describe('RESPONSE_MAP 卫生', () => {
  it('键 = `METHOD /path`（METHOD 全大写 HTTP 动词，路径以 / 开头）', () => {
    for (const key of Object.keys(RESPONSE_MAP)) {
      expect(key).toMatch(/^(GET|POST|PUT|PATCH|DELETE) \//);
    }
  });

  it('response 值是 zod schema；无重复键（对象字面量天然去重，断言规模兜底）', () => {
    for (const [key, doc] of Object.entries(RESPONSE_MAP)) {
      if (doc.response !== undefined) {
        expect(doc.response, key).toBeInstanceOf(z.ZodType);
      }
    }
    expect(Object.keys(RESPONSE_MAP).length).toBeGreaterThan(200);
  });

  it('关键域在场（workunit/channels/pmo/contract envelope 派生的代表性端点）', () => {
    for (const key of [
      'GET /api/v1/workunits',
      'POST /api/v1/workunits/:id/claim',
      'GET /api/v1/channels/:id/messages',
      'GET /api/v1/pmo/project',
      'GET /api/v1/mcp/admin/tools',
      'POST /api/knowledge/upsert',
    ]) {
      expect(RESPONSE_MAP[key]?.response, key).toBeDefined();
    }
  });
});
