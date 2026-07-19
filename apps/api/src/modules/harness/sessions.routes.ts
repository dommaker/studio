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
 */

import { Router, Request, Response } from 'express';
import { logger } from '@dommaker/studio-shared';
import { loadHarness, harnessModule } from './runtime.js';

export const sessionsRoutes = Router();

// ─── Context Management (T-011) ───

/**
 * POST /api/v1/harness/estimate-tokens
 * Estimate token count for text or objects
 */
sessionsRoutes.post('/estimate-tokens', async (req: Request, res: Response) => {
  try {
    const loaded = await loadHarness();
    if (!loaded) return res.status(503).json({ error: 'Harness not available' });

    const { text, object } = req.body;
    await loadHarness();
    const TokenEstimator = harnessModule!.TokenEstimator;

    let tokens: number;
    if (text) {
      tokens = TokenEstimator.estimateText(text);
    } else if (object) {
      tokens = TokenEstimator.estimateObject(object);
    } else {
      return res.status(400).json({ error: 'text or object is required' });
    }

    return res.json({ tokens, method: 'character-based-estimate' });
  } catch (error) {
    logger.error('Failed to estimate tokens', { error: String(error) });
    return res.status(500).json({ error: 'Failed to estimate tokens' });
  }
});

// Session store (in-memory, for lightweight session management)
const sessions = new Map<string, any>();

/**
 * POST /api/v1/harness/sessions
 * Create a new session
 */
sessionsRoutes.post('/sessions', async (req: Request, res: Response) => {
  try {
    const loaded = await loadHarness();
    if (!loaded) return res.status(503).json({ error: 'Harness not available' });

    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'id is required' });

    await loadHarness();
    const manager = new harnessModule!.SessionManager();
    const session = manager.createSession(id);
    sessions.set(id, { manager, session });

    return res.json({ data: { id, created: true } });
  } catch (error) {
    logger.error('Failed to create session', { error: String(error) });
    return res.status(500).json({ error: 'Failed to create session' });
  }
});

/**
 * POST /api/v1/harness/sessions/:id/events
 * Append event to session
 */
sessionsRoutes.post('/sessions/:id/events', async (req: Request, res: Response) => {
  try {
    const loaded = await loadHarness();
    if (!loaded) return res.status(503).json({ error: 'Harness not available' });

    const { id } = req.params;
    const { event } = req.body;
    if (!event) return res.status(400).json({ error: 'event is required' });

    // S2 修复：复用已创建的 SessionManager，不 new 新实例
    const entry = sessions.get(id);
    if (!entry) return res.status(404).json({ error: `Session not found: ${id}` });

    entry.manager.appendToSession(id, event);
    return res.json({ recorded: true });
  } catch (error) {
    logger.error('Failed to append event', { error: String(error) });
    return res.status(500).json({ error: 'Failed to append event' });
  }
});

/**
 * GET /api/v1/harness/sessions/:id
 * Get session info
 */
sessionsRoutes.get('/sessions/:id', async (req: Request, res: Response) => {
  try {
    const loaded = await loadHarness();
    if (!loaded) return res.status(503).json({ error: 'Harness not available' });

    const { id } = req.params;

    // S2 修复：复用已创建的 SessionManager
    const entry = sessions.get(id);
    if (!entry) return res.status(404).json({ error: `Session not found: ${id}` });

    try {
      const info = entry.manager.getSessionInfo(id);
      return res.json({ data: info });
    } catch {
      return res.status(404).json({ error: `Session not found: ${id}` });
    }
  } catch (error) {
    logger.error('Failed to get session', { error: String(error) });
    return res.status(500).json({ error: 'Failed to get session' });
  }
});

/**
 * POST /api/v1/harness/sessions/:id/checkpoint
 * Save session checkpoint
 */
sessionsRoutes.post('/sessions/:id/checkpoint', async (req: Request, res: Response) => {
  try {
    const loaded = await loadHarness();
    if (!loaded) return res.status(503).json({ error: 'Harness not available' });

    const { id } = req.params;

    // S2 修复：复用已创建的 SessionManager
    const entry = sessions.get(id);
    if (!entry) return res.status(404).json({ error: `Session not found: ${id}` });

    try {
      const checkpoint = entry.manager.checkpointSession(id);
      return res.json({ data: checkpoint });
    } catch {
      return res.status(404).json({ error: `Session not found: ${id}` });
    }
  } catch (error) {
    logger.error('Failed to checkpoint session', { error: String(error) });
    return res.status(500).json({ error: 'Failed to checkpoint session' });
  }
});
