// PlanDirectionCard — #567：方向锁定接力卡（plan 一脉会话内方向人闸，裁决轮前置环节）
// 卡面 = 「方向待锁定」+ 引导文案 + 「去选定」按钮；点击 = 开 WU 抽屉并自动弹 PlanDirectionDialog
// （「打开即弹」由抽屉侧 DrawerState.autoDirection 入参承载）。形态照 PlanRulingCard（#467）。
// 抉择点/候选明细不在卡面——里程碑 meta 只带 cardType，数据源 = 抽屉侧 WU metadata.planDirections。
import type { ChannelMessage } from '../../api/channel';
import type { CardMeta } from './ChannelMessageItem';

interface Props {
  message: ChannelMessage;
  meta: CardMeta;
  /** 跳轉选定：开 WU 抽屉 + 自动弹方向选定对话框（ChannelDetailPage 注入） */
  onOpenDirection?: (workUnitId: string) => void;
}

export function PlanDirectionCard({ message, onOpenDirection }: Props) {
  return (
    <div className="mc-card" data-card-type="plan_direction" style={{ borderColor: 'var(--warning-border)' }}>
      <div className="mc-card-head">
        <span className="mc-card-label">方向待锁定</span>
        <span className="mc-status mc-status-need">待人工</span>
      </div>
      <p className="mc-card-dim">{message.content}</p>
      {message.workUnitId && onOpenDirection && (
        <div className="mc-card-actions">
          <button
            className="mc-btn mc-btn-primary"
            onClick={() => onOpenDirection(message.workUnitId!)}
          >
            去选定
          </button>
        </div>
      )}
    </div>
  );
}
