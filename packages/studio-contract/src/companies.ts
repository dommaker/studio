/**
 * companies 域契约——正本字段以 apps/api/src/modules/companies/routes.ts 实际 wire 行为为准
 * （CompanyRecord = ~/.studio/data/companies/*.json 全字段）。
 *
 * wire 形状（defineRoute 统一壳后）：
 * - 全部端点 `{ data: T }`（list/hall-stats/sizes-config 原已带 `{ data }` 壳形状不变；
 *   get/create(201)/update 原裸对象统一进壳）
 */

import { z } from 'zod';
import { dataBodySchema } from './envelope.js';

// ── 实体 ──

/**
 * Company wire 形状（= CompanyRecord 全字段）。手写 interface（前端 pmoDataStore
 * 按必填消费 id/name/size；手抄版 createdAt/updatedAt 可缺省是漂移——后端恒返回）；
 * parity 测试见 __tests__/companies.test.ts。
 */
export interface Company {
  id: string;
  name: string;
  size: string;
  createdAt: string;
  updatedAt: string;
}

export const companySchema = z.object({
  id: z.string(),
  name: z.string(),
  size: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// ── 派生读形状 ──

/** 公司规模配置条目（GET /sizes/config 静态配置表） */
export const companySizeConfigEntrySchema = z.object({
  name: z.string(),
  roleLimit: z.number(),
});
export type CompanySizeConfigEntry = z.infer<typeof companySizeConfigEntrySchema>;

/** 公司大厅统计（GET /:companyId/hall-stats 聚合） */
export const companyHallStatsSchema = z.object({
  company: z.object({
    id: z.string(),
    name: z.string(),
    size: z.string(),
  }),
  runningTasks: z.number(),
  todayCompletedTasks: z.number(),
});
export type CompanyHallStats = z.infer<typeof companyHallStatsSchema>;

// ── 请求 ──

export const companyIdParamsSchema = z.object({ companyId: z.string().min(1) });
export type CompanyIdParams = z.infer<typeof companyIdParamsSchema>;

/** POST / 创建公司（name 缺省原静默存 undefined，zod 收紧为 400；服务端自动建默认 OKR） */
export const createCompanyBodySchema = z.object({
  name: z.string().trim().min(1),
});
export type CreateCompanyBody = z.infer<typeof createCompanyBodySchema>;

/** PATCH /:companyId 更新（name 缺省原静默写 undefined，zod 收紧为 400） */
export const updateCompanyBodySchema = z.object({
  name: z.string().trim().min(1),
});
export type UpdateCompanyBody = z.infer<typeof updateCompanyBodySchema>;

// ── 响应 ──

/** GET /：`{ data: Company[] }`（原已带壳，形状不变；空库自动创建默认公司） */
export const companyListResponseSchema = dataBodySchema(z.array(companySchema));

/** GET/POST(201)/PATCH 单体：`{ data: Company }`（原裸对象） */
export const companyResponseSchema = dataBodySchema(companySchema);

/** GET /sizes/config：`{ data: Record<size, CompanySizeConfigEntry> }`（原已带壳，形状不变） */
export const companySizeConfigResponseSchema = dataBodySchema(z.record(z.string(), companySizeConfigEntrySchema));

/** GET /:companyId/hall-stats：`{ data: CompanyHallStats }`（原已带壳，形状不变） */
export const companyHallStatsResponseSchema = dataBodySchema(companyHallStatsSchema);
