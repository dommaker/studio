/**
 * Goal API 路由 - Goal 驱动架构
 *
 * @deprecated Phase 3 LOW: Goal 路由正在迁移到 WorkUnit API。
 * 本文件保留兼容性，Phase 3 HIGH 将逐步替换端点实现。
 *
 * POST /api/v1/goals — @deprecated → POST /api/v1/work-units (创建 WorkUnit)
 * GET  /api/v1/goals — @deprecated → GET /api/v1/work-units (列表查询)
 * GET  /api/v1/goals/stats — @deprecated → GET /api/v1/work-units/stats
 * GET  /api/v1/goals/:id — @deprecated → GET /api/v1/work-units/:id
 * POST /api/v1/goals/:id/plan — @deprecated (410)
 * POST /api/v1/goals/:id/approve — @deprecated (410)
 * POST /api/v1/goals/:id/execute — @deprecated (410)
 * PUT  /api/v1/goals/:id/steps/:stepId — @deprecated → PUT /api/v1/work-units/:id/steps/:stepId
 * GET  /api/v1/goals/:id/executable — @deprecated → GET /api/v1/work-units/:id/executable
 * GET  /api/v1/goals/:id/executions — @deprecated → GET /api/v1/work-units/:id/executions
 * POST /api/v1/goals/:id/executions/:executionId/cancel — @deprecated → POST /api/v1/work-units/:id/executions/:id/cancel
 * POST /api/v1/goals/:id/executions/:executionId/retry — @deprecated → POST /api/v1/work-units/:id/executions/:id/retry
 * DELETE /api/v1/goals/:id — @deprecated → DELETE /api/v1/work-units/:id
 */

import { Router, Request, Response } from 'express';
import { goalService } from './goal.service.js';
import { logger } from '@dommaker/studio-shared';
import { prisma } from '@dommaker/studio-prisma';
import { agentRunner } from '@dommaker/studio-agent';
import { apiCache, CACHE_CONFIG } from '../../middleware/api-cache.js';

const router = Router();

/**
 * POST /api/v1/goals
 * @deprecated → POST /api/v1/work-units — 创建 WorkUnit 替代创建 Goal
 * Phase 3 HIGH 迁移实现，当前保留兼容。
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { title, description, priority, constraints, context, companyId } = req.body;
    if (!title || !description || !companyId) {
      return res.status(400).json({
        error: { code: 'VALIDATION', message: 'title, description, companyId are required' },
      });
    }

    const goal = await goalService.createGoal({
      title, description, priority, constraints, context, companyId,
      createdBy: (req as any).userId,
    });

    return res.status(201).json(goal);
  } catch (error) {
    logger.error('[Goal API] Create failed', { error: String(error) });
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create goal' } });
  }
});

/**
 * GET /api/v1/goals
 * @deprecated → GET /api/v1/work-units — WorkUnit 列表查询替代
 */
router.get('/', apiCache(CACHE_CONFIG.short), async (req: Request, res: Response) => {
  try {
    const { companyId, status, failureType } = req.query;
    if (!companyId) {
      return res.status(400).json({
        error: { code: 'VALIDATION', message: 'companyId is required' },
      });
    }

    const goals = await goalService.listGoals(companyId as string, status as string, failureType as string);
    return res.json({ data: goals });
  } catch (error) {
    logger.error('[Goal API] List failed', { error: String(error) });
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list goals' } });
  }
});

/**
 * GET /api/v1/goals/stats
 * @deprecated → GET /api/v1/work-units/stats — WorkUnit 仪表盘统计替代
 */
router.get('/stats', apiCache(CACHE_CONFIG.medium), async (req: Request, res: Response) => {
  try {
    const { companyId } = req.query;
    const where: any = {};
    if (companyId) where.companyId = companyId;

    const [totalGoals, activeGoals, completedGoals] = await Promise.all([
      prisma.workUnit.count({ where: { ...where, type: 'task', parentId: null } }),
      prisma.workUnit.count({ where: { ...where, type: 'task', parentId: null, status: 'active' } }),
      prisma.workUnit.count({ where: { ...where, type: 'task', parentId: null, status: 'done' } }),
    ]);

    const runningExecutions = await prisma.workUnit.count({ where: { status: 'active', parentId: { not: null } } });

    return res.json({
      data: {
        totalGoals,
        activeGoals,
        completedGoals,
        runningGoalExecutions: runningExecutions,
      },
    });
  } catch (error) {
    logger.error('[Goal API] Stats failed', { error: String(error) });
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get stats' } });
  }
});

