/**
 * WorkUnit API 路由 (AS-025 §3.28c-1, §5.16)
 *
 * Endpoints:
 *   GET    /api/v1/workunits          — list
 *   POST   /api/v1/workunits          — create
 *   GET    /api/v1/workunits/:id      — get by id
 *   PUT    /api/v1/workunits/:id      — update
 *   DELETE /api/v1/workunits/:id      — delete
 *   POST   /api/v1/workunits/:id/claim   — claim (optimistic lock)
 *   POST   /api/v1/workunits/:id/unclaim — unclaim
 *   POST   /api/v1/workunits/:id/status  — transition status (state machine)
 *   POST   /api/v1/workunits/:id/review-passed   — review approved (in_review → done)
 *   POST   /api/v1/workunits/:id/review-rejected — review rejected (in_review → active/blocked)
 *
 * 涌现路径 (AS-025 §5.15):
 *   POST   /api/v1/workunits/from-message — convert ChannelMessage to WorkUnit
 *
 * 讨论空间 (AS-025 §5.16):
 *   GET    /api/v1/workunits/:id/messages       — list messages by workUnitId
 *   POST   /api/v1/workunits/:id/messages       — send message (auto-associate workUnitId)
 *   PATCH  /api/v1/workunits/:id/messages/:messageId — edit message
 */

import { Router, type Request, type Response } from 'express';
import { FileStore } from '@dommaker/studio-shared';
import { WorkUnitService } from './workunit.service.js';
import { aggregateTreeTokens } from '../agents/token-usage.service.js';
import { channelMessageService } from '../channels/channel-message.service.js';
import { getErrorMessage } from '../../utils/errors.js';
import { parsePagination, formatPaginatedResponse } from '../../utils/pagination.js';
import { requireAuth, requireNotGuest } from '../../middleware/auth.js';

const router = Router();
const fileStore = new FileStore();
const service = new WorkUnitService(fileStore);

/**
 * A2A §4.4: 调用方 authorType 识别（body.authorType 优先，其次 x-author-type header）。
 * 与讨论空间发帖的 authorType 字段同约定；UI/人类调用不发送该字段 → 'human'。
 */
function resolveCallerAuthorType(req: Request): string {
  const fromBody = typeof req.body?.authorType === 'string' ? req.body.authorType : undefined;
  const fromHeader = req.headers['x-author-type'];
  return fromBody ?? (typeof fromHeader === 'string' ? fromHeader : 'human');
}

/** GET / — list WorkUnits */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { type, status, assigneeId, channelId, parentId } = req.query;
    const { page, limit } = parsePagination(req);

    const result = await service.list({
      type: type as string,
      status: status as string,
      assigneeId: assigneeId as string,
      channelId: channelId as string,
      parentId: parentId as string,
      page,
      limit,
    });

    res.json(formatPaginatedResponse(result.data, result.total, page, limit));
  } catch (error) {
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: getErrorMessage(error) },
    });
  }
});

/** POST / — create WorkUnit */
router.post('/', requireAuth(), requireNotGuest(), async (req: Request, res: Response) => {
  try {
    const { scope, type, assigneeId, status, channelId, parentId, metadata, projectPath } = req.body;

    if (!scope || typeof scope !== 'string') {
      return res.status(400).json({
        error: { code: 'INVALID_INPUT', message: 'scope is required and must be a string' },
      });
    }

    const wu = await service.create({
      scope,
      type,
      assigneeId,
      status,
      channelId,
      parentId,
      metadata,
      projectPath,
    });

    res.status(201).json(wu);
  } catch (error) {
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: getErrorMessage(error) },
    });
  }
});

/** POST /from-message — convert ChannelMessage to WorkUnit (emergence path) */
router.post('/from-message', requireAuth(), requireNotGuest(), async (req: Request, res: Response) => {
  try {
    const { messageId, type, metadata } = req.body;

    if (!messageId || typeof messageId !== 'string') {
      return res.status(400).json({
        error: { code: 'INVALID_INPUT', message: 'messageId is required' },
      });
    }

    const wu = await service.createFromMessage(messageId, { type, metadata });
    res.status(201).json(wu);
  } catch (error) {
    const msg = getErrorMessage(error);
    if (msg.includes('not found')) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: msg } });
    }
    if (msg.includes('already linked')) {
      return res.status(409).json({ error: { code: 'ALREADY_CONVERTED', message: msg } });
    }
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: msg } });
  }
});

