/**
 * iron-laws 域契约测试：请求边界（含 #641 context 保键）+ 响应壳。
 * 正本 = apps/api/src/modules/harness/iron-laws.routes.ts。
 */

import { describe, it, expect } from 'vitest';
import {
  ironLawSchema,
  ironLawCheckBodySchema,
  ironLawCheckAllBodySchema,
  ironLawCheckResultSchema,
  ironLawCheckAllResultSchema,
  ironLawListResponseSchema,
  ironLawGetResponseSchema,
  ironLawCheckResponseSchema,
  ironLawCheckAllResponseSchema,
} from '../iron-laws.js';
import * as contractIndex from '../index.js';

describe('ironLawSchema', () => {
  it('id 必填；passthrough 放行 harness 侧扩展字段', () => {
    const law = ironLawSchema.parse({ id: 'no_secrets', severity: 'error', message: 'm', custom: 1 });
    expect(law.id).toBe('no_secrets');
    expect((law as Record<string, unknown>).custom).toBe(1);
    expect(() => ironLawSchema.parse({ severity: 'error' })).toThrow();
  });
});

describe('请求边界', () => {
  it('check：lawId 单值或数组必填（MISSING_LAW_ID 退役）；context record 保留 has* 键', () => {
    const body = { lawId: 'c1', context: { operation: 'x', hasRequirement: true } };
    expect(ironLawCheckBodySchema.parse(body)).toEqual(body);
    expect(ironLawCheckBodySchema.parse({ lawId: ['c1', 'c2'], context: {} }).lawId).toHaveLength(2);
    expect(() => ironLawCheckBodySchema.parse({ context: {} })).toThrow();
    expect(() => ironLawCheckBodySchema.parse({ lawId: 'c1' })).toThrow();
    expect(() => ironLawCheckBodySchema.parse({ lawId: [], context: {} })).toThrow();
    // #641：sanitize 依赖 has* 键在 zod 校验后仍在（record 不剥键）
    const parsed = ironLawCheckBodySchema.parse(body);
    expect(parsed.context.hasRequirement).toBe(true);
  });

  it('check-all：context 必填（MISSING_CONTEXT 退役）', () => {
    expect(ironLawCheckAllBodySchema.parse({ context: {} })).toEqual({ context: {} });
    expect(() => ironLawCheckAllBodySchema.parse({})).toThrow();
  });
});

describe('响应壳', () => {
  it('GET / → { data: laws[] }（success/count/source 壳退役）', () => {
    const body = { data: [{ id: 'c1' }, { id: 'c2' }] };
    expect(ironLawListResponseSchema.parse(body).data).toHaveLength(2);
  });

  it('GET /:id → { data: law }', () => {
    expect(ironLawGetResponseSchema.parse({ data: { id: 'c1' } }).data.id).toBe('c1');
  });

  it('POST /check → { data: { result, strippedEvidenceFlags? } }（单条或 id→result 映射）', () => {
    const single = { result: { id: 'c1', satisfied: true, message: 'm' } };
    expect(ironLawCheckResultSchema.parse(single)).toEqual(single);
    const batch = {
      result: { c1: { id: 'c1', satisfied: true, message: 'm' } },
      strippedEvidenceFlags: ['hasTest'],
    };
    expect(ironLawCheckResponseSchema.parse({ data: batch }).data.strippedEvidenceFlags).toEqual(['hasTest']);
  });

  it('POST /check-all → { data: { results, strippedEvidenceFlags?, degradedChecks?, violationPartialView? } }', () => {
    const full = {
      results: { passed: false, errors: [{ id: 'c1', satisfied: false, message: 'm' }], warnings: [], warningCount: 0 },
      strippedEvidenceFlags: ['hasRequirement'],
      degradedChecks: [{ id: 'c2', skipReason: '证据不可得' }],
      violationPartialView: { truncated: true, reason: 'r' },
    };
    expect(ironLawCheckAllResultSchema.parse(full)).toEqual(full);
    expect(ironLawCheckAllResponseSchema.parse({ data: full }).data.results.passed).toBe(false);
    // 最小形态（无标注键）
    expect(ironLawCheckAllResultSchema.parse({ results: full.results })).toEqual({ results: full.results });
  });
});

describe('index.ts 出口', () => {
  it('iron-laws 域 schema 经 index 导出', () => {
    expect(contractIndex.ironLawCheckBodySchema).toBeDefined();
    expect(contractIndex.ironLawCheckAllResponseSchema).toBeDefined();
  });
});
