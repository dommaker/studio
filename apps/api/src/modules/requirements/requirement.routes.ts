/**
 * Requirement API 路由 — REQ 需求编号体系（vision §5.3）
 *
 * Endpoints:
 *   GET   /api/v1/requirements           — list（status/channelId 过滤）
 *   GET   /api/v1/requirements/chain-stats — 批量徽章统计（#387：每需求 {finished,total}，PMO 卡片用）
 *   POST  /api/v1/requirements           — 手动创建
 *   GET   /api/v1/requirements/:id       — get by id
 *   PATCH /api/v1/requirements/:id       — 更新 status/title/docs/description
 *   GET   /api/v1/requirements/:id/chain — 全链路（需求 + WorkUnit 状态列表）
 *
 * 契约驱动迁移（2026-09 批次 1/7）：全部端点走 core/http.ts defineRoute——
 * zod 校验入参（手写 guard 收进 schema）、统一 envelope（{ data }）、
 * 错误映射 options.errors（'Project not found' → 400 先于 'not found' → 404）。
 */
import { Router } from 'express';
import {
  listRequirementsQuerySchema,
  chainStatsQuerySchema,
  requirementIdParamsSchema,
  createRequirementBodySchema,
  updateRequirementBodySchema,
  ERROR_CODES,
} from '@dommaker/studio-contract';
import { FileStore } from '@dommaker/studio-shared';
import { RequirementService } from './requirement.service.js';
import { requireAuth, requireNotGuest } from '../../middleware/auth.js';
import { defineRoute, HttpError } from '../../core/http.js';

export function createRequirementRoutes(fileStore?: FileStore): Router {
  const router = Router();
  const service = new RequirementService(fileStore);
  // #387: 单次批量 id 上限（PMO 单页 ≤ 20 项目，留余量；超出静默截断）
  const MAX_BATCH_IDS = 100;

  /** GET / — list requirements（status/channelId 过滤；status 非法值 zod 400） */
  router.get('/', defineRoute({ query: listRequirementsQuerySchema }, async (_req, _res, { query }) => {
    return service.list({ status: query.status, channelId: query.channelId });
  }));

  /** POST / — 手动创建需求（B3a: projectId 挂接 PMO 项目，不存在 → 400） */
  router.post('/', requireAuth(), requireNotGuest(), defineRoute(
    { body: createRequirementBodySchema },
    {
      status: 201,
      errors: [{ match: 'Project not found', status: 400, code: ERROR_CODES.BAD_REQUEST }],
    },
    async (_req, _res, { body }) => {
      return service.create({
        title: body.title,
        channelId: body.channelId ?? null,
        description: body.description,
        createdBy: body.createdBy ?? 'manual',
        docs: body.docs,
        projectId: body.projectId,
      });
    },
  ));

  /**
   * GET /chain-stats?reqIds=REQ-1,REQ-2 — #387 批量徽章统计：每需求 {finished,total}
   * （finished = workFinished 口径，服务端同源计算）。PMO 卡片专用，消逐项目
   * getChain 的 N+1；不存在的需求不出现在结果里（前端徽章静默缺省）。
   */
  router.get('/chain-stats', defineRoute({ query: chainStatsQuerySchema }, async (_req, _res, { query }) => {
    const ids = query.reqIds.split(',').map(s => s.trim()).filter(s => s.length > 0);
    return service.getChainStats(ids.slice(0, MAX_BATCH_IDS));
  }));

  /** GET /:id — get requirement by id */
  router.get('/:id', defineRoute({ params: requirementIdParamsSchema }, async (_req, _res, { params }) => {
    const data = await service.get(params.id);
    if (!data) throw new HttpError(404, ERROR_CODES.NOT_FOUND, `Requirement not found: ${params.id}`);
    return data;
  }));

  /** PATCH /:id — 更新 status/title/docs/description/projectId */
  router.patch('/:id', requireAuth(), requireNotGuest(), defineRoute(
    { params: requirementIdParamsSchema, body: updateRequirementBodySchema },
    {
      errors: [
        // 顺序敏感：'Project not found' 含 'not found'，须先命中 400
        { match: 'Project not found', status: 400, code: ERROR_CODES.BAD_REQUEST },
        { match: 'not found', status: 404, code: ERROR_CODES.NOT_FOUND },
      ],
    },
    async (_req, _res, { params, body }) => {
      return service.update(params.id, {
        title: body.title,
        status: body.status,
        description: body.description,
        docs: body.docs,
        projectId: body.projectId,
      });
    },
  ));

  /** GET /:id/chain — 全链路数据（需求 + WorkUnit id/title/status/assignee） */
  router.get('/:id/chain', defineRoute({ params: requirementIdParamsSchema }, async (_req, _res, { params }) => {
    const chain = await service.getChain(params.id);
    if (!chain) throw new HttpError(404, ERROR_CODES.NOT_FOUND, `Requirement not found: ${params.id}`);
    return chain;
  }));

  return router;
}

export default createRequirementRoutes();
