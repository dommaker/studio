/**
 * agents.routes — Harness Agent 生命周期子路由（T-014）
 *
 * 从 routes.ts 提取（T3 大文件拆分，零行为变更），处理器逐字迁移：
 * - POST /agents              注册 agent
 * - POST /agents/:id/start    标记 agent 已启动
 * - POST /agents/:id/complete 标记 agent 已完成
 * - POST /agents/:id/fail     标记 agent 已失败
 * - GET  /agents              列出所有 agent
 * - GET  /agents/:id          agent 状态
 *
 * AgentLifecycle 单例仅本文件使用。
 */

import { Router, Request, Response } from 'express';
import { logger } from '@dommaker/studio-shared';
import type { AgentLifecycle as AgentLifecycleType } from '@dommaker/harness';
import { loadHarness, harnessModule } from './runtime.js';

export const agentsRoutes = Router();

// ─── Agent Lifecycle (T-014) ───

// In-memory agent lifecycle store
let agentLifecycle: AgentLifecycleType | null = null;

async function getAgentLifecycle(): Promise<AgentLifecycleType | null> {
  if (!agentLifecycle) {
    const loaded = await loadHarness();
    if (!loaded || !harnessModule) return null;
    agentLifecycle = new harnessModule.AgentLifecycle();
  }
  return agentLifecycle;
}

/**
 * POST /api/v1/harness/agents
 * Register an agent
 */
agentsRoutes.post('/agents', async (req: Request, res: Response) => {
  try {
    const lifecycle = await getAgentLifecycle();
    if (!lifecycle) return res.status(503).json({ error: 'Harness not available' });

    const { id, type, name, capabilities, config } = req.body;
    if (!id) return res.status(400).json({ error: 'id is required' });

    const state = lifecycle.register({ id, type, name, capabilities, ...config });
    return res.json({ data: state });
  } catch (error) {
    logger.error('Failed to register agent', { error: String(error) });
    return res.status(500).json({ error: 'Failed to register agent' });
  }
});

/**
 * POST /api/v1/harness/agents/:id/start
 * Mark agent as started
 */
agentsRoutes.post('/agents/:id/start', async (req: Request, res: Response) => {
  try {
    const lifecycle = await getAgentLifecycle();
    if (!lifecycle) return res.status(503).json({ error: 'Harness not available' });

    const state = lifecycle.start(req.params.id);
    if (!state) return res.status(404).json({ error: 'Agent not found' });
    return res.json({ data: state });
  } catch (error) {
    logger.error('Failed to start agent', { error: String(error) });
    return res.status(500).json({ error: 'Failed to start agent' });
  }
});

/**
 * POST /api/v1/harness/agents/:id/complete
 * Mark agent as completed
 */
agentsRoutes.post('/agents/:id/complete', async (req: Request, res: Response) => {
  try {
    const lifecycle = await getAgentLifecycle();
    if (!lifecycle) return res.status(503).json({ error: 'Harness not available' });

    const state = lifecycle.complete(req.params.id, req.body.metadata);
    if (!state) return res.status(404).json({ error: 'Agent not found' });
    return res.json({ data: state });
  } catch (error) {
    logger.error('Failed to complete agent', { error: String(error) });
    return res.status(500).json({ error: 'Failed to complete agent' });
  }
});

/**
 * POST /api/v1/harness/agents/:id/fail
 * Mark agent as failed
 */
agentsRoutes.post('/agents/:id/fail', async (req: Request, res: Response) => {
  try {
    const lifecycle = await getAgentLifecycle();
    if (!lifecycle) return res.status(503).json({ error: 'Harness not available' });

    const { error: errorMsg } = req.body;
    const state = lifecycle.fail(req.params.id, errorMsg || 'Unknown error');
    if (!state) return res.status(404).json({ error: 'Agent not found' });
    return res.json({ data: state });
  } catch (error) {
    logger.error('Failed to mark agent as failed', { error: String(error) });
    return res.status(500).json({ error: 'Failed to mark agent as failed' });
  }
});

/**
 * GET /api/v1/harness/agents
 * List all agents
 */
agentsRoutes.get('/agents', async (_req: Request, res: Response) => {
  try {
    const lifecycle = await getAgentLifecycle();
    if (!lifecycle) return res.status(503).json({ error: 'Harness not available' });

    const agents = lifecycle.getAllStates();
    return res.json({ data: agents, total: agents.length });
  } catch (error) {
    logger.error('Failed to list agents', { error: String(error) });
    return res.status(500).json({ error: 'Failed to list agents' });
  }
});

/**
 * GET /api/v1/harness/agents/:id
 * Get agent state
 */
agentsRoutes.get('/agents/:id', async (req: Request, res: Response) => {
  try {
    const lifecycle = await getAgentLifecycle();
    if (!lifecycle) return res.status(503).json({ error: 'Harness not available' });

    const state = lifecycle.getState(req.params.id);
    if (!state) return res.status(404).json({ error: 'Agent not found' });
    return res.json({ data: state });
  } catch (error) {
    logger.error('Failed to get agent', { error: String(error) });
    return res.status(500).json({ error: 'Failed to get agent' });
  }
});
