/**
 * Role API 路由
 */

import { Router, Request, Response } from 'express';
import { RoleService } from './role.service.js';
import { prisma } from '../../core/database.js';
import { logger } from '@dommaker/studio-shared';
import { parsePagination, formatPaginatedResponse } from '../../utils/pagination.js';
import { getErrorMessage } from '../../utils/errors.js';
import { apiCache, CACHE_CONFIG } from '../../middleware/api-cache.js';  // PF-002
import { requireNotGuest, checkOwnership, requireRole, type AuthRequest } from '../../middleware/auth.js';  // SEC-001 / SEC-002
import { AuditService } from '@dommaker/studio-audit';  // SEC-010
import { createLazyService } from '../../utils/services.js';

const router = Router();
const auditService = new AuditService(prisma);  // SEC-010

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- RoleService type definitions are incomplete
const getRoleService = createLazyService<any>(() => new RoleService(prisma));

/**
 * GET /api/v1/roles
 * 获取角色列表
 */
// PF-002: 角色列表缓存（30秒 TTL）
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
 * GET /api/v1/roles/types
 * 获取角色类型列表
 */
router.get('/types', async (req: Request, res: Response) => {
  try {
    const service = getRoleService();
    const types = service.getRoleTypes();
    res.json({ data: types });
  } catch (error) {
    logger.error('Failed to get role types', { error: getErrorMessage(error) });
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get role types' },
    });
  }
});

/**
 * GET /api/v1/roles/levels
 * 获取级别配置
 */
router.get('/levels', async (req: Request, res: Response) => {
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
 * 创建角色
 * SEC-010: 记录审计日志
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
      res.status(404).json({
        error: { code: 'NOT_FOUND', message: msg },
      });
    } else if (msg.includes('limit')) {
      res.status(400).json({
        error: { code: 'LIMIT_EXCEEDED', message: msg },
      });
    } else {
      res.status(500).json({
        error: { code: 'INTERNAL_ERROR', message: 'Failed to create role' },
      });
    }
  }
});

/**
 * GET /api/v1/roles/:roleId
 * 获取角色详情
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
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get role' },
    });
  }
});

/**
 * PUT /api/v1/roles/:roleId
 * 更新角色
 * SEC-010: 记录审计日志
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

    await auditService.log({
      userId: (req as AuthRequest).user?.id,
      action: 'update',
      resource: 'role',
      resourceId: req.params.roleId,
      status: 'failure',
      errorMessage: msg,
    }).catch(e => logger.error('Audit log error', { error: getErrorMessage(e) }));

    if (msg.includes('not found')) {
      res.status(404).json({
        error: { code: 'NOT_FOUND', message: msg },
      });
    } else {
      res.status(500).json({
        error: { code: 'INTERNAL_ERROR', message: 'Failed to update role' },
      });
    }
  }
});

/**
 * DELETE /api/v1/roles/:roleId
 * 删除角色
 * SEC-001: 需要登录
 * SEC-002: 所有者或管理员
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
      res.status(404).json({
        error: { code: 'NOT_FOUND', message: msg },
      });
    } else {
      res.status(500).json({
        error: { code: 'INTERNAL_ERROR', message: 'Failed to delete role' },
      });
    }
  }
});

/**
 * POST /api/v1/roles/:roleId/capabilities
 * 添加能力
 */
router.post('/:roleId/capabilities', async (req: Request, res: Response) => {
  try {
    const service = getRoleService();
    const { roleId } = req.params;
    const { capabilityIds, source = 'learned' } = req.body;

    if (!capabilityIds || !Array.isArray(capabilityIds)) {
      return res.status(400).json({
        error: { code: 'INVALID_INPUT', message: 'capabilityIds must be an array' },
      });
    }

    await service.addCapabilities(roleId, capabilityIds, source);
    const role = await service.getById(roleId);
    res.json(role);
  } catch (error: unknown) {
    const msg = getErrorMessage(error);
    logger.error('Failed to add capabilities', { error: msg });
    if (msg.includes('not found')) {
      res.status(404).json({
        error: { code: 'NOT_FOUND', message: msg },
      });
    } else if (msg.includes('limit')) {
      res.status(400).json({
        error: { code: 'LIMIT_EXCEEDED', message: msg },
      });
    } else {
      res.status(500).json({
        error: { code: 'INTERNAL_ERROR', message: 'Failed to add capabilities' },
      });
    }
  }
});

/**
 * DELETE /api/v1/roles/:roleId/capabilities/:capabilityId
 * 移除能力
 * SEC-002: 所有者或管理员
 */
router.delete('/:roleId/capabilities/:capabilityId', checkOwnership('Role'), async (req: Request, res: Response) => {
  try {
    const service = getRoleService();
    const { roleId, capabilityId } = req.params;

    await service.removeCapability(roleId, capabilityId);
    const role = await service.getById(roleId);
    res.json(role);
  } catch (error: unknown) {
    logger.error('Failed to remove capability', { error: getErrorMessage(error) });
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to remove capability' },
    });
  }
});

// ============================================
// Skills 管理 API（概念简化）
// ============================================

/**
 * GET /api/v1/roles/:roleId/skills
 * 获取角色的技能列表
 */
