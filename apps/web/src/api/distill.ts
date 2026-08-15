// Distill review API — #143 蒸馏提案人审闸口
// distill_proposal 卡 approve → POST /distill/approve（执行蒸馏运行，含预算守卫）
//                    reject  → POST /distill/reject（零副作用）
// 刷新后已审态派生   → GET  /distill/proposal-status（按提案状态）
// #144 GC 候选清单人审闸口
// gc_proposal 卡 approve → POST /distill/gc/approve（候选条目归档，可恢复）
//                reject  → POST /distill/gc/reject（零副作用，人判保留不再提案）
// 刷新后已审态派生 → GET  /distill/gc/proposal-status
import { api } from './index';

/** 提案状态（与 API DistillProposalStatus 对齐；unknown = 查无此提案） */
export type DistillProposalStatus = 'pending' | 'executed' | 'rejected' | 'failed' | 'card-failed' | 'unknown';

/** GC 提案状态（与 API GcProposalStatus 对齐；unknown = 查无此提案） */
export type GcProposalStatus = 'pending' | 'executed' | 'rejected' | 'card-failed' | 'unknown';

/** 审计提案状态（与 API ConstraintAuditStatus 对齐；unknown = 查无此提案） */
export type AuditProposalStatus = 'pending' | 'executed' | 'rejected' | 'card-failed' | 'unknown';

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
  // #144 GC 候选清单
  gcApprove: (gcProposalId: string) =>
    api.post<{ success: boolean; archivedIds?: string[]; error?: string }>('/distill/gc/approve', { gcProposalId }),
  gcReject: (gcProposalId: string) =>
    api.post('/distill/gc/reject', { gcProposalId }),
  gcProposalStatus: (gcProposalIds: string[]) =>
    api.get<{ success: boolean; statuses: Record<string, GcProposalStatus> }>(
      `/distill/gc/proposal-status?ids=${gcProposalIds.map(encodeURIComponent).join(',')}`,
    ),
  // #146 存量约束审计
  auditApprove: (auditProposalId: string) =>
    api.post<{ success: boolean; retiredIds?: string[]; error?: string }>('/distill/audit/approve', { auditProposalId }),
  auditReject: (auditProposalId: string) =>
    api.post('/distill/audit/reject', { auditProposalId }),
  auditProposalStatus: (auditProposalIds: string[]) =>
    api.get<{ success: boolean; statuses: Record<string, AuditProposalStatus> }>(
      `/distill/audit/proposal-status?ids=${auditProposalIds.map(encodeURIComponent).join(',')}`,
    ),
};
