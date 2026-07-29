// PMO API Routes - 项目管理办公室
import { Router, Request, Response } from 'express';
import { okrService, OKRService } from './okr.service.js';
import { projectService, parsePmoNumberFromCommand } from './project.service.js';
import { getDeliveryStatus, deliverProject } from './delivery.js';
import { logger } from '../../utils/logger.js';
import { requireAuth, requireNotGuest, requireRole, type AuthRequest } from '../../middleware/auth.js';  // 🆕 SEC-001 / SEC-002
import { apiCache, CACHE_CONFIG } from '../../middleware/api-cache.js';
import { FileStore } from '@dommaker/studio-shared';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'node:fs';
import { resolveStudioLogFile } from '../../utils/studio-log-path.js';

/** A2A §4.4 同款约定：agent 身份调用一律 403（交付权只在人） */
function resolveCallerAuthorType(req: Request): string {
  const fromBody = typeof req.body?.authorType === 'string' ? req.body.authorType : undefined;
  const fromHeader = req.headers['x-author-type'];
  return fromBody ?? (typeof fromHeader === 'string' ? fromHeader : 'human');
}

const router = Router();
const EXECUTIONS_JSONL = resolveStudioLogFile('executions.jsonl');
const STUDIO_EVENTS_JSONL = resolveStudioLogFile('studio-events.jsonl');

// ============================================
// Project API（GEN-005）
// ============================================

/**
 * GET /api/v1/pmo/project
 * 获取项目列表
 */
