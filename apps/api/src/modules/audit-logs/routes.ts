// audit-logs/routes.ts - 审计日志 API (AR-012)
import { Router, Request, Response } from 'express';
import { AuditService, AuditActions, AuditResources } from '@dommaker/studio-audit';
import { logger } from '../../utils/logger.js';
import { prisma } from '../../core/database.js';
import { formatPaginatedResponse } from '../../utils/pagination.js';
import { createLazyService } from '../../utils/services.js';

const router = Router();

const getAuditService = createLazyService(() => new AuditService(prisma));

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
 * - limit: 每页数量 (default: 50)
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const service = getAuditService();
    
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
      page: req.query.page ? parseInt(req.query.page as string) : 1,
      limit: req.query.limit ? parseInt(req.query.limit as string) : 50,
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
 * POST /api/audit-logs/cleanup - 清理过期日志
 * 
 * Body:
 * - retentionDays: 保留天数 (default: 90)
 */
router.post('/cleanup', async (req: Request, res: Response) => {
  try {
    const service = getAuditService();
    const retentionDays = req.body.retentionDays || 90;
    
    const count = await service.cleanup(retentionDays);

    res.json({
      message: `Cleaned up ${count} audit logs`,
      retentionDays,
      deletedCount: count,
    });
  } catch (error) {
    logger.error({ error }, 'Failed to cleanup audit logs');
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to cleanup audit logs' },
    });
  }
});

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