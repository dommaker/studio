/**
 * Company API 路由
 */

import { Router, Request, Response } from 'express';
import { prisma } from '../../core/database.js';
import { logger } from '../../utils/logger.js';

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
    const companies = await prisma.company.findMany({
      orderBy: { createdAt: 'desc' },
    });

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

    const company = await prisma.company.create({
      data: {
        name,
        size: 'custom',
      },
    });

    // 🆕 AS-016: 自动创建默认 OKR
    const { okrService } = await import('../pmo/okr.service');
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

    const company = await prisma.company.update({
      where: { id: companyId },
      data: {
        name,
      },
    });

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

    const company = await prisma.company.findUnique({
      where: { id: companyId },
    });

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
      // 公司信息
      prisma.company.findUnique({
        where: { id: companyId },
        select: { id: true, name: true, size: true },
      }),
      // 执行中的任务数
      prisma.execution.count({
        where: { status: 'running' },
      }),
    ]);

    if (!company) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: `Company ${companyId} not found` },
      });
    }

    // 今日完成任务数
    const todayCompletedTasks = await prisma.execution.count({
      where: {
        status: 'completed',
        endTime: {
          gte: new Date(new Date().setHours(0, 0, 0, 0)),
        },
      },
    });

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