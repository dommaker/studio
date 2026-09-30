// Role memory review API — #353 人审提案卡通用端点（review-proposal 正本，kind='memory'）
// memory_proposal 卡 approve → POST /review-proposals/memory/:draftId/approve（逐草稿，approve→promote）
//               reject  → POST /review-proposals/memory/:draftId/reject（逐草稿，reject→demote）
// 刷新后已审态派生   → GET  /review-proposals/memory/:draftId/status（提案状态；旧 promoted 读侧归一为 executed）
//
// 契约驱动迁移（2026-10 批次 4/7）：提案状态词表/approve 响应类型改 contract import；
// status 响应 `{ data: { status } }`、approve 响应进 `{ data }` 壳——解包 res.data →
// res.data.data。
import type {
  ReviewProposalStatusValue,
  ReviewProposalApproveResult,
  ReviewProposalStatusResult,
} from '@dommaker/studio-contract';
import { api } from './index';

/** 提案状态（与 API review-proposal 状态词表对齐；unknown = 查无此提案） */
export type MemoryProposalStatus = ReviewProposalStatusValue;

/** 按 draftId 逐个查通用端点并合并成 statuses map（通用端点为单 id 形态，见 ADR 决策 4） */
async function fetchStatuses(draftIds: string[]) {
  const responses = await Promise.all(draftIds.map(id =>
    api.get<{ data: ReviewProposalStatusResult }>(`/review-proposals/memory/${encodeURIComponent(id)}/status`),
  ));
  const statuses: Record<string, MemoryProposalStatus> = {};
  draftIds.forEach((id, i) => { statuses[id] = responses[i].data.data.status; });
  return { data: { success: true, statuses } };
}

export const memoryApi = {
  approve: (draftId: string) =>
    api.post<{ data: ReviewProposalApproveResult & { promoted?: number; topicsUpdated?: string[] } }>(
      `/review-proposals/memory/${encodeURIComponent(draftId)}/approve`,
    ),
  reject: (draftId: string) =>
    api.post(`/review-proposals/memory/${encodeURIComponent(draftId)}/reject`),
  status: (draftIds: string[]) => fetchStatuses(draftIds),
};
