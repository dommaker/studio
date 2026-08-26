// Auditor API — auditor_suggestion 提案卡审批（#356 起走 review-proposal 正本通用端点，kind='auditor'）：
//   approve → POST /review-proposals/auditor/:proposalId/approve（adapter 建未指派 task 工单，返回 workUnitId）
//   reject  → POST /review-proposals/auditor/:proposalId/reject（仅留痕）
//   刷新后已审态派生 → GET /review-proposals/auditor/:proposalId/status
// 旧专有端点 POST /channels/:id/messages/:mid/card-decision（#278）已随 #356 删除。
import { api } from './index';

/** 提案状态（与 review-proposal 正本状态词表对齐；unknown = 查无此提案） */
export type AuditorProposalStatus = 'pending' | 'executed' | 'rejected' | 'failed' | 'card-failed' | 'unknown';

export const auditorApi = {
  /** auditor_suggestion 卡审批（通用端点，proposalId 取自 cardData） */
  approveProposal: (proposalId: string) =>
    api.post<{ success: boolean; workUnitId?: string; error?: string }>(
      `/review-proposals/auditor/${encodeURIComponent(proposalId)}/approve`,
    ),
  rejectProposal: (proposalId: string) =>
    api.post(`/review-proposals/auditor/${encodeURIComponent(proposalId)}/reject`),
  proposalStatus: (proposalId: string) =>
    api.get<{ success: boolean; status: AuditorProposalStatus }>(
      `/review-proposals/auditor/${encodeURIComponent(proposalId)}/status`,
    ),
};