router.get('/:roleId/skills', async (req: Request, res: Response) => {
  try {
    const service = getRoleService();
    const { roleId } = req.params;

    const abilities = await service.getAllAbilities(roleId);
    res.json({
      skills: abilities.skills,
      skillConfig: abilities.skillConfig,
    });
  } catch (error: unknown) {
    logger.error('Failed to get skills', { error: getErrorMessage(error) });
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get skills' },
    });
  }
});

/**
 * POST /api/v1/roles/:roleId/skills
 * 添加技能
 */
router.post('/:roleId/skills', async (req: Request, res: Response) => {
  try {
    const service = getRoleService();
    const { roleId } = req.params;
    const { skillIds, config } = req.body;

    if (!skillIds || !Array.isArray(skillIds)) {
      return res.status(400).json({
        error: { code: 'INVALID_INPUT', message: 'skillIds must be an array' },
      });
    }

    await service.addSkills(roleId, skillIds, config);
    const role = await service.getById(roleId);
    res.json(role);
  } catch (error: unknown) {
    const msg = getErrorMessage(error);
    logger.error('Failed to add skills', { error: msg });
    if (msg.includes('not found')) {
      res.status(404).json({
        error: { code: 'NOT_FOUND', message: msg },
      });
    } else {
      res.status(500).json({
        error: { code: 'INTERNAL_ERROR', message: 'Failed to add skills' },
      });
    }
  }
});

/**
 * DELETE /api/v1/roles/:roleId/skills/:skillId
 * 移除技能
 * SEC-002: 所有者或管理员
 */
router.delete('/:roleId/skills/:skillId', checkOwnership('Role'), async (req: Request, res: Response) => {
  try {
    const service = getRoleService();
    const { roleId, skillId } = req.params;

    await service.removeSkill(roleId, skillId);
    const role = await service.getById(roleId);
    res.json(role);
  } catch (error: unknown) {
    logger.error('Failed to remove skill', { error: getErrorMessage(error) });
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to remove skill' },
    });
  }
});

/**
 * PATCH /api/v1/roles/:roleId/skills/:skillId/config
 * 更新技能配置
 */
router.patch('/:roleId/skills/:skillId/config', async (req: Request, res: Response) => {
  try {
    const service = getRoleService();
    const { roleId, skillId } = req.params;

    await service.updateSkillConfig(roleId, skillId, req.body);
    const role = await service.getById(roleId);
    res.json(role);
  } catch (error: unknown) {
    logger.error('Failed to update skill config', { error: getErrorMessage(error) });
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to update skill config' },
    });
  }
});

/**
 * GET /api/v1/roles/:roleId/skills/:skillId/check
 * 检查角色是否拥有技能
 */
router.get('/:roleId/skills/:skillId/check', async (req: Request, res: Response) => {
  try {
    const service = getRoleService();
    const { roleId, skillId } = req.params;

    const hasSkill = await service.hasSkill(roleId, skillId);
    res.json({ hasSkill });
  } catch (error: unknown) {
    logger.error('Failed to check skill', { error: getErrorMessage(error) });
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to check skill' },
    });
  }
});

// ============================================
// Workflows 管理 API（概念简化）
// ============================================

/**
 * GET /api/v1/roles/:roleId/workflows
 * 获取角色的工作流列表
 */
router.get('/:roleId/workflows', async (req: Request, res: Response) => {
  try {
    const service = getRoleService();
    const { roleId } = req.params;

    const abilities = await service.getAllAbilities(roleId);
    res.json({ workflows: abilities.workflows });
  } catch (error: unknown) {
    logger.error('Failed to get workflows', { error: getErrorMessage(error) });
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get workflows' },
    });
  }
});

/**
 * POST /api/v1/roles/:roleId/workflows
 * 添加工作流
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
      res.status(404).json({
        error: { code: 'NOT_FOUND', message: msg },
      });
    } else {
      res.status(500).json({
        error: { code: 'INTERNAL_ERROR', message: 'Failed to add workflows' },
      });
    }
  }
});

/**
 * DELETE /api/v1/roles/:roleId/workflows/:workflowId
 * 移除工作流
 * SEC-002: 所有者或管理员
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
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to remove workflow' },
    });
  }
});

/**
 * GET /api/v1/roles/:roleId/workflows/:workflowId/check
 * 检查角色是否拥有工作流
 */
router.get('/:roleId/workflows/:workflowId/check', async (req: Request, res: Response) => {
  try {
    const service = getRoleService();
    const { roleId, workflowId } = req.params;

    const hasWorkflow = await service.hasWorkflow(roleId, workflowId);
    res.json({ hasWorkflow });
  } catch (error: unknown) {
    logger.error('Failed to check workflow', { error: getErrorMessage(error) });
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to check workflow' },
    });
  }
});

// ============================================
// Abilities 总览 API（概念简化）
// ============================================

/**
 * GET /api/v1/roles/:roleId/abilities
 * 获取角色的所有能力（skills + workflows）
 */
router.get('/:roleId/abilities', async (req: Request, res: Response) => {
  try {
    const service = getRoleService();
    const { roleId } = req.params;

    const abilities = await service.getAllAbilities(roleId);
    res.json(abilities);
  } catch (error: unknown) {
    const msg = getErrorMessage(error);
    logger.error('Failed to get abilities', { error: msg });
    if (msg.includes('not found')) {
      res.status(404).json({
        error: { code: 'NOT_FOUND', message: msg },
      });
    } else {
      res.status(500).json({
        error: { code: 'INTERNAL_ERROR', message: 'Failed to get abilities' },
      });
    }
  }
});

export default router;
