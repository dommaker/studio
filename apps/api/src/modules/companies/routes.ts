/**
 * Company API 路由
 *
 * 存储迁移: Prisma → FileStore (~/.studio/data/companies/)
 *
 * 契约驱动迁移（2026-10 批次 2/7）：全部端点走 core/http.ts defineRoute——
 * name 手写形状校验缺位处由 zod 收紧（缺省原静默存 undefined → 400）；
 * 统一 envelope（{ data }；list/hall-stats/sizes-config 原已带壳形状不变，
 * get/create(201)/update 原裸对象统一进壳）；404 走 HttpError，500 兜底统一 INTERNAL。
 */

import { Router } from 'express';
import {
  companyIdParamsSchema,
  createCompanyBodySchema,
  updateCompanyBodySchema,
  ERROR_CODES,
  type Company,
  companyListResponseSchema,
  companyResponseSchema,
  companySizeConfigResponseSchema,
  companyHallStatsResponseSchema,
} from '@dommaker/studio-contract';
import { defineRoute, HttpError } from '../../core/http.js';
import { getStore } from '../../core/store.js';
import { companyPath, createCompany, listCompanies } from './company-application.js';

const router = Router();

// 公司规模配置
const COMPANY_SIZE_CONFIG = {
  small: { name: '小型公司', roleLimit: 3 },
  medium: { name: '中型公司', roleLimit: 10 },
  large: { name: '大型公司', roleLimit: 30 },
};

/**
 * GET /api/v1/companies
 * 获取公司列表；空库时自动创建默认公司（#434：设置页公司节删除后，创建兜底挪到服务端）
 */
router.get('/', defineRoute({ response: companyListResponseSchema }, async () => listCompanies()));

/**
 * POST /api/v1/companies
 * 创建公司
 */
router.post('/', defineRoute({ body: createCompanyBodySchema, response: companyResponseSchema }, { status: 201 }, async (_req, _res, { body }) => {
  return createCompany(body.name);
}));

/**
 * GET /api/v1/companies/sizes/config
 * 获取公司规模配置（须注册在 /:companyId 之前——'sizes' 单段会被 :companyId 吞掉，旧路由顺序如此）
 */
router.get('/sizes/config', defineRoute({ response: companySizeConfigResponseSchema }, async () => {
  return COMPANY_SIZE_CONFIG;
}));

/**
 * GET /api/v1/companies/:companyId/hall-stats
 * 获取公司大厅统计数据（聚合多 API 数据；须注册在 /:companyId 之前，旧路由顺序如此）
 */
router.get('/:companyId/hall-stats', defineRoute({ params: companyIdParamsSchema, response: companyHallStatsResponseSchema }, async (_req, _res, { params }) => {
  const { companyId } = params;

  const company = await getStore().readJson<Company>(companyPath(companyId));
  if (!company) {
    throw new HttpError(404, ERROR_CODES.NOT_FOUND, `Company ${companyId} not found`);
  }

  // executions.jsonl 数据源已随 executions 模块整删退役（全仓无写入方，越域深读已斩）；
  // 任务计数占位 0，响应形状不变（web 无消费方；活口径应改由 workunit 域派生，留待后续票）
  return {
    company: {
      id: company.id,
      name: company.name,
      size: company.size,
    },
    runningTasks: 0,
    todayCompletedTasks: 0,
  };
}));

/**
 * GET /api/v1/companies/:companyId
 * 获取公司详情
 */
router.get('/:companyId', defineRoute({ params: companyIdParamsSchema, response: companyResponseSchema }, async (_req, _res, { params }) => {
  const company = await getStore().readJson<Company>(companyPath(params.companyId));
  if (!company) {
    throw new HttpError(404, ERROR_CODES.NOT_FOUND, `Company ${params.companyId} not found`);
  }
  return company;
}));

/**
 * PATCH /api/v1/companies/:companyId
 * 更新公司信息
 */
router.patch('/:companyId', defineRoute(
  { params: companyIdParamsSchema, body: updateCompanyBodySchema, response: companyResponseSchema },
  async (_req, _res, { params, body }) => {
    const existing = await getStore().readJson<Company>(companyPath(params.companyId));
    if (!existing) {
      throw new HttpError(404, ERROR_CODES.NOT_FOUND, `Company ${params.companyId} not found`);
    }
    const company: Company = { ...existing, name: body.name, updatedAt: new Date().toISOString() };
    await getStore().writeJson(companyPath(params.companyId), company);
    return company;
  },
));

export default router;
