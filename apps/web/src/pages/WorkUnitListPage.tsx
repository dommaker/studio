import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { deriveDisplayState, WU_STATUS_LABELS, WU_TYPE_LABELS, type DerivedWuState } from '@dommaker/studio-shared/web';
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
import { useWebSocketContext } from '../api/websocketHooks';
import { Select } from '../components/ui';
import { MetaStrip } from '../components/ui/MetaStrip';
import { formatShortTime } from '../utils/datetime';
import '../styles/workunits.css';

/** F6：WU 展示状态唯一派生口径（铁律：禁止各自读 metadata.attestations 解释） */
const deriveWu = (wu: { status: string; metadata?: string | null }): DerivedWuState =>
  deriveDisplayState({ status: wu.status, metadata: wu.metadata });

const STATUS_OPTIONS = ['all', 'pending', 'unassigned', 'active', 'in_review', 'done', 'closed', 'blocked'] as const;

/** Step 2 筛选合一：统计 chip 集（点击过滤/再点取消回全部）；待人工是派生维度单列 */
const STATUS_CHIPS = [
  { key: 'pending', label: '待确认', color: 'var(--warning)' },
  { key: 'unassigned', label: WU_STATUS_LABELS.unassigned, color: 'var(--text-muted)' },
  { key: 'active', label: WU_STATUS_LABELS.active, color: 'var(--accent-primary)' },
  { key: 'in_review', label: WU_STATUS_LABELS.in_review, color: 'var(--warning)' },
] as const;

