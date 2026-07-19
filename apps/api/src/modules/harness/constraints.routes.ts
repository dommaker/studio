/**
 * constraints.routes — Harness 约束生命周期与质量门子路由（T-002 / M2）
 *
 * 从 routes.ts 提取（T3 大文件拆分，零行为变更），处理器逐字迁移：
 * - GET  /constraints                 列出所有约束 + 分层状态
 * - GET  /constraints/stats           分层统计汇总（注册于 /constraints/:id 之前）
 * - GET  /constraints/:id             约束详情
 * - POST /constraints/:id/degrade     手动降级约束
 * - POST /constraints/:id/rollback    回滚约束到原始级别
 * - POST /constraints/:id/schedule    设置弃用计划
 * - POST /check-constraints           M2 质量门：非抛出式约束检查（RequirementsDoc UI）
 */

import { Router, Request, Response } from 'express';
import { logger } from '@dommaker/studio-shared';
import { loadHarness, harnessModule } from './runtime.js';

export const constraintsRoutes = Router();

// ─── Constraint Lifecycle (T-002) ───

/**
 * GET /api/v1/harness/constraints
 * 列出所有约束 + 分层状态
 */
constraintsRoutes.get('/constraints', async (_req: Request, res: Response) => {
  try {
    await loadHarness();
    const registry = new harnessModule!.ConstraintRegistry();
    const constraints = registry.getAll().map(c => ({
      id: c.id,
      level: c.level,
      layer: c.layer,
      deprecationStatus: c.deprecationStatus,
      permanent: c.permanent,
      trigger: c.trigger,
      rule: c.rule,
      message: c.message,
    }));
    return res.json({ data: constraints, total: constraints.length });
  } catch (error) {
    logger.error('Failed to list constraints', { error: String(error) });
    return res.status(500).json({ error: 'Failed to list constraints' });
  }
});

/**
 * GET /api/v1/harness/constraints/stats
 * 分层统计汇总
 */
constraintsRoutes.get('/constraints/stats', async (_req: Request, res: Response) => {
  try {
    await loadHarness();
    const registry = new harnessModule!.ConstraintRegistry();
    const stats = registry.getLayerStats();
    return res.json({ data: stats });
  } catch (error) {
    logger.error('Failed to get constraint stats', { error: String(error) });
    return res.status(500).json({ error: 'Failed to get constraint stats' });
  }
});

/**
 * GET /api/v1/harness/constraints/:id
 * 约束详情
 */
constraintsRoutes.get('/constraints/:id', async (req: Request, res: Response) => {
  try {
    await loadHarness();
    const registry = new harnessModule!.ConstraintRegistry();
    const constraint = registry.get(req.params.id);
    if (!constraint) return res.status(404).json({ error: 'Constraint not found' });
    return res.json({ data: constraint });
  } catch (error) {
    logger.error('Failed to get constraint', { error: String(error) });
    return res.status(500).json({ error: 'Failed to get constraint' });
  }
});

/**
 * POST /api/v1/harness/constraints/:id/degrade
 * 手动降级约束
 */
constraintsRoutes.post('/constraints/:id/degrade', async (req: Request, res: Response) => {
  try {
    await loadHarness();
    const registry = new harnessModule!.ConstraintRegistry();
    const constraint = registry.get(req.params.id);
    if (!constraint) return res.status(404).json({ error: 'Constraint not found' });

    if (constraint.layer === 'safety') {
      return res.status(400).json({ error: 'Cannot degrade safety-layer constraint' });
    }

    const success = registry.degrade(req.params.id);
    if (!success) return res.status(400).json({ error: 'Degradation failed (no schedule or already deprecated)' });

    const updated = registry.get(req.params.id);
    return res.json({ data: updated, degraded: true });
  } catch (error) {
    logger.error('Failed to degrade constraint', { error: String(error) });
    return res.status(500).json({ error: 'Failed to degrade constraint' });
  }
});

/**
 * POST /api/v1/harness/constraints/:id/rollback
 * 回滚约束到原始级别
 */
constraintsRoutes.post('/constraints/:id/rollback', async (req: Request, res: Response) => {
  try {
    await loadHarness();
    const registry = new harnessModule!.ConstraintRegistry();
    const constraint = registry.get(req.params.id);
    if (!constraint) return res.status(404).json({ error: 'Constraint not found' });

    const { originalLevel } = req.body;
    if (!originalLevel) return res.status(400).json({ error: 'originalLevel is required' });

    const success = registry.rollback(req.params.id, originalLevel);
    if (!success) return res.status(400).json({ error: 'Rollback failed (not rollbackable)' });

    const updated = registry.get(req.params.id);
    return res.json({ data: updated, rolledBack: true });
  } catch (error) {
    logger.error('Failed to rollback constraint', { error: String(error) });
    return res.status(500).json({ error: 'Failed to rollback constraint' });
  }
});

/**
 * POST /api/v1/harness/constraints/:id/schedule
 * 设置弃用计划
 */
constraintsRoutes.post('/constraints/:id/schedule', async (req: Request, res: Response) => {
  try {
    await loadHarness();
    const registry = new harnessModule!.ConstraintRegistry();
    const constraint = registry.get(req.params.id);
    if (!constraint) return res.status(404).json({ error: 'Constraint not found' });

    if (constraint.layer === 'safety') {
      return res.status(400).json({ error: 'Cannot schedule deprecation for safety-layer constraint' });
    }

    const { targetLevel, reason, interceptRateThreshold, scheduledDate, rollbackable } = req.body;
    if (!targetLevel || !reason) {
      return res.status(400).json({ error: 'targetLevel and reason are required' });
    }

    const success = registry.scheduleDeprecation(req.params.id, {
      targetLevel,
      reason,
      interceptRateThreshold,
      scheduledDate,
      rollbackable: rollbackable !== false,
    });
    if (!success) return res.status(400).json({ error: 'Schedule failed' });

    const updated = registry.get(req.params.id);
    return res.json({ data: updated, scheduled: true });
  } catch (error) {
    logger.error('Failed to schedule deprecation', { error: String(error) });
    return res.status(500).json({ error: 'Failed to schedule deprecation' });
  }
});

// ─── Quality Gate (M2) ───

/**
 * POST /api/v1/harness/check-constraints
 * M2: RequirementsDoc quality gate — run non-throwing constraint check for UI
 */
constraintsRoutes.post('/check-constraints', async (req: Request, res: Response) => {
  try {
    const loaded = await loadHarness();
    if (!loaded) return res.status(503).json({ error: 'Harness not available' });

    const { operation, taskDescription, projectPath, hasRequirement, hasRequirementReview } = req.body;
    if (!operation) return res.status(400).json({ error: 'operation is required' });

    // Use checkConstraints (checkConstraintsSafe removed in harness 0.13.0)
    const result = await harnessModule!.checkConstraints({
      operation: operation as string,
      taskDescription,
      projectPath,
      hasRequirement: hasRequirement !== false,
      hasRequirementReview: hasRequirementReview !== false,
    });

    return res.json({ data: result });
  } catch (error) {
    logger.error('Failed to check constraints', { error: String(error) });
    return res.status(500).json({ error: 'Failed to check constraints' });
  }
});
