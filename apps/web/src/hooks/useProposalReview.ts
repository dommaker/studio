// useProposalReview — #352 人审提案卡审核生命周期单一实现（ADR 2026-08-25 决策 5）
// reviewed/pending/armed 状态 + 挂载期派生已审态 + act 包装，全部单点化。
// 「派生已审态」收敛前三种写法（distill 家族 statuses?.[id] / memory every(promoted) / knowledge maturity 派生）
// 的 diff 全部收进 proposalCardConfigs 的 fetchReviewed/initialReviewed 配置项；
// 打开时查一次，失败静默保持待审，不实时推送（ADR 决策 6）。
import { useEffect, useState } from 'react';
import type { CardMeta } from '../utils/messageMeta';
import type { ProposalCardConfig, ProposalReviewState } from '../components/channel/proposalCardConfigs';

export interface UseProposalReviewOptions {
  config: ProposalCardConfig;
  meta: CardMeta;
  messageId: string;
  /** approve/reject 由父级分发执行，返回是否成功（undefined 视为成功） */
  onAction: (messageId: string, action: string) => void | Promise<boolean>;
}

export function useProposalReview({ config, meta, messageId, onAction }: UseProposalReviewOptions) {
  const cardData = meta.cardData ?? null;
  const [reviewed, setReviewed] = useState<ProposalReviewState | null>(
    () => config.initialReviewed?.(meta.status) ?? null,
  );
  const [pending, setPending] = useState(false);
  // #288 两步确认（高危操作，当前仅 constraint_audit）：armed=true 表示已进入待确认态，再次点击才执行
  const [armed, setArmed] = useState(false);

  // 已审态挂载期派生（刷新/重进频道后仍正确；其他入口的审核也会反映）：
  // fetchReviewed 命中终态 → reviewed；null/缺数据/抛错 → 静默保持待审。仅在打开时查一次。
  useEffect(() => {
    if (reviewed || !config.fetchReviewed) return;
    const fetchReviewed = config.fetchReviewed;
    let cancelled = false;
    void (async () => {
      try {
        const state = await fetchReviewed(cardData);
        if (!cancelled && state) setReviewed(state);
      } catch { /* 派生失败保持待审 */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const act = async (decision: 'approve' | 'reject') => {
    setPending(true);
    try {
      const ok = await onAction(messageId, decision === 'approve' ? config.approveAction : config.rejectAction);
      if (ok !== false) setReviewed(decision === 'approve' ? config.approvedState : 'rejected');
    } finally {
      setPending(false);
      // #288：执行完毕（含失败重武装）退出两步确认待确认态
      setArmed(false);
    }
  };

  return { reviewed, pending, armed, setArmed, act };
}
