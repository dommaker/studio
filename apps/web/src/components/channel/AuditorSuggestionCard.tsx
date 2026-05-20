// Auditor suggestion card — B3-005
import type { ChannelMessage } from '../../api/channel';

interface Props {
  message: ChannelMessage;
  meta: Record<string, any>;
  onAction: (messageId: string, action: string) => void;
}

const TYPE_ICONS: Record<string, string> = {
  param_tuning: '\u2699\uFE0F',
  prompt_optimization: '\uD83D\uDCDD',
  skill_weight: '\uD83C\uDFAF',
  skill_status: '\uD83D\uDCC8',
};

const TYPE_LABELS: Record<string, string> = {
  param_tuning: '参数调优',
  prompt_optimization: 'Prompt 优化',
  skill_weight: 'Skill 权重',
  skill_status: 'Skill 发布',
};

export function AuditorSuggestionCard({ message, meta, onAction }: Props) {
  const status = meta.status as string | undefined;
  const suggestions = meta.cardData?.suggestions as Array<{
    type: string;
    risk: string;
    skillId?: string;
    skillName?: string;
    agentType?: string;
    detail: string;
    data?: Record<string, unknown>;
  }> | undefined;

  if (status === 'confirmed' || status === 'rejected') {
    return (
      <div className="bg-white border border-gray-200 rounded-lg shadow-sm p-3 max-w-md">
        <div className="text-xs text-gray-500 mb-1">{'\uD83D\uDD27'} 审计建议</div>
        <div className={`text-sm ${status === 'confirmed' ? 'text-green-700' : 'text-red-600'}`}>
          {status === 'confirmed' ? '已确认执行' : '已拒绝'}
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white border border-amber-200 rounded-lg shadow-sm p-3 max-w-md">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-gray-500">
          {'\uD83D\uDD27'} 审计建议 — 待确认
        </span>
        <span className="text-xs text-amber-600">{suggestions?.length || 0} 条建议</span>
      </div>

      {/* Suggestions */}
      {suggestions?.map((s, i) => (
        <div key={i} className="mb-1.5 border-b border-gray-100 pb-1.5 last:border-0">
          <div className="flex items-center gap-1.5">
            <span className="text-sm">{TYPE_ICONS[s.type] || '\uD83D\uDD27'}</span>
            <span className="text-xs font-medium text-gray-700">
              {TYPE_LABELS[s.type] || s.type}
            </span>
            {s.risk === 'high' && (
              <span className="text-xs text-red-500 bg-red-50 px-1 rounded">高风险</span>
            )}
          </div>
          <p className="text-xs text-gray-600 mt-0.5 ml-5">{s.detail}</p>
          {s.agentType && (
            <span className="text-xs text-gray-400 ml-5">Agent: {s.agentType}</span>
          )}
        </div>
      ))}

      {/* Action buttons */}
      {status !== 'confirmed' && status !== 'rejected' && (
        <div className="flex gap-2 border-t pt-2 mt-1">
          <button
            onClick={() => onAction(message.id, 'auditor_apply_confirm')}
            className="flex-1 text-xs px-3 py-1.5 rounded text-white bg-green-500 hover:bg-green-600 transition-colors"
          >
            确认执行
          </button>
          <button
            onClick={() => onAction(message.id, 'auditor_apply_reject')}
            className="flex-1 border border-gray-300 text-gray-700 text-xs px-3 py-1.5 rounded hover:bg-gray-50 transition-colors"
          >
            拒绝
          </button>
        </div>
      )}
    </div>
  );
}
