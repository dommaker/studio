/**
 * evolution.routes — 知识进化引擎子路由（§12.12）
 *
 * 从 routes.ts 提取（T3 大文件拆分，零行为变更），处理器逐字迁移：
 * - POST /evolution/micro   微观进化：从执行结果中提取知识
 * - POST /evolution/meso    中观进化：项目级别知识整合
 * - POST /evolution/macro   宏观进化：跨项目知识迁移
 * - POST /evolution/decay   衰减检查：归档过期知识
 * - GET  /evolution/health  知识库健康指标
 */

import { Router } from 'express';
import { logger } from '@dommaker/studio-shared';
import { knowledgeEvolution } from './evolution.service.js';
import { requireAuth, requireNotGuest } from '../../middleware/auth.js';

export const evolutionRoutes = Router();

/**
 * POST /api/v1/knowledge/evolution/micro
 * 微观进化：从执行结果中提取知识
 */
evolutionRoutes.post('/evolution/micro', requireAuth(), requireNotGuest(), async (req, res) => {
  try {
    const { executionId, projectId, companyId } = req.body;
    if (!executionId || !projectId || !companyId) {
      return res.status(400).json({ error: 'executionId, projectId, companyId are required' });
    }
    const results = await knowledgeEvolution.microEvolution(executionId, projectId, companyId);
    return res.json({ results, total: results.length });
  } catch (error) {
    logger.error('Micro evolution failed');
    return res.status(500).json({ error: 'Micro evolution failed' });
  }
});

/**
 * POST /api/v1/knowledge/evolution/meso
 * 中观进化：项目级别知识整合
 */
evolutionRoutes.post('/evolution/meso', requireAuth(), requireNotGuest(), async (req, res) => {
  try {
    const { projectId } = req.body;
    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }
    const results = await knowledgeEvolution.mesoEvolution(projectId);
    return res.json({ results, total: results.length });
  } catch (error) {
    logger.error('Meso evolution failed');
    return res.status(500).json({ error: 'Meso evolution failed' });
  }
});

/**
 * POST /api/v1/knowledge/evolution/macro
 * 宏观进化：跨项目知识迁移
 */
evolutionRoutes.post('/evolution/macro', requireAuth(), requireNotGuest(), async (req, res) => {
  try {
    const { companyId } = req.body;
    if (!companyId) {
      return res.status(400).json({ error: 'companyId is required' });
    }
    const result = await knowledgeEvolution.macroEvolution(companyId);
    return res.json(result);
  } catch (error) {
    logger.error('Macro evolution failed');
    return res.status(500).json({ error: 'Macro evolution failed' });
  }
});

/**
 * POST /api/v1/knowledge/evolution/decay
 * 衰减检查：归档过期知识
 */
evolutionRoutes.post('/evolution/decay', requireAuth(), requireNotGuest(), async (req, res) => {
  try {
    const results = await knowledgeEvolution.decayCheck();
    return res.json({ results, total: results.length });
  } catch (error) {
    logger.error('Decay check failed');
    return res.status(500).json({ error: 'Decay check failed' });
  }
});

/**
 * GET /api/v1/knowledge/evolution/health
 * 知识库健康指标
 */
evolutionRoutes.get('/evolution/health', async (req, res) => {
  try {
    const companyId = req.query.companyId as string;
    if (!companyId) {
      return res.status(400).json({ error: 'companyId is required' });
    }
    const metrics = await knowledgeEvolution.getHealthMetrics(companyId);
    return res.json(metrics);
  } catch (error) {
    logger.error('Failed to get health metrics');
    return res.status(500).json({ error: 'Failed to get health metrics' });
  }
});
