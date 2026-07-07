// PMO API Routes - 项目管理办公室
import { Router, Request, Response } from 'express';
import { okrService, OKRService } from './okr.service.js';
import { projectService, parsePmoNumberFromCommand } from './project.service.js';
import { prisma } from '../../core/database.js';
import { logger } from '../../utils/logger.js';
import { requireNotGuest, requireRole } from '../../middleware/auth.js';  // 🆕 SEC-001 / SEC-002
import { apiCache, CACHE_CONFIG } from '../../middleware/api-cache.js';

const router = Router();

// ============================================
// Project API（GEN-005）
// ============================================

/**
 * GET /api/v1/pmo/project
 * 获取项目列表
 */
router.get('/project', async (req: Request, res: Response) => {
  try {
    const companyId = req.query.companyId as string;
    const status = req.query.status as string | undefined;
    const priority = req.query.priority as string | undefined;
    const okrId = req.query.okrId as string | undefined;
    const limit = parseInt(req.query.limit as string) || 20;

    if (!companyId) {
      return res.status(400).json({
        error: { code: 'MISSING_COMPANY_ID', message: 'companyId is required' },
      });
    }

    const projects = await projectService.list(companyId, {
      status,
      priority,
      okrId,
      limit,
    });

    res.json({ data: projects });
  } catch (error) {
    logger.error({ error }, 'Failed to list projects');
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to list projects' },
    });
  }
});

/**
 * POST /api/v1/pmo/project
 * 创建项目（自动生成 PMO 号）
 */
router.post('/project', async (req: Request, res: Response) => {
  try {
    const { companyId, title, description, requirement, okrId, priority, gitBranch, gitRepo } = req.body;

    if (!companyId || !title) {
      return res.status(400).json({
        error: { code: 'MISSING_FIELDS', message: 'companyId and title are required' },
      });
    }

    const project = await projectService.create({
      companyId,
      title,
      description,
      requirement,
      okrId,
      priority,
      gitBranch,
      gitRepo,
    });

    res.status(201).json(project);
  } catch (error) {
    logger.error({ error }, 'Failed to create project');
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: (error as Error).message },
    });
  }
});

/**
 * GET /api/v1/pmo/project/:id
 * 获取项目详情
 */
router.get('/project/:id', async (req: Request, res: Response) => {
  try {
    const project = await projectService.get(req.params.id);

    if (!project) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Project not found' },
      });
    }

    res.json(project);
  } catch (error) {
    logger.error({ error }, 'Failed to get project');
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get project' },
    });
  }
});

/**
 * GET /api/v1/pmo/project/by-pmo/:pmoNumber
 * 通过 PMO 号获取项目
 */
router.get('/project/by-pmo/:pmoNumber', async (req: Request, res: Response) => {
  try {
    const companyId = req.query.companyId as string;
    const pmoNumber = req.params.pmoNumber;

    if (!companyId) {
      return res.status(400).json({
        error: { code: 'MISSING_COMPANY_ID', message: 'companyId is required' },
      });
    }

    const project = await projectService.getByPmoNumber(companyId, pmoNumber);

    if (!project) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Project not found' },
      });
    }

    res.json(project);
  } catch (error) {
    logger.error({ error }, 'Failed to get project by PMO number');
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get project' },
    });
  }
});

/**
 * PUT /api/v1/pmo/project/:id
 * 更新项目
 */
router.put('/project/:id', async (req: Request, res: Response) => {
  try {
    const project = await projectService.update(req.params.id, req.body);
    res.json(project);
  } catch (error) {
    logger.error({ error }, 'Failed to update project');
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: (error as Error).message },
    });
  }
});

/**
 * PUT /api/v1/pmo/project/:id/status
 * 更新项目状态
 */
router.put('/project/:id/status', async (req: Request, res: Response) => {
  try {
    const { status } = req.body;

    if (!status) {
      return res.status(400).json({
        error: { code: 'MISSING_STATUS', message: 'status is required' },
      });
    }

    const project = await projectService.updateStatus(req.params.id, status);
    res.json(project);
  } catch (error) {
    logger.error({ error }, 'Failed to update project status');
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: (error as Error).message },
    });
  }
});

