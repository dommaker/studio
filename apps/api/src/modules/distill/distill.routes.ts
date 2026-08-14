/**
 * distill.routes (#143/#144) — 蒸馏提案与 GC 候选清单人审闸口 approve/reject 端点。
 *
 * distill_proposal 卡片在 #系统 频道点击「确认蒸馏 / 拒绝」→ 前端调本端点：
 *   POST /approve { proposalId } → DistillService.approve（预算守卫 + 执行蒸馏运行）
 *   POST /reject  { proposalId } → DistillService.reject（零副作用）
 *   GET  /proposal-status?ids=a,b,c → 各提案状态（卡片刷新后派生已审态用，只读）
 * gc_proposal 卡片（#144 GC 候选清单）：
 *   POST /gc/approve { gcProposalId } → DistillService.approveGc（候选条目归档，可恢复）
 *   POST /gc/reject  { gcProposalId } → DistillService.rejectGc（零副作用，人判保留不再提案）
 *   GET  /gc/proposal-status?ids=a,b,c → 各 GC 提案状态（只读）
 * 与 /role-memory/promote|demote（#101）平行，对象不同（蒸馏提案 vs 角色记忆草稿）。
 */
import { Router } from 'express';
import { requireAuth, requireNotGuest } from '../../middleware/auth.js';
import { getDistillService } from './distill-runtime.js';

const router = Router();

function parseProposalId(body: unknown): string | null {
  const id = (body as { proposalId?: unknown } | null)?.proposalId;
  return typeof id === 'string' && id.trim() ? id.trim() : null;
}

function parseGcProposalId(body: unknown): string | null {
  const id = (body as { gcProposalId?: unknown } | null)?.gcProposalId;
  return typeof id === 'string' && id.trim() ? id.trim() : null;
}

router.post('/approve', requireAuth(), requireNotGuest(), async (req, res) => {
  try {
    const proposalId = parseProposalId(req.body);
    if (!proposalId) return res.status(400).json({ error: 'proposalId required' });
    const result = await getDistillService().approve(proposalId);
    if (result.ok) return res.json({ success: true, productIds: result.productIds });
    // 预算熔断不是错误：提案保持 pending，人可次日重试
    if (result.skipped) return res.json({ success: false, skipped: result.skipped });
    if (result.error?.startsWith('proposal-not-')) return res.status(400).json({ error: result.error });
    return res.status(500).json({ error: result.error ?? 'distill run failed' });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

router.post('/reject', requireAuth(), requireNotGuest(), async (req, res) => {
  try {
    const proposalId = parseProposalId(req.body);
    if (!proposalId) return res.status(400).json({ error: 'proposalId required' });
    const result = await getDistillService().reject(proposalId);
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * GET /proposal-status?ids=a,b,c → { statuses: { [id]: pending|executed|rejected|failed|card-failed|unknown } }
 * 只读（不需要 requireNotGuest）：distill_proposal 卡片刷新/重进频道后据此派生已审态。
 */
router.get('/proposal-status', requireAuth(), async (req, res) => {
  try {
    const ids = typeof req.query.ids === 'string' ? req.query.ids.split(',').filter(s => s.length > 0) : [];
    if (ids.length === 0) return res.status(400).json({ error: 'ids must be a non-empty comma-separated list' });
    const statuses = await getDistillService().getProposalStatuses(ids);
    res.json({ success: true, statuses });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ── #144 GC 候选清单人审闸口 ──

router.post('/gc/approve', requireAuth(), requireNotGuest(), async (req, res) => {
  try {
    const gcProposalId = parseGcProposalId(req.body);
    if (!gcProposalId) return res.status(400).json({ error: 'gcProposalId required' });
    const result = await getDistillService().approveGc(gcProposalId);
    if (result.ok) return res.json({ success: true, archivedIds: result.archivedIds });
    if (result.error?.startsWith('gc-proposal-not-')) return res.status(400).json({ error: result.error });
    return res.status(500).json({ error: result.error ?? 'gc approve failed' });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

router.post('/gc/reject', requireAuth(), requireNotGuest(), async (req, res) => {
  try {
    const gcProposalId = parseGcProposalId(req.body);
    if (!gcProposalId) return res.status(400).json({ error: 'gcProposalId required' });
    const result = await getDistillService().rejectGc(gcProposalId);
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * GET /gc/proposal-status?ids=a,b,c → { statuses: { [id]: pending|executed|rejected|card-failed|unknown } }
 * 只读（不需要 requireNotGuest）：gc_proposal 卡片刷新/重进频道后据此派生已审态。
 */
router.get('/gc/proposal-status', requireAuth(), async (req, res) => {
  try {
    const ids = typeof req.query.ids === 'string' ? req.query.ids.split(',').filter(s => s.length > 0) : [];
    if (ids.length === 0) return res.status(400).json({ error: 'ids must be a non-empty comma-separated list' });
    const statuses = await getDistillService().getGcProposalStatuses(ids);
    res.json({ success: true, statuses });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

export default router;
