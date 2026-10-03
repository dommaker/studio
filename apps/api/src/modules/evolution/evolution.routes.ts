/**
 * E1 约束进化 API（vision §6）。
 *
 *   GET  /api/v1/evolution/proposals?status=&targetType=   提案列表
 *   GET  /api/v1/evolution/proposals/:id                   单个提案
 *   POST /api/v1/evolution/proposals/:id/approve           批准并生效（body: { reason?, decidedBy? }）
 *   POST /api/v1/evolution/proposals/:id/reject            拒绝（body: { reason? }）
 *   POST /api/v1/evolution/run                             手动触发一轮提案生成
 *
 * 决策路径与提案卡审批（/review-proposals/evolution/:id/*）共用 EvolutionService.decide —— 同一幂等语义。
 *
 * 契约驱动迁移（2026-10 批次 3/7）：defineRoute 化 + 统一 envelope——
 * `{ success: true, data }` 壳的 success 标志退役（`{ data }`）；`{ success: false,
 * error: string }` 统一为 `{ error: { code, message } }`（EvolutionError code
 * NOT_FOUND→404 / CONFLICT→409 / APPLY_FAILED→500 保持，code 即 envelope code）。
 */
import { Router, type Request } from 'express';
import {
  listEvolutionProposalsQuerySchema,
  evolutionProposalIdParamsSchema,
  decideEvolutionBodySchema,
} from '@dommaker/studio-contract';
import { EvolutionError, EvolutionService, getEvolutionService } from './evolution.service.js';
import { defineRoute, HttpError } from '../../core/http.js';

/** EvolutionError → HttpError（code 即标准错误码词表中的 NOT_FOUND/CONFLICT；APPLY_FAILED→500） */
function toHttpError(err: unknown): never {
  if (err instanceof EvolutionError) {
    const status = err.code === 'NOT_FOUND' ? 404 : err.code === 'CONFLICT' ? 409 : 500;
    throw new HttpError(status, err.code, err.message);
  }
  throw err;
}

export function createEvolutionRoutes(service?: EvolutionService): Router {
  const router = Router();
  const svc = (): EvolutionService => service ?? getEvolutionService();

  router.get('/proposals', defineRoute({ query: listEvolutionProposalsQuerySchema }, async (_req, _res, { query }) => {
    const { status, targetType } = query;
    return svc().list({
      ...(status ? { status } : {}),
      ...(targetType ? { targetType } : {}),
    });
  }));

  router.get('/proposals/:id', defineRoute({ params: evolutionProposalIdParamsSchema }, async (_req, _res, { params }) => {
    const data = await svc().get(params.id);
    if (!data) throw new HttpError(404, 'NOT_FOUND', `Evolution proposal not found: ${params.id}`);
    return data;
  }));

  router.post('/proposals/:id/approve', defineRoute(
    { params: evolutionProposalIdParamsSchema, body: decideEvolutionBodySchema },
    async (req, _res, { params, body }) => {
      try {
        const decidedBy = body.decidedBy
          ? body.decidedBy
          : `api:${(req as Request & { user?: { name?: string } }).user?.name ?? 'local'}`;
        return await svc().decide(params.id, 'approve', {
          decidedBy,
          reason: body.reason,
        });
      } catch (err) {
        toHttpError(err);
      }
    },
  ));

  router.post('/proposals/:id/reject', defineRoute(
    { params: evolutionProposalIdParamsSchema, body: decideEvolutionBodySchema },
    async (req, _res, { params, body }) => {
      try {
        return await svc().decide(params.id, 'reject', {
          decidedBy: `api:${(req as Request & { user?: { name?: string } }).user?.name ?? 'local'}`,
          reason: body.reason,
        });
      } catch (err) {
        toHttpError(err);
      }
    },
  ));

  router.post('/run', defineRoute({}, async () => {
    return svc().runScan();
  }));

  return router;
}

export default createEvolutionRoutes();
