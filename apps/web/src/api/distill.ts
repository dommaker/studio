// Distill review API — #351 人审提案卡通用端点（review-proposal 正本）
// distill_proposal 卡 approve → POST /review-proposals/distill/:id/approve（执行蒸馏运行，含预算守卫）
//                    reject  → POST /review-proposals/distill/:id/reject（零副作用）
// gc_proposal 卡       approve → POST /review-proposals/gc/:id/approve（候选条目归档，可恢复）
//                      reject  → POST /review-proposals/gc/:id/reject（零副作用，人判保留不再提案）
// constraint_audit 卡  approve → POST /review-proposals/audit/:id/approve（retire 执行，可回滚）
//                      reject  → POST /review-proposals/audit/:id/reject
// 刷新后已审态派生     → GET  /review-proposals/:kind/:id/status（按提案状态）
import { api } from './index';

/** 提案状态（与 API review-proposal 状态词表对齐；unknown = 查无此提案） */
export type ReviewProposalStatus = 'pending' | 'executed' | 'rejected' | 'failed' | 'card-failed' | 'unknown';

// #351 状态词表唯一口径（distill 超集）：三类提案同一词表
export type DistillProposalStatus = ReviewProposalStatus;
export type GcProposalStatus = ReviewProposalStatus;
export type AuditProposalStatus = ReviewProposalStatus;

export interface DistillApproveResponse {
  success: boolean;
  productIds?: string[];
  /** 预算熔断：提案保持 pending，可次日重试 */
  skipped?: 'budget-exhausted';
  error?: string;
}

interface StatusResponse {
  success: boolean;
  status: ReviewProposalStatus;
}

/** 按 id 逐个查通用端点并合并成 statuses map（通用端点为单 id 形态，见 ADR 决策 4） */
async function fetchStatuses<S extends ReviewProposalStatus>(kind: string, ids: string[]) {
  const responses = await Promise.all(ids.map(id =>
    api.get<StatusResponse>(`/review-proposals/${kind}/${encodeURIComponent(id)}/status`),
  ));
  const statuses: Record<string, S> = {};
  ids.forEach((id, i) => { statuses[id] = responses[i].data.status as S; });
  return { data: { success: true, statuses } };
}

export const distillApi = {
  approve: (proposalId: string) =>
    api.post<DistillApproveResponse>(`/review-proposals/distill/${encodeURIComponent(proposalId)}/approve`),
  reject: (proposalId: string) =>
    api.post(`/review-proposals/distill/${encodeURIComponent(proposalId)}/reject`),
  proposalStatus: (proposalIds: string[]) =>
    fetchStatuses<DistillProposalStatus>('distill', proposalIds),
  // #144 GC 候选清单
  gcApprove: (gcProposalId: string) =>
    api.post<{ success: boolean; archivedIds?: string[]; error?: string }>(
      `/review-proposals/gc/${encodeURIComponent(gcProposalId)}/approve`,
    ),
  gcReject: (gcProposalId: string) =>
    api.post(`/review-proposals/gc/${encodeURIComponent(gcProposalId)}/reject`),
  gcProposalStatus: (gcProposalIds: string[]) =>
    fetchStatuses<GcProposalStatus>('gc', gcProposalIds),
  // #146 存量约束审计
  auditApprove: (auditProposalId: string) =>
    api.post<{ success: boolean; retiredIds?: string[]; error?: string }>(
      `/review-proposals/audit/${encodeURIComponent(auditProposalId)}/approve`,
    ),
  auditReject: (auditProposalId: string) =>
    api.post(`/review-proposals/audit/${encodeURIComponent(auditProposalId)}/reject`),
  auditProposalStatus: (auditProposalIds: string[]) =>
    fetchStatuses<AuditProposalStatus>('audit', auditProposalIds),
};
