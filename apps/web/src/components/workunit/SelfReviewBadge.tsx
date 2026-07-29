import { deriveDisplayState } from '@dommaker/studio-shared';

/**
 * F6（决策 5）自评标记：频道内除实现者外无人可评时，评审由实现者自评兜底。
 * 两种数据源：
 *  - 评审 WU 自身：metadata.selfReview === true（ReviewDispatcher 建单时落档）
 *  - 被评审的父 WU：台账 l2.selfReview（评审回传时写入，deriveDisplayState 透出）
 * 提醒人工复核，不阻断流程（自评保流转，提醒给人看）。
 */
export function SelfReviewBadge({ wu }: { wu: { status: string; type?: string; metadata?: string | null } }) {
  let meta: { selfReview?: boolean } = {};
  try {
    meta = wu.metadata ? JSON.parse(wu.metadata) : {};
  } catch {
    meta = {};
  }
  const isSelfReview =
    (wu.type === 'review' && meta.selfReview === true) ||
    deriveDisplayState({ status: wu.status, metadata: wu.metadata }).evidence.selfReview;
  if (!isSelfReview) return null;
  return (
    <span
      className="text-xs px-2 py-0.5 rounded u-warn-dim u-warn"
      title="本任务由实现者自评（频道内无其他可评审成员）——建议人工复核"
    >
      自评
    </span>
  );
}
