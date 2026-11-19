// proposalCardConfigs 共享层：ProposalCardConfig 类型 + 跨域复用的配置助手
// （拆分来源：components/channel/proposalCardConfigs.tsx；按提案域拆分后各域文件从这里取公共件）
import type { ReactNode } from 'react';

/** 卡片已审终态词（distill 家族 = 提案状态 executed/rejected/failed；memory/knowledge = approved/rejected） */
export type ProposalReviewState = 'approved' | 'rejected' | 'executed' | 'failed';

export interface ProposalCardConfig {
  /** 消息 meta.cardType（渲染分发键） */
  cardType: string;
  /** review-proposal 注册表 kind（8 类已全部接通通用端点） */
  kind: string;
  approveAction: string;
  rejectAction: string;
  /** approve 成功后落入的已审终态词（reject 恒为 'rejected'） */
  approvedState: ProposalReviewState;
  /** 审批副作用（dispatch 参数化调用）：false = 保持待审且不 refresh；异常由调用方归一为 false */
  exec: (cardData: Record<string, unknown> | null, decision: 'approve' | 'reject') => Promise<boolean>;
  /** 挂载期派生已审态（打开时查一次，不实时推送——ADR 决策 6）：null = 保持待审；抛错由 hook 静默 */
  fetchReviewed?: (cardData: Record<string, unknown> | null) => Promise<ProposalReviewState | null>;
  /** meta.status 直读已审态（memory/knowledge 现有行为） */
  initialReviewed?: (metaStatus: unknown) => ProposalReviewState | null;
  /** 终态墓碑卡头 */
  reviewedTitle: string;
  reviewLabels: Partial<Record<ProposalReviewState, { text: string; cls: string }>>;
  pendingTitle: string;
  countText: (cardData: Record<string, unknown> | undefined) => string;
  approveLabel: string;
  rejectLabel: string;
  /** 条目清单 + 说明文案（卡间唯一真正的 diff） */
  renderContent: (cardData: Record<string, unknown> | undefined) => ReactNode;
}

/** distill 家族审批副作用：按提案 id 走通用端点；approve success=false（预算熔断/执行失败）→ 保持待审。
 *  契约驱动迁移（批次 4/7）：approve 响应进 `{ data }` 壳——axios res.data 为壳体，再解一层取 data */
export function proposalExec(
  idKey: string,
  approve: (id: string) => Promise<{ data: { data: { success?: boolean } } }>,
  reject: (id: string) => Promise<unknown>,
): ProposalCardConfig['exec'] {
  return async (cardData, decision) => {
    const id = typeof cardData?.[idKey] === 'string' ? (cardData[idKey] as string) : '';
    if (!id) return false;
    if (decision === 'approve') {
      const { data } = await approve(id);
      if (!data?.data?.success) return false;
    } else {
      await reject(id);
    }
    return true;
  };
}

/** distill 家族已审态派生：statuses?.[id] 命中终态词表 → reviewed，否则保持待审 */
export function proposalFetchReviewed(
  idKey: string,
  statusApi: (ids: string[]) => Promise<{ data: { statuses?: Record<string, string> } }>,
  terminalStates: ProposalReviewState[],
): ProposalCardConfig['fetchReviewed'] {
  return async cardData => {
    const id = typeof cardData?.[idKey] === 'string' ? (cardData[idKey] as string) : '';
    if (!id) return null;
    const { data } = await statusApi([id]);
    const status = data?.statuses?.[id];
    return (terminalStates as string[]).includes(status ?? '') ? (status as ProposalReviewState) : null;
  };
}

/** 条目样式行（5 卡共用的清单行骨架：底部分隔线 + 上下呼吸，#431 内联→类） */
export const entryRowCls = 'mb-1.5 border-b u-border pb-1.5';

/** meta.status 直读（memory/knowledge 共有行为） */
export const metaStatusReviewed: ProposalCardConfig['initialReviewed'] = s =>
  s === 'approved' || s === 'rejected' ? s : null;
