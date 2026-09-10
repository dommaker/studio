// PlanRulingCard — #467：裁决轮接力卡（plan 一脉会话内的一次性人闸）
// 卡面 = 「裁决轮待裁」+ 引导文案 + 「去裁决」按钮；点击 = 开 WU 抽屉并自动弹 PlanRulingDialog
// （「打开即弹」由抽屉侧 DrawerState.autoRuling 入参承载）。形态照 AnalysisConfirmCard（#284）。
import type { ChannelMessage } from '../../api/channel';
import type { CardMeta } from './ChannelMessageItem';

interface Props {
  message: ChannelMessage;
  meta: CardMeta;
  /** 跳轉裁决：开 WU 抽屉 + 自动弹裁决对话框（ChannelDetailPage 注入） */
  onOpenRuling?: (workUnitId: string) => void;
}

export function PlanRulingCard({ message, onOpenRuling }: Props) {
  return (
    <div className="mc-card" data-card-type="plan_ruling" style={{ borderColor: 'var(--warning-border)' }}>
      <div className="mc-card-head">
        <span className="mc-card-label">裁决轮待裁</span>
        <span className="mc-status mc-status-need">待人工</span>
      </div>
      <p className="mc-card-dim">{message.content}</p>
      {message.workUnitId && onOpenRuling && (
        <div className="mc-card-actions">
          <button
            className="mc-btn mc-btn-primary"
            onClick={() => onOpenRuling(message.workUnitId!)}
          >
            去裁决
          </button>
        </div>
      )}
    </div>
  );
}
