// M4a: Deploy SQL approval card
// 2026-07 视觉重构（方向 A Mission Control）：mc-card 视觉重绘；审批链路零变更
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
      <div className="mc-card" data-card-type="deploy_approval">
        <div className="mc-card-head">
          <span className="mc-card-label">部署审批</span>
          <span className={status === 'approved' ? 'mc-status mc-status-done' : 'mc-status mc-status-error'}>
            {status === 'approved' ? '已批准' : '已拒绝'}
          </span>
        </div>
        <div className="mc-card-dim">{message.content}</div>
      </div>
    );
  }

  return (
    <div className="mc-card" data-card-type="deploy_approval" style={{ borderColor: 'var(--warning-border)' }}>
      <div className="mc-card-head">
        <span className="mc-card-label">部署审批</span>
        <span className="mc-status mc-status-running">待审批</span>
      </div>

      {/* Blockers */}
      {blockers.length > 0 && (
        <div className="mc-status mc-status-error" style={{ display: 'block', padding: '6px 8px', marginBottom: 8 }}>
          <span style={{ fontWeight: 600 }}>阻断项</span>
          <ul style={{ margin: '4px 0 0', paddingLeft: 16, listStyle: 'disc' }}>
            {blockers.map((b: string, i: number) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
        </div>
      )}

      {/* SQL changes */}
      {sqlChanges.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <span className="mc-card-label">SQL 变更 ({sqlChanges.length})</span>
          <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 96, overflowY: 'auto' }}>
            {sqlChanges.map((sql: string, i: number) => (
              <pre key={i} className="mc-card-dim" style={{ background: 'var(--bg-tertiary)', borderRadius: 3, padding: 4, border: '1px solid var(--border-subtle)', margin: 0, overflowX: 'auto' }}>
                {sql.length > 120 ? sql.slice(0, 120) + '...' : sql}
              </pre>
            ))}
          </div>
        </div>
      )}

      {/* Dependency changes */}
      {depChanges.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <span className="mc-card-label">依赖变更</span>
          <ul className="mc-card-dim" style={{ margin: '4px 0 0', paddingLeft: 16, listStyle: 'disc' }}>
            {depChanges.map((d: { name: string; from?: string; to?: string }, i: number) => (
              <li key={i}>{d.name}{d.from && d.to ? `: ${d.from} → ${d.to}` : ''}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Approve/Reject */}
      <div className="mc-card-actions">
        <button onClick={handleApprove} disabled={approving} className="mc-btn mc-btn-primary">
          {approving ? '审批中...' : '批准部署'}
        </button>
        <button onClick={handleReject} disabled={rejecting} className="mc-btn">
          {rejecting ? '处理中...' : '拒绝'}
        </button>
      </div>
    </div>
  );
}
