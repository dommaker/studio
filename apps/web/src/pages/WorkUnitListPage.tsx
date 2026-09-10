import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { deriveDisplayState, WU_STATUS_LABELS, WU_TYPE_LABELS, type DerivedWuState } from '@dommaker/studio-shared/web';
import { useWorkUnitStore } from '../stores/workunitStore';
import { SelfReviewBadge } from '../components/workunit/SelfReviewBadge';
import { AssigneeLabel } from '../components/workunit/AssigneeLabel';
import { StaleSleepBadge } from '../components/workunit/StaleSleepBadge';
import { WuGateActions } from '../components/workunit/WuGateActions';
import { WorkUnitDrawer, type DrawerState } from '../components/channel/WorkUnitDrawer';
import type { ReviewConfirmPayload, WorkUnit } from '../api/workunit';
import { parseBlockedBy } from '../components/pmo/mapUtils';
import { useWebSocketContext } from '../api/websocketHooks';
import { Select } from '../components/ui';
import { formatShortTime } from '../utils/datetime';
import { serverErrorMessage } from '../utils/errorMessage';
import '../styles/workunits.css';

/** F6：WU 展示状态唯一派生口径（铁律：禁止各自读 metadata.attestations 解释） */
const deriveWu = (wu: { status: string; metadata?: string | null }): DerivedWuState =>
  deriveDisplayState({ status: wu.status, metadata: wu.metadata });

const STATUS_OPTIONS = ['all', 'pending', 'unassigned', 'active', 'in_review', 'done', 'closed', 'blocked'] as const;

/** Step 2 筛选合一：统计 chip 集（点击过滤/再点取消回全部）；待人工是派生维度单列。
 *  #472 颜色语义：待确认中性（待确认≠待验收，不再同 warning 黄）；待人工 warning（error 红留给真错误）。 */
const STATUS_CHIPS = [
  { key: 'pending', label: '待确认', color: 'var(--text-secondary)' },
  { key: 'unassigned', label: WU_STATUS_LABELS.unassigned, color: 'var(--text-muted)' },
  { key: 'active', label: WU_STATUS_LABELS.active, color: 'var(--accent-primary)' },
  { key: 'in_review', label: WU_STATUS_LABELS.in_review, color: 'var(--warning)' },
] as const;

