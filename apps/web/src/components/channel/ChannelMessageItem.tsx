// Channel message renderer — AC-C2: reply button + AC-C3: thread + AC-E3: Convert to Task
// 2026-07 视觉重构（方向 A Mission Control）：纯文本行 + 卡片族视觉重绘；交互语义零变更
// #277（决策 #248 D1/D2/D3/D5）：分侧布局——人右轻气泡 / agent 左无气泡文档流 / 系统播报
// （Studio 无卡非等待消息）居中淡色一行 / 卡片全宽不参与分侧；compact 省略重复头；双侧 @name 染 mention chip。
import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ChannelFileVocabulary, ChannelMessage } from '../../api/channel';
import { AuthorAvatar } from './AuthorAvatar';
import { FileRefChip } from './FileRefChip';
import { MarkdownBody } from '../knowledge/MarkdownBody';
import { matchFileRefToken } from '../../utils/fileChipMatch';
import { renderWithMentions } from '../../utils/mentions';
import { RequirementsDocCard } from './RequirementsDocCard';
import { KnowledgeConfirmCard } from './KnowledgeConfirmCard';
import { KnowledgeProposalCard } from './KnowledgeProposalCard';
import { MemoryProposalCard } from './MemoryProposalCard';
import { DistillProposalCard } from './DistillProposalCard';
import { GcProposalCard } from './GcProposalCard';
import { ConstraintAuditCard } from './ConstraintAuditCard';
import { AuditorSuggestionCard } from './AuditorSuggestionCard';
import { AnalysisConfirmCard } from './AnalysisConfirmCard';
import { ConvertToTaskDialog } from './ConvertToTaskDialog';
import { NeedInputOptions } from './NeedInputOptions';
import { shortWuId } from '../../utils/id';
import { parseMeta, type CardMeta, type MetaOption } from '../../utils/messageMeta';
import { useImeEnterGuard } from '../../hooks/useImeEnterGuard';

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
  /** #284（决策 #250 D6）：analysis_confirm 接力卡「去确认」——开 WU 抽屉并自动弹确认对话框 */
  onOpenWorkUnitConfirm?: (workUnitId: string) => void;
  onOpenRequirement?: (reqId: string) => void;
  /** F5: NEED_INPUT 卡片内嵌回复（与回复按钮同链路：sendMessage + replyToId） */
  onInlineReply?: (message: ChannelMessage, content: string) => void;
  /** #285: agent 消息 inline-code 文件 chip 词表；经 MarkdownBody renderInlineCode 挂载（#271） */
  fileVocabulary?: ChannelFileVocabulary;
  /** #277（决策 #248 D2）：连续合并——省略重复头（头像/署名/时间），动作保留 */
  compact?: boolean;
  /** #279（决策 #250 D4）：顶栏待办 chip 定位高亮 */
  highlight?: boolean;
}

function renderCard(
  meta: CardMeta,
  message: ChannelMessage,
  onAction: Props['onAction'],
  onOpenWorkUnitConfirm: Props['onOpenWorkUnitConfirm'],
) {
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
    case 'distill_proposal': // #143 蒸馏提案人审闸口
      return <DistillProposalCard message={message} meta={meta} onAction={onAction} />;
    case 'gc_proposal': // #144 知识库 GC 候选清单人审闸口
      return <GcProposalCard message={message} meta={meta} onAction={onAction} />;
    case 'constraint_audit_proposal': // #146 存量约束退役建议人审闸口
      return <ConstraintAuditCard message={message} meta={meta} onAction={onAction} />;
    case 'auditor_suggestion':
      return <AuditorSuggestionCard message={message} meta={meta} onAction={onAction} />;
    case 'analysis_confirm': // #284（决策 #250 D6）analysis 接力卡
      return <AnalysisConfirmCard message={message} meta={meta} onOpenConfirm={onOpenWorkUnitConfirm} />;
    default:
      return null;
  }
}

