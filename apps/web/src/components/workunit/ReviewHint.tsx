/**
 * AC-2.4: WorkUnit in_review 无 reviewer 角色时前端提醒横幅
 *
 * 检测条件：WorkUnit status='in_review' 且频道成员中无 reviewer 角色
 * （reviewer = description 含 'reviewer' 关键词的 profile）
 */
export interface ReviewHintProps {
  /** WorkUnit 状态 */
  status: string;
  /** 频道成员中的 active profiles */
  channelMembers: Array<{ id: string; name: string; description: string | null }>;
  /** 点击跳转到角色初始化向导 */
  onSetupClick?: () => void;
}

function hasReviewer(members: ReviewHintProps['channelMembers']): boolean {
  return members.some(m =>
    m.description?.toLowerCase().includes('reviewer')
  );
}

export function ReviewHint({ status, channelMembers, onSetupClick }: ReviewHintProps) {
  if (status !== 'in_review') return null;
  if (hasReviewer(channelMembers)) return null;

  return (
    <div
      style={{
        padding: '8px 12px',
        background: '#fef3c7',
        border: '1px solid #f59e0b',
        borderRadius: '4px',
        marginBottom: '8px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        fontSize: '14px',
      }}
      data-testid="review-hint"
    >
      <span>建议创建 reviewer 角色以启用自动审查</span>
      {onSetupClick && (
        <button
          onClick={onSetupClick}
          style={{
            background: 'transparent',
            border: 'none',
            color: '#2563eb',
            cursor: 'pointer',
            textDecoration: 'underline',
            fontSize: '14px',
          }}
          data-testid="review-hint-setup"
        >
          去设置
        </button>
      )}
    </div>
  );
}
