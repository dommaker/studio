/**
 * Role API 路由
 */

import { Router, Request, Response } from 'express';
import { RoleService } from './role.service.js';
import { prisma } from '../../core/database.js';
import { logger } from '@dommaker/studio-shared';
import { parsePagination, formatPaginatedResponse } from '../../utils/pagination.js';
import { getErrorMessage } from '../../utils/errors.js';
import { apiCache, CACHE_CONFIG } from '../../middleware/api-cache.js';
import { checkOwnership, type AuthRequest } from '../../middleware/auth.js';
import { AuditService } from '@dommaker/studio-audit';
import { createLazyService } from '../../utils/services.js';

const router = Router();
const auditService = new AuditService(prisma);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getRoleService = createLazyService<any>(() => new RoleService(prisma));

/**
 * GET /api/v1/roles
 */
router.get('/', apiCache(CACHE_CONFIG.medium), async (req: Request, res: Response) => {
  try {
    const service = getRoleService();
    const { companyId, type, status } = req.query;
    const { page, limit } = parsePagination(req);

    const result = await service.list({
      companyId: companyId as string,
      type: type as string,
      status: status as string,
      page,
      limit,
    });

    res.json(formatPaginatedResponse(result.data, result.total, page, limit));
  } catch (error) {
    logger.error('Failed to list roles', { error: getErrorMessage(error) });
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to list roles' },
    });
  }
});

/**
 * GET /api/v1/roles/levels
 */
router.get('/levels', async (_req: Request, res: Response) => {
  try {
    const service = getRoleService();
    const config = service.getLevelConfig();
    res.json({ data: config });
  } catch (error) {
    logger.error('Failed to get level config', { error: getErrorMessage(error) });
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get level config' },
    });
  }
});

/**
 * POST /api/v1/roles
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const service = getRoleService();
    const role = await service.create(req.body);

    await auditService.log({
      userId: (req as AuthRequest).user?.id,
      action: 'create',
      resource: 'role',
      resourceId: role.id,
      details: { name: role.name, type: role.type },
      status: 'success',
    }).catch(err => logger.error('Audit log error', { error: getErrorMessage(err) }));

    res.status(201).json(role);
  } catch (error: unknown) {
    const msg = getErrorMessage(error);
    logger.error('Failed to create role', { error: msg });

    await auditService.log({
      userId: (req as AuthRequest).user?.id,
      action: 'create',
      resource: 'role',
      status: 'failure',
      errorMessage: msg,
    }).catch(e => logger.error('Audit log error', { error: getErrorMessage(e) }));

    if (msg.includes('not found')) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: msg } });
    } else {
      res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create role' } });
    }
  }
});

/**
 * GET /api/v1/roles/:roleId
 */
router.get('/:roleId', async (req: Request, res: Response) => {
  try {
    const service = getRoleService();
    const { roleId } = req.params;

    const role = await service.getById(roleId);

    if (!role) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: `Role ${roleId} not found` },
      });
    }

    res.json(role);
  } catch (error) {
    logger.error('Failed to get role', { error: getErrorMessage(error) });
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get role' } });
  }
});

/**
 * PUT /api/v1/roles/:roleId
 */
router.put('/:roleId', async (req: Request, res: Response) => {
  try {
    const service = getRoleService();
    const { roleId } = req.params;

    const beforeUpdate = await service.getById(roleId).catch(() => null);

    const role = await service.update(roleId, req.body);

    await auditService.log({
      userId: (req as AuthRequest).user?.id,
      action: 'update',
      resource: 'role',
      resourceId: roleId,
      changes: {
        before: beforeUpdate ? { name: beforeUpdate.name, type: beforeUpdate.type } : null,
        after: { name: role.name, type: role.type },
      },
      status: 'success',
    }).catch(err => logger.error('Audit log error', { error: getErrorMessage(err) }));

    res.json(role);
  } catch (error: unknown) {
    const msg = getErrorMessage(error);
    logger.error('Failed to update role', { error: msg });
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update role' } });
  }
});

/**
 * DELETE /api/v1/roles/:roleId
 */
router.delete('/:roleId', checkOwnership('Role'), async (req: Request, res: Response) => {
  try {
    const service = getRoleService();
    const { roleId } = req.params;

    await service.delete(roleId);
    res.status(204).send();
  } catch (error: unknown) {
    const msg = getErrorMessage(error);
    logger.error('Failed to delete role', { error: msg });
    if (msg.includes('not found')) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: msg } });
    } else {
      res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to delete role' } });
    }
  }
});

// ============================================
// Workflow management
// ============================================

/**
 * POST /api/v1/roles/:roleId/workflows
 */
router.post('/:roleId/workflows', async (req: Request, res: Response) => {
  try {
    const service = getRoleService();
    const { roleId } = req.params;
    const { workflowIds } = req.body;

    if (!workflowIds || !Array.isArray(workflowIds)) {
      return res.status(400).json({
        error: { code: 'INVALID_INPUT', message: 'workflowIds must be an array' },
      });
    }

    await service.addWorkflows(roleId, workflowIds);
    const role = await service.getById(roleId);
    res.json(role);
  } catch (error: unknown) {
    const msg = getErrorMessage(error);
    logger.error('Failed to add workflows', { error: msg });
    if (msg.includes('not found')) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: msg } });
    } else {
      res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to add workflows' } });
    }
  }
});

/**
 * DELETE /api/v1/roles/:roleId/workflows/:workflowId
 */
router.delete('/:roleId/workflows/:workflowId', checkOwnership('Role'), async (req: Request, res: Response) => {
  try {
    const service = getRoleService();
    const { roleId, workflowId } = req.params;

    await service.removeWorkflow(roleId, workflowId);
    const role = await service.getById(roleId);
    res.json(role);
  } catch (error: unknown) {
    logger.error('Failed to remove workflow', { error: getErrorMessage(error) });
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to remove workflow' } });
  }
});

/**
 * GET /api/v1/roles/:roleId/workflows/:workflowId/check
 */
router.get('/:roleId/workflows/:workflowId/check', async (req: Request, res: Response) => {
  try {
    const service = getRoleService();
    const { roleId, workflowId } = req.params;

    const hasWorkflow = await service.hasWorkflow(roleId, workflowId);
    res.json({ hasWorkflow });
  } catch (error: unknown) {
    logger.error('Failed to check workflow', { error: getErrorMessage(error) });
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to check workflow' } });
  }
});

export default router;