export function ChannelMessageItem({
  message, onAction, onReply, findMessage, channelId,
  isThreadAnchor, threadReplyCount, isExpanded, onToggleThread, isThreadReply,
  waitingForInput, onOpenWorkUnit, onOpenWorkUnitConfirm, onOpenRequirement, onInlineReply, fileVocabulary, compact, highlight,
}: Props) {
  const isHuman = message.authorType === 'human';
  const meta = parseMeta(message.meta);
  const card = renderCard(meta, message, onAction, onOpenWorkUnitConfirm);
  const parentMessage = message.replyToId && findMessage ? findMessage(message.replyToId) : undefined;
  const [convertOpen, setConvertOpen] = useState(false);
  const [needDraft, setNeedDraft] = useState('');
  const [needSent, setNeedSent] = useState(false);
  // #270：NEED_INPUT 内嵌回复框共享 composer 同款 IME 守卫
  const { handleCompositionEnd, isImeEvent } = useImeEnterGuard();
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

  // #267（决策 #250 D3）：meta.options 存在 → 结构化选项卡（点选即发送内嵌回复）；
  // 无 options → 现有单行回复框 fallback。防御性过滤非法元素（缺 label 的丢弃）
  const needOptions: MetaOption[] | undefined = Array.isArray(meta.options)
    ? meta.options.filter((o): o is MetaOption => !!o && typeof o.label === 'string')
    : undefined;

  // #271（决策 #248 D4）：agent 无卡片正文走 Markdown 渲染（wiki-link 关闭 + 代码块复制按钮）；
  // #285 文件 chip 经 renderInlineCode 挂载到 inline-code，命中词表唯一项才染 chip
  const renderInlineCode = useCallback(
    (text: string) => {
      if (!fileVocabulary) return null;
      const ref = matchFileRefToken(text, fileVocabulary);
      return ref ? <FileRefChip token={text.trim()} fileRef={ref} /> : null;
    },
    [fileVocabulary],
  );

  // #277 D3：系统播报判定——Studio 署名、无卡片、非 NEED_INPUT 等待中（等待中的提问保留 agent 形态供回复）
  const isSystem = !isHuman && !card && !waitingForInput && message.agentName === 'Studio';
  // #277 D1：分侧类——卡片全宽不参与分侧
  const sideClass = card ? 'mc-msg-card' : isSystem ? 'mc-msg-system' : isHuman ? 'mc-msg-human' : 'mc-msg-agent';

  const actionButtons = (
    <>
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
    </>
  );

  return (
    <div
      className={`mc-msg ${isThreadReply ? 'mc-msg-reply' : ''} ${compact ? 'mc-msg-compact' : ''} ${sideClass}${highlight ? ' mc-msg-highlight' : ''}`}
      data-message-id={message.id}
    >
      {/* Quote block (reply reference) */}
      {parentMessage && (
        <div className="mc-quote">
          {parentMessage.authorType === 'human' ? 'You' : parentMessage.agentName || 'Agent'}：{parentMessage.content}
        </div>
      )}

      {/* Author label + hover actions */}
      {/* #277 D2：agent 侧完整头（头像 + @名 + 时间）；人类侧头像 + 时间（不署名）；系统播报无头 */}
      {!isSystem && !compact && (
        <div className="mc-msg-head">
          {isHuman ? (
            <>
              <span className="mc-time">{formatTime(message.createdAt)}</span>
              <AuthorAvatar isHuman={isHuman} agentName={message.agentName} />
            </>
          ) : (
            <>
              <AuthorAvatar isHuman={isHuman} agentName={message.agentName} />
              <span className="mc-author mc-author-agent">{`@${message.agentName || 'Agent'}`}</span>
              <span className="mc-time">{formatTime(message.createdAt)}</span>
            </>
          )}
          {/* #279（走查 F4）：needSent（已回复）时 badge 让位——「已回复」与「等待回复」不同屏并存 */}
          {waitingForInput && !needSent && (
            <span className="mc-wait-badge">等待回复</span>
          )}
          <span className="mc-msg-actions">{actionButtons}</span>
        </div>
      )}
      {/* #277 D2：compact 省略重复头；动作（+等待 badge）浮于角落保留可用性 */}
      {!isSystem && compact && (
        <span className="mc-msg-actions mc-msg-actions-compact">
          {waitingForInput && !needSent && (
            <span className="mc-wait-badge">等待回复</span>
          )}
          {actionButtons}
        </span>
      )}

      {/* Content or Card */}
      {/* #271: agent 正文 Markdown 渲染（wikiLinks 关、codeCopy 开）；人类/系统维持纯文本 pre-wrap。
          #277 D5：双侧 @name 染 mention chip（纯文本侧 renderWithMentions 拆分；agent 侧 MarkdownBody mentions 插件） */}
      {card || (isSystem || isHuman ? (
        <div className={`mc-msg-body ${isHuman ? 'mc-bubble' : ''}`}>{renderWithMentions(message.content)}</div>
      ) : (
        <div className="mc-msg-body">
          <MarkdownBody
            content={message.content}
            className="mc-md"
            wikiLinks={false}
            codeCopy
            renderInlineCode={renderInlineCode}
            mentions
          />
        </div>
      ))}

      {/* F5: NEED_INPUT 卡片内嵌回复框；#267：有 meta.options 时渲染结构化选项卡 */}
      {waitingForInput && onInlineReply && (
        needSent ? (
          <div className="mc-need-sent">✓ 已回复，WorkUnit 将继续执行</div>
        ) : needOptions && needOptions.length > 0 ? (
          <NeedInputOptions
            options={needOptions}
            multiSelect={meta.multiSelect === true}
            onReply={content => {
              onInlineReply(message, content);
              setNeedSent(true);
            }}
          />
        ) : (
          <div className="mc-need-form">
            <input
              aria-label={`回复 ${message.workUnitId ?? message.id}`}
              placeholder="直接在此回复，WorkUnit 将继续执行…"
              value={needDraft}
              onChange={e => setNeedDraft(e.target.value)}
              onCompositionEnd={handleCompositionEnd}
              onKeyDown={e => {
                // #270：IME 选词 Enter 不发送；长按不连发
                if (e.key !== 'Enter' || isImeEvent(e) || e.repeat) return;
                sendInlineReply();
              }}
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
            <button className="mc-wu-link" onClick={() => onOpenWorkUnit(message.workUnitId!)} title={`打开 WorkUnit 详情：${message.workUnitId}`}>
              {shortWuId(message.workUnitId)} ›
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

/** 卡片 meta 类型与解析已迁至 utils/messageMeta（#264）；此处 re-export 保持既有 import 路径不变 */
export type { CardMeta } from '../../utils/messageMeta';

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}
