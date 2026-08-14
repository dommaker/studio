// Channel message renderer — AC-C2: reply button + AC-C3: thread + AC-E3: Convert to Task
// 2026-07 视觉重构（方向 A Mission Control）：纯文本行 + 卡片族视觉重绘；交互语义零变更
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ChannelMessage } from '../../api/channel';
import { AuthorAvatar } from './AuthorAvatar';
import { RequirementsDocCard } from './RequirementsDocCard';
import { KnowledgeConfirmCard } from './KnowledgeConfirmCard';
import { KnowledgeProposalCard } from './KnowledgeProposalCard';
import { MemoryProposalCard } from './MemoryProposalCard';
import { AuditorSuggestionCard } from './AuditorSuggestionCard';
import { ConvertToTaskDialog } from './ConvertToTaskDialog';

interface Props {
  message: ChannelMessage;
  onAction: (messageId: string, action: string) => void;
  onReply?: (message: ChannelMessage) => void;
  findMessage?: (id: string) => ChannelMessage | undefined;
  channelId?: string;
  /** AC-C3: thread rendering */
  isThreadAnchor?: boolean;
  threadReplyCount?: number;
  isExpanded?: boolean;
  onToggleThread?: () => void;
  isThreadReply?: boolean;
  /** F5: 关联 WorkUnit 挂起等待人类回复（NEED_INPUT） */
  waitingForInput?: boolean;
  /** Mission Control: 打开右抽屉（WorkUnit 详情 / REQ 全链路） */
  onOpenWorkUnit?: (workUnitId: string) => void;
  onOpenRequirement?: (reqId: string) => void;
  /** F5: NEED_INPUT 卡片内嵌回复（与回复按钮同链路：sendMessage + replyToId） */
  onInlineReply?: (message: ChannelMessage, content: string) => void;
}

function renderCard(meta: CardMeta, message: ChannelMessage, onAction: Props['onAction']) {
  switch (meta.cardType) {
    case 'requirements_doc':
      return <RequirementsDocCard message={message} meta={meta} onAction={onAction} />;
    case 'knowledge_confirm':
    case 'retract_confirm':
      return <KnowledgeConfirmCard message={message} meta={meta} onAction={onAction} />;
    case 'knowledge_proposal': // 2026-07 知识审核闭环
      return <KnowledgeProposalCard message={message} meta={meta} onAction={onAction} />;
    case 'memory_proposal': // #101 角色记忆人审闸口
      return <MemoryProposalCard message={message} meta={meta} onAction={onAction} />;
    case 'auditor_suggestion':
      return <AuditorSuggestionCard message={message} meta={meta} onAction={onAction} />;
    default:
      return null;
  }
}

