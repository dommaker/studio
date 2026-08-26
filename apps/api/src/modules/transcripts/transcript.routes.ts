/**
 * Transcript 只读路由（#174，#60 C5）
 *
 * GET /api/v1/transcripts/:workUnitId — 按 WU 读取归档 transcript（认证，分页）
 * 数据来自 #97 归档器（readTranscript），文件不存在返回 200 空列表（不 404）。
 * 只有这一个 GET，只读。
 */

import { Router, Request, Response } from 'express';
import { logger } from '@dommaker/studio-shared';
import { requireAuth } from '../../middleware/auth.js';
import { readTranscript } from './transcript-archive.js';
import { parsePagination } from '../../utils/pagination.js';

const router = Router();

/** workUnitId 防路径穿越：拒绝空值 / 含路径分隔符 / 含 .. 的 id */
function isValidWorkUnitId(id: string): boolean {
  return Boolean(id) && !id.includes('/') && !id.includes('\\') && !id.includes('..');
}

/**
 * GET /:workUnitId
 * Query: offset（默认 0）、limit（默认 20，上限 100 — #359 起统一 parsePagination，原上限 50）
 * 响应：{ workUnitId, total, offset, limit, entries }
 */
router.get('/:workUnitId', requireAuth(), async (req: Request, res: Response) => {
  try {
    const workUnitId = req.params.workUnitId;
    if (!isValidWorkUnitId(workUnitId)) {
      return res.status(400).json({ error: 'invalid workUnitId' });
    }

    const offset = Math.max(parseInt(String(req.query.offset || '0'), 10) || 0, 0);
    const { limit } = parsePagination(req);

    const all = await readTranscript(workUnitId);
    const entries = all.slice(offset, offset + limit);

    res.json({ workUnitId, total: all.length, offset, limit, entries });
  } catch (error: unknown) {
    logger.error('[Transcripts] GET failed', { error: String(error) });
    res.status(500).json({ error: 'Failed to read transcript' });
  }
});

export default router;