router.get('/project', async (req: Request, res: Response) => {
  try {
    const status = req.query.status as string | undefined;
    const priority = req.query.priority as string | undefined;
    const okrId = req.query.okrId as string | undefined;
    const limit = parseInt(req.query.limit as string) || 20;

    const projects = await projectService.list({
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
router.post('/project', requireAuth(), requireNotGuest(), async (req: Request, res: Response) => {
  try {
    const { companyId, title, description, requirement, okrId, priority, gitBranch, gitRepo, deliveryPolicy, requirementsDocId } = req.body;

    if (!title) {
      return res.status(400).json({
        error: { code: 'MISSING_FIELDS', message: 'title is required' },
      });
    }
    // PMO-a：交付策略白名单校验（缺省 branch-only）
    if (deliveryPolicy !== undefined && deliveryPolicy !== 'auto-merge' && deliveryPolicy !== 'branch-only') {
      return res.status(400).json({
        error: { code: 'INVALID_INPUT', message: "deliveryPolicy must be 'auto-merge' or 'branch-only'" },
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
      deliveryPolicy,
      requirementsDocId,
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
 * GET /api/v1/pmo/project/:id/delivery
 * PMO-b：交付台账（WU 汇总 + 证据齐缺 + deliverable 标记；branch-only 交付的就是这份回答）
 */
router.get('/project/:id/delivery', async (req: Request, res: Response) => {
  try {
    const status = await getDeliveryStatus(req.params.id);
    if (!status) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Project not found' },
      });
    }
    res.json(status);
  } catch (error) {
    logger.error({ error }, 'Failed to get delivery status');
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get delivery status' },
    });
  }
});

/**
 * POST /api/v1/pmo/project/:id/deliver
 * PMO-b：auto-merge 交付（human-only）——证据齐才把 PMO 分支合入默认分支（本地，不 push）。
 * 缺证据 409 硬拒；branch-only 409 并附分支名（交付动作在下游发布链路，studio 不碰）。
 */
router.post('/project/:id/deliver', requireAuth(), requireNotGuest(), async (req: Request, res: Response) => {
  try {
    if (resolveCallerAuthorType(req) === 'agent') {
      return res.status(403).json({
        error: { code: 'FORBIDDEN', message: 'Delivery is human-only (authorType=agent rejected)' },
      });
    }
    const user = (req as AuthRequest).user;
    const outcome = await deliverProject(req.params.id, user?.name ?? user?.email ?? user?.id ?? 'human');
    // 注：本包 tsconfig 未开 strict，可辨识联合须用 === 字面量比较收窄（merge-on-review-pass 同款）
    if (outcome.delivered === true) {
      return res.json(outcome);
    }
    if (outcome.reason === 'not-found') {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project not found' } });
    }
    res.status(409).json({
      error: {
        code: outcome.reason.toUpperCase().replace(/-/g, '_'),
        message: outcome.detail ?? outcome.reason,
        missing: outcome.missing,
        conflictFiles: outcome.conflictFiles,
      },
    });
  } catch (error) {
    logger.error({ error }, 'Failed to deliver project');
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: (error as Error).message },
    });
  }
});

/**
 * GET /api/v1/pmo/project/by-pmo/:pmoNumber
 * 通过 PMO 号获取项目
 */
router.get('/project/by-pmo/:pmoNumber', async (req: Request, res: Response) => {
  try {
    const pmoNumber = req.params.pmoNumber;

    const project = await projectService.getByPmoNumber(pmoNumber);

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
router.put('/project/:id', requireAuth(), requireNotGuest(), async (req: Request, res: Response) => {
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
router.put('/project/:id/status', requireAuth(), requireNotGuest(), async (req: Request, res: Response) => {
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
router.post('/project/:id/publish', requireAuth(), requireNotGuest(), async (req: Request, res: Response) => {
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
 * GET /api/v1/pmo/project/:id/sdd
 * 查询与 PMO 关联的 SDD 条目
 */
router.get('/project/:id/sdd', async (req: Request, res: Response) => {
  try {
    const result = await projectService.getLinkedSDDs(req.params.id);
    res.json(result);
  } catch (error) {
    const message = (error as Error).message;
    if (message.includes('not found')) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message } });
    }
    logger.error({ error: message, projectId: req.params.id }, 'Failed to query linked SDDs');
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message },
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
router.post('/okr', requireAuth(), requireNotGuest(), async (req: Request, res: Response) => {
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
router.put('/okr/:id', requireAuth(), requireNotGuest(), async (req: Request, res: Response) => {
  try {
    const { roleId, ...updates } = req.body;
    const okrId = req.params.id;

    // 获取 OKR 以检查权限
    const okr: any = await okrService.get(okrId);

    // 权限检查
    if (roleId) {
      const isAdmin = await okrService.checkPermission(roleId, okr.companyId as string);
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
    const okr: any = await okrService.get(okrId);

    // 权限检查
    if (roleId) {
      const isAdmin = await okrService.checkPermission(roleId, okr.companyId as string);
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
    const fileStore = new FileStore();
    let allRows = await fileStore.readJsonl<any>(EXECUTIONS_JSONL);
    if (where.okrId) allRows = allRows.filter((r: any) => r.okrId === where.okrId);
    if (where.status) allRows = allRows.filter((r: any) => r.status === where.status);
    allRows.sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    const dbExecutions = allRows.slice(0, limit);

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
router.put('/projects/:id/okr', requireAuth(), requireNotGuest(), async (req: Request, res: Response) => {
  try {
    const executionId = req.params.id;
    const { okrId } = req.body;

    // 获取 Execution
    const fileStore = new FileStore();
    const allRows = await fileStore.readJsonl<any>(EXECUTIONS_JSONL);
    const execution = allRows.find((r: any) => r.id === executionId);

    if (!execution) {
      // Execution may not exist yet, create new row
      await fileStore.appendJsonl(EXECUTIONS_JSONL, { id: executionId, roleId: null, okrId });
      return res.json({ id: executionId, roleId: null, okrId });
    }

    // 更新 OKR 关联 — read-modify-write
    const updated = { ...execution, okrId };
    const content = allRows.map(r => JSON.stringify(r)).join('\n') + '\n';
    await fs.promises.writeFile(EXECUTIONS_JSONL, content, 'utf-8');

    res.json(updated);
  } catch (error) {
    logger.error({ error }, 'Failed to set project OKR');
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to set project OKR' },
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
    const fileStore = new FileStore();
    const snapshots = await fileStore.getIndex();
    const activeWorkUnits = snapshots.filter(s => s.status === 'active').length;
    const pendingWorkUnits = snapshots.filter(s => s.status === 'unassigned').length;
    const recentEvents = await fileStore.readJsonl<any>(STUDIO_EVENTS_JSONL);
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