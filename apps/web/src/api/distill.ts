// Distill review API — #143 蒸馏提案人审闸口
// distill_proposal 卡 approve → POST /distill/approve（执行蒸馏运行，含预算守卫）
//                    reject  → POST /distill/reject（零副作用）
// 刷新后已审态派生   → GET  /distill/proposal-status（按提案状态）
import { api } from './index';

/** 提案状态（与 API DistillProposalStatus 对齐；unknown = 查无此提案） */
export type DistillProposalStatus = 'pending' | 'executed' | 'rejected' | 'failed' | 'card-failed' | 'unknown';

export interface DistillApproveResponse {
  success: boolean;
  productIds?: string[];
  /** 预算熔断：提案保持 pending，可次日重试 */
  skipped?: 'budget-exhausted';
  error?: string;
}

export const distillApi = {
  approve: (proposalId: string) =>
    api.post<DistillApproveResponse>('/distill/approve', { proposalId }),
  reject: (proposalId: string) =>
    api.post('/distill/reject', { proposalId }),
  proposalStatus: (proposalIds: string[]) =>
    api.get<{ success: boolean; statuses: Record<string, DistillProposalStatus> }>(
      `/distill/proposal-status?ids=${proposalIds.map(encodeURIComponent).join(',')}`,
    ),
};
