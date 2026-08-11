/**
 * Company API 路由
 *
 * 存储迁移: Prisma → FileStore (~/.studio/data/companies/)
 */

import { Router, Request, Response } from 'express';
import { FileStore, generateId } from '@dommaker/studio-shared';
import { logger } from '../../utils/logger.js';
import * as path from 'path';
import { studioPath } from '@dommaker/studio-shared/studio-dir';
import * as fs from 'node:fs';
import { resolveStudioLogFile } from '../../utils/studio-log-path.js';

const COMPANIES_DIR = studioPath('data', 'companies');
const EXECUTIONS_JSONL = resolveStudioLogFile('executions.jsonl');
const fileStore = new FileStore();

interface CompanyRecord {
  id: string;
  name: string;
  size: string;
  createdAt: string;
  updatedAt: string;
}

function companyPath(id: string): string {
  return path.join(COMPANIES_DIR, `${id}.json`);
}

async function ensureDir(dir: string): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true });
}

async function listCompanies(): Promise<CompanyRecord[]> {
  try {
    const entries = await fs.promises.readdir(COMPANIES_DIR, { withFileTypes: true });
    const files = entries.filter(e => e.isFile() && e.name.endsWith('.json'));
    const companies: CompanyRecord[] = [];
    for (const f of files) {
      const data = await fileStore.readJson<CompanyRecord>(path.join(COMPANIES_DIR, f.name));
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

/**
 * GET /api/v1/companies
 * 获取公司列表
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const companies = await listCompanies();
    companies.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    res.json({ data: companies });
  } catch (error) {
    logger.error({ error }, 'Failed to list companies');
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to list companies' },
    });
  }
});

/**
 * POST /api/v1/companies
 * 创建公司
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name } = req.body;

    const id = generateId('company');
    const now = new Date().toISOString();
    const company: CompanyRecord = { id, name, size: 'custom', createdAt: now, updatedAt: now };
    await ensureDir(COMPANIES_DIR);
    await fileStore.writeJson(companyPath(id), company);

    // 🆕 AS-016: 自动创建默认 OKR
    const { okrService } = await import('../pmo/okr.service.js');
    try {
      await okrService.createDefaultOKR(company.id);
    } catch (okrError) {
      // OKR 创建失败不影响公司创建
      logger.warn({ companyId: company.id, okrError }, 'Failed to create default OKR');
    }

    res.status(201).json(company);
  } catch (error) {
    logger.error({ error }, 'Failed to create company');
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to create company' },
    });
  }
});

/**
 * PATCH /api/v1/companies/:companyId
 * 更新公司信息
 */
router.patch('/:companyId', async (req: Request, res: Response) => {
  try {
    const { companyId } = req.params;
    const { name } = req.body;

    const existing = await fileStore.readJson<CompanyRecord>(companyPath(companyId));
    if (!existing) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: `Company ${companyId} not found` } });
    }
    const company: CompanyRecord = { ...existing, name, updatedAt: new Date().toISOString() };
    await fileStore.writeJson(companyPath(companyId), company);

    res.json(company);
  } catch (error) {
    logger.error({ error }, 'Failed to update company');
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to update company' },
    });
  }
});

/**
 * GET /api/v1/companies/:companyId
 * 获取公司详情
 */
router.get('/:companyId', async (req: Request, res: Response) => {
  try {
    const { companyId } = req.params;

    const company = await fileStore.readJson<CompanyRecord>(companyPath(companyId));

    if (!company) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: `Company ${companyId} not found` },
      });
    }

    res.json(company);
  } catch (error) {
    logger.error({ error }, 'Failed to get company');
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get company' },
    });
  }
});

/**
 * GET /api/v1/companies/sizes
 * 获取公司规模配置
 */
router.get('/sizes/config', (req: Request, res: Response) => {
  res.json({ data: COMPANY_SIZE_CONFIG });
});

/**
 * GET /api/v1/companies/:companyId/hall-stats
 * 获取公司大厅统计数据（聚合多 API 数据）
 */
router.get('/:companyId/hall-stats', async (req: Request, res: Response) => {
  try {
    const { companyId } = req.params;

    // 并行查询多个数据源
    const [company, executions] = await Promise.all([
      // 公司信息（FileStore）
      fileStore.readJson<CompanyRecord>(companyPath(companyId)),
      // 执行中的任务数
      (async () => {
        const execs = await fileStore.readJsonl<any>(EXECUTIONS_JSONL);
        return execs.filter((e: any) => e.status === 'running').length;
      })(),
    ]);

    if (!company) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: `Company ${companyId} not found` },
      });
    }

    // 今日完成任务数
    const allExecs = await fileStore.readJsonl<any>(EXECUTIONS_JSONL);
    const todayStart = new Date(new Date().setHours(0, 0, 0, 0));
    const todayCompletedTasks = allExecs.filter((e: any) =>
      e.status === 'completed' && e.endTime && new Date(e.endTime) >= todayStart
    ).length;

    res.json({
      data: {
        company: {
          id: company.id,
          name: company.name,
          size: company.size,
        },
        runningTasks: executions,
        todayCompletedTasks,
      },
    });
  } catch (error) {
    logger.error({ error }, 'Failed to get hall stats');
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get hall stats' },
    });
  }
});

export default router;