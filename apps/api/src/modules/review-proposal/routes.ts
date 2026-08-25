/**
 * review-proposal/routes (#351) — 人审提案卡通用端点（ADR 决策 4）
 *
 *   POST /api/v1/review-proposals/:kind/:id/approve → adapter.onApprove（审批后动作）
 *   POST /api/v1/review-proposals/:kind/:id/reject  → 落 rejected 墓碑 + adapter.onReject
 *   GET  /api/v1/review-proposals/:kind/:id/status  → 提案状态（卡片刷新派生已审态，只读）
 *
 * kind 走注册表分发（未知 kind → 404）；各域不再保留专有审批端点
 * （专有语义在 adapter 配置里表达）。响应形状沿用 distill 旧端点口径：
 * approve 成功 { success:true, ...data }；skipped（预算熔断）200 { success:false, skipped }；
 * 执行失败 500；not-found / not-pending 400。
 */
import { Router } from 'express';
import { requireAuth, requireNotGuest } from '../../middleware/auth.js';
import { approveProposal, rejectProposal, getProposalStatus } from './service.js';

const router = Router();

router.post('/:kind/:id/approve', requireAuth(), requireNotGuest(), async (req, res) => {
  try {
    const result = await approveProposal(req.params.kind, req.params.id);
    if (result.kind === 'executed') return res.json({ success: true, ...result.data });
    // 预算熔断不是错误：提案保持 pending，人可次日重试
    if (result.kind === 'skipped') return res.json({ success: false, skipped: result.skipped });
    if (result.kind === 'invalid') {
      if (result.error.startsWith('unknown-kind')) return res.status(404).json({ error: result.error });
      return res.status(400).json({ error: result.error });
    }
    // failed（执行失败，已落墓碑）与 aborted（前置条件不可用，不落墓碑可重试）均 500
    return res.status(500).json({ error: result.error });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

router.post('/:kind/:id/reject', requireAuth(), requireNotGuest(), async (req, res) => {
  try {
    const result = await rejectProposal(req.params.kind, req.params.id);
    if (result.ok) return res.json({ success: true });
    if (result.error?.startsWith('unknown-kind')) return res.status(404).json({ error: result.error });
    return res.status(400).json({ error: result.error });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/** GET /:kind/:id/status → { success:true, status }（unknown = 查无此提案）；只读不要求 requireNotGuest */
router.get('/:kind/:id/status', requireAuth(), async (req, res) => {
  try {
    const result = await getProposalStatus(req.params.kind, req.params.id);
    if (!result.ok) return res.status(404).json({ error: result.error });
    res.json({ success: true, status: result.status });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

export default router;