/** GET /:id — get WorkUnit by id */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const wu = await service.getById(req.params.id);

    if (!wu) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: `WorkUnit ${req.params.id} not found` },
      });
    }

    res.json(wu);
  } catch (error) {
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: getErrorMessage(error) },
    });
  }
});

/** PUT /:id — update WorkUnit */
router.put('/:id', requireAuth(), requireNotGuest(), async (req: Request, res: Response) => {
  try {
    const wu = await service.update(req.params.id, req.body);
    res.json(wu);
  } catch (error) {
    const msg = getErrorMessage(error);
    if (msg.includes('not found') || msg.includes('Record to update not found')) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: msg },
      });
    }
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: msg },
    });
  }
});

/** GET /:id/tree-tokens - 树级 token 开销聚合（AC-5.4, §8.4.4） */
router.get('/:id/tree-tokens', async (req: Request, res: Response) => {
  try {
    const wu = await service.getById(req.params.id);
    if (!wu) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: `WorkUnit ${req.params.id} not found` },
      });
    }
    const meta = wu.metadata ? JSON.parse(wu.metadata) as { collab?: { rootId?: string } } : {};
    const rootId = meta.collab?.rootId ?? wu.id;
    const report = await aggregateTreeTokens(rootId, fileStore);
    res.json(report);
  } catch (error) {
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: getErrorMessage(error) },
    });
  }
});

/** DELETE /:id — delete WorkUnit */
router.delete('/:id', requireAuth(), requireNotGuest(), async (req: Request, res: Response) => {
  try {
    await service.delete(req.params.id);
    res.status(204).send();
  } catch (error) {
    const msg = getErrorMessage(error);
    if (msg.includes('not found') || msg.includes('Record to delete does not exist')) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: msg },
      });
    }
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: msg },
    });
  }
});

/** POST /:id/claim — claim WorkUnit (optimistic lock) */
router.post('/:id/claim', requireAuth(), requireNotGuest(), async (req: Request, res: Response) => {
  try {
    const { agentId } = req.body;
    if (!agentId || typeof agentId !== 'string') {
      return res.status(400).json({
        error: { code: 'INVALID_INPUT', message: 'agentId is required' },
      });
    }

    const wu = await service.claim(req.params.id, agentId);
    res.json(wu);
  } catch (error) {
    const msg = getErrorMessage(error);
    if (msg === 'Claim failed') {
      return res.status(409).json({
        error: { code: 'CLAIM_FAILED', message: msg },
      });
    }
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: msg },
    });
  }
});

/** POST /:id/unclaim — unclaim WorkUnit */
router.post('/:id/unclaim', requireAuth(), requireNotGuest(), async (req: Request, res: Response) => {
  try {
    const wu = await service.unclaim(req.params.id);
    res.json(wu);
  } catch (error) {
    const msg = getErrorMessage(error);
    if (msg.includes('not found') || msg.includes('Record to update not found')) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: msg },
      });
    }
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: msg },
    });
  }
});

/** POST /:id/review-passed — review approved (in_review → done) */
router.post('/:id/review-passed', requireAuth(), requireNotGuest(), async (req: Request, res: Response) => {
  try {
    // A2A §4.4-2 / §8-Q3: 验收权只在人 —— agent 身份调用一律 403。
    // 身份约定：调用方在 body.authorType 或 x-author-type header 声明；
    // UI/人类调用不发送该字段（或发送 'human'）。
    if (resolveCallerAuthorType(req) === 'agent') {
      return res.status(403).json({
        error: { code: 'FORBIDDEN', message: 'Review actions are human-only (authorType=agent rejected)' },
      });
    }
    const wu = await service.reviewPassed(req.params.id);
    res.json(wu);
  } catch (error) {
    const msg = getErrorMessage(error);
    if (msg.includes('not found')) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: msg } });
    }
    if (msg.includes('Cannot review')) {
      return res.status(400).json({ error: { code: 'INVALID_TRANSITION', message: msg } });
    }
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: msg } });
  }
});

/** POST /:id/review-rejected — review rejected (in_review → active, or blocked after 3) */
router.post('/:id/review-rejected', requireAuth(), requireNotGuest(), async (req: Request, res: Response) => {
  try {
    // A2A §4.4-2 / §8-Q3: 同 review-passed，agent 身份调用一律 403
    if (resolveCallerAuthorType(req) === 'agent') {
      return res.status(403).json({
        error: { code: 'FORBIDDEN', message: 'Review actions are human-only (authorType=agent rejected)' },
      });
    }
    const wu = await service.reviewRejected(req.params.id, req.body?.reason);
    res.json(wu);
  } catch (error) {
    const msg = getErrorMessage(error);
    if (msg.includes('not found')) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: msg } });
    }
    if (msg.includes('Cannot review')) {
      return res.status(400).json({ error: { code: 'INVALID_TRANSITION', message: msg } });
    }
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: msg } });
  }
});

