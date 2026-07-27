/**
 * Requirement API 路由 — REQ 需求编号体系（vision §5.3）
 *
 * Endpoints:
 *   GET   /api/v1/requirements           — list（status/channelId 过滤）
 *   POST  /api/v1/requirements           — 手动创建
 *   GET   /api/v1/requirements/:id       — get by id
 *   PATCH /api/v1/requirements/:id       — 更新 status/title/docs/description
 *   GET   /api/v1/requirements/:id/chain — 全链路（需求 + WorkUnit 状态列表）
 */
import { Router, type Request, type Response } from 'express';
import { FileStore, type RequirementStatus } from '@dommaker/studio-shared';
import { RequirementService, REQUIREMENT_STATUSES } from './requirement.service.js';
import { requireAuth, requireNotGuest } from '../../middleware/auth.js';

export function createRequirementRoutes(fileStore?: FileStore): Router {
  const router = Router();
  const service = new RequirementService(fileStore);

  /** GET / — list requirements（status/channelId 过滤） */
  router.get('/', async (req: Request, res: Response) => {
    const { status, channelId } = req.query;
    if (status !== undefined && !REQUIREMENT_STATUSES.includes(status as RequirementStatus)) {
      return res.status(400).json({ success: false, error: `status must be one of: ${REQUIREMENT_STATUSES.join(', ')}` });
    }
    const data = await service.list({
      status: status as string | undefined,
      channelId: channelId as string | undefined,
    });
    res.json({ success: true, data });
  });

  /** POST / — 手动创建需求 */
  router.post('/', requireAuth(), requireNotGuest(), async (req: Request, res: Response) => {
    const { title, channelId, description, createdBy, docs, projectId } = req.body;
    if (!title || typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ success: false, error: 'title is required' });
    }
    if (docs !== undefined && (!Array.isArray(docs) || docs.some(d => typeof d !== 'string'))) {
      return res.status(400).json({ success: false, error: 'docs must be an array of strings' });
    }
    // B3a: projectId 挂接 PMO 项目（string | null；不存在 → 400）
    if (projectId !== undefined && projectId !== null && typeof projectId !== 'string') {
      return res.status(400).json({ success: false, error: 'projectId must be a string or null' });
    }
    try {
      const data = await service.create({
        title: title.trim(),
        channelId: typeof channelId === 'string' ? channelId : null,
        description: typeof description === 'string' ? description : undefined,
        createdBy: typeof createdBy === 'string' ? createdBy : 'manual',
        docs,
        projectId: projectId === undefined ? undefined : projectId,
      });
      res.status(201).json({ success: true, data });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('Project not found')) {
        return res.status(400).json({ success: false, error: msg });
      }
      throw e;
    }
  });

  /** GET /:id — get requirement by id */
  router.get('/:id', async (req: Request, res: Response) => {
    const data = await service.get(req.params.id);
    if (!data) return res.status(404).json({ success: false, error: `Requirement not found: ${req.params.id}` });
    res.json({ success: true, data });
  });

  /** PATCH /:id — 更新 status/title/docs/description/projectId */
  router.patch('/:id', requireAuth(), requireNotGuest(), async (req: Request, res: Response) => {
    const { title, status, description, docs, projectId } = req.body;
    if (status !== undefined && !REQUIREMENT_STATUSES.includes(status)) {
      return res.status(400).json({ success: false, error: `status must be one of: ${REQUIREMENT_STATUSES.join(', ')}` });
    }
    if (title !== undefined && (typeof title !== 'string' || !title.trim())) {
      return res.status(400).json({ success: false, error: 'title must be a non-empty string' });
    }
    if (docs !== undefined && (!Array.isArray(docs) || docs.some(d => typeof d !== 'string'))) {
      return res.status(400).json({ success: false, error: 'docs must be an array of strings' });
    }
    // B3a: projectId 挂接/清除 PMO 项目（string | null；项目不存在 → 400）
    if (projectId !== undefined && projectId !== null && typeof projectId !== 'string') {
      return res.status(400).json({ success: false, error: 'projectId must be a string or null' });
    }
    try {
      const data = await service.update(req.params.id, {
        title: typeof title === 'string' ? title.trim() : undefined,
        status,
        description,
        docs,
        projectId: projectId === undefined ? undefined : projectId,
      });
      res.json({ success: true, data });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('Project not found')) {
        return res.status(400).json({ success: false, error: msg });
      }
      if (msg.includes('not found')) {
        return res.status(404).json({ success: false, error: msg });
      }
      throw e;
    }
  });

  /** GET /:id/chain — 全链路数据（需求 + WorkUnit id/title/status/assignee） */
  router.get('/:id/chain', async (req: Request, res: Response) => {
    const chain = await service.getChain(req.params.id);
    if (!chain) return res.status(404).json({ success: false, error: `Requirement not found: ${req.params.id}` });
    res.json({ success: true, data: chain });
  });

  return router;
}

export default createRequirementRoutes();
