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
} from '@dommaker/studio-contract';
import { FileStore, generateId } from '@dommaker/studio-shared';
import * as path from 'path';
import { studioPath } from '@dommaker/studio-shared/studio-dir';
import * as fs from 'node:fs';
import { resolveStudioLogFile } from '../../utils/studio-log-path.js';
import { defineRoute, HttpError } from '../../core/http.js';
import { getStore } from '../../core/store.js';


const COMPANIES_DIR = studioPath('data', 'companies');
const EXECUTIONS_JSONL = resolveStudioLogFile('executions.jsonl');

function companyPath(id: string): string {
  return path.join(COMPANIES_DIR, `${id}.json`);
}

async function ensureDir(dir: string): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true });
}

async function listCompanies(): Promise<Company[]> {
  try {
    const entries = await fs.promises.readdir(COMPANIES_DIR, { withFileTypes: true });
    const files = entries.filter(e => e.isFile() && e.name.endsWith('.json'));
    const companies: Company[] = [];
    for (const f of files) {
      const data = await getStore().readJson<Company>(path.join(COMPANIES_DIR, f.name));
      if (data) companies.push(data);
    }
    return companies;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

const router = Router();

// 公司规模配置
const COMPANY_SIZE_CONFIG = {
  small: { name: '小型公司', roleLimit: 3 },
  medium: { name: '中型公司', roleLimit: 10 },
  large: { name: '大型公司', roleLimit: 30 },
};

async function createCompany(name: string): Promise<Company> {
  const id = generateId('company');
  const now = new Date().toISOString();
  const company: Company = { id, name, size: 'custom', createdAt: now, updatedAt: now };
  await ensureDir(COMPANIES_DIR);
  await getStore().writeJson(companyPath(id), company);

  // 🆕 AS-016: 自动创建默认 OKR
  const { okrService } = await import('../pmo/index.js');
  try {
    await okrService.createDefaultOKR(company.id);
  } catch (okrError) {
    // OKR 创建失败不影响公司创建
    const { logger } = await import('../../utils/logger.js');
    logger.warn({ companyId: company.id, okrError }, 'Failed to create default OKR');
  }
  return company;
}

/**
 * GET /api/v1/companies
 * 获取公司列表；空库时自动创建默认公司（#434：设置页公司节删除后，创建兜底挪到服务端）
 */
router.get('/', defineRoute({}, async () => {
  let companies = await listCompanies();
  if (companies.length === 0) {
    companies = [await createCompany('我的工作空间')];
  }
  companies.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return companies;
}));

/**
 * POST /api/v1/companies
 * 创建公司
 */
router.post('/', defineRoute({ body: createCompanyBodySchema }, { status: 201 }, async (_req, _res, { body }) => {
  return createCompany(body.name);
}));

/**
 * GET /api/v1/companies/sizes/config
 * 获取公司规模配置（须注册在 /:companyId 之前——'sizes' 单段会被 :companyId 吞掉，旧路由顺序如此）
 */
router.get('/sizes/config', defineRoute({}, async () => {
  return COMPANY_SIZE_CONFIG;
}));

/**
 * GET /api/v1/companies/:companyId/hall-stats
 * 获取公司大厅统计数据（聚合多 API 数据；须注册在 /:companyId 之前，旧路由顺序如此）
 */
router.get('/:companyId/hall-stats', defineRoute({ params: companyIdParamsSchema }, async (_req, _res, { params }) => {
  const { companyId } = params;

  // 并行查询多个数据源
  const [company, executions] = await Promise.all([
    // 公司信息（FileStore）
    getStore().readJson<Company>(companyPath(companyId)),
    // 执行中的任务数
    (async () => {
      const execs = await getStore().readJsonl<{ status?: string }>(EXECUTIONS_JSONL);
      return execs.filter((e) => e.status === 'running').length;
    })(),
  ]);

  if (!company) {
    throw new HttpError(404, ERROR_CODES.NOT_FOUND, `Company ${companyId} not found`);
  }

  // 今日完成任务数
  const allExecs = await getStore().readJsonl<{ status?: string; endTime?: string }>(EXECUTIONS_JSONL);
  const todayStart = new Date(new Date().setHours(0, 0, 0, 0));
  const todayCompletedTasks = allExecs.filter((e) =>
    e.status === 'completed' && e.endTime && new Date(e.endTime) >= todayStart
  ).length;

  return {
    company: {
      id: company.id,
      name: company.name,
      size: company.size,
    },
    runningTasks: executions,
    todayCompletedTasks,
  };
}));

/**
 * GET /api/v1/companies/:companyId
 * 获取公司详情
 */
router.get('/:companyId', defineRoute({ params: companyIdParamsSchema }, async (_req, _res, { params }) => {
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
  { params: companyIdParamsSchema, body: updateCompanyBodySchema },
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
