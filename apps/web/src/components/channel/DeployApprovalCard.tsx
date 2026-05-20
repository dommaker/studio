// M4a: Deploy SQL approval card
import { useState } from 'react';
import { api } from '../../api';
import type { ChannelMessage } from '../../api/channel';

interface Props {
  message: ChannelMessage;
  meta: Record<string, any>;
  onAction: (messageId: string, action: string) => void;
}

export function DeployApprovalCard({ message, meta, onAction }: Props) {
  const status = meta.status || 'pending';
  const [approving, setApproving] = useState(false);
  const [rejecting, setRejecting] = useState(false);

  const handleApprove = async () => {
    setApproving(true);
    try {
      await api.post(`/harness/deploy/approve`, { cardId: meta.cardId, messageId: message.id });
      onAction(message.id, 'deploy_approve');
    } catch {
      setApproving(false);
    }
  };

  const handleReject = async () => {
    setRejecting(true);
    try {
      await api.post(`/harness/deploy/reject`, { cardId: meta.cardId, messageId: message.id });
      onAction(message.id, 'deploy_reject');
    } catch {
      setRejecting(false);
    }
  };

  const changes = meta.changes || meta.cardData?.changes || {};
  const blockers = meta.blockers || meta.cardData?.blockers || [];
  const sqlChanges = changes.sql || [];
  const depChanges = changes.dependencies || [];

  if (status !== 'pending') {
    return (
      <div className="bg-white border border-gray-200 rounded-lg shadow-sm p-4 max-w-md">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium text-gray-500">部署审批</span>
          <span className={`text-xs px-2 py-0.5 rounded-full ${
            status === 'approved' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
          }`}>
            {status === 'approved' ? '已批准' : '已拒绝'}
          </span>
        </div>
        <div className="text-xs text-gray-400">{message.content}</div>
      </div>
    );
  }

  return (
    <div className="bg-white border border-orange-200 rounded-lg shadow-sm p-4 max-w-md">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-gray-500">部署审批</span>
        <span className="text-xs px-2 py-0.5 rounded-full bg-orange-100 text-orange-700">
          待审批
        </span>
      </div>

      {/* Blockers */}
      {blockers.length > 0 && (
        <div className="mb-3 bg-red-50 border border-red-100 rounded p-2">
          <span className="text-xs font-medium text-red-600">阻断项</span>
          <ul className="text-xs text-red-500 mt-1 list-disc list-inside">
            {blockers.map((b: string, i: number) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
        </div>
      )}

      {/* SQL changes */}
      {sqlChanges.length > 0 && (
        <div className="mb-3">
          <span className="text-xs font-medium text-gray-600">SQL 变更 ({sqlChanges.length})</span>
          <div className="mt-1 space-y-1 max-h-24 overflow-y-auto">
            {sqlChanges.map((sql: string, i: number) => (
              <pre key={i} className="text-xs bg-gray-50 rounded p-1 font-mono text-gray-700 border border-gray-100">
                {sql.length > 120 ? sql.slice(0, 120) + '...' : sql}
              </pre>
            ))}
          </div>
        </div>
      )}

      {/* Dependency changes */}
      {depChanges.length > 0 && (
        <div className="mb-3">
          <span className="text-xs font-medium text-gray-600">依赖变更</span>
          <ul className="text-xs text-gray-500 mt-1 list-disc list-inside">
            {depChanges.map((d: { name: string; from?: string; to?: string }, i: number) => (
              <li key={i}>{d.name}{d.from && d.to ? `: ${d.from} → ${d.to}` : ''}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Approve/Reject */}
      <div className="flex gap-2 border-t pt-2">
        <button
          onClick={handleApprove}
          disabled={approving}
          className="flex-1 bg-green-500 text-white text-xs px-3 py-1.5 rounded hover:bg-green-600 disabled:opacity-50"
        >
          {approving ? '审批中...' : '批准部署'}
        </button>
        <button
          onClick={handleReject}
          disabled={rejecting}
          className="flex-1 border border-gray-300 text-gray-700 text-xs px-3 py-1.5 rounded hover:bg-gray-50 disabled:opacity-50"
        >
          {rejecting ? '处理中...' : '拒绝'}
        </button>
      </div>
    </div>
  );
}
