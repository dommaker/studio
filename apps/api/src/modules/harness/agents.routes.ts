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
 *
 * 契约驱动迁移（2026-10 批次 6/7）：走 core/http.ts defineRoute——
 * 注册 id 必填收进 zod（原手写 400 退役）；列表壳内层 data 键改名词键
 * `{ data: { agents, total } }`（无消费方）；错误统一 `{ error: { code, message } }`
 * （503 SERVICE_UNAVAILABLE；500 message 由固定串变为实际错误消息）。
 */

import { Router } from 'express';
import { defineRoute, HttpError } from '../../core/http.js';
import {
  harnessAgentRegisterBodySchema,
  harnessAgentFailBodySchema,
  harnessAgentCompleteBodySchema,
  harnessIdParamsSchema,
} from '@dommaker/studio-contract';
import type { AgentLifecycle as AgentLifecycleType } from '@dommaker/harness';
import { loadHarness, harnessModule } from './runtime.js';

export const agentsRoutes = Router();

const HARNESS_UNAVAILABLE = () => new HttpError(503, 'SERVICE_UNAVAILABLE', 'Harness not available');

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
agentsRoutes.post('/agents', defineRoute(
  { body: harnessAgentRegisterBodySchema },
  async (_req, _res, { body }) => {
    const lifecycle = await getAgentLifecycle();
    if (!lifecycle) throw HARNESS_UNAVAILABLE();

    const state = lifecycle.register({
      id: body.id,
      type: body.type,
      name: body.name,
      capabilities: body.capabilities,
      ...body.config,
    } as unknown as Parameters<AgentLifecycleType['register']>[0]);
    return state as unknown as Record<string, unknown>;
  },
));

/**
 * POST /api/v1/harness/agents/:id/start
 * Mark agent as started
 */
agentsRoutes.post('/agents/:id/start', defineRoute(
  { params: harnessIdParamsSchema },
  async (_req, _res, { params }) => {
    const lifecycle = await getAgentLifecycle();
    if (!lifecycle) throw HARNESS_UNAVAILABLE();

    const state = lifecycle.start(params.id);
    if (!state) throw new HttpError(404, 'NOT_FOUND', 'Agent not found');
    return state as unknown as Record<string, unknown>;
  },
));

/**
 * POST /api/v1/harness/agents/:id/complete
 * Mark agent as completed
 */
agentsRoutes.post('/agents/:id/complete', defineRoute(
  { params: harnessIdParamsSchema, body: harnessAgentCompleteBodySchema },
  async (_req, _res, { params, body }) => {
    const lifecycle = await getAgentLifecycle();
    if (!lifecycle) throw HARNESS_UNAVAILABLE();

    const state = lifecycle.complete(params.id, body.metadata as Parameters<AgentLifecycleType['complete']>[1]);
    if (!state) throw new HttpError(404, 'NOT_FOUND', 'Agent not found');
    return state as unknown as Record<string, unknown>;
  },
));

/**
 * POST /api/v1/harness/agents/:id/fail
 * Mark agent as failed
 */
agentsRoutes.post('/agents/:id/fail', defineRoute(
  { params: harnessIdParamsSchema, body: harnessAgentFailBodySchema },
  async (_req, _res, { params, body }) => {
    const lifecycle = await getAgentLifecycle();
    if (!lifecycle) throw HARNESS_UNAVAILABLE();

    const state = lifecycle.fail(params.id, body.error || 'Unknown error');
    if (!state) throw new HttpError(404, 'NOT_FOUND', 'Agent not found');
    return state as unknown as Record<string, unknown>;
  },
));

/**
 * GET /api/v1/harness/agents
 * List all agents
 */
agentsRoutes.get('/agents', defineRoute({}, async () => {
  const lifecycle = await getAgentLifecycle();
  if (!lifecycle) throw HARNESS_UNAVAILABLE();

  const agents = lifecycle.getAllStates();
  return { agents, total: agents.length };
}));

/**
 * GET /api/v1/harness/agents/:id
 * Get agent state
 */
agentsRoutes.get('/agents/:id', defineRoute(
  { params: harnessIdParamsSchema },
  async (_req, _res, { params }) => {
    const lifecycle = await getAgentLifecycle();
    if (!lifecycle) throw HARNESS_UNAVAILABLE();

    const state = lifecycle.getState(params.id);
    if (!state) throw new HttpError(404, 'NOT_FOUND', 'Agent not found');
    return state as unknown as Record<string, unknown>;
  },
));
