/**
 * RuntimeInstance API 路由 (AS-026 AC-1)
 *
 * Endpoints:
 *   GET    /api/v1/agent-instances          — list
 *   POST   /api/v1/agent-instances          — create
 *   GET    /api/v1/agent-instances/:id      — get by id
 *   PATCH  /api/v1/agent-instances/:id      — update
 */

import { Router, type Request, type Response } from 'express';
import { AgentInstanceService } from './agent-instance.service.js';
import { getErrorMessage } from '../../utils/errors.js';
import { parsePagination, formatPaginatedResponse } from '../../utils/pagination.js';

const router = Router();
const service = new AgentInstanceService();

/** GET / — list RuntimeInstances */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { status } = req.query;
    const { page, limit } = parsePagination(req);

    const result = await service.list({
      status: status as string,
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

/** POST / — create RuntimeInstance */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { roleId, sessionId, metadata } = req.body;

    if (!roleId || typeof roleId !== 'string') {
      return res.status(400).json({
        error: { code: 'INVALID_INPUT', message: 'roleId is required and must be a string' },
      });
    }

    const instance = await service.create({ roleId, sessionId, metadata });
    res.status(201).json(instance);
  } catch (error) {
    const msg = getErrorMessage(error);
    if (msg.includes('Foreign key constraint') || msg.includes('P2003')) {
      return res.status(400).json({
        error: { code: 'INVALID_REFERENCE', message: `roleId "${req.body.roleId}" does not exist` },
      });
    }
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: msg },
    });
  }
});

/** GET /:id — get RuntimeInstance by id */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const instance = await service.getById(req.params.id);
    if (!instance) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: `RuntimeInstance ${req.params.id} not found` },
      });
    }
    res.json(instance);
  } catch (error) {
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: getErrorMessage(error) },
    });
  }
});

/** PATCH /:id — update RuntimeInstance */
router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const instance = await service.update(req.params.id, req.body);
    res.json(instance);
  } catch (error) {
    const msg = getErrorMessage(error);
    if (msg.includes('Invalid status')) {
      return res.status(400).json({
        error: { code: 'INVALID_INPUT', message: msg },
      });
    }
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

export default router;
