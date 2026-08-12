// PMO API Routes - 项目管理办公室
import { Router, Request, Response } from 'express';
import { okrService } from './okr.service.js';
import { projectService, parsePmoNumberFromCommand } from './project.service.js';
import { getDeliveryStatus, deliverProject } from './delivery.js';
import { syncProjectProgress } from './progress-rollup.js';
import { logger } from '../../utils/logger.js';
import { requireAuth, requireNotGuest, requireRole, type AuthRequest } from '../../middleware/auth.js';  // 🆕 SEC-001 / SEC-002
import { apiCache, CACHE_CONFIG } from '../../middleware/api-cache.js';
import { FileStore } from '@dommaker/studio-shared';
import * as os from 'os';
import * as path from 'path';
import { resolveStudioLogFile } from '../../utils/studio-log-path.js';

/** A2A §4.4 同款约定：agent 身份调用一律 403（交付权只在人） */
function resolveCallerAuthorType(req: Request): string {
  const fromBody = typeof req.body?.authorType === 'string' ? req.body.authorType : undefined;
  const fromHeader = req.headers['x-author-type'];
  return fromBody ?? (typeof fromHeader === 'string' ? fromHeader : 'human');
}

const router = Router();
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
    const { companyId, title, description, requirement, okrId, priority, gitBranch, gitRepo, gitRepos, deliveryPolicy, requirementsDocId } = req.body;

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
    // #114 T8：多工程入参——必须为非空字符串数组（空数组视为未传，走旧单选行为）
    if (gitRepos !== undefined && (!Array.isArray(gitRepos) || gitRepos.some((r: unknown) => typeof r !== 'string'))) {
      return res.status(400).json({
        error: { code: 'INVALID_INPUT', message: 'gitRepos must be an array of strings' },
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
      gitRepos,
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
    // 读取时重算进度（best-effort）：analysis 派生链无 Requirement 归属，事件入口此前接不上，存量项目进度滞留
    await syncProjectProgress(req.params.id).catch(err =>
      logger.warn({ projectId: req.params.id, error: String(err) }, '[PMO] Progress resync on read failed (non-blocking)'));
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
    const { companyId, title, objectives, keyResults, quarter } = req.body;

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
 * 更新 OKR
 */
router.put('/okr/:id', requireAuth(), requireNotGuest(), async (req: Request, res: Response) => {
  try {
    const updates = req.body;
    const okrId = req.params.id;

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
    const okrId = req.params.id;

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