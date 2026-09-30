/**
 * companies 域契约测试：实体/请求/响应 schema 的接受-拒绝边界 + Company parity。
 * 正本 = companies/routes.ts CompanyRecord + 路由实测 wire 行为。
 */

import { describe, it, expect } from 'vitest';
import {
  companySchema,
  type Company,
  companySizeConfigEntrySchema,
  companyHallStatsSchema,
  companyIdParamsSchema,
  createCompanyBodySchema,
  updateCompanyBodySchema,
  companyListResponseSchema,
  companyResponseSchema,
  companySizeConfigResponseSchema,
  companyHallStatsResponseSchema,
} from '../companies.js';
import * as contractIndex from '../index.js';

/** 后端 CompanyRecord 全字段最小合法形状 */
const companyRow: Company = {
  id: 'company_1',
  name: '我的工作空间',
  size: 'custom',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

describe('companySchema', () => {
  // strict:false 仓 z.infer 全字段退化可选 → Company 是手写 interface；parity 兜漂移
  it('parity：Company interface fixture 全键 = schema.shape 键；必填字段删除即拒', () => {
    expect(companySchema.parse(companyRow)).toEqual(companyRow);
    expect(Object.keys(companySchema.shape).sort()).toEqual(Object.keys(companyRow).sort());
    for (const key of Object.keys(companyRow)) {
      const { [key]: _drop, ...rest } = companyRow as Record<string, unknown>;
      expect(companySchema.safeParse(rest).success, `删除 ${key} 应被拒`).toBe(false);
    }
  });
});

describe('请求 schema', () => {
  it('create / update body：name trim 后非空（缺省原静默存 undefined，收紧 400）', () => {
    expect(createCompanyBodySchema.parse({ name: ' 测试公司 ' }).name).toBe('测试公司');
    expect(createCompanyBodySchema.safeParse({}).success).toBe(false);
    expect(createCompanyBodySchema.safeParse({ name: '  ' }).success).toBe(false);
    expect(updateCompanyBodySchema.parse({ name: '新名字' })).toEqual({ name: '新名字' });
    expect(updateCompanyBodySchema.safeParse({}).success).toBe(false);
    expect(companyIdParamsSchema.safeParse({ companyId: '' }).success).toBe(false);
  });
});

describe('派生读与响应壳', () => {
  it('sizes/config 与 hall-stats 形状', () => {
    expect(companySizeConfigEntrySchema.parse({ name: '小型公司', roleLimit: 3 })).toBeTruthy();
    expect(companyHallStatsSchema.parse({
      company: { id: 'c', name: 'n', size: 'custom' }, runningTasks: 1, todayCompletedTasks: 2,
    })).toBeTruthy();
    expect(companyHallStatsSchema.safeParse({ company: { id: 'c' }, runningTasks: 0, todayCompletedTasks: 0 }).success).toBe(false);
  });

  it('{ data } 统一壳', () => {
    expect(companyListResponseSchema.parse({ data: [companyRow] }).data).toHaveLength(1);
    expect(companyResponseSchema.parse({ data: companyRow }).data.id).toBe('company_1');
    expect(companySizeConfigResponseSchema.parse({
      data: { small: { name: '小型公司', roleLimit: 3 } },
    }).data.small).toEqual({ name: '小型公司', roleLimit: 3 });
    expect(companyHallStatsResponseSchema.parse({
      data: { company: { id: 'c', name: 'n', size: 's' }, runningTasks: 0, todayCompletedTasks: 0 },
    })).toBeTruthy();
  });

  it('index.ts 出口包含 companies 域 schema', () => {
    expect(contractIndex.companySchema).toBe(companySchema);
    expect(contractIndex.createCompanyBodySchema).toBe(createCompanyBodySchema);
  });
});