/**
 * DELETE /api/v1/pmo/project/:id
 * 删除项目（仅 pending/cancelled 状态）
 * 🆕 SEC-002: Admin only
 */
router.delete('/project/:id', requireRole('Admin'), async (req: Request, res: Response) => {
  try {
    const result = await projectService.delete(req.params.id);
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Failed to delete project');
    res.status(400).json({
      error: { code: 'BAD_REQUEST', message: (error as Error).message },
    });
  }
});

/**
 * POST /api/v1/pmo/project/:id/publish
 * 发布 PMO 到 Channel，创建分析 WorkUnit
 */
router.post('/project/:id/publish', async (req: Request, res: Response) => {
  try {
    const { channelId } = req.body;
    if (!channelId) {
      return res.status(400).json({
        error: { code: 'MISSING_CHANNEL_ID', message: 'channelId is required' },
      });
    }

    const result = await projectService.publish({
      projectId: req.params.id,
      channelId,
    });
    res.json(result);
  } catch (error) {
    const message = (error as Error).message;
    const status = message.includes('not found') || message.includes('pending') ? 400 : 500;
    logger.error({ error: message, projectId: req.params.id }, 'Failed to publish project');
    res.status(status).json({
      error: { code: status === 400 ? 'BAD_REQUEST' : 'INTERNAL_ERROR', message },
    });
  }
});

/**
 * POST /api/v1/pmo/project/parse-command
 * 解析 CEO 指令中的 PMO 号
 */
router.post('/project/parse-command', async (req: Request, res: Response) => {
  try {
    const { command } = req.body;

    if (!command) {
      return res.status(400).json({
        error: { code: 'MISSING_COMMAND', message: 'command is required' },
      });
    }

    const result = parsePmoNumberFromCommand(command);
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Failed to parse command');
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to parse command' },
    });
  }
});

// ============================================
// OKR API
// ============================================

/**
 * GET /api/v1/pmo/okr
 * 获取 OKR 列表
 */
router.get('/okr', apiCache(CACHE_CONFIG.medium), async (req: Request, res: Response) => {
  try {
    const companyId = req.query.companyId as string;
    const status = req.query.status as string | undefined;

    if (!companyId) {
      return res.status(400).json({
        error: { code: 'MISSING_COMPANY_ID', message: 'companyId is required' },
      });
    }

    const okrs = await okrService.list(companyId, { status });
    res.json({ data: okrs });
  } catch (error) {
    logger.error({ error }, 'Failed to list OKRs');
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to list OKRs' },
    });
  }
});

/**
 * POST /api/v1/pmo/okr
 * 创建 OKR（需要管理员权限）
 */
router.post('/okr', async (req: Request, res: Response) => {
  try {
    const { companyId, title, objectives, keyResults, quarter, roleId } = req.body;

    // 权限检查
    if (roleId) {
      const isAdmin = await okrService.checkPermission(roleId, companyId);
      if (!isAdmin) {
        return res.status(403).json({
          error: { code: 'FORBIDDEN', message: 'Only admins can create OKR' },
        });
      }
    }

    const okr = await okrService.create({
      companyId,
      title,
      objectives,
      keyResults,
      quarter,
    });

    res.status(201).json(okr);
  } catch (error) {
    logger.error({ error }, 'Failed to create OKR');
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: (error as Error).message },
    });
  }
});

/**
 * GET /api/v1/pmo/okr/metrics
 * B59-001: 返回所有注册 metricType 的实时基线值
 */
router.get('/okr/metrics', async (req: Request, res: Response) => {
  try {
    const days = parseInt(req.query.days as string) || 7;
    const metrics: Record<string, { value: number | null; status: string; dataSource: string; description: string }> = {};

    for (const [metricType, entry] of Object.entries(OKRService.METRIC_REGISTRY)) {
      try {
        const value = await okrService.getMetricBaseline(metricType, days);
        metrics[metricType] = {
          value,
          status: value !== null ? 'ok' : 'no_data',
          dataSource: entry.dataSource,
          description: entry.description,
        };
      } catch {
        metrics[metricType] = {
          value: null,
          status: 'error',
          dataSource: entry.dataSource,
          description: entry.description,
        };
      }
    }

    res.json({ metrics, days });
  } catch (error) {
    logger.error({ error }, 'Failed to get OKR metrics');
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get OKR metrics' },
    });
  }
});

