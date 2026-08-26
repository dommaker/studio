// ReviewProposalCard — #352 人审提案卡合一壳（ADR 2026-08-25 决策 5）
// 5 张卡（distill/gc/memory/knowledge/constraint_audit）坍缩为本壳 + proposalCardConfigs 纯数据配置；
// 生命周期单点化在 useProposalReview。卡间 diff 只剩条目清单与文案（配置 renderContent/labels）。
// 视觉复用 mc-card 族，DOM class/文案/按钮行为逐字保持旧卡。
import type { ChannelMessage } from '../../api/channel';
import type { CardMeta } from '../../utils/messageMeta';
import { useProposalReview } from '../../hooks/useProposalReview';
import { PROPOSAL_CARD_CONFIGS, type ProposalCardConfig } from './proposalCardConfigs';

interface Props {
  message: ChannelMessage;
  meta: CardMeta;
  /** approve/reject 由父级分发执行，返回是否成功（undefined 视为成功） */
  onAction: (messageId: string, action: string) => void | Promise<boolean>;
}

export function ReviewProposalCard({ message, meta, onAction }: Props) {
  const config = PROPOSAL_CARD_CONFIGS[meta.cardType ?? ''];
  // 渲染分发（ChannelMessageItem）已按 5 个 cardType 过滤，理论不可达；防御未知 cardType 不渲染
  if (!config) return null;
  return <ConfiguredProposalCard config={config} message={message} meta={meta} onAction={onAction} />;
}

function ConfiguredProposalCard({ config, message, meta, onAction }: Props & { config: ProposalCardConfig }) {
  const cardData = meta.cardData;
  const { reviewed, pending, armed, setArmed, act } = useProposalReview({
    config,
    meta,
    messageId: message.id,
    onAction,
  });

  // 终态墓碑（已审态）
  if (reviewed) {
    const label = config.reviewLabels[reviewed];
    return (
      <div className="mc-card" data-card-type={config.cardType}>
        <div className="mc-card-label" style={{ marginBottom: 4 }}>{config.reviewedTitle}</div>
        <span className={`mc-status ${label?.cls ?? ''}`}>{label?.text ?? ''}</span>
      </div>
    );
  }

  // #288 两步确认：twoStepApprove 卡首次点击仅进入待确认态，再次点击才执行
  const handleApprove = () => {
    if (config.twoStepApprove && !armed) {
      setArmed(true);
      return;
    }
    void act('approve');
  };
  const handleReject = () => {
    if (config.twoStepApprove) setArmed(false);
    void act('reject');
  };

  return (
    <div className="mc-card" data-card-type={config.cardType} style={{ borderColor: 'var(--accent-border)' }}>
      <div className="mc-card-head">
        <span className="mc-card-label">{config.pendingTitle}</span>
        <span className="mc-status mc-status-need">{config.countText(cardData)}</span>
      </div>

      {config.renderContent(cardData)}

      {/* Action buttons（pending 锁存禁用防连击；twoStepApprove = #288 两步确认） */}
      <div className="mc-card-actions">
        <button
          onClick={handleApprove}
          disabled={pending}
          className="mc-btn mc-btn-primary"
        >
          {config.twoStepApprove && armed ? config.armedApproveLabel : config.approveLabel}
        </button>
        <button
          onClick={handleReject}
          disabled={pending}
          className="mc-btn"
        >
          {config.rejectLabel}
        </button>
      </div>
    </div>
  );
}
