// Evolution proposal review API — #623 断点 3 遗留补丁（review-proposal 正本 kind='evolution'）
// evolution_proposal 卡 approve → POST /review-proposals/evolution/:id/approve
//   （EvolutionService.decide → applier 生效：retire/disable 落 config.yml 等）
//                    reject  → POST /review-proposals/evolution/:id/reject（零副作用）
// 刷新后已审态派生     → GET  /review-proposals/evolution/:id/status
// 状态读侧归一（api 侧 review-adapter）：applied→executed，approved→pending（APPLY_FAILED 可重试）
//
// 契约驱动迁移（2026-10 批次 4/7）：本批收口——提案状态词表/approve 响应类型改
// contract import；status 响应 `{ data: { status } }`、approve 响应进 `{ data }` 壳。
import type {
  ReviewProposalStatusValue,
  ReviewProposalApproveResult,
  ReviewProposalStatusResult,
} from '@dommaker/studio-contract';
import { api } from './index';

/** approve 响应 data（adapter data 透传：proposalId/appliedAt） */
export type EvolutionApproveResponse = ReviewProposalApproveResult & {
  proposalId?: string;
  appliedAt?: string | null;
};

export const evolutionApi = {
  approve: (proposalId: string) =>
    api.post<{ data: EvolutionApproveResponse }>(`/review-proposals/evolution/${encodeURIComponent(proposalId)}/approve`),
  reject: (proposalId: string) =>
    api.post(`/review-proposals/evolution/${encodeURIComponent(proposalId)}/reject`),
  proposalStatus: (proposalId: string) =>
    api.get<{ data: ReviewProposalStatusResult & { status: ReviewProposalStatusValue } }>(
      `/review-proposals/evolution/${encodeURIComponent(proposalId)}/status`,
    ),
};
