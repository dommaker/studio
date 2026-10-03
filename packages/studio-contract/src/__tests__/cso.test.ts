/**
 * cso 域契约测试：GET /validate 降级三形态 + 响应壳。
 * 正本 = apps/api/src/modules/harness/cso.routes.ts。
 */

import { describe, it, expect } from 'vitest';
import { csoValidateResultSchema, csoValidateResponseSchema } from '../cso.js';
import * as contractIndex from '../index.js';

describe('csoValidateResultSchema', () => {
  it('正常校验 / validator 不可用 / 异常跳过三形态（恒 valid:true + issues 数组）', () => {
    expect(csoValidateResultSchema.parse({ valid: true, issues: [] }))
      .toEqual({ valid: true, issues: [] });
    expect(csoValidateResultSchema.parse({ valid: true, issues: [], note: 'CSOValidator not available' }).note)
      .toBe('CSOValidator not available');
    expect(csoValidateResultSchema.parse({ valid: true, issues: [], note: 'CSO check skipped' }).note)
      .toBe('CSO check skipped');
    expect(() => csoValidateResultSchema.parse({ valid: true })).toThrow();
  });

  it('响应壳：GET /validate → { data: { valid, issues, note? } }', () => {
    expect(csoValidateResponseSchema.parse({ data: { valid: true, issues: [] } }).data.valid).toBe(true);
  });
});

describe('index.ts 出口', () => {
  it('cso 域 schema 经 index 导出', () => {
    expect(contractIndex.csoValidateResultSchema).toBeDefined();
    expect(contractIndex.csoValidateResponseSchema).toBeDefined();
  });
});
