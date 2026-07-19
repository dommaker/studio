import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useWorkUnitStore } from '../stores/workunitStore';
import { DiscussionPanel } from '../components/DiscussionPanel';

const statusLabels: Record<string, string> = {
  unassigned: '待分配',
  active: '执行中',
  in_review: '审查中',
  done: '已完成',
  closed: '已关闭',
  blocked: '阻塞',
};

const statusColors: Record<string, string> = {
  unassigned: 'bg-gray-500/20 text-gray-300',
  active: 'bg-purple-500/20 text-purple-300',
  in_review: 'bg-yellow-500/20 text-yellow-300',
  done: 'bg-green-500/20 text-green-300',
  closed: 'bg-green-500/20 text-green-300',
  blocked: 'bg-red-500/20 text-red-300',
};

const typeLabels: Record<string, string> = {
  task: '任务',
  monitor: '监控',
  analysis: '分析',
  discussion: '讨论',
};

const STATUS_OPTIONS = ['all', 'unassigned', 'active', 'in_review', 'done', 'closed', 'blocked'] as const;

export function WorkUnitListPage() {
  const {
    workunits, total, loading, error,
    loadWorkUnits, createWorkUnit, reviewPassed, reviewRejected,
    statusFilter, setStatusFilter,
  } = useWorkUnitStore();

  const [showCreate, setShowCreate] = useState(false);
  const [newScope, setNewScope] = useState('');
  const [newType, setNewType] = useState('task');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    loadWorkUnits();
  }, []);

  const handleCreate = async () => {
    if (!newScope.trim()) return;
    setCreating(true);
    try {
      await createWorkUnit({ scope: newScope.trim(), type: newType });
      setNewScope('');
      setShowCreate(false);
    } catch (e) {
      console.error('Create WorkUnit failed:', e);
    } finally {
      setCreating(false);
    }
  };

  const formatTime = (ts: string | null) => {
    if (!ts) return '-';
    return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--bg-primary)' }}>
      {/* Header */}
      <div className="px-8 py-6" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="page-title">WorkUnit</h1>
            <p className="page-subtitle">Agent Network 工作单元 — 创建、分配、审查</p>
          </div>
          <div className="flex gap-2">
            <button className="btn btn-primary" onClick={() => setShowCreate(!showCreate)}>
              {showCreate ? '取消' : '+ 新建'}
            </button>
            <Link to="/" className="btn btn-secondary">返回</Link>
          </div>
        </div>

        {/* Stats */}
        <div className="flex gap-6 mt-4">
          <StatBadge label="总数" value={total} color="text-blue-400" />
          <StatBadge label="待分配" value={workunits.filter(w => w.status === 'unassigned').length} color="text-gray-400" />
          <StatBadge label="执行中" value={workunits.filter(w => w.status === 'active').length} color="text-purple-400" />
          <StatBadge label="审查中" value={workunits.filter(w => w.status === 'in_review').length} color="text-yellow-400" />
        </div>
      </div>

      <div className="flex-1 overflow-auto px-8 pb-8">
        <div className="max-w-5xl">
          {/* Create form */}
          {showCreate && (
            <div className="mt-4 p-4 rounded-lg" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
              <div className="flex gap-3 items-end">
                <div className="flex-1">
                  <label className="text-xs text-gray-400 mb-1 block">Scope（描述任务）</label>
                  <input
                    className="w-full px-3 py-2 rounded bg-gray-800 text-white border border-gray-600 focus:border-blue-500 outline-none"
                    placeholder="例：实现用户登录功能"
                    value={newScope}
                    onChange={e => setNewScope(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleCreate()}
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-400 mb-1 block">Type</label>
                  <select
                    className="px-3 py-2 rounded bg-gray-800 text-white border border-gray-600 outline-none"
                    value={newType}
                    onChange={e => setNewType(e.target.value)}
                  >
                    {Object.entries(typeLabels).map(([v, l]) => (
                      <option key={v} value={v}>{l}</option>
                    ))}
                  </select>
                </div>
                <button
                  className="btn btn-primary"
                  onClick={handleCreate}
                  disabled={creating || !newScope.trim()}
                >
                  {creating ? '创建中...' : '创建'}
                </button>
              </div>
            </div>
          )}

          {/* Filters */}
          <div className="flex gap-2 mt-4">
            {STATUS_OPTIONS.map(s => (
              <button
                key={s}
                className={`text-xs px-3 py-1 rounded-full transition-colors ${
                  (statusFilter ?? 'all') === s
                    ? 'bg-blue-500/30 text-blue-300'
                    : 'bg-gray-700/30 text-gray-400 hover:bg-gray-600/30'
                }`}
                onClick={() => setStatusFilter(s === 'all' ? null : s)}
              >
                {s === 'all' ? '全部' : statusLabels[s] ?? s}
              </button>
            ))}
          </div>

          {/* Error */}
          {error && (
            <div className="mt-4 p-3 rounded bg-red-500/10 text-red-300 text-sm">{error}</div>
          )}

          {/* List */}
          {loading && workunits.length === 0 ? (
            <div className="text-center py-20 text-gray-500">加载中...</div>
          ) : workunits.length === 0 ? (
            <div className="text-center py-20 text-gray-500">
              <div className="text-4xl mb-4">📋</div>
              <p>暂无 WorkUnit</p>
              <p className="text-sm mt-2">点击"新建"创建第一个工作单元</p>
            </div>
          ) : (
            <div className="space-y-2 mt-4">
              {workunits.map(wu => (
                <WorkUnitRow
                  key={wu.id}
                  wu={wu}
                  onReviewPassed={() => reviewPassed(wu.id)}
                  onReviewRejected={(reason) => reviewRejected(wu.id, reason)}
                  formatTime={formatTime}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function WorkUnitRow({
  wu, onReviewPassed, onReviewRejected, formatTime,
}: {
  wu: any;
  onReviewPassed: () => void;
  onReviewRejected: (reason?: string) => void;
  formatTime: (ts: string | null) => string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [rejectReason, setRejectReason] = useState('');

  return (
    <div className="rounded-lg" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
      <div
        className="p-3 cursor-pointer flex items-center justify-between gap-4"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className={`text-xs px-2 py-0.5 rounded ${statusColors[wu.status] || 'bg-gray-500/20 text-gray-300'}`}>
              {statusLabels[wu.status] ?? wu.status}
            </span>
            <span className="text-xs text-gray-500">{typeLabels[wu.type] ?? wu.type}</span>
            {wu.reqId && (
              <span className="text-xs px-2 py-0.5 rounded bg-blue-500/20 text-blue-300" title="REQ 需求编号">
                {wu.reqId}
              </span>
            )}
            <span className="font-medium text-white truncate">{wu.scope}</span>
          </div>
          <div className="flex items-center gap-4 mt-1 text-xs text-gray-500">
            <span>ID: {wu.id.slice(0, 8)}...</span>
            {wu.assigneeId && <span>Agent: {wu.assigneeId.slice(0, 8)}...</span>}
            <span>创建: {formatTime(wu.createdAt)}</span>
            {wu.claimedAt && <span>Claim: {formatTime(wu.claimedAt)}</span>}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {wu.status === 'in_review' && (
            <>
              <button
                className="text-xs px-2 py-1 rounded bg-green-500/20 text-green-300 hover:bg-green-500/30"
                onClick={e => { e.stopPropagation(); onReviewPassed(); }}
              >
                通过
              </button>
              <button
                className="text-xs px-2 py-1 rounded bg-red-500/20 text-red-300 hover:bg-red-500/30"
                onClick={e => { e.stopPropagation(); setShowRejectModal(true); }}
              >
                拒绝
              </button>
            </>
          )}
          <span className="text-gray-500 text-sm">{expanded ? '▾' : '▸'}</span>
        </div>
      </div>

      {expanded && (
        <div className="px-3 pb-3 text-sm" style={{ borderTop: '1px solid var(--border-subtle)' }}>
          <div className="grid grid-cols-2 gap-2 mt-2 text-xs">
            <div><span className="text-gray-500">ID:</span> <span className="text-gray-300">{wu.id}</span></div>
            <div><span className="text-gray-500">Type:</span> <span className="text-gray-300">{wu.type}</span></div>
            <div><span className="text-gray-500">Assignee:</span> <span className="text-gray-300">{wu.assigneeId ?? 'none'}</span></div>
            <div><span className="text-gray-500">Channel:</span> <span className="text-gray-300">{wu.channelId ?? 'none'}</span></div>
            <div><span className="text-gray-500">REQ:</span> <span className="text-gray-300">{wu.reqId ?? 'none'}</span></div>
            <div><span className="text-gray-500">Retry:</span> <span className="text-gray-300">{wu.retryCount}</span></div>
            <div><span className="text-gray-500">Failure:</span> <span className="text-gray-300">{wu.failureType ?? 'none'}</span></div>
            <div className="col-span-2"><span className="text-gray-500">Updated:</span> <span className="text-gray-300">{formatTime(wu.updatedAt)}</span></div>
            {wu.completedAt && (
              <div className="col-span-2"><span className="text-gray-500">Completed:</span> <span className="text-gray-300">{formatTime(wu.completedAt)}</span></div>
            )}
          </div>
          {wu.metadata && (
            <div className="mt-2">
              <span className="text-gray-500 text-xs">Metadata:</span>
              <pre className="mt-1 text-xs text-gray-400 bg-gray-800/50 rounded p-2 overflow-auto max-h-32">
                {(() => { try { return JSON.stringify(JSON.parse(wu.metadata), null, 2); } catch { return wu.metadata; } })()}
              </pre>
            </div>
          )}
          <DiscussionPanel workUnitId={wu.id} />
        </div>
      )}

      {showRejectModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowRejectModal(false)}>
          <div className="bg-gray-800 rounded-lg p-4 w-96" onClick={e => e.stopPropagation()}>
            <h3 className="text-white font-medium mb-3">拒绝原因</h3>
            <textarea
              className="w-full px-3 py-2 rounded bg-gray-700 text-white border border-gray-600 outline-none focus:border-blue-500 text-sm"
              rows={3}
              placeholder="输入拒绝原因（可选）"
              value={rejectReason}
              onChange={e => setRejectReason(e.target.value)}
            />
            <div className="flex gap-2 mt-3 justify-end">
              <button
                className="text-xs px-3 py-1.5 rounded bg-gray-600 text-gray-300 hover:bg-gray-500"
                onClick={() => { setShowRejectModal(false); setRejectReason(''); }}
              >
                取消
              </button>
              <button
                className="text-xs px-3 py-1.5 rounded bg-red-500/20 text-red-300 hover:bg-red-500/30"
                onClick={() => { onReviewRejected(rejectReason || undefined); setShowRejectModal(false); setRejectReason(''); }}
              >
                确认拒绝
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatBadge({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className={`text-lg font-bold ${color}`}>{value}</span>
      <span className="text-sm text-gray-400">{label}</span>
    </div>
  );
}
