// audit-logs/routes.ts - 审计日志 API (AR-012)
import { Router, Request, Response } from 'express';
import { AuditService, AuditActions, AuditResources } from '@dommaker/studio-audit';
import { logger } from '../../utils/logger.js';
import { FileStore } from '@dommaker/studio-shared';
import { parsePagination, formatPaginatedResponse } from '../../utils/pagination.js';
import { createLazyService } from '../../utils/services.js';

const router = Router();

const getAuditService = createLazyService(() => new AuditService(new FileStore()));

// ========== API 路由 ==========

/**
 * GET /api/audit-logs - 查询审计日志
 * 
 * Query params:
 * - userId: 用户 ID
 * - roleId: 角色 ID
 * - companyId: 公司 ID
 * - action: 操作类型
 * - resource: 资源类型
 * - resourceId: 资源 ID
 * - status: 状态 (success/failure)
 * - startTime: 开始时间 (ISO 8601)
 * - endTime: 结束时间 (ISO 8601)
 * - page: 页码 (default: 1)
 * - limit: 每页数量 (default: 20, max: 100) — #359 起统一走 parsePagination clamp
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const service = getAuditService();
    // #359：统一 parsePagination（clamp 1..100），堵 limit=999999 直通豁口；缺省 50→20
    const { page, limit } = parsePagination(req);

    const query = {
      userId: req.query.userId as string,
      roleId: req.query.roleId as string,
      companyId: req.query.companyId as string,
      action: req.query.action as string,
      resource: req.query.resource as string,
      resourceId: req.query.resourceId as string,
      status: req.query.status as string,
      anonymousId: req.query.anonymousId as string,  // 🆕 SEC-009
      startTime: req.query.startTime ? new Date(req.query.startTime as string) : undefined,
      endTime: req.query.endTime ? new Date(req.query.endTime as string) : undefined,
      page,
      limit,
    };

    const result = await service.query(query);

    res.json(formatPaginatedResponse(result.data, result.total, result.page, result.limit));
  } catch (error) {
    logger.error({ error }, 'Failed to query audit logs');
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to query audit logs' },
    });
  }
});

/**
 * GET /api/audit-logs/stats - 获取审计日志统计
 */
router.get('/stats', async (req: Request, res: Response) => {
  try {
    const service = getAuditService();
    
    const query = {
      startTime: req.query.startTime ? new Date(req.query.startTime as string) : undefined,
      endTime: req.query.endTime ? new Date(req.query.endTime as string) : undefined,
      userId: req.query.userId as string,
      companyId: req.query.companyId as string,
    };

    const stats = await service.getStats(query);
    res.json(stats);
  } catch (error) {
    logger.error({ error }, 'Failed to get audit stats');
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get audit stats' },
    });
  }
});

/**
 * GET /api/audit-logs/actions - 获取操作类型列表
 */
router.get('/actions', (_req: Request, res: Response) => {
  res.json({
    data: Object.values(AuditActions),
  });
});

/**
 * GET /api/audit-logs/resources - 获取资源类型列表
 */
router.get('/resources', (_req: Request, res: Response) => {
  res.json({
    data: Object.values(AuditResources),
  });
});

/**
 * GET /api/audit-logs/:id - 获取单条审计日志
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const service = getAuditService();
    const log = await service.getById(req.params.id);

    if (!log) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Audit log not found' },
      });
    }

    res.json(log);
  } catch (error) {
    logger.error({ error }, 'Failed to get audit log');
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get audit log' },
    });
  }
});

/**
 * POST /api/audit-logs - 创建审计日志
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const service = getAuditService();
    const log = await service.log(req.body);

    res.status(201).json(log);
  } catch (error) {
    logger.error({ error }, 'Failed to create audit log');
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to create audit log' },
    });
  }
});

/**
 * #256: POST /api/audit-logs/cleanup 端点下线--硬删 audit 行不归档，绕过 #213
 * 「只增不删」决议。删除语义统一归轮转机制（STUDIO_LOG_FILE_POLICIES
 * 已配置 audit.jsonl: hotDays=90, action=archive）。
 * 若需重新引入清理能力，必须先归档（复用 rotateJsonlLog/appendGz）再删热行。
 */

/**
 * GET /api/audit-logs/export - 导出审计日志
 */
router.get('/export', async (req: Request, res: Response) => {
  try {
    const service = getAuditService();
    
    const query = {
      userId: req.query.userId as string,
      companyId: req.query.companyId as string,
      startTime: req.query.startTime ? new Date(req.query.startTime as string) : undefined,
      endTime: req.query.endTime ? new Date(req.query.endTime as string) : undefined,
    };

    const logs = await service.export(query);

    // 设置下载头
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="audit-logs-${new Date().toISOString().split('T')[0]}.json"`);
    
    res.json(logs);
  } catch (error) {
    logger.error({ error }, 'Failed to export audit logs');
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to export audit logs' },
    });
  }
});

export default router;