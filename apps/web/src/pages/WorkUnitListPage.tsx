import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { deriveDisplayState, type DerivedWuState } from '@dommaker/studio-shared/web';
import { useWorkUnitStore } from '../stores/workunitStore';
import { DiscussionPanel } from '../components/DiscussionPanel';
import { ExecutionSteps } from '../components/workunit/ExecutionSteps';
import { ReviewHint } from '../components/workunit/ReviewHint';
import { SelfReviewBadge } from '../components/workunit/SelfReviewBadge';
import { channelApi, type AgentProfile } from '../api/channel';
import type { WorkUnit } from '../api/workunit';
import { buildMapOpeningPrefill, parseBlockedBy } from '../components/pmo/mapUtils';
import { BlockedByList } from '../components/workunit/BlockedByList';
import { AnalysisApproveDialog } from '../components/pmo/AnalysisApproveDialog';
import { useWorkUnitEvents } from '../hooks/useWorkUnitEvents';
import { Select } from '../components/ui';

/** F6：WU 展示状态唯一派生口径（铁律：禁止各自读 metadata.attestations 解释） */
const deriveWu = (wu: { status: string; metadata?: string | null }): DerivedWuState =>
  deriveDisplayState({ status: wu.status, metadata: wu.metadata });

const statusLabels: Record<string, string> = {
  pending: '待确认',
  unassigned: '待分配',
  active: '执行中',
  in_review: '审查中',
  done: '已完成',
  closed: '已关闭',
  blocked: '阻塞',
};

const statusColors: Record<string, string> = {
  pending: 'u-warn-dim u-warn',
  unassigned: 'u-surface-2 u-text-3',
  active: 'u-accent-dim u-accent',
  in_review: 'u-warn-dim u-warn',
  done: 'u-ok-dim u-ok',
  closed: 'u-ok-dim u-ok',
  blocked: 'u-err-dim u-err',
};

const typeLabels: Record<string, string> = {
  task: '任务',
  monitor: '监控',
  analysis: '分析',
  discussion: '讨论',
};

const STATUS_OPTIONS = ['all', 'pending', 'unassigned', 'active', 'in_review', 'done', 'closed', 'blocked'] as const;

