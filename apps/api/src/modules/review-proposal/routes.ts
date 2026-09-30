/**
 * review-proposal/routes (#351) — 人审提案卡通用端点（ADR 决策 4）
 *
 *   POST /api/v1/review-proposals/:kind/:id/approve → adapter.onApprove（审批后动作）
 *   POST /api/v1/review-proposals/:kind/:id/reject  → 落 rejected 墓碑 + adapter.onReject
 *   GET  /api/v1/review-proposals/:kind/:id/status  → 提案状态（卡片刷新派生已审态，只读）
 *
 * kind 走注册表分发（未知 kind → 404）；各域不再保留专有审批端点
 * （专有语义在 adapter 配置里表达）。
 *
 * 契约驱动迁移（2026-10 批次 4/7）：全端点走 core/http.ts defineRoute——
 * 响应统一 `{ data }` 壳（approve executed `{ success:true, ...adapterData }` /
 * skipped 200 `{ success:false, skipped }` / reject `{ success:true }` 原平铺进壳；
 * status 的 success 标志退役 → `{ data: { status } }`）；错误统一
 * `{ error: { code, message } }`（原 `{ error: string }`，unknown-kind 404 /
 * not-found/not-pending 400 / failed/aborted 500 状态码不变，message 保留原机器串）。
 */
import { Router } from 'express';
import { reviewProposalParamsSchema, ERROR_CODES } from '@dommaker/studio-contract';
import { requireAuth, requireNotGuest } from '../../middleware/auth.js';
import { approveProposal, rejectProposal, getProposalStatus } from './service.js';
import { defineRoute, HttpError } from '../../core/http.js';

const router = Router();

router.post('/:kind/:id/approve', requireAuth(), requireNotGuest(), defineRoute(
  { params: reviewProposalParamsSchema },
  async (_req, _res, { params }) => {
    const result = await approveProposal(params.kind, params.id);
    if (result.kind === 'executed') return { success: true, ...result.data };
    // 预算熔断不是错误：提案保持 pending，人可次日重试
    if (result.kind === 'skipped') return { success: false, skipped: result.skipped };
    if (result.kind === 'invalid') {
      if (result.error.startsWith('unknown-kind')) {
        throw new HttpError(404, ERROR_CODES.NOT_FOUND, result.error);
      }
      throw new HttpError(400, ERROR_CODES.BAD_REQUEST, result.error);
    }
    // failed（执行失败，已落墓碑）与 aborted（前置条件不可用，不落墓碑可重试）均 500
    throw new HttpError(500, ERROR_CODES.INTERNAL, result.error);
  },
));

router.post('/:kind/:id/reject', requireAuth(), requireNotGuest(), defineRoute(
  { params: reviewProposalParamsSchema },
  async (_req, _res, { params }) => {
    const result = await rejectProposal(params.kind, params.id);
    if (result.ok) return { success: true };
    if (result.error?.startsWith('unknown-kind')) {
      throw new HttpError(404, ERROR_CODES.NOT_FOUND, result.error);
    }
    throw new HttpError(400, ERROR_CODES.BAD_REQUEST, result.error ?? 'reject failed');
  },
));

/** GET /:kind/:id/status → { data: { status } }（unknown = 查无此提案）；只读不要求 requireNotGuest */
router.get('/:kind/:id/status', requireAuth(), defineRoute(
  { params: reviewProposalParamsSchema },
  async (_req, _res, { params }) => {
    const result = await getProposalStatus(params.kind, params.id);
    if (!result.ok) throw new HttpError(404, ERROR_CODES.NOT_FOUND, result.error ?? 'unknown-kind');
    return { status: result.status };
  },
));

export default router;
