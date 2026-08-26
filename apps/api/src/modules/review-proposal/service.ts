/**
 * review-proposal/service (#351) — 人审提案卡生命周期（唯一正本）
 *
 * 收进正本的四件事（ADR 决策 1）：
 *   - submit：建提案（append-only）→ 发卡 → 发卡失败落 card-failed 墓碑（终态不阻塞后续提案）
 *   - approve：not-found / not-pending 闸 → adapter.onApprove → 按 outcome 落 executed/failed 墓碑
 *     （skipped = 熔断口径：不落墓碑，提案保持 pending 可重试）
 *   - reject：落 rejected 墓碑 → adapter.onReject（业务零副作用语义归 adapter）
 *   - status：卡片刷新派生已审态（查无 → unknown）
 */
import { postReviewProposalCard } from './card.js';
import { getReviewProposalAdapter, type ReviewProposalAdapter } from './registry.js';
import type { ReviewProposalBase, ReviewProposalStatus } from './store.js';

/** approve 生命周期结果（路由据此映射 HTTP） */
export type ApproveLifecycleResult =
  | { kind: 'executed'; data?: Record<string, unknown> }
  | { kind: 'failed'; error: string }
  | { kind: 'skipped'; skipped: string }
  | { kind: 'aborted'; error: string }
  | { kind: 'invalid'; error: string };

/**
 * 建提案 + 发卡。发卡失败落 card-failed 墓碑（#101/#143 降级口径），返回 posted=false。
 * 去重（pending 不重复发卡）归调用方（业务触发侧）——正本只保证生命周期一致。
 */
export async function submitProposal<P extends ReviewProposalBase>(
  adapter: ReviewProposalAdapter<P>,
  proposal: P,
): Promise<{ posted: boolean }> {
  await adapter.store.appendProposal(proposal);
  const { content, cardData } = adapter.renderCardContent(proposal);
  const posted = await postReviewProposalCard(
    { cardType: adapter.cardType, content, cardData, logTag: adapter.kind, author: adapter.author },
    { fileStore: adapter.fileStore },
  );
  if (!posted) await adapter.store.appendStatus(proposal.id, 'card-failed');
  return { posted };
}

/** 人审 approve：闸口校验 → adapter.onApprove → 按 outcome 落墓碑 */
export async function approveProposal(kind: string, id: string): Promise<ApproveLifecycleResult> {
  const adapter = getReviewProposalAdapter(kind);
  if (!adapter) return { kind: 'invalid', error: `unknown-kind:${kind}` };
  const proposal = await adapter.store.getProposal(id);
  if (!proposal) return { kind: 'invalid', error: 'proposal-not-found' };
  if (proposal.status !== 'pending') return { kind: 'invalid', error: `proposal-not-pending:${proposal.status}` };

  const outcome = await adapter.onApprove(proposal);
  if (outcome.status === 'executed') {
    await adapter.store.appendStatus(id, 'executed');
    return { kind: 'executed', data: outcome.data };
  }
  if (outcome.status === 'failed') {
    await adapter.store.appendStatus(id, 'failed');
    return { kind: 'failed', error: outcome.error };
  }
  // aborted：前置条件不可用，不落墓碑（提案保持 pending，装配修复后可重试）
  if (outcome.status === 'aborted') return { kind: 'aborted', error: outcome.error };
  // skipped：熔断不落墓碑，提案保持 pending（次日可重试）
  return { kind: 'skipped', skipped: outcome.skipped };
}

/** 人审 reject：落 rejected 墓碑 → adapter.onReject（可选） */
export async function rejectProposal(
  kind: string,
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  const adapter = getReviewProposalAdapter(kind);
  if (!adapter) return { ok: false, error: `unknown-kind:${kind}` };
  const proposal = await adapter.store.getProposal(id);
  if (!proposal) return { ok: false, error: 'proposal-not-found' };
  if (proposal.status !== 'pending') return { ok: false, error: `proposal-not-pending:${proposal.status}` };

  await adapter.store.appendStatus(id, 'rejected');
  await adapter.onReject?.(proposal);
  return { ok: true };
}

/** 卡片刷新派生已审态（只读）：查无提案 → unknown */
export async function getProposalStatus(
  kind: string,
  id: string,
): Promise<{ ok: boolean; status?: ReviewProposalStatus | 'unknown'; error?: string }> {
  const adapter = getReviewProposalAdapter(kind);
  if (!adapter) return { ok: false, error: `unknown-kind:${kind}` };
  const proposal = await adapter.store.getProposal(id);
  return { ok: true, status: proposal?.status ?? 'unknown' };
}
