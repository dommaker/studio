// Distill review API — #351 人审提案卡通用端点（review-proposal 正本）
// distill_proposal 卡 approve → POST /review-proposals/distill/:id/approve（执行蒸馏运行，含预算守卫）
//                    reject  → POST /review-proposals/distill/:id/reject（零副作用）
// gc_proposal 卡       approve → POST /review-proposals/gc/:id/approve（候选条目归档，可恢复）
//                      reject  → POST /review-proposals/gc/:id/reject（零副作用，人判保留不再提案）
// 刷新后已审态派生     → GET  /review-proposals/:kind/:id/status（按提案状态）
//
// 契约驱动迁移（2026-10 批次 4/7）：ReviewProposalStatus/approve 响应类型改 contract
// import；status 响应 `{ data: { status } }`（success 标志退役）、approve 响应进
// `{ data }` 壳——解包 res.data → res.data.data。
import type {
  ReviewProposalStatusValue,
  ReviewProposalApproveResult,
  ReviewProposalStatusResult,
} from '@dommaker/studio-contract';
import { api } from './index';

/** 提案状态（与 API review-proposal 状态词表对齐；unknown = 查无此提案；stale = evolution 超期未审） */
export type ReviewProposalStatus = ReviewProposalStatusValue;

// #351 状态词表唯一口径（distill 超集）：三类提案同一词表
export type DistillProposalStatus = ReviewProposalStatus;
export type GcProposalStatus = ReviewProposalStatus;

/** approve 响应 data（adapter data 透传：productIds；预算熔断 skipped） */
export type DistillApproveResponse = ReviewProposalApproveResult & {
  productIds?: string[];
  /** 预算熔断：提案保持 pending，可次日重试 */
  skipped?: 'budget-exhausted';
};

/** 按 id 逐个查通用端点并合并成 statuses map（通用端点为单 id 形态，见 ADR 决策 4） */
async function fetchStatuses(kind: string, ids: string[]) {
  const responses = await Promise.all(ids.map(id =>
    api.get<{ data: ReviewProposalStatusResult }>(`/review-proposals/${kind}/${encodeURIComponent(id)}/status`),
  ));
  const statuses: Record<string, ReviewProposalStatus> = {};
  ids.forEach((id, i) => { statuses[id] = responses[i].data.data.status; });
  return { data: { success: true, statuses } };
}

export const distillApi = {
  approve: (proposalId: string) =>
    api.post<{ data: DistillApproveResponse }>(`/review-proposals/distill/${encodeURIComponent(proposalId)}/approve`),
  reject: (proposalId: string) =>
    api.post(`/review-proposals/distill/${encodeURIComponent(proposalId)}/reject`),
  proposalStatus: (proposalIds: string[]) =>
    fetchStatuses('distill', proposalIds),
  // #144 GC 候选清单
  gcApprove: (gcProposalId: string) =>
    api.post<{ data: ReviewProposalApproveResult & { archivedIds?: string[] } }>(
      `/review-proposals/gc/${encodeURIComponent(gcProposalId)}/approve`,
    ),
  gcReject: (gcProposalId: string) =>
    api.post(`/review-proposals/gc/${encodeURIComponent(gcProposalId)}/reject`),
  gcProposalStatus: (gcProposalIds: string[]) =>
    fetchStatuses('gc', gcProposalIds),
};