/**
 * GET /api/v1/pmo/okr/data-health
 * B59-001: 返回数据源健康状态 + metricType 覆盖度
 */
router.get('/okr/data-health', async (_req: Request, res: Response) => {
  try {
    const health = await okrService.checkDataSourceHealth();
    const registrySize = Object.keys(OKRService.METRIC_REGISTRY).length;

    // Count how many metrics have data available
    let metricsWithData = 0;
    let metricsWithoutData = 0;
    for (const metricType of Object.keys(OKRService.METRIC_REGISTRY)) {
      try {
        const value = await okrService.getMetricBaseline(metricType);
        if (value !== null) metricsWithData++;
        else metricsWithoutData++;
      } catch {
        metricsWithoutData++;
      }
    }

    res.json({
      dataSources: health,
      metricRegistry: {
        total: registrySize,
        withData: metricsWithData,
        withoutData: metricsWithoutData,
      },
    });
  } catch (error) {
    logger.error({ error }, 'Failed to get data health');
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get data health' },
    });
  }
});

/**
 * GET /api/v1/pmo/okr/:id
 * 获取 OKR 详情
 */
router.get('/okr/:id', async (req: Request, res: Response) => {
  try {
    const okr = await okrService.get(req.params.id);
    res.json(okr);
  } catch (error) {
    logger.error({ error }, 'Failed to get OKR');
    res.status(404).json({
      error: { code: 'NOT_FOUND', message: 'OKR not found' },
    });
  }
});

/**
 * PUT /api/v1/pmo/okr/:id
 * 更新 OKR（需要管理员权限）
 */
router.put('/okr/:id', async (req: Request, res: Response) => {
  try {
    const { roleId, ...updates } = req.body;
    const okrId = req.params.id;

    // 获取 OKR 以检查权限
    const okr = await prisma.oKR.findUnique({
      where: { id: okrId },
      select: { companyId: true },
    });

    if (!okr) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'OKR not found' },
      });
    }

    // 权限检查
    if (roleId) {
      const isAdmin = await okrService.checkPermission(roleId, okr.companyId);
      if (!isAdmin) {
        return res.status(403).json({
          error: { code: 'FORBIDDEN', message: 'Only admins can update OKR' },
        });
      }
    }

    const updated = await okrService.update(okrId, updates);
    res.json(updated);
  } catch (error) {
    logger.error({ error }, 'Failed to update OKR');
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: (error as Error).message },
    });
  }
});

/**
 * DELETE /api/v1/pmo/okr/:id
 * 删除 OKR（需要管理员权限）
 * 🆕 SEC-002: Admin only
 */
router.delete('/okr/:id', requireRole('Admin'), async (req: Request, res: Response) => {
  try {
    const { roleId } = req.body;
    const okrId = req.params.id;

    // 获取 OKR 以检查权限
    const okr = await prisma.oKR.findUnique({
      where: { id: okrId },
      select: { companyId: true },
    });

    if (!okr) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'OKR not found' },
      });
    }

    // 权限检查
    if (roleId) {
      const isAdmin = await okrService.checkPermission(roleId, okr.companyId);
      if (!isAdmin) {
        return res.status(403).json({
          error: { code: 'FORBIDDEN', message: 'Only admins can delete OKR' },
        });
      }
    }

    const result = await okrService.delete(okrId);
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Failed to delete OKR');
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to delete OKR' },
    });
  }
});

// ============================================
// 项目 API（Execution）
// ============================================

/**
 * GET /api/v1/pmo/projects
 * 获取项目列表（可按 OKR 分组）
 */
