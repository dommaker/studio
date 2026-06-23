/**
 * AgentProfile API 路由 (AS-025 Phase 2)
 *
 * Endpoints:
 *   GET    /api/v1/agent-profiles          — list
 *   POST   /api/v1/agent-profiles          — create
 *   GET    /api/v1/agent-profiles/:id      — get by id
 *   PATCH  /api/v1/agent-profiles/:id      — update
 *   DELETE /api/v1/agent-profiles/:id      — delete
 */

import { Router, type Request, type Response } from 'express';
import { prisma } from '../../core/database.js';
import { AgentProfileService } from './agent-profile.service.js';
import { getErrorMessage } from '../../utils/errors.js';
import { parsePagination, formatPaginatedResponse } from '../../utils/pagination.js';

const router = Router();
const service = new AgentProfileService(prisma);

/** GET / — list AgentProfiles */
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

/** POST / — create AgentProfile */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name, description, channels, status } = req.body;

    if (!name || typeof name !== 'string') {
      return res.status(400).json({
        error: { code: 'INVALID_INPUT', message: 'name is required and must be a string' },
      });
    }

    const profile = await service.create({ name, description, channels, status });
    res.status(201).json(profile);
  } catch (error) {
    const msg = getErrorMessage(error);
    if (msg.includes('Unique constraint')) {
      return res.status(409).json({
        error: { code: 'DUPLICATE', message: `AgentProfile with name "${req.body.name}" already exists` },
      });
    }
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: msg },
    });
  }
});

/** GET /:id — get AgentProfile by id */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const profile = await service.getById(req.params.id);
    if (!profile) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: `AgentProfile ${req.params.id} not found` },
      });
    }
    res.json(profile);
  } catch (error) {
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: getErrorMessage(error) },
    });
  }
});

/** PATCH /:id — update AgentProfile */
router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const profile = await service.update(req.params.id, req.body);
    res.json(profile);
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

/** DELETE /:id — delete AgentProfile */
router.delete('/:id', async (req: Request, res: Response) => {
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

export default router;
