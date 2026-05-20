/**
 * Company API 路由
 */

import { Router, Request, Response } from 'express';
import { prisma } from '../../core/database.js';
import { logger } from '../../utils/logger.js';

const router = Router();

// 公司规模配置
const COMPANY_SIZE_CONFIG = {
  small: { name: '小型公司', balance: 30000, roleLimit: 3 },
  medium: { name: '中型公司', balance: 100000, roleLimit: 10 },
  large: { name: '大型公司', balance: 500000, roleLimit: 30 },
};

/**
 * GET /api/v1/companies
 * 获取公司列表
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const companies = await prisma.company.findMany({
      include: {
        _count: {
          select: { Role: true },
        },
      },
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
    const { name, balance } = req.body;

    const company = await prisma.company.create({
      data: {
        name,
        size: 'custom',
        balance: balance || 30000,  // 默认 30K
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
    const { name, balance } = req.body;

    const company = await prisma.company.update({
      where: { id: companyId },
      data: {
        name,
        balance,
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
      include: {
        Role: {
          select: {
            id: true,
            name: true,
            type: true,
            level: true,
            status: true,
          },
        },
        _count: {
          select: { Role: true },
        },
      },
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
    const [company, roles, executions, meetings] = await Promise.all([
      // 公司信息
      prisma.company.findUnique({
        where: { id: companyId },
        select: { id: true, name: true, balance: true, size: true },
      }),
      // 角色统计
      prisma.role.findMany({
        where: { companyId },
        select: { id: true, status: true },
      }),
      // 执行中的任务数
      prisma.execution.count({
        where: { status: 'running' },
      }),
      // 今日会议数
      prisma.meeting.count({
        where: {
          companyId,
          createdAt: {
            gte: new Date(new Date().setHours(0, 0, 0, 0)),
          },
        },
      }),
    ]);

    if (!company) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: `Company ${companyId} not found` },
      });
    }

    // 计算统计数据
    const totalRoles = roles.length;
    const onlineRoles = roles.filter(r => r.status === 'active').length;
    const totalBalance = company.balance || 0;
    const spentAgg = await prisma.settlement.aggregate({
      where: { companyId, type: { in: ['salary', 'reward'] } },
      _sum: { amount: true },
    });
    const totalSpent = spentAgg._sum.amount || 0;

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
        balance: totalBalance,
        totalSpent,
        totalRoles,
        onlineRoles,
        runningTasks: executions,
        todayMeetings: meetings,
        todayCompletedTasks,
        transactionCount: await prisma.transaction.count({ where: { companyId } }),
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