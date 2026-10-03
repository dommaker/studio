/**
 * sessions.routes — Harness 上下文管理子路由（T-011）
 *
 * 从 routes.ts 提取（T3 大文件拆分，零行为变更），处理器逐字迁移：
 * - POST /estimate-tokens          估算文本/对象的 token 数
 * - POST /sessions                 创建会话
 * - POST /sessions/:id/events      向会话追加事件
 * - GET  /sessions/:id             会话信息
 * - POST /sessions/:id/checkpoint  保存会话检查点
 *
 * sessions 为内存态会话存储（轻量会话管理），仅本文件使用。
 *
 * 契约驱动迁移（2026-10 批次 6/7）：走 core/http.ts defineRoute——
 * text/object 二选一（refine）与 id/event 必填收进 zod（原手写 400 退役）；
 * 平铺 `{ tokens, method }` / `{ recorded }` 进 `{ data }` 壳；错误统一
 * `{ error: { code, message } }`（503 SERVICE_UNAVAILABLE；500 message 由
 * 固定串变为实际错误消息）。
 */

import { Router } from 'express';
import { defineRoute, HttpError } from '../../core/http.js';
import {
  estimateTokensBodySchema,
  sessionCreateBodySchema,
  sessionEventBodySchema,
  harnessIdParamsSchema,
} from '@dommaker/studio-contract';
import { loadHarness, harnessModule } from './runtime.js';

export const sessionsRoutes = Router();

const HARNESS_UNAVAILABLE = () => new HttpError(503, 'SERVICE_UNAVAILABLE', 'Harness not available');

// ─── Context Management (T-011) ───

/**
 * POST /api/v1/harness/estimate-tokens
 * Estimate token count for text or objects
 */
sessionsRoutes.post('/estimate-tokens', defineRoute(
  { body: estimateTokensBodySchema },
  async (_req, _res, { body }) => {
    const loaded = await loadHarness();
    if (!loaded) throw HARNESS_UNAVAILABLE();

    const estimateTokens = harnessModule!.estimateTokens;

    let tokens: number;
    if (body.text) {
      tokens = estimateTokens(body.text);
    } else {
      // 对齐旧 estimateObject 的兜底语义：JSON.stringify 抛错（如循环引用）记 0 不抛；
      // 尺子本体已换 harness 1.16.0 estimateTokens 逐码点口径，与旧按字符估算并非数值等价
      try {
        tokens = estimateTokens(JSON.stringify(body.object));
      } catch {
        tokens = 0;
      }
    }

    return { tokens, method: 'character-based-estimate' };
  },
));

// Session store (in-memory, for lightweight session management)
const sessions = new Map<string, any>();

/**
 * POST /api/v1/harness/sessions
 * Create a new session
 */
sessionsRoutes.post('/sessions', defineRoute(
  { body: sessionCreateBodySchema },
  async (_req, _res, { body }) => {
    const loaded = await loadHarness();
    if (!loaded) throw HARNESS_UNAVAILABLE();

    const manager = new harnessModule!.SessionManager();
    const session = manager.createSession(body.id!);
    sessions.set(body.id!, { manager, session });

    return { id: body.id!, created: true };
  },
));

/**
 * POST /api/v1/harness/sessions/:id/events
 * Append event to session
 */
sessionsRoutes.post('/sessions/:id/events', defineRoute(
  { params: harnessIdParamsSchema, body: sessionEventBodySchema },
  async (_req, _res, { params, body }) => {
    const loaded = await loadHarness();
    if (!loaded) throw HARNESS_UNAVAILABLE();

    // S2 修复：复用已创建的 SessionManager，不 new 新实例
    const entry = sessions.get(params.id);
    if (!entry) throw new HttpError(404, 'NOT_FOUND', `Session not found: ${params.id}`);

    entry.manager.appendToSession(params.id, body.event);
    return { recorded: true };
  },
));

/**
 * GET /api/v1/harness/sessions/:id
 * Get session info
 */
sessionsRoutes.get('/sessions/:id', defineRoute(
  { params: harnessIdParamsSchema },
  async (_req, _res, { params }) => {
    const loaded = await loadHarness();
    if (!loaded) throw HARNESS_UNAVAILABLE();

    // S2 修复：复用已创建的 SessionManager
    const entry = sessions.get(params.id);
    if (!entry) throw new HttpError(404, 'NOT_FOUND', `Session not found: ${params.id}`);

    try {
      return entry.manager.getSessionInfo(params.id) as Record<string, unknown>;
    } catch {
      throw new HttpError(404, 'NOT_FOUND', `Session not found: ${params.id}`);
    }
  },
));

/**
 * POST /api/v1/harness/sessions/:id/checkpoint
 * Save session checkpoint
 */
sessionsRoutes.post('/sessions/:id/checkpoint', defineRoute(
  { params: harnessIdParamsSchema },
  async (_req, _res, { params }) => {
    const loaded = await loadHarness();
    if (!loaded) throw HARNESS_UNAVAILABLE();

    // S2 修复：复用已创建的 SessionManager
    const entry = sessions.get(params.id);
    if (!entry) throw new HttpError(404, 'NOT_FOUND', `Session not found: ${params.id}`);

    try {
      return entry.manager.checkpointSession(params.id) as Record<string, unknown>;
    } catch {
      throw new HttpError(404, 'NOT_FOUND', `Session not found: ${params.id}`);
    }
  },
));