export function ChannelMessageItem({
  message, onAction, onReply, findMessage, channelId,
  isThreadAnchor, threadReplyCount, isExpanded, onToggleThread, isThreadReply,
  waitingForInput, onOpenWorkUnit, onOpenRequirement, onInlineReply,
}: Props) {
  const isHuman = message.authorType === 'human';
  const meta = parseMeta(message.meta);
  const card = renderCard(meta, message, onAction);
  const parentMessage = message.replyToId && findMessage ? findMessage(message.replyToId) : undefined;
  const [convertOpen, setConvertOpen] = useState(false);
  const [needDraft, setNeedDraft] = useState('');
  const [needSent, setNeedSent] = useState(false);
  const canConvert = !message.workUnitId && isHuman && !!channelId;
  const reqId: string | undefined = meta.requirementId || meta.reqId;
  // 2026-07 §5.7: 里程碑消息 meta.pmoId（老消息没有 → undefined，不渲染 PMO chip）
  const pmoId: string | undefined = typeof meta.pmoId === 'string' ? meta.pmoId : undefined;
  const navigate = useNavigate();

  const handleConverted = () => {
    setConvertOpen(false);
    // Parent will refresh messages via onAction
    onAction(message.id, 'converted');
  };

  // F5: 卡片内嵌回复 —— 走与回复按钮完全相同的链路（sendMessage + replyToId），
  // 后端 message-routing 检测 replyTo 继承 workUnitId 后调 resumeWaitingWorkUnit
  const sendInlineReply = () => {
    const trimmed = needDraft.trim();
    if (!trimmed || !onInlineReply) return;
    onInlineReply(message, trimmed);
    setNeedDraft('');
    setNeedSent(true);
  };

  return (
    <div className={`mc-msg ${isThreadReply ? 'mc-msg-reply' : ''}`} data-message-id={message.id}>
      {/* Quote block (reply reference) */}
      {parentMessage && (
        <div className="mc-quote">
          {parentMessage.authorType === 'human' ? 'You' : parentMessage.agentName || 'Agent'}：{parentMessage.content}
        </div>
      )}

      {/* Author label + hover actions */}
      <div className="mc-msg-head">
        <AuthorAvatar isHuman={isHuman} agentName={message.agentName} />
        <span className={isHuman ? 'mc-author' : 'mc-author mc-author-agent'}>
          {isHuman ? 'You' : `@${message.agentName || 'Agent'}`}
        </span>
        <span className="mc-time">{formatTime(message.createdAt)}</span>
        {waitingForInput && (
          <span className="mc-wait-badge">等待回复</span>
        )}
        <span className="mc-msg-actions">
          {onReply && (
            <button
              onClick={() => onReply(message)}
              className="mc-icon-btn"
              title="回复"
              aria-label="回复消息"
            >
              ↩
            </button>
          )}
          {canConvert && (
            <button
              onClick={() => setConvertOpen(true)}
              className="mc-icon-btn"
              title="转为任务"
              aria-label="转为任务"
            >
              ⊕
            </button>
          )}
        </span>
      </div>

      {/* Content or Card */}
      {card || (
        <div className="mc-msg-body">{message.content}</div>
      )}

      {/* F5: NEED_INPUT 卡片内嵌回复框 */}
      {waitingForInput && onInlineReply && (
        needSent ? (
          <div className="mc-need-sent">✓ 已回复，WorkUnit 将继续执行</div>
        ) : (
          <div className="mc-need-form">
            <input
              aria-label={`回复 ${message.workUnitId ?? message.id}`}
              placeholder="直接在此回复，WorkUnit 将继续执行…"
              value={needDraft}
              onChange={e => setNeedDraft(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && sendInlineReply()}
            />
            <button className="mc-btn mc-btn-primary" onClick={sendInlineReply} disabled={!needDraft.trim()}>
              回复
            </button>
          </div>
        )
      )}

      {/* Footer: WU/REQ 链接（开右抽屉）+ WU/PMO 直跳 + 线程开关 */}
      {(message.workUnitId || reqId || pmoId || (isThreadAnchor && threadReplyCount !== undefined && threadReplyCount > 0)) && (
        <div className="mc-card-foot">
          {message.workUnitId && onOpenWorkUnit && (
            <button className="mc-wu-link" onClick={() => onOpenWorkUnit(message.workUnitId!)} title="打开 WorkUnit 详情">
              {message.workUnitId} ›
            </button>
          )}
          {message.workUnitId && (
            <button
              className="mc-wu-link"
              onClick={() => navigate(`/workunits/${message.workUnitId}`)}
              title="新页面打开 WorkUnit 详情"
              aria-label="新页面打开 WorkUnit 详情"
            >
              ↗
            </button>
          )}
          {pmoId && (
            <button
              className="mc-wu-link"
              onClick={() => navigate(`/pmo/project/${pmoId}`)}
              title="打开项目详情"
              aria-label="打开项目详情"
            >
              PMO ›
            </button>
          )}
          {reqId && onOpenRequirement && (
            <button className="mc-wu-link" onClick={() => onOpenRequirement(reqId)} title="打开 REQ 全链路">
              {reqId} ›
            </button>
          )}
          {isThreadAnchor && threadReplyCount !== undefined && threadReplyCount > 0 && (
            <button onClick={onToggleThread} className="mc-thread-toggle" style={{ margin: 0 }}>
              {isExpanded ? '▾ 收起回复' : `▸ ${threadReplyCount} 条回复`}
            </button>
          )}
        </div>
      )}

      {/* AC-E3: Convert to Task dialog */}
      {channelId && (
        <ConvertToTaskDialog
          open={convertOpen}
          onClose={() => setConvertOpen(false)}
          messageId={message.id}
          channelId={channelId}
          messageContent={message.content}
          onConverted={handleConverted}
        />
      )}
    </div>
  );
}

/** 卡片 meta：消息 meta JSON 解析产物；cardData 形状随 cardType 而异，卡片内按需断言 */
export interface CardMeta {
  cardType?: string;
  status?: string;
  cardData?: Record<string, unknown>;
  projectPath?: string;
  requirementsDocId?: string;
  requirementId?: string;
  reqId?: string;
  pmoId?: string;
  error?: string;
  [key: string]: unknown;
}

function parseMeta(meta?: string): CardMeta {
  try { return JSON.parse(meta || '{}'); } catch { return {}; }
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}
