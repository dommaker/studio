/**
 * Role Memory API 路由
 * POST /api/v1/roles/:roleId/memory — 添加记忆
 * GET  /api/v1/roles/:roleId/memory — 查询记忆（支持 ?type=&q=&limit=）
 * GET  /api/v1/roles/:roleId/memory/stats — 记忆统计
 * GET  /api/v1/roles/:roleId/memory/prompt — 格式化为 prompt 文本
 * PUT  /api/v1/roles/:roleId/memory/:entryId — 更新记忆
 * DEL  /api/v1/roles/:roleId/memory/:entryId — 删除记忆
 * DEL  /api/v1/roles/:roleId/memory — 清空记忆
 */

import { Router, Request, Response } from 'express';
import { memoryService } from './memory.service.js';
import { logger } from '@dommaker/studio-shared';

const router = Router({ mergeParams: true });

/**
 * GET /api/v1/roles/:roleId/memory
 * 查询记忆（支持 ?type=experience&q=keyword&limit=10）
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { roleId } = req.params;
    const { type, q, limit } = req.query;

    if (q) {
      const entries = await memoryService.search(roleId, q as string, Number(limit) || 10);
      return res.json({ entries });
    }

    if (type) {
      const entries = await memoryService.getByType(roleId, type as any);
      return res.json({ entries });
    }

    const memory = await memoryService.getMemory(roleId);
    return res.json(memory);
  } catch (error) {
    logger.error('[Memory API] Failed to get memory', { error: String(error) });
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get memory' } });
  }
});

/**
 * GET /api/v1/roles/:roleId/memory/stats
 */
router.get('/stats', async (req: Request, res: Response) => {
  try {
    const { roleId } = req.params;
    const stats = await memoryService.getStats(roleId);
    res.json(stats);
  } catch (error) {
    logger.error('[Memory API] Failed to get stats', { error: String(error) });
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get stats' } });
  }
});

/**
 * GET /api/v1/roles/:roleId/memory/prompt
 * 格式化记忆为 agent prompt 文本
 */
router.get('/prompt', async (req: Request, res: Response) => {
  try {
    const { roleId } = req.params;
    const limit = Number(req.query.limit) || 10;
    const text = await memoryService.formatForPrompt(roleId, limit);
    res.json({ text, roleId });
  } catch (error) {
    logger.error('[Memory API] Failed to format prompt', { error: String(error) });
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to format prompt' } });
  }
});

/**
 * POST /api/v1/roles/:roleId/memory
 * 添加记忆条目
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { roleId } = req.params;
    const { type, content, taskId, importance } = req.body;

    if (!type || !content) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'type and content are required' } });
    }

    const validTypes = ['experience', 'decision', 'feedback', 'learning'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: `type must be one of: ${validTypes.join(', ')}` } });
    }

    const entry = await memoryService.addEntry(roleId, {
      type,
      content,
      taskId,
      importance: importance ?? 3,
    });

    return res.status(201).json(entry);
  } catch (error) {
    logger.error('[Memory API] Failed to add entry', { error: String(error) });
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to add entry' } });
  }
});

/**
 * PUT /api/v1/roles/:roleId/memory/:entryId
 */
router.put('/:entryId', async (req: Request, res: Response) => {
  try {
    const { roleId, entryId } = req.params;
    const { content, importance } = req.body;

    const updated = await memoryService.updateEntry(roleId, entryId, { content, importance });
    if (!updated) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Entry not found' } });
    }

    return res.json(updated);
  } catch (error) {
    logger.error('[Memory API] Failed to update entry', { error: String(error) });
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update entry' } });
  }
});

/**
 * DELETE /api/v1/roles/:roleId/memory/:entryId
 */
router.delete('/:entryId', async (req: Request, res: Response) => {
  try {
    const { roleId, entryId } = req.params;
    const deleted = await memoryService.deleteEntry(roleId, entryId);
    if (!deleted) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Entry not found' } });
    }
    return res.json({ success: true });
  } catch (error) {
    logger.error('[Memory API] Failed to delete entry', { error: String(error) });
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to delete entry' } });
  }
});

/**
 * DELETE /api/v1/roles/:roleId/memory
 * 清空记忆
 */
router.delete('/', async (req: Request, res: Response) => {
  try {
    const { roleId } = req.params;
    await memoryService.clearMemory(roleId);
    return res.json({ success: true });
  } catch (error) {
    logger.error('[Memory API] Failed to clear memory', { error: String(error) });
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to clear memory' } });
  }
});

export default router;