router.get('/projects', async (req: Request, res: Response) => {
  try {
    const companyId = req.query.companyId as string;
    const okrId = req.query.okrId as string | undefined;
    const status = req.query.status as string | undefined;
    const limit = parseInt(req.query.limit as string) || 20;

    // 获取公司下所有角色 ID
    const roles = await prisma.role.findMany({
      where: { companyId },
      select: { id: true },
    });
    const roleIds = roles.map(r => r.id);

    // 构建查询条件
    const where: Record<string, unknown> = {};
    if (okrId) {
      where.okrId = okrId;
    }
    if (status) {
      where.status = status;
    }

    // 从 runtime 获取执行列表（通过 runtime-proxy）
    const runtimeUrl = process.env.AGENT_RUNTIME_URL || 'http://localhost:13202';  // 🆕 AS-017: 统一端口
    const response = await fetch(`${runtimeUrl}/api/executions?limit=${limit}`);
    const runtimeData = await response.json() as {
      data: Record<string, unknown>[];
      pagination: { page: number; limit: number; total: number; totalPages: number };
    };

    // runtime 数据不包含 roleId，依赖下方 DB 查询的 roleId IN 过滤
    const executions = runtimeData.data;

    // 获取数据库中的 Execution 记录（补充 okrId）
    const dbExecutions = await prisma.execution.findMany({
      where: {
        roleId: { in: roleIds },
        ...where,
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    // 合并数据
    const projects = executions.map((exec) => {
      const dbExec = dbExecutions.find(d => d.id === exec.id);
      return {
        ...exec,
        okrId: dbExec?.okrId || null,
        dbId: dbExec?.id,
      };
    });

    res.json({
      data: projects,
      pagination: runtimeData.pagination,
    });
  } catch (error) {
    logger.error({ error }, 'Failed to list projects');
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to list projects' },
    });
  }
});

/**
 * PUT /api/v1/pmo/projects/:id/okr
 * 设置项目关联的 OKR（需要管理员或 ProjectLead 权限）
 */
router.put('/projects/:id/okr', async (req: Request, res: Response) => {
  try {
    const executionId = req.params.id;
    const { okrId, roleId } = req.body;

    // 获取 Execution 和关联的角色
    const execution = await prisma.execution.findUnique({
      where: { id: executionId },
      include: {
        Role: {
          select: { companyId: true, isProjectLead: true },
        },
      },
    });

    if (!execution) {
      // Execution 可能不存在于数据库，先创建
      const newExecution = await prisma.execution.create({
        data: {
          id: executionId,
          workflowId: 'unknown',
          roleId: null,
          okrId,
        },
      });
      return res.json(newExecution);
    }

    // 权限检查：管理员或 ProjectLead
    if (roleId && execution.Role) {
      const isAdmin = await okrService.checkPermission(roleId, execution.Role.companyId);
      const isProjectLead = execution.Role.isProjectLead;

      if (!isAdmin && !isProjectLead) {
        return res.status(403).json({
          error: { code: 'FORBIDDEN', message: 'Only admins or ProjectLead can set OKR' },
        });
      }
    }

    // 更新 OKR 关联
    const updated = await prisma.execution.update({
      where: { id: executionId },
      data: { okrId },
    });

    res.json(updated);
  } catch (error) {
    logger.error({ error }, 'Failed to set project OKR');
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to set project OKR' },
    });
  }
});

/**
 * POST /api/v1/pmo/init-admin
 * 初始化公司管理员（将 CEO 加入 adminRoleIds）
 */
router.post('/init-admin', async (req: Request, res: Response) => {
  try {
    const { companyId } = req.body;

    await okrService.initAdmin(companyId);

    res.json({ success: true, message: 'Admin initialized' });
  } catch (error) {
    logger.error({ error }, 'Failed to init admin');
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to init admin' },
    });
  }
});

// ============================================
// O3g: Pipeline Health Dashboard API
// ============================================

/**
 * GET /api/v1/pmo/health — pipeline health dashboard
 */
router.get('/health', async (_req: Request, res: Response) => {
  try {
    const [activeWorkUnits, pendingWorkUnits, recentEvents] = await Promise.all([
      prisma.workUnit.count({ where: { status: 'active' } }),
      prisma.workUnit.count({ where: { status: 'unassigned' } }),
      prisma.studioEvent.findMany({ orderBy: { timestamp: 'desc' }, take: 20 }),
    ]);
    res.json({
      activeWorkUnits,
      pendingWorkUnits,
      recentActivity: recentEvents.length,
      ok: activeWorkUnits > 0 || pendingWorkUnits > 0,
    });
  } catch (error) {
    logger.error({ error }, 'Failed to get pipeline health');
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get pipeline health' },
    });
  }
});

export default router;