// Role memory review API — #353 人审提案卡通用端点（review-proposal 正本，kind='memory'）
// memory_proposal 卡 approve → POST /review-proposals/memory/:draftId/approve（逐草稿，approve→promote）
//               reject  → POST /review-proposals/memory/:draftId/reject（逐草稿，reject→demote）
// 刷新后已审态派生   → GET  /review-proposals/memory/:draftId/status（提案状态；旧 promoted 读侧归一为 executed）
import { api } from './index';

/** 提案状态（与 API review-proposal 状态词表对齐；unknown = 查无此提案） */
export type MemoryProposalStatus = 'pending' | 'executed' | 'rejected' | 'failed' | 'card-failed' | 'unknown';

interface StatusResponse {
  success: boolean;
  status: MemoryProposalStatus;
}

/** 按 draftId 逐个查通用端点并合并成 statuses map（通用端点为单 id 形态，见 ADR 决策 4） */
async function fetchStatuses(draftIds: string[]) {
  const responses = await Promise.all(draftIds.map(id =>
    api.get<StatusResponse>(`/review-proposals/memory/${encodeURIComponent(id)}/status`),
  ));
  const statuses: Record<string, MemoryProposalStatus> = {};
  draftIds.forEach((id, i) => { statuses[id] = responses[i].data.status; });
  return { data: { success: true, statuses } };
}

export const memoryApi = {
  approve: (draftId: string) =>
    api.post<{ success: boolean; promoted?: number; topicsUpdated?: string[]; error?: string }>(
      `/review-proposals/memory/${encodeURIComponent(draftId)}/approve`,
    ),
  reject: (draftId: string) =>
    api.post(`/review-proposals/memory/${encodeURIComponent(draftId)}/reject`),
  status: (draftIds: string[]) => fetchStatuses(draftIds),
};
