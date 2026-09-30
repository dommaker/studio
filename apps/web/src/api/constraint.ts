// Constraint proposal review API — ADR-0033 块 3 子项 7/8（review-proposal 正本 kind='constraint'）
// constraint_proposal 卡 approve → POST /review-proposals/constraint/:id/approve
//   （action=new：落盘 .harness/constraints.yml + git commit 留痕；action=upgrade：pack-proposal 打包材料）
//                    reject  → POST /review-proposals/constraint/:id/reject（零副作用，不再重复提案）
// 刷新后已审态派生     → GET  /review-proposals/constraint/:id/status
//
// 契约驱动迁移（2026-10 批次 4/7）：提案状态词表/approve 响应类型改 contract import；
// status 响应 `{ data: { status } }`、approve 响应进 `{ data }` 壳。
import type {
  ReviewProposalStatusValue,
  ReviewProposalApproveResult,
  ReviewProposalStatusResult,
} from '@dommaker/studio-contract';
import { api } from './index';

/** approve 响应 data（adapter data 透传：constraintId/committed） */
export type ConstraintApproveResponse = ReviewProposalApproveResult & {
  constraintId?: string;
  committed?: boolean;
};

export const constraintApi = {
  approve: (proposalId: string) =>
    api.post<{ data: ConstraintApproveResponse }>(`/review-proposals/constraint/${encodeURIComponent(proposalId)}/approve`),
  reject: (proposalId: string) =>
    api.post(`/review-proposals/constraint/${encodeURIComponent(proposalId)}/reject`),
  proposalStatus: (proposalId: string) =>
    api.get<{ data: ReviewProposalStatusResult & { status: ReviewProposalStatusValue } }>(
      `/review-proposals/constraint/${encodeURIComponent(proposalId)}/status`,
    ),
};