export function WorkUnitListPage() {
  const {
    workunits, total, loading, error,
    loadWorkUnits, createWorkUnit, reviewPassed, reviewRejected, confirmPending,
    statusFilter, setStatusFilter,
  } = useWorkUnitStore();

  const [showCreate, setShowCreate] = useState(false);
  const [newScope, setNewScope] = useState('');
  const [newType, setNewType] = useState('task');
  const [creating, setCreating] = useState(false);
  const [humanOnly, setHumanOnly] = useState(false);
  const [searchParams] = useSearchParams();

  // #184：支持下钻链接 URL 初始化状态筛选（/workunits?status=blocked），仅首载读取一次
  useEffect(() => {
    const s = searchParams.get('status');
    if (s && s !== 'all' && (STATUS_OPTIONS as readonly string[]).includes(s)) {
      setStatusFilter(s);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadWorkUnits();
  }, [loadWorkUnits]);

  // WU 事件（SSE）：创建/状态变化时刷新列表（防抖合并在 hook 内）
  useWorkUnitEvents(() => { loadWorkUnits(); });

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

        {/* Stats —— F6-b：计数走派生列（双轨期与存储状态并存比对） */}
        <div className="flex gap-6 mt-4">
          <StatBadge label="总数" value={total} color="u-accent" />
          <StatBadge label="待分配" value={workunits.filter(w => deriveWu(w).column === 'unassigned').length} color="u-text-3" />
          <StatBadge label="执行中" value={workunits.filter(w => deriveWu(w).column === 'active').length} color="u-accent" />
          <StatBadge label="审查中" value={workunits.filter(w => deriveWu(w).column === 'in_review').length} color="u-warn" />
          <StatBadge label="待人工" value={workunits.filter(w => deriveWu(w).needsHuman).length} color="u-err" />
        </div>
      </div>

      <div className="flex-1 overflow-auto px-8 pb-8">
        <div className="max-w-5xl">
          {/* Create form */}
          {showCreate && (
            <div className="card mt-4 p-4">
              <div className="flex gap-3 items-end">
                <div className="flex-1">
                  <label className="text-xs u-text-3 mb-1 block">Scope（描述任务）</label>
                  <input
                    className="w-full px-3 py-2 rounded u-surface u-text border u-border-2  outline-none"
                    placeholder="例：实现用户登录功能"
                    value={newScope}
                    onChange={e => setNewScope(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleCreate()}
                  />
                </div>
                <div>
                  <label className="text-xs u-text-3 mb-1 block">Type</label>
                  <Select
                    className="px-3 py-2 rounded u-surface u-text border u-border-2 outline-none"
                    value={newType}
                    onChange={setNewType}
                    options={Object.entries(typeLabels).map(([v, l]) => ({ value: v, label: l }))}
                  />
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

          {/* Filters —— 状态 pill 走服务端过滤（存储状态）；待人工 pill 是派生维度，客户端过滤 */}
          <div className="flex gap-2 mt-4">
            {STATUS_OPTIONS.map(s => (
              <button
                key={s}
                className={`text-xs px-3 py-1 rounded-full transition-colors ${
                  !humanOnly && (statusFilter ?? 'all') === s
                    ? 'u-accent-dim u-accent'
                    : 'u-surface-2 u-text-3 u-hover-bg'
                }`}
                onClick={() => { setHumanOnly(false); setStatusFilter(s === 'all' ? null : s); }}
              >
                {s === 'all' ? '全部' : statusLabels[s] ?? s}
              </button>
            ))}
            <button
              className={`text-xs px-3 py-1 rounded-full transition-colors ${
                humanOnly ? 'u-err-dim u-err' : 'u-surface-2 u-text-3 u-hover-bg'
              }`}
              onClick={() => setHumanOnly(!humanOnly)}
              title="活已干完但人还没确认（手写审查中 + done 缺人工确认）"
            >
              待人工
            </button>
          </div>

          {/* Error */}
          {error && (
            <div className="mt-4 p-3 rounded u-err-dim u-err text-sm">{error}</div>
          )}

          {/* List */}
          {loading && workunits.length === 0 ? (
            <div className="text-center py-20 u-text-2">加载中...</div>
          ) : workunits.length === 0 ? (
            <div className="text-center py-20 u-text-2">
              <div className="text-4xl mb-4">📋</div>
              <p>暂无 WorkUnit</p>
              <p className="text-sm mt-2">点击"新建"创建第一个工作单元</p>
            </div>
          ) : (
            <div className="space-y-2 mt-4">
              {(humanOnly ? workunits.filter(w => deriveWu(w).needsHuman) : workunits).map(wu => (
                <WorkUnitRow
                  key={wu.id}
                  wu={wu}
                  onReviewPassed={(summary, assigneeId) => reviewPassed(wu.id, summary, assigneeId)}
                  onReviewRejected={(reason) => reviewRejected(wu.id, reason)}
                  onConfirmPending={() => confirmPending(wu.id)}
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
  wu, onReviewPassed, onReviewRejected, onConfirmPending, formatTime,
}: {
  wu: WorkUnit;
  onReviewPassed: (summary?: string, assigneeId?: string) => void;
  onReviewRejected: (reason?: string) => void;
  /** #284（决策 #250 D1）：pending 人闸确认（行展开态入口，与频道抽屉同行为） */
  onConfirmPending: () => void;
  formatTime: (ts: string | null) => string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  // #106 M7：analysis 通过/确认弹窗——预填 agent 产出的待决问题清单（人审改后随 summary 回传开图）
  const [showApproveModal, setShowApproveModal] = useState(false);
  const [channelMembers, setChannelMembers] = useState<AgentProfile[]>([]);
  const navigate = useNavigate();
  // F6-b：徽章/按钮的展示判断一律过派生函数（通过/拒绝的调用资格仍看存储状态，
  // 因为服务端状态机以存储为准；done 缺 l3 时"确认"调同一端点幂等补写）
  const derived = deriveWu(wu);
  // #116：依赖未了结的待分配单 → 置灰 + 被阻塞徽标。
  // 注意服务端对非 unassigned 行 claimable 恒 false（workunit.routes.ts 口径），必须叠加存储状态判定
  const depBlocked = wu.status === 'unassigned' && wu.claimable === false;
  const depIds = depBlocked ? parseBlockedBy(wu.metadata) : [];

  // analysis 单走确认弹窗（待决问题清单审核）；其余类型保持一键通过
  const handleApprove = () => (wu.type === 'analysis' ? setShowApproveModal(true) : onReviewPassed());

  // AC-2.4: expanded 时获取频道成员，用于 ReviewHint 判断是否有 reviewer
  useEffect(() => {
    if (!expanded || !wu.channelId) return;
    channelApi.listAgents(wu.channelId)
      .then(res => setChannelMembers(res.data.data))
      .catch(() => { /* best-effort */ });
  }, [expanded, wu.channelId]);

  return (
    <div className={depBlocked ? 'card u-dimmed' : 'card'}>
      <div
        className="p-3 cursor-pointer flex items-center justify-between gap-4"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className={`text-xs px-2 py-0.5 rounded ${statusColors[derived.column] || 'u-surface-2 u-text-3'}`}>
              {statusLabels[derived.column] ?? derived.column}
            </span>
            {/* #116：被阻塞徽标，悬停 title 列依赖 id（客户端不知各依赖状态，口径保持中性；
                未了结判定与可点击清单见行内展开 BlockedByList） */}
            {depBlocked && (
              <span
                className="text-xs px-2 py-0.5 rounded u-warn-dim u-warn"
                title={depIds.length > 0 ? `依赖：${depIds.join(', ')}` : '依赖未了结'}
              >
                被阻塞
              </span>
            )}
            <SelfReviewBadge wu={wu} />
            <span className="text-xs u-text-2">{typeLabels[wu.type] ?? wu.type}</span>
            {wu.reqId && (
              <span className="text-xs px-2 py-0.5 rounded u-accent-dim u-accent" title="REQ 需求编号">
                {wu.reqId}
              </span>
            )}
            {/* 标题 = 详情页链接（↗ 深链枢纽）；行其余区域点击仍为行内展开 */}
            <Link
              to={`/workunits/${wu.id}`}
              className="font-medium u-text truncate u-hover-accent"
              title="打开 WorkUnit 详情页"
              onClick={e => e.stopPropagation()}
            >
              {wu.scope}
            </Link>
          </div>
          <div className="flex items-center gap-4 mt-1 text-xs u-text-2">
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
                className="text-xs px-2 py-1 rounded u-ok-dim u-ok u-hover-bg"
                onClick={e => { e.stopPropagation(); handleApprove(); }}
              >
                通过
              </button>
              <button
                className="text-xs px-2 py-1 rounded u-err-dim u-err u-hover-bg"
                onClick={e => { e.stopPropagation(); setShowRejectModal(true); }}
              >
                拒绝
              </button>
            </>
          )}
          {/* F6-b：done 但缺人工确认（l3）→ 确认按钮（幂等补写台账，不改状态）。
              语义：L2 agent 评审已是流程硬门（过了即推进），此按钮是 L3 人工验收留痕，不阻断流程。 */}
          {wu.status === 'done' && derived.needsHuman && (
            <button
              className="text-xs px-2 py-1 rounded u-ok-dim u-ok u-hover-bg"
              title="流程已由 Agent 评审推进完成；此确认为 L3 人工验收留痕，不阻断流程，确认后出审查列"
              onClick={e => { e.stopPropagation(); handleApprove(); }}
            >
              确认
            </button>
          )}
          <span className="u-text-2 text-sm">{expanded ? '▾' : '▸'}</span>
        </div>
      </div>

      {expanded && (
        <div className="px-3 pb-3 text-sm" style={{ borderTop: '1px solid var(--border-subtle)' }}>
          {/* AC-2.4: in_review + 无 reviewer -> 提醒横幅 */}
          <ReviewHint
            status={wu.status}
            channelMembers={channelMembers}
            onSetupClick={() => navigate('/setup/roles')}
          />
          <div className="grid grid-cols-2 gap-2 mt-2 text-xs">
            <div><span className="u-text-2">ID:</span> <span className="u-text-3">{wu.id}</span></div>
            <div><span className="u-text-2">Type:</span> <span className="u-text-3">{wu.type}</span></div>
            <div><span className="u-text-2">Assignee:</span> <span className="u-text-3">{wu.assigneeId ?? 'none'}</span></div>
            <div><span className="u-text-2">Channel:</span> <span className="u-text-3">{wu.channelId ?? 'none'}</span></div>
            <div><span className="u-text-2">REQ:</span> <span className="u-text-3">{wu.reqId ?? 'none'}</span></div>
            <div><span className="u-text-2">Retry:</span> <span className="u-text-3">{wu.retryCount}</span></div>
            <div><span className="u-text-2">Failure:</span> <span className="u-text-3">{wu.failureType ?? 'none'}</span></div>
            <div className="col-span-2"><span className="u-text-2">Updated:</span> <span className="u-text-3">{formatTime(wu.updatedAt)}</span></div>
            {wu.completedAt && (
              <div className="col-span-2"><span className="u-text-2">Completed:</span> <span className="u-text-3">{formatTime(wu.completedAt)}</span></div>
            )}
          </div>
          {/* #284（决策 #250 D1/F7）：pending 人闸确认入口补齐到行展开态（与频道抽屉同行为：
              确认 → unassigned 进 frontier 可认领） */}
          {wu.status === 'pending' && (
            <div className="mt-2">
              <button
                className="text-xs px-2 py-1 rounded u-ok-dim u-ok u-hover-bg"
                title="待确认人闸：扩范围单创建落待确认，确认后进入待认领（agent 可见可认领）"
                onClick={onConfirmPending}
              >
                确认（进待认领）
              </button>
            </div>
          )}
          {/* #116：被阻塞行展开显示依赖清单（各依赖状态 + 跳详情页） */}
          {depBlocked && (
            <div className="mt-2">
              <BlockedByList metadata={wu.metadata} />
            </div>
          )}
          {wu.metadata && (
            <div className="mt-2">
              <span className="u-text-2 text-xs">Metadata:</span>
              <pre className="mt-1 text-xs u-text-3 u-surface rounded p-2 overflow-auto max-h-32">
                {(() => { try { return JSON.stringify(JSON.parse(wu.metadata), null, 2); } catch { return wu.metadata; } })()}
              </pre>
            </div>
          )}
          {/* 执行过程（思考/工具调用/用量，SSE 步级刷新）——与频道页右抽屉同一视图 */}
          <div className="mt-2">
            <ExecutionSteps workUnitId={wu.id} />
          </div>
          <DiscussionPanel workUnitId={wu.id} />
        </div>
      )}

      {showApproveModal && (
        <AnalysisApproveDialog
          prefill={buildMapOpeningPrefill(wu.metadata)}
          channelId={wu.channelId}
          onConfirm={(summary, assigneeId) => { onReviewPassed(summary, assigneeId); setShowApproveModal(false); }}
          onCancel={() => setShowApproveModal(false)}
        />
      )}

      {showRejectModal && (
        <div className="modal-overlay" onClick={() => setShowRejectModal(false)}>
          <div className="modal" style={{ maxWidth: '24rem' }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">拒绝原因</h3>
              <button className="modal-close" onClick={() => setShowRejectModal(false)} aria-label="关闭">×</button>
            </div>
            <div className="modal-body">
              <textarea
                className="input w-full"
                rows={3}
                placeholder="输入拒绝原因（可选）"
                value={rejectReason}
                onChange={e => setRejectReason(e.target.value)}
              />
            </div>
            <div className="modal-footer">
              <button
                className="btn btn-secondary"
                onClick={() => { setShowRejectModal(false); setRejectReason(''); }}
              >
                取消
              </button>
              <button
                className="btn btn-danger"
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
      <span className={`font-bold ${color}`} style={{ fontSize: 'var(--fs-stat)' }}>{value}</span>
      <span className="text-sm u-text-3">{label}</span>
    </div>
  );
}
