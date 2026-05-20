// Channel message renderer — B2: multi-card support
import type { ChannelMessage } from '../../api/channel';
import { RequirementsDocCard } from './RequirementsDocCard';
import { KnowledgeConfirmCard } from './KnowledgeConfirmCard';
import { AuditorSuggestionCard } from './AuditorSuggestionCard';
import { DeployApprovalCard } from './DeployApprovalCard'; // M4a

interface Props {
  message: ChannelMessage;
  onAction: (messageId: string, action: string) => void;
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

export function ChannelMessageItem({ message, onAction }: Props) {
  const isHuman = message.authorType === 'human';
  const meta = parseMeta(message.meta);
  const card = renderCard(meta, message, onAction);

  return (
    <div className={`flex ${isHuman ? 'justify-end' : 'justify-start'} mb-4`}>
      <div className={`max-w-[80%] ${isHuman ? 'order-1' : 'order-1'}`}>
        {/* Author label */}
        <div className={`text-xs mb-1 ${isHuman ? 'text-right text-blue-600' : 'text-left text-gray-500'}`}>
          {isHuman ? 'You' : message.agentName || 'Agent'}
        </div>

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
