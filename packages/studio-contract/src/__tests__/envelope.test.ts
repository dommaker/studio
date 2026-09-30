/**
 * envelope 响应壳契约测试：三形状的 schema 行为 + 包出口完整性。
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  errorBodySchema,
  paginationSchema,
  dataBodySchema,
  paginatedBodySchema,
  ERROR_CODES,
} from '../envelope.js';

describe('envelope', () => {
  it('error 壳：{ error: { code, message } }', () => {
    const ok = { error: { code: 'NOT_FOUND', message: 'nope' } };
    expect(errorBodySchema.parse(ok)).toEqual(ok);
    expect(errorBodySchema.safeParse({ error: 'string-not-object' }).success).toBe(false);
    expect(errorBodySchema.safeParse({ error: { code: 'X' } }).success).toBe(false);
  });

  it('pagination 壳：page/limit 正整数，total/totalPages 非负', () => {
    const ok = { page: 1, limit: 20, total: 0, totalPages: 0 };
    expect(paginationSchema.parse(ok)).toEqual(ok);
    expect(paginationSchema.safeParse({ ...ok, page: 0 }).success).toBe(false);
    expect(paginationSchema.safeParse({ ...ok, total: -1 }).success).toBe(false);
  });

  it('data 壳包装任意 item schema', () => {
    const schema = dataBodySchema(z.object({ id: z.string() }));
    expect(schema.parse({ data: { id: '1' } })).toEqual({ data: { id: '1' } });
    expect(schema.safeParse({ data: { id: 1 } }).success).toBe(false);
  });

  it('分页壳 = data 数组 + pagination', () => {
    const schema = paginatedBodySchema(z.object({ id: z.string() }));
    const ok = { data: [{ id: '1' }], pagination: { page: 1, limit: 20, total: 1, totalPages: 1 } };
    expect(schema.parse(ok)).toEqual(ok);
    expect(schema.safeParse({ data: [{ id: '1' }] }).success).toBe(false);
  });

  it('ERROR_CODES 词表稳定', () => {
    expect(ERROR_CODES.BAD_REQUEST).toBe('BAD_REQUEST');
    expect(ERROR_CODES.NOT_FOUND).toBe('NOT_FOUND');
    expect(ERROR_CODES.INTERNAL).toBe('INTERNAL');
  });
});
