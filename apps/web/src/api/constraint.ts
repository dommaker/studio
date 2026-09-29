// Constraint proposal review API — ADR-0033 块 3 子项 7/8（review-proposal 正本 kind='constraint'）
// constraint_proposal 卡 approve → POST /review-proposals/constraint/:id/approve
//   （action=new：落盘 .harness/constraints.yml + git commit 留痕；action=upgrade：pack-proposal 打包材料）
//                    reject  → POST /review-proposals/constraint/:id/reject（零副作用，不再重复提案）
// 刷新后已审态派生     → GET  /review-proposals/constraint/:id/status
import { api } from './index';
import type { ReviewProposalStatus } from './distill';

export interface ConstraintApproveResponse {
  success: boolean;
  constraintId?: string;
  committed?: boolean;
  error?: string;
}

export const constraintApi = {
  approve: (proposalId: string) =>
    api.post<ConstraintApproveResponse>(`/review-proposals/constraint/${encodeURIComponent(proposalId)}/approve`),
  reject: (proposalId: string) =>
    api.post(`/review-proposals/constraint/${encodeURIComponent(proposalId)}/reject`),
  proposalStatus: (proposalId: string) =>
    api.get<{ success: boolean; status: ReviewProposalStatus }>(
      `/review-proposals/constraint/${encodeURIComponent(proposalId)}/status`,
    ),
};
