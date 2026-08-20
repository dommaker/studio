// AnalysisConfirmCard — #284（决策 #250 D6）analysis 接力卡
// 卡面 = 「分析结论待确认」+ 引导文案 + 「去确认」按钮；点击 = 开 WU 抽屉并自动弹 AnalysisApproveDialog
// （「打开即弹」由抽屉侧 DrawerState.autoApprove 入参承载）。替代原易被流冲走的纯文本引导。
import type { ChannelMessage } from '../../api/channel';
import type { CardMeta } from './ChannelMessageItem';

interface Props {
  message: ChannelMessage;
  meta: CardMeta;
  /** 跳轉确认：开 WU 抽屉 + 自动弹确认对话框（ChannelDetailPage 注入） */
  onOpenConfirm?: (workUnitId: string) => void;
}

export function AnalysisConfirmCard({ message, onOpenConfirm }: Props) {
  return (
    <div className="mc-card" data-card-type="analysis_confirm" style={{ borderColor: 'var(--warning-border)' }}>
      <div className="mc-card-head">
        <span className="mc-card-label">分析结论待确认</span>
        <span className="mc-status mc-status-need">待人工</span>
      </div>
      <p className="mc-card-dim">{message.content}</p>
      {message.workUnitId && onOpenConfirm && (
        <div className="mc-card-actions">
          <button
            className="mc-btn mc-btn-primary"
            onClick={() => onOpenConfirm(message.workUnitId!)}
          >
            去确认
          </button>
        </div>
      )}
    </div>
  );
}
