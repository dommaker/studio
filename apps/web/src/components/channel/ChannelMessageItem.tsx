// Channel message renderer — AC-C2: reply button + quote rendering
import type { ChannelMessage } from '../../api/channel';
import { RequirementsDocCard } from './RequirementsDocCard';
import { KnowledgeConfirmCard } from './KnowledgeConfirmCard';
import { AuditorSuggestionCard } from './AuditorSuggestionCard';
import { DeployApprovalCard } from './DeployApprovalCard'; // M4a

interface Props {
  message: ChannelMessage;
  onAction: (messageId: string, action: string) => void;
  onReply?: (message: ChannelMessage) => void;
  findMessage?: (id: string) => ChannelMessage | undefined;
}

function renderCard(meta: Record<string, any>, message: ChannelMessage, onAction: Props['onAction']) {
  switch (meta.cardType) {
    case 'requirements_doc':
      return <RequirementsDocCard message={message} meta={meta} onAction={onAction} />;
    case 'knowledge_confirm':
    case 'retract_confirm':
      return <KnowledgeConfirmCard message={message} meta={meta} onAction={onAction} />;
    case 'auditor_suggestion':
      return <AuditorSuggestionCard message={message} meta={meta} onAction={onAction} />;
    case 'deploy_approval': // M4a
      return <DeployApprovalCard message={message} meta={meta} onAction={onAction} />;
    default:
      return null;
  }
}

export function ChannelMessageItem({ message, onAction, onReply, findMessage }: Props) {
  const isHuman = message.authorType === 'human';
  const meta = parseMeta(message.meta);
  const card = renderCard(meta, message, onAction);
  const parentMessage = message.replyToId && findMessage ? findMessage(message.replyToId) : undefined;

  return (
    <div className={`flex ${isHuman ? 'justify-end' : 'justify-start'} mb-4 group`}>
      <div className={`max-w-[80%] ${isHuman ? 'order-1' : 'order-1'}`}>
        {/* Author label + reply button */}
        <div className={`text-xs mb-1 flex items-center gap-2 ${isHuman ? 'justify-end text-blue-600' : 'justify-start text-gray-500'}`}>
          <span>{isHuman ? 'You' : message.agentName || 'Agent'}</span>
          {onReply && (
            <button
              onClick={() => onReply(message)}
              className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-blue-500 transition-opacity text-xs"
              title="回复"
            >
              ↩
            </button>
          )}
        </div>

        {/* Quote block (reply reference) */}
        {parentMessage && (
          <div className="text-xs text-gray-500 border-l-2 border-gray-300 pl-2 mb-1 italic truncate max-w-full">
            &gt; {parentMessage.authorType === 'human' ? 'You' : parentMessage.agentName || 'Agent'}: {parentMessage.content}
          </div>
        )}

        {/* Content or Card */}
        {card || (
          <div className={`rounded-lg px-4 py-2 text-sm whitespace-pre-wrap ${
            isHuman
              ? 'bg-blue-500 text-white rounded-br-none'
              : 'bg-gray-100 text-gray-900 rounded-bl-none'
          }`}>
            {message.content}
          </div>
        )}

        {/* Timestamp */}
        <div className={`text-xs mt-1 text-gray-400 ${isHuman ? 'text-right' : 'text-left'}`}>
          {formatTime(message.createdAt)}
        </div>
      </div>
    </div>
  );
}

function parseMeta(meta?: string): Record<string, any> {
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