export function WorkUnitListPage() {
  const {
    workunits, total, loading, error,
    loadWorkUnits, loadMoreWorkUnits, createWorkUnit, reviewPassed, reviewRejected, confirmPending,
    statusFilter, setStatusFilter,
    unattributedOnly, unattributedTotal, setUnattributedOnly, loadUnattributedCount,
  } = useWorkUnitStore();

  const [showCreate, setShowCreate] = useState(false);
  const [newScope, setNewScope] = useState('');
  const [newType, setNewType] = useState('task');
  const [creating, setCreating] = useState(false);
  // 批次A 项4：创建失败内联错误（原 console.error 静默）
  const [createError, setCreateError] = useState<string | null>(null);
  const [humanOnly, setHumanOnly] = useState(false);
  const [searchParams] = useSearchParams();
  // E2-1（2026-09 页面重设计）：行点击 → 右侧抽屉（替代整行展开区）；复用频道工作区同一 WorkUnitDrawer
  const [drawer, setDrawer] = useState<DrawerState>(null);

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
    setCreateError(null);
    try {
      await createWorkUnit({ scope: newScope.trim(), type: newType });
      setNewScope('');
      setShowCreate(false);
    } catch (e) {
      // 批次A 项4：失败内联进创建表单（服务端 error.message 优先）
      setCreateError(serverErrorMessage(e) ?? '创建失败，请重试');
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

        {/* Stats = 快速筛选 chip（Step 2 筛选合一；计数口径：总数走 server total，其余按已加载子集派生列计数——
            #472：分页未全量/筛选生效时在 chip 行内联标注口径，防数字撒谎） */}
        <div className="flex gap-2 mt-4 flex-wrap items-center">
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
            label="待人工" value={workunits.filter(w => deriveWu(w).needsHuman).length} color="var(--warning)"
            active={humanOnly}
            onClick={() => setHumanOnly(!humanOnly)}
            title="活已干完但人还没确认（手写待验收 + done 缺人工确认）"
          />
          {/* #472：口径标注——除「总数」外 chip 计的是当前已加载子集；全量无筛选时计数即全量，不标注。
              措辞避开「已加载」（底栏分页文案唯一断言占用） */}
          {(statusFilter !== null || humanOnly || workunits.length < total) && (
            <span className="text-xs u-text-3">
              计数口径：当前 {workunits.length}/{total} 条
            </span>
          )}
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

      {/* E2-1：列表 + 流内右抽屉双栏（768–1023 抽屉转 fixed 覆盖、<768 全屏化，走 .mc-drawer 全局降级规则） */}
      <div className="flex-1 flex min-h-0">
        <div className="flex-1 overflow-auto px-8 pb-8">
          <div className="max-w-5xl">
            {/* Create form */}
            {showCreate && (
              <div className="card mt-4 p-4">
                <div className="flex gap-3 items-end">
                  <div className="flex-1">
                    <label className="text-xs u-text-3 mb-1 block">任务描述</label>
                    <input
                      className="w-full px-3 py-2 rounded u-surface u-text border u-border-2  outline-none"
                      placeholder="例：实现用户登录功能"
                      value={newScope}
                      onChange={e => setNewScope(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && handleCreate()}
                    />
                  </div>
                  <div>
                    <label className="text-xs u-text-3 mb-1 block">类型</label>
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
                {createError && <div className="mt-2 text-xs u-err">{createError}</div>}
              </div>
            )}

            {/* Error */}
            {error && (
              <div className="mt-4 p-3 rounded u-err-dim u-err text-sm">{error}</div>
            )}

            {/* List —— 无边框行列表（细分隔线 + 左侧状态色条）；待人工 = 派生维度客户端过滤 */}
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
                    onOpen={() => setDrawer({ kind: 'wu', id: wu.id })}
                    onReviewPassed={(summary, assigneeId, confirm) => reviewPassed(wu.id, summary, assigneeId, confirm)}
                    onReviewRejected={(reason) => reviewRejected(wu.id, reason)}
                    onConfirmPending={() => confirmPending(wu.id)}
                    formatTime={formatShortTime}
                  />
                ))}
                {/* E2-5 分页（承接批次 B-3）：追加式「加载更多」+ 已加载/共 N 明示（共 N = pagination.total） */}
                <div className="flex items-center justify-between mt-2 text-xs u-text-3">
                  <span>已加载 <span className="font-mono">{workunits.length}</span> / 共 <span className="font-mono">{total}</span></span>
                  {workunits.length < total && (
                    <button
                      className="btn btn-secondary btn-sm"
                      disabled={loading}
                      onClick={() => void loadMoreWorkUnits()}
                    >
                      {loading ? '加载中…' : '加载更多'}
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* E2-1：WU/REQ 详情右抽屉（与频道工作区同一组件，props 自包含自取数） */}
        <div className="wu-drawer-host">
          <WorkUnitDrawer
            drawer={drawer}
            onClose={() => setDrawer(null)}
            onOpenWu={(id) => setDrawer({ kind: 'wu', id })}
            onOpenReq={(id) => setDrawer({ kind: 'req', id })}
          />
        </div>
      </div>
    </div>
  );
}

