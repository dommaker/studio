// Evolution proposal review API — #623 断点 3 遗留补丁（review-proposal 正本 kind='evolution'）
// evolution_proposal 卡 approve → POST /review-proposals/evolution/:id/approve
//   （EvolutionService.decide → applier 生效：retire/disable 落 config.yml 等）
//                    reject  → POST /review-proposals/evolution/:id/reject（零副作用）
// 刷新后已审态派生     → GET  /review-proposals/evolution/:id/status
// 状态读侧归一（api 侧 review-adapter）：applied→executed，approved→pending（APPLY_FAILED 可重试）
import { api } from './index';
import type { ReviewProposalStatus } from './distill';

export interface EvolutionApproveResponse {
  success: boolean;
  proposalId?: string;
  appliedAt?: string | null;
  error?: string;
}

export const evolutionApi = {
  approve: (proposalId: string) =>
    api.post<EvolutionApproveResponse>(`/review-proposals/evolution/${encodeURIComponent(proposalId)}/approve`),
  reject: (proposalId: string) =>
    api.post(`/review-proposals/evolution/${encodeURIComponent(proposalId)}/reject`),
  proposalStatus: (proposalId: string) =>
    api.get<{ success: boolean; status: ReviewProposalStatus }>(
      `/review-proposals/evolution/${encodeURIComponent(proposalId)}/status`,
    ),
};