/** POST /:id/status — transition WorkUnit status (state machine) */
router.post('/:id/status', requireAuth(), requireNotGuest(), async (req: Request, res: Response) => {
  try {
    const { status } = req.body;
    if (!status || typeof status !== 'string') {
      return res.status(400).json({
        error: { code: 'INVALID_INPUT', message: 'status is required' },
      });
    }

    const wu = await service.transitionStatus(req.params.id, status);
    res.json(wu);
  } catch (error) {
    const msg = getErrorMessage(error);
    if (msg.includes('Invalid status transition')) {
      return res.status(400).json({
        error: { code: 'INVALID_TRANSITION', message: msg },
      });
    }
    if (msg.includes('not found')) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: msg },
      });
    }
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: msg },
    });
  }
});

// ── 讨论空间 (AS-025 §5.16) ──

/** GET /:id/messages — list messages in discussion space (workUnitId grouping) */
router.get('/:id/messages', async (req: Request, res: Response) => {
  try {
    const { before, limit = '50' } = req.query;
    const take = Math.min(Number(limit), 100);

    const beforeDate = before ? new Date(before as string) : undefined;

    const result = await channelMessageService.listByWorkUnitId(req.params.id, {
      before: beforeDate,
      limit: take,
    });

    res.json({
      success: true,
      data: result.data,
      total: result.total,
      hasMore: result.data.length < result.total,
    });
  } catch (error) {
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: getErrorMessage(error) },
    });
  }
});

/** POST /:id/messages — send message in discussion space (auto-associate workUnitId) */
router.post('/:id/messages', requireAuth(), requireNotGuest(), async (req: Request, res: Response) => {
  try {
    const { content, replyToId, authorType = 'human', agentName } = req.body;

    if (!content || typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({
        error: { code: 'INVALID_INPUT', message: 'content is required' },
      });
    }

    // Verify WorkUnit exists
    const wu = await service.getById(req.params.id);
    if (!wu) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: `WorkUnit ${req.params.id} not found` },
      });
    }

    // Need a channelId — use WorkUnit's channelId or fallback to system channel
    let channelId = wu.channelId;
    if (!channelId) {
      const rndChannels = await fileStore.listChannels({ type: 'rnd' });
      const sysChannel = rndChannels.length > 0 ? rndChannels[0] : null;
      if (!sysChannel) {
        return res.status(400).json({
          error: { code: 'NO_CHANNEL', message: 'No channel available for discussion messages' },
        });
      }
      channelId = sysChannel.id;
    }

    let message;
    if (authorType === 'agent' && agentName) {
      message = await channelMessageService.createAgentMessage(
        channelId, agentName, content.trim(),
        { replyToId, workUnitId: req.params.id },
      );
    } else {
      message = await channelMessageService.createHumanMessage(
        channelId, content.trim(), replyToId, req.params.id,
      );
    }

    res.status(201).json(message);
  } catch (error) {
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: getErrorMessage(error) },
    });
  }
});

/** PATCH /:id/messages/:messageId — edit message in discussion space */
router.patch('/:id/messages/:messageId', requireAuth(), requireNotGuest(), async (req: Request, res: Response) => {
  try {
    const { content, meta } = req.body;

    if (content === undefined && meta === undefined) {
      return res.status(400).json({
        error: { code: 'INVALID_INPUT', message: 'content or meta is required' },
      });
    }

    // Verify message belongs to this WorkUnit
    const found = await fileStore.getMessageById(req.params.messageId);
    if (!found) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: `Message ${req.params.messageId} not found` },
      });
    }
    if (found.message.workUnitId !== req.params.id) {
      return res.status(400).json({
        error: { code: 'INVALID_INPUT', message: 'Message does not belong to this WorkUnit' },
      });
    }

    const updated = await channelMessageService.updateMessage(req.params.messageId, {
      content,
      meta,
    });

    res.json(updated);
  } catch (error) {
    const msg = getErrorMessage(error);
    if (msg.includes('not found')) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: msg },
      });
    }
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: msg },
    });
  }
});

export default router;
