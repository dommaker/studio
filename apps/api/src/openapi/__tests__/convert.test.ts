/**
 * openapi.ts（zod → OpenAPI 3.0 SchemaObject 转换器）测试。
 * 覆盖面 = 仓内 contract 实际使用的 zod 子集（见 openapi.ts 头注释清单）；
 * 断言生成物是合法 OpenAPI 结构（类型/required/壳语义），不逐字段复刻实现细节。
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { zodToOpenAPISchema } from '../openapi.js';
import { workUnitSchema, workUnitListResponseSchema, reviewConfirmPayloadSchema } from '../workunit.js';

describe('zodToOpenAPISchema 基础标量', () => {
  it('string/number/boolean/null/unknown', () => {
    expect(zodToOpenAPISchema(z.string())).toEqual({ type: 'string' });
    expect(zodToOpenAPISchema(z.number())).toEqual({ type: 'number' });
    expect(zodToOpenAPISchema(z.boolean())).toEqual({ type: 'boolean' });
    expect(zodToOpenAPISchema(z.null())).toEqual({ nullable: true });
    expect(zodToOpenAPISchema(z.unknown())).toEqual({});
  });

  it('string 修饰：min/max/regex；trim 不影响形状', () => {
    expect(zodToOpenAPISchema(z.string().min(1).max(10))).toEqual({ type: 'string', minLength: 1, maxLength: 10 });
    expect(zodToOpenAPISchema(z.string().regex(/^a+$/))).toEqual({ type: 'string', pattern: '^a+$' });
    expect(zodToOpenAPISchema(z.string().trim().min(1))).toEqual({ type: 'string', minLength: 1 });
  });

  it('number 修饰：int → integer；positive/nonnegative → minimum', () => {
    expect(zodToOpenAPISchema(z.number().int())).toEqual({ type: 'integer' });
    expect(zodToOpenAPISchema(z.number().int().positive())).toEqual({ type: 'integer', minimum: 0, exclusiveMinimum: true });
    expect(zodToOpenAPISchema(z.number().nonnegative())).toEqual({ type: 'number', minimum: 0 });
  });

  it('enum/literal', () => {
    expect(zodToOpenAPISchema(z.enum(['a', 'b']))).toEqual({ type: 'string', enum: ['a', 'b'] });
    expect(zodToOpenAPISchema(z.literal('x'))).toEqual({ type: 'string', enum: ['x'] });
    expect(zodToOpenAPISchema(z.literal(42))).toEqual({ type: 'number', enum: [42] });
  });
});

describe('zodToOpenAPISchema 复合结构', () => {
  it('object：required 只含非 optional/default 键；strip 不写 additionalProperties', () => {
    const out = zodToOpenAPISchema(z.object({
      id: z.string(),
      nick: z.string().optional(),
      maybe: z.string().nullable(),
      d: z.string().default('x'),
    }));
    expect(out.type).toBe('object');
    expect(out.required?.sort()).toEqual(['id', 'maybe']);
    expect(out.properties?.nick).toEqual({ type: 'string' });
    expect(out.properties?.maybe).toEqual({ type: 'string', nullable: true });
    expect(out.properties?.d).toEqual({ type: 'string', default: 'x' });
    expect('additionalProperties' in out).toBe(false);
  });

  it('passthrough → additionalProperties: true；strict → false', () => {
    expect(zodToOpenAPISchema(z.object({ a: z.string() }).passthrough()).additionalProperties).toBe(true);
    expect(zodToOpenAPISchema(z.object({ a: z.string() }).strict()).additionalProperties).toBe(false);
  });

  it('array/record', () => {
    expect(zodToOpenAPISchema(z.array(z.string()))).toEqual({ type: 'array', items: { type: 'string' } });
    expect(zodToOpenAPISchema(z.record(z.string(), z.number()))).toEqual({
      type: 'object', additionalProperties: { type: 'number' },
    });
    expect(zodToOpenAPISchema(z.record(z.unknown()))).toEqual({ type: 'object', additionalProperties: {} });
  });

  it('union → anyOf；discriminatedUnion → oneOf + discriminator', () => {
    const u = zodToOpenAPISchema(z.union([z.string(), z.number()]));
    expect(u.anyOf).toEqual([{ type: 'string' }, { type: 'number' }]);
    const d = zodToOpenAPISchema(reviewConfirmPayloadSchema);
    expect(d.discriminator).toEqual({ propertyName: 'kind' });
    expect(d.oneOf).toHaveLength(3);
    expect(d.oneOf?.[0].properties?.kind).toEqual({ type: 'string', enum: ['decision'] });
  });

  it('refine 透传内层形状（校验语义不进 JSON Schema）', () => {
    const refined = z.object({ path: z.string() }).refine(() => true);
    expect(zodToOpenAPISchema(refined)).toEqual({
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    });
  });

  it('未覆盖子集退化 {} + x-studio-unconverted 标注', () => {
    const out = zodToOpenAPISchema(z.tuple([z.string()]));
    expect(out['x-studio-unconverted']).toBe('ZodTuple');
  });
});

describe('zodToOpenAPISchema 真实 contract schema 冒烟', () => {
  it('workUnitSchema 产出合法 object schema（必填键集合与 parity 语义一致）', () => {
    const out = zodToOpenAPISchema(workUnitSchema);
    expect(out.type).toBe('object');
    // WorkUnit interface 必填字段（workspaceId/reqId/assigneeRoleId/claimable 为可选）
    for (const key of ['id', 'parentId', 'type', 'scope', 'status', 'createdAt', 'updatedAt']) {
      expect(out.required).toContain(key);
    }
    for (const key of ['workspaceId', 'reqId', 'assigneeRoleId', 'claimable']) {
      expect(out.required).not.toContain(key);
    }
    expect(out.properties?.parentId).toEqual({ type: 'string', nullable: true });
  });

  it('分页响应壳 = { data: T[], pagination }', () => {
    const out = zodToOpenAPISchema(workUnitListResponseSchema);
    expect(out.required?.sort()).toEqual(['data', 'pagination']);
    expect(out.properties?.data).toMatchObject({ type: 'array' });
    expect(out.properties?.pagination?.required?.sort()).toEqual(['limit', 'page', 'total', 'totalPages']);
  });
});
