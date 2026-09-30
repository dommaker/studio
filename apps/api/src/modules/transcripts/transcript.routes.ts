/**
 * Transcript 只读路由（#174，#60 C5）
 *
 * GET /api/v1/transcripts/:workUnitId — 按 WU 读取归档 transcript（认证，分页）
 * 数据来自 #97 归档器（readTranscript），文件不存在返回 200 空列表（不 404）。
 * 只有这一个 GET，只读。
 *
 * 契约驱动迁移（2026-10 批次 5/7）：走 core/http.ts defineRoute——workUnitId 防路径
 * 穿越手写 400 收进 zod params；响应统一 `{ data }` 壳（原平铺进壳，分页语义不变）；
 * 错误统一 `{ error: { code, message } }`（500 文案由固定串变为实际错误消息）。
 */

import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { readTranscript } from './transcript-archive.js';
import { parsePagination } from '../../utils/pagination.js';
import { defineRoute } from '../../core/http.js';
import { transcriptParamsSchema, transcriptQuerySchema } from '@dommaker/studio-contract';

const router = Router();

/**
 * GET /:workUnitId
 * Query: offset（默认 0）、limit（默认 20，上限 100 — #359 起统一 parsePagination，原上限 50）
 * 响应：{ data: { workUnitId, total, offset, limit, entries } }
 */
router.get('/:workUnitId', requireAuth(), defineRoute(
  { params: transcriptParamsSchema, query: transcriptQuerySchema },
  async (req, _res, { params }) => {
    const { workUnitId } = params;

    const offset = Math.max(parseInt(String(req.query.offset || '0'), 10) || 0, 0);
    const { limit } = parsePagination(req);

    const all = await readTranscript(workUnitId);
    const entries = all.slice(offset, offset + limit);

    return { workUnitId, total: all.length, offset, limit, entries };
  },
));

export default router;
