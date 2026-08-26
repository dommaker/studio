/**
 * parsePagination 单测（#359）
 *
 * 统一分页口径：page ≥ 1，limit clamp 1..100，缺省 page=1 / limit=20。
 * 各路由分页入口一律经此函数（AC：全部分页入口经 parsePagination）。
 */
import { describe, it, expect } from 'vitest';
import type { Request } from 'express';
import { parsePagination } from '../pagination.js';

function reqWithQuery(query: Record<string, unknown>): Request {
  return { query } as unknown as Request;
}

describe('parsePagination (#359)', () => {
  it('缺省：page=1 / limit=20 / offset=0', () => {
    expect(parsePagination(reqWithQuery({}))).toEqual({ page: 1, limit: 20, offset: 0 });
  });

  it('正常值：page/limit 透传并换算 offset', () => {
    expect(parsePagination(reqWithQuery({ page: '3', limit: '10' }))).toEqual({ page: 3, limit: 10, offset: 20 });
  });

  it('limit 上限 clamp：999999 → 100', () => {
    expect(parsePagination(reqWithQuery({ limit: '999999' })).limit).toBe(100);
  });

  it('limit 下限 clamp：0 / 负数 → 1 或缺省', () => {
    // 0 是 falsy，parseInt 后 || DEFAULT_LIMIT → 20
    expect(parsePagination(reqWithQuery({ limit: '0' })).limit).toBe(20);
    expect(parsePagination(reqWithQuery({ limit: '-5' })).limit).toBe(1);
  });

  it('page 下限 clamp：0 / 负数 → 1', () => {
    expect(parsePagination(reqWithQuery({ page: '0' })).page).toBe(1);
    expect(parsePagination(reqWithQuery({ page: '-3' })).page).toBe(1);
  });

  it('非数字输入回落缺省值', () => {
    expect(parsePagination(reqWithQuery({ page: 'abc', limit: 'xyz' }))).toEqual({ page: 1, limit: 20, offset: 0 });
  });
});
