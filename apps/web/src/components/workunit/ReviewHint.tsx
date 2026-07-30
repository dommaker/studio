/**
 * AC-2.4（F4 2026-07-28 改口径）: WorkUnit in_review 且频道无可认领成员时的前端提醒横幅
 *
 * 检测条件：WorkUnit status='in_review' 且频道成员为空——
 * F4 reviewer 解锚后评审子 WU 未指派走 claim 涌现，任何频道成员都可认领；
 * 真正需要提醒的只剩"无人可领"（评审将滞留，需加成员或人工处理）。
 * （单成员 = 实现者本人时为自评兜底，服务端已发频道系统消息提醒，前端不重复。）
 */
export interface ReviewHintProps {
  /** WorkUnit 状态 */
  status: string;
  /** 频道成员中的 active profiles */
  channelMembers: Array<{ id: string; name: string; description: string | null }>;
  /** 点击跳转到角色初始化向导 */
  onSetupClick?: () => void;
}

export function ReviewHint({ status, channelMembers, onSetupClick }: ReviewHintProps) {
  if (status !== 'in_review') return null;
  if (channelMembers.length > 0) return null;

  return (
    <div
      className="u-warn-dim u-warn"
      style={{
        padding: '8px 12px',
        border: '1px solid var(--warning-border)',
        borderRadius: '4px',
        marginTop: '8px',
        marginBottom: '8px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '12px',
        fontSize: 'var(--fs-base)',
      }}
      data-testid="review-hint"
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span aria-hidden="true">⚠</span>
        <span>频道内没有可认领评审的成员，评审将滞留——请添加成员或人工评审</span>
      </span>
      {onSetupClick && (
        <button
          className="btn btn-warning btn-sm"
          onClick={onSetupClick}
          style={{ flexShrink: 0 }}
          data-testid="review-hint-setup"
        >
          去设置
        </button>
      )}
    </div>
  );
}