function WorkUnitRow({
  wu, onOpen, onReviewPassed, onReviewRejected, onConfirmPending, formatTime,
}: {
  wu: WorkUnit;
  /** E2-1：行点击开右侧抽屉（替代整行展开区） */
  onOpen: () => void;
  onReviewPassed: (summary?: string, assigneeId?: string, confirm?: ReviewConfirmPayload) => Promise<unknown>;
  onReviewRejected: (reason?: string) => Promise<unknown>;
  /** #284（决策 #250 D1）：pending 人闸确认（行内快速处置入口，与抽屉/详情页同组件） */
  onConfirmPending: () => Promise<unknown>;
  formatTime: (ts: string | null) => string;
}) {
  // F6-b：徽章/按钮的展示判断一律过派生函数（通过/拒绝的调用资格仍看存储状态，
  // 因为服务端状态机以存储为准；done 缺 l3 时"确认"调同一端点幂等补写）
  const derived = deriveWu(wu);
  // #116：依赖未了结的待分配单 → 置灰 + 被阻塞徽标。
  // 注意服务端对非 unassigned 行 claimable 恒 false（workunit.routes.ts 口径），必须叠加存储状态判定
  const depBlocked = wu.status === 'unassigned' && wu.claimable === false;
  const depIds = depBlocked ? parseBlockedBy(wu.metadata) : [];

  return (
    <div
      className={`wu-row${depBlocked ? ' u-dimmed' : ''}${derived.needsHuman ? ' wu-row-human' : ''}`}
      data-status={derived.column}
    >
      <div
        className="px-3 py-2.5 cursor-pointer flex items-center justify-between gap-4"
        onClick={onOpen}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            {/* 状态色点 + 状态词（小字）：着色走 data-status（与左侧色条同口径） */}
            <span className="wu-dot" aria-hidden="true" />
            <span className="wu-status">{WU_STATUS_LABELS[derived.column] ?? derived.column}</span>
            {/* 标题（行点击开抽屉；详情页入口 = 行尾 ↗，深链场景） */}
            <span className="font-medium u-text truncate">{wu.scope}</span>
            {/* 弱化 chip：类型 / REQ / 被阻塞；#400 验收修复：shrink-0+nowrap 防长标题挤压 */}
            <span className="wu-chip">{WU_TYPE_LABELS[wu.type] ?? wu.type}</span>
            {wu.reqId && (
              <span className="wu-chip" title="REQ 需求编号">
                {wu.reqId}
              </span>
            )}
            {/* #116：被阻塞徽标，悬停 title 列依赖 id（依赖清单与各依赖状态见详情页「依赖与验收」节） */}
            {depBlocked && (
              <span
                className="wu-chip wu-chip-warn"
                title={depIds.length > 0 ? `依赖：${depIds.join(', ')}` : '依赖未了结'}
              >
                被阻塞
              </span>
            )}
            <SelfReviewBadge wu={wu} />
            <StaleSleepBadge wu={wu} />
          </div>
          <div className="flex items-center gap-4 mt-1 text-xs u-text-2">
            {/* #474：ID 截断显示、全文收进 title；Agent 不再拿截断 hash 当人名——AssigneeLabel 解析成角色名 */}
            <span className="font-mono" title={wu.id}>ID: {wu.id.slice(0, 8)}...</span>
            {wu.assigneeId && (
              // stopPropagation：解析到时 AssigneeLabel 是 Link，防冒泡触发行点击开抽屉
              <span onClick={e => e.stopPropagation()}>
                <AssigneeLabel assigneeId={wu.assigneeId} className="font-mono" />
              </span>
            )}
            <span>创建: <span className="font-mono">{formatTime(wu.createdAt)}</span></span>
            {wu.claimedAt && <span>领取: <span className="font-mono">{formatTime(wu.claimedAt)}</span></span>}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* E2-4：行内闸门按钮 = 共享 WuGateActions（快速处置不开抽屉；组件内吞冒泡） */}
          <WuGateActions
            wu={wu}
            onReviewPassed={onReviewPassed}
            onReviewRejected={onReviewRejected}
            onConfirmPending={onConfirmPending}
          />
          {/* E2-1：行尾 ↗ = 完整详情页入口（深链分享/深度调查场景） */}
          <Link
            to={`/workunits/${wu.id}`}
            className="u-text-2 u-hover-accent"
            title="打开完整详情页"
            aria-label="打开完整详情页"
            onClick={e => e.stopPropagation()}
          >
            ↗
          </Link>
        </div>
      </div>
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
