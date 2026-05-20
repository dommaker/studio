// Knowledge confirm / retract card — B1-008/B1-010
import type { ChannelMessage } from '../../api/channel';

interface Props {
  message: ChannelMessage;
  meta: Record<string, any>;
  onAction: (messageId: string, action: string) => void;
}

const TYPE_LABELS: Record<string, string> = {
  decision: '设计决策',
  pitfall: '踩坑记录',
  guideline: '最佳实践',
  model: '架构模式',
};

export function KnowledgeConfirmCard({ message, meta, onAction }: Props) {
  const isRetract = meta.cardType === 'retract_confirm';
  const status = meta.status as string | undefined;
  const entries = meta.cardData?.entries as Array<{
    type: string;
    title: string;
    content: string;
    tags: string[];
  }> | undefined;

  if (status === 'confirmed' || status === 'rejected' || status === 'deprecated' || status === 'published') {
    return (
      <div className="bg-white border border-gray-200 rounded-lg shadow-sm p-3 max-w-md">
        <div className="text-xs text-gray-500 mb-1">{isRetract ? '⚠️ 撤回确认' : '📚 知识收录'}</div>
        <div className={`text-sm ${status === 'confirmed' || status === 'published' ? 'text-green-700' : status === 'deprecated' ? 'text-gray-500' : 'text-red-600'}`}>
          {isRetract
            ? (status === 'deprecated' ? '已确认废弃' : '撤回已取消，保持发布')
            : (status === 'confirmed' ? '已确认入库' : '已拒绝')}
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white border border-blue-200 rounded-lg shadow-sm p-3 max-w-md">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-gray-500">
          {isRetract ? '⚠️ 撤回确认' : '📚 知识收录确认'}
        </span>
        <span className="text-xs text-blue-600">{entries?.length || 0} 条知识</span>
      </div>

      {/* Entries */}
      {entries?.map((entry, i) => (
        <div key={i} className="mb-1.5 border-b border-gray-100 pb-1.5 last:border-0">
          <p className="text-sm font-medium text-gray-800">{entry.title}</p>
          <p className="text-xs text-gray-500 mt-0.5">{entry.content}</p>
          <div className="flex gap-1 mt-0.5">
            <span className="text-xs text-blue-500 bg-blue-50 px-1 rounded">
              {TYPE_LABELS[entry.type] || entry.type}
            </span>
            {entry.tags?.map(tag => (
              <span key={tag} className="text-xs text-gray-400 bg-gray-50 px-1 rounded">{tag}</span>
            ))}
          </div>
        </div>
      ))}

      {/* Action buttons */}
      {status !== 'confirmed' && status !== 'rejected' && status !== 'deprecated' && (
        <div className="flex gap-2 border-t pt-2 mt-1">
          <button
            onClick={() => onAction(message.id, isRetract ? 'retract_confirm' : 'knowledge_confirm')}
            className={`flex-1 text-xs px-3 py-1.5 rounded text-white transition-colors ${
              isRetract ? 'bg-orange-500 hover:bg-orange-600' : 'bg-green-500 hover:bg-green-600'
            }`}
          >
            {isRetract ? '确认废弃' : '确认入库'}
          </button>
          <button
            onClick={() => onAction(message.id, isRetract ? 'retract_reject' : 'knowledge_reject')}
            className="flex-1 border border-gray-300 text-gray-700 text-xs px-3 py-1.5 rounded hover:bg-gray-50 transition-colors"
          >
            拒绝
          </button>
        </div>
      )}
    </div>
  );
}