export function WorkUnitListPage() {
  const {
    workunits, total, loading, error,
    loadWorkUnits, createWorkUnit, reviewPassed, reviewRejected, confirmPending,
    statusFilter, setStatusFilter,
    unattributedOnly, unattributedTotal, setUnattributedOnly, loadUnattributedCount,
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
    // #405：未归属计数徽标（服务端 total 口径；过滤态下由 loadWorkUnits 顺带同步）
    void loadUnattributedCount();
  }, [loadWorkUnits, loadUnattributedCount]);

  // #318：WU SSE 负载直更（替代 eventTick 整页重拉）——status_changed 直替/移除行、created 插头部；
  // SSE 重连经 onReconnect 一次性 refetch 对齐（ADR D3）
  const applyWorkunitEvent = useWorkUnitStore(s => s.applyWorkunitEvent);
  const { onEvent, onReconnect } = useWebSocketContext();
  useEffect(() => onEvent((msg) => {
    if (msg.event_type !== 'workunit.status_changed' && msg.event_type !== 'workunit.created') return;
    const data = msg.data as { workunit?: WorkUnit } | null;
    if (!data?.workunit) return;
    applyWorkunitEvent(data.workunit, { insertIfMissing: msg.event_type === 'workunit.created' });
  }), [onEvent, applyWorkunitEvent]);
  useEffect(() => onReconnect(() => { void loadWorkUnits(); void loadUnattributedCount(); }), [onReconnect, loadWorkUnits, loadUnattributedCount]);

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

  // 状态 chip：与服务端 statusFilter 互斥于 humanOnly（选状态清待人工，同原 pill 行为）；
  // 再点已激活 chip = 取消回全部
  const clickStatusChip = (key: string) => {
    setHumanOnly(false);
    setStatusFilter(!humanOnly && statusFilter === key ? null : key);
  };

  return (
    <div className="h-full flex flex-col u-page-bg">
      {/* Header */}
      <div className="u-page-head">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="page-title">任务</h1>
            <p className="page-subtitle">创建、分配、审查全部任务</p>
          </div>
          <div className="flex gap-2">
            <button className="btn btn-primary" onClick={() => setShowCreate(!showCreate)}>
              {showCreate ? '取消' : '+ 新建'}
            </button>
          </div>
        </div>

        {/* Stats = 快速筛选 chip（Step 2 筛选合一；计数口径不变：总数走 server total，其余当前页派生列计数。
            F6-b：计数走派生列（双轨期与存储状态并存比对）） */}
        <div className="flex gap-2 mt-4 flex-wrap">
          <StatChip
            label="总数" value={total} color="var(--accent-primary)"
            active={!humanOnly && statusFilter === null}
            onClick={() => { setHumanOnly(false); setStatusFilter(null); }}
          />
          {/* #280：pending 单列「待确认」（扩范围人闸），不再计入「待人工」 */}
          {STATUS_CHIPS.map(c => (
            <StatChip
              key={c.key}
              label={c.label}
              value={workunits.filter(w => deriveWu(w).column === c.key).length}
              color={c.color}
              active={!humanOnly && statusFilter === c.key}
              onClick={() => clickStatusChip(c.key)}
            />
          ))}
          <StatChip
            label="待人工" value={workunits.filter(w => deriveWu(w).needsHuman).length} color="var(--error)"
            active={humanOnly}
            onClick={() => setHumanOnly(!humanOnly)}
            title="活已干完但人还没确认（手写待验收 + done 缺人工确认）"
          />
          {/* #405：未归属过滤（服务端 attributed=false，#428）+ 服务端 total 计数徽标——低调小 chip，
              与状态 chip 同为服务端维度可交集组合；取消即恢复原列表 */}
          <button
            className={`wu-unattr${unattributedOnly ? ' wu-unattr-on' : ''}`}
            onClick={() => { setHumanOnly(false); setUnattributedOnly(!unattributedOnly); }}
            title="无 reqId 且无 PMO 归因戳的任务（不计入任何项目交付统计，仅作归因覆盖率信号）"
          >
            未归属{unattributedTotal !== null && <span className="font-mono"> {unattributedTotal}</span>}
          </button>
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
                    options={Object.entries(WU_TYPE_LABELS).map(([v, l]) => ({ value: v, label: l }))}
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

          {/* Error */}
          {error && (
            <div className="mt-4 p-3 rounded u-err-dim u-err text-sm">{error}</div>
          )}

          {/* List —— Step 2：无边框行列表（细分隔线 + 左侧状态色条）；待人工 = 派生维度客户端过滤 */}
          {loading && workunits.length === 0 ? (
            <div className="text-center py-20 u-text-2">加载中...</div>
          ) : workunits.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">📋</div>
              <p>暂无任务</p>
              <p className="text-sm mt-2">点击"新建"创建第一个任务</p>
            </div>
          ) : (
            <div className="mt-4">
              {(humanOnly ? workunits.filter(w => deriveWu(w).needsHuman) : workunits).map(wu => (
                <WorkUnitRow
                  key={wu.id}
                  wu={wu}
                  onReviewPassed={(summary, assigneeId) => reviewPassed(wu.id, summary, assigneeId)}
                  onReviewRejected={(reason) => reviewRejected(wu.id, reason)}
                  onConfirmPending={() => confirmPending(wu.id)}
                  formatTime={formatShortTime}
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
  const [showMetadata, setShowMetadata] = useState(false);
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
    <div
      className={`wu-row${expanded ? ' wu-row-open' : ''}${depBlocked ? ' u-dimmed' : ''}`}
      data-status={derived.column}
    >
      <div
        className="px-3 py-2.5 cursor-pointer flex items-center justify-between gap-4"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            {/* 状态色点 + 状态词（小字）：着色走 data-status（与左侧色条同口径） */}
            <span className="wu-dot" aria-hidden="true" />
            <span className="wu-status">{WU_STATUS_LABELS[derived.column] ?? derived.column}</span>
            {/* 标题 = 详情页链接（↗ 深链枢纽）；行其余区域点击仍为行内展开 */}
            <Link
              to={`/workunits/${wu.id}`}
              className="font-medium u-text truncate u-hover-accent"
              title="打开任务详情页"
              onClick={e => e.stopPropagation()}
            >
              {wu.scope}
            </Link>
            {/* 弱化 chip：类型 / REQ / 被阻塞；#400 验收修复：shrink-0+nowrap 防长标题挤压 */}
            <span className="wu-chip">{WU_TYPE_LABELS[wu.type] ?? wu.type}</span>
            {wu.reqId && (
              <span className="wu-chip" title="REQ 需求编号">
                {wu.reqId}
              </span>
            )}
            {/* #116：被阻塞徽标，悬停 title 列依赖 id（客户端不知各依赖状态，口径保持中性；
                未了结判定与可点击清单见行内展开 BlockedByList） */}
            {depBlocked && (
              <span
                className="wu-chip wu-chip-warn"
                title={depIds.length > 0 ? `依赖：${depIds.join(', ')}` : '依赖未了结'}
              >
                被阻塞
              </span>
            )}
            <SelfReviewBadge wu={wu} />
          </div>
          <div className="flex items-center gap-4 mt-1 text-xs u-text-2">
            <span className="font-mono">ID: {wu.id.slice(0, 8)}...</span>
            {wu.assigneeId && <span className="font-mono">Agent: {wu.assigneeId.slice(0, 8)}...</span>}
            <span>创建: <span className="font-mono">{formatTime(wu.createdAt)}</span></span>
            {wu.claimedAt && <span>领取: <span className="font-mono">{formatTime(wu.claimedAt)}</span></span>}
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
              title="流程已由 Agent 评审推进完成；此确认为人工确认留痕，不阻断流程，确认后出审查列"
              onClick={e => { e.stopPropagation(); handleApprove(); }}
            >
              确认
            </button>
          )}
          <span className="u-text-2 text-sm">{expanded ? '▾' : '▸'}</span>
        </div>
      </div>

      {expanded && (
        <div className="px-3 pb-3 text-sm border-t u-border">
          {/* AC-2.4: in_review + 无 reviewer -> 提醒横幅 */}
          <ReviewHint
            status={wu.status}
            channelMembers={channelMembers}
            onSetupClick={() => navigate('/setup/roles')}
          />
          {/* Step 2：metadata grid → MetaStrip 紧凑横排（字段不变，Completed 无值自动省略） */}
          <MetaStrip
            className="text-xs u-text-2 mt-2 flex flex-wrap gap-x-4 gap-y-1"
            items={[
              { key: 'id', label: 'ID', value: <span className="u-text-3 font-mono">{wu.id}</span> },
              { key: 'type', label: 'Type', value: <span className="u-text-3">{wu.type}</span> },
              { key: 'assignee', label: 'Assignee', value: <span className="u-text-3 font-mono">{wu.assigneeId ?? 'none'}</span> },
              { key: 'channel', label: 'Channel', value: <span className="u-text-3 font-mono">{wu.channelId ?? 'none'}</span> },
              { key: 'req', label: 'REQ', value: <span className="u-text-3 font-mono">{wu.reqId ?? 'none'}</span> },
              { key: 'retry', label: 'Retry', value: <span className="u-text-3">{wu.retryCount}</span> },
              { key: 'failure', label: 'Failure', value: <span className="u-text-3">{wu.failureType ?? 'none'}</span> },
              { key: 'updated', label: 'Updated', value: <span className="u-text-3 font-mono">{formatTime(wu.updatedAt)}</span> },
              { key: 'completed', label: 'Completed', value: wu.completedAt ? <span className="u-text-3 font-mono">{formatTime(wu.completedAt)}</span> : null },
            ]}
          />
          {/* #284（决策 #250 D1/F7）：pending 人闸确认入口补齐到行展开态（与频道抽屉同行为：
              确认 → unassigned 进 frontier 可认领） */}
          {wu.status === 'pending' && (
            <div className="mt-2">
              <button
                className="text-xs px-2 py-1 rounded u-ok-dim u-ok u-hover-bg"
                title="待确认人闸：扩范围单创建落待确认，确认后进入待领取（agent 可见可领取）"
                onClick={onConfirmPending}
              >
                确认（进待领取）
              </button>
            </div>
          )}
          {/* #116：被阻塞行展开显示依赖清单（各依赖状态 + 跳详情页） */}
          {depBlocked && (
            <div className="mt-2">
              <BlockedByList metadata={wu.metadata} />
            </div>
          )}
          {/* Step 2：metadata JSON 默认收进 toggle */}
          {wu.metadata && (
            <div className="mt-2">
              <button
                className="wu-toggle"
                aria-expanded={showMetadata}
                onClick={() => setShowMetadata(!showMetadata)}
              >
                {showMetadata ? '▾ 隐藏 metadata' : '▸ 查看 metadata'}
              </button>
              {showMetadata && (
                <pre className="mt-1 text-xs u-text-3 u-surface rounded p-2 overflow-auto max-h-32">
                  {(() => { try { return JSON.stringify(JSON.parse(wu.metadata!), null, 2); } catch { return wu.metadata; } })()}
                </pre>
              )}
            </div>
          )}
          {/* 执行过程（思考/工具调用/用量，SSE 负载直更 #318）——与频道页右抽屉同一视图 */}
          <div className="mt-3">
            <div className="wu-sec">执行过程</div>
            <ExecutionSteps workUnitId={wu.id} />
          </div>
          <div className="mt-3">
            <div className="wu-sec">讨论</div>
            <DiscussionPanel workUnitId={wu.id} />
          </div>
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

/** Step 2：可点击的统计筛选 chip（数字+状态，点击过滤/再点取消；视觉对齐 AgentDashboard StatFilter） */
function StatChip({ label, value, color, active, onClick, title }: {
  label: string; value: number; color: string; active: boolean; onClick: () => void; title?: string;
}) {
  return (
    <button
      className={`wu-stat${active ? ' wu-stat-on' : ''}`}
      aria-pressed={active}
      onClick={onClick}
      title={title}
    >
      <span className="font-mono font-bold wu-stat-num" style={{ color }}>{value}</span>
      <span className="text-sm u-text-3">{label}</span>
    </button>
  );
}