/**
 * GET /api/v1/goals/:id
 * @deprecated → GET /api/v1/work-units/:id — WorkUnit 详情替代
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const goal = await goalService.getGoal(req.params.id);
    if (!goal) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Goal not found' } });
    }
    return res.json(goal);
  } catch (error) {
    logger.error('[Goal API] Get failed', { error: String(error) });
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get goal' } });
  }
});

/**
 * POST /api/v1/goals/:id/plan
 * @deprecated 已废弃 — Analyst 直接输出 acGroups + modelTier，不再需要 LLM 二次分解。
 * Channel 流程走 createGoalFromChannelDoc，此端点无消费方。
 */
router.post('/:id/plan', async (_req: Request, res: Response) => {
  return res.status(410).json({ error: { code: 'DEPRECATED', message: 'Plan generation deprecated. Analyst outputs acGroups directly via Channel flow.' } });
});

/**
 * POST /api/v1/goals/:id/approve
 * @deprecated 已废弃 — Channel 流程直接创建 executing 状态的 Goal，无需手动审批。
 */
router.post('/:id/approve', async (_req: Request, res: Response) => {
  return res.status(410).json({ error: { code: 'DEPRECATED', message: 'Plan approval deprecated. Channel flow creates goals in executing state directly.' } });
});

/**
 * POST /api/v1/goals/:id/execute
 * @deprecated 已废弃 — Channel 流程直接创建 GoalExecution，无需手动触发。
 */
router.post('/:id/execute', async (_req: Request, res: Response) => {
  return res.status(410).json({ error: { code: 'DEPRECATED', message: 'Manual execution deprecated. Channel flow creates executions directly.' } });
});

/**
 * GET /api/v1/goals/:id/executable
 * @deprecated → GET /api/v1/work-units/:id/executable — WorkUnit 可执行步骤替代
 */
router.get('/:id/executable', async (req: Request, res: Response) => {
  try {
    const steps = await goalService.getExecutableSteps(req.params.id);
    return res.json({ steps });
  } catch (error) {
    logger.error('[Goal API] Get executable failed', { error: String(error) });
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get executable steps' } });
  }
});

/**
 * PUT /api/v1/goals/:id/steps/:stepId
 * @deprecated → PUT /api/v1/work-units/:id/steps/:stepId — WorkUnit 步骤状态更新替代
 */
router.put('/:id/steps/:stepId', async (req: Request, res: Response) => {
  try {
    const { status, output, error: stepError } = req.body;
    const execution = await goalService.updateStepExecution(req.params.stepId, {
      status, output, error: stepError,
    });
    return res.json(execution);
  } catch (error) {
    logger.error('[Goal API] Update step failed', { error: String(error) });
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update step' } });
  }
});

/**
 * GET /api/v1/goals/:id/executions
 * @deprecated → GET /api/v1/work-units/:id/executions — WorkUnit Execution 列表替代
 */
router.get('/:id/executions', async (req: Request, res: Response) => {
  try {
    const executions = await prisma.workUnit.findMany({
      where: { parentId: req.params.id },
      orderBy: { createdAt: 'desc' },
    });
    return res.json({ data: executions });
  } catch (error) {
    logger.error('[Goal API] List executions failed', { error: String(error) });
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list executions' } });
  }
});

/**
 * POST /api/v1/goals/:id/executions/:executionId/cancel — 取消执行
 * @deprecated → POST /api/v1/work-units/:id/executions/:executionId/cancel
 * 同时终止 agent 子进程（SIGTERM → SIGKILL）
 */
router.post('/:id/executions/:executionId/cancel', async (req: Request, res: Response) => {
  try {
    const execution = await goalService.cancelGoalExecution(req.params.executionId);
    // Kill the actual agent process — cancelGoalExecution only updates DB status
    try {
      await agentRunner.stop(req.params.executionId);
      logger.info('[Goal API] Agent process stopped', { executionId: req.params.executionId });
    } catch (stopErr) {
      logger.warn('[Goal API] Failed to stop agent process (non-fatal)', { executionId: req.params.executionId, error: String(stopErr) });
    }
    return res.json({ data: execution });
  } catch (error) {
    logger.error('[Goal API] Cancel execution failed', { error: String(error) });
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: String(error) } });
  }
});

/**
 * POST /api/v1/goals/:id/executions/:executionId/retry — 重试执行
 * @deprecated → POST /api/v1/work-units/:id/executions/:executionId/retry
 */
router.post('/:id/executions/:executionId/retry', async (req: Request, res: Response) => {
  try {
    const execution = await goalService.retryGoalExecution(req.params.executionId);
    return res.json({ data: execution });
  } catch (error) {
    logger.error('[Goal API] Retry execution failed', { error: String(error) });
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: String(error) } });
  }
});

/**
 * DELETE /api/v1/goals/:id
 * @deprecated → DELETE /api/v1/work-units/:id — WorkUnit 删除替代
 */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    await goalService.deleteGoal(req.params.id);
    return res.json({ success: true });
  } catch (error) {
    logger.error('[Goal API] Delete failed', { error: String(error) });
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to delete goal' } });
  }
});

export default router;
