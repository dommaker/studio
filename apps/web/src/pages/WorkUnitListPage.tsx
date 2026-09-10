import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { deriveDisplayState, WU_STATUS_LABELS, WU_TYPE_LABELS, type DerivedWuState } from '@dommaker/studio-shared/web';
import { useWorkUnitStore } from '../stores/workunitStore';
import { SelfReviewBadge } from '../components/workunit/SelfReviewBadge';
import { AssigneeLabel } from '../components/workunit/AssigneeLabel';
import { StaleSleepBadge } from '../components/workunit/StaleSleepBadge';
import { WuGateActions } from '../components/workunit/WuGateActions';
import type { ReviewConfirmPayload, WorkUnit } from '../api/workunit';
import { parseBlockedBy } from '../components/pmo/mapUtils';
import { useWebSocketContext } from '../api/websocketHooks';
import { Select, Button, SkeletonText } from '../components/ui';
import { IconClipboard } from '../components/ui/icons';
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
    workunits, total, allTotal, loading, error,
    loadWorkUnits, loadMoreWorkUnits, loadAllCount, createWorkUnit, reviewPassed, reviewRejected, confirmPending,
    statusFilter, setStatusFilter,
    unattributedOnly, unattributedTotal, setUnattributedOnly, loadUnattributedCount,
    searchQuery, setSearchQuery,
  } = useWorkUnitStore();

  const [showCreate, setShowCreate] = useState(false);
  const [newScope, setNewScope] = useState('');
  const [newType, setNewType] = useState('task');
  const [creating, setCreating] = useState(false);
  // 批次A 项4：创建失败内联错误（原 console.error 静默）
  const [createError, setCreateError] = useState<string | null>(null);
  const [humanOnly, setHumanOnly] = useState(false);
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  // 批次 D-2 项4：标题搜索输入（300ms 防抖进 store，参考 LibraryPage userIdInput 防抖先例）
  const [searchInput, setSearchInput] = useState('');
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstSearchEffectRef = useRef(true);
  // 2026-09-10 第二轮重设计：行点击直跳 /workunits/:id 详情页（替代 E2-1 右抽屉——
  // 400px 流内窄栏可读性差且与详情页功能重复；快速处置由行内 WuGateActions 覆盖）

  // 防抖落 store（跳过首次运行：挂载首拉已由下方 effect 触发，空串不重复加载）
  useEffect(() => {
    if (firstSearchEffectRef.current) {
      firstSearchEffectRef.current = false;
      return;
    }
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => {
      setSearchQuery(searchInput.trim() ? searchInput.trim() : null);
    }, 300);
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, [searchInput, setSearchQuery]);

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
    // 全量总数徽标：首载无过滤时由 loadWorkUnits 顺带同步；URL 深链带过滤（#184）时这里补齐
    void loadAllCount();
  }, [loadWorkUnits, loadUnattributedCount, loadAllCount]);

  // #318：WU SSE 负载直更（替代 eventTick 整页重拉）——status_changed 直替/移除行、created 插头部；
  // SSE 重连经 onReconnect 一次性 refetch 对齐（ADR D3）
  const applyWorkunitEvent = useWorkUnitStore(s => s.applyWorkunitEvent);
  const { onEvent, onReconnect } = useWebSocketContext();
  // 批次 E-3：SSE 新 WU 行渐隐高亮（白名单③状态色切换）——created 事件插头部的新行挂
  // .wu-row-new（accent-dim 底色），2s 后移类经 .wu-row 既有 background-color 过渡渐隐；
  // 过滤不符的行 store 不插入，fresh 标记由定时器自清，无副作用
  const [freshWuIds, setFreshWuIds] = useState<ReadonlySet<string>>(new Set());
  const freshWuTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  useEffect(() => () => { freshWuTimersRef.current.forEach(clearTimeout); }, []);
  useEffect(() => onEvent((msg) => {
    if (msg.event_type !== 'workunit.status_changed' && msg.event_type !== 'workunit.created') return;
    const data = msg.data as { workunit?: WorkUnit } | null;
    if (!data?.workunit) return;
    applyWorkunitEvent(data.workunit, { insertIfMissing: msg.event_type === 'workunit.created' });
    if (msg.event_type === 'workunit.created') {
      const wuId = data.workunit.id;
      setFreshWuIds(prev => (prev.has(wuId) ? prev : new Set(prev).add(wuId)));
      const timers = freshWuTimersRef.current;
      if (timers.has(wuId)) clearTimeout(timers.get(wuId));
      timers.set(wuId, setTimeout(() => {
        timers.delete(wuId);
        setFreshWuIds(prev => { const next = new Set(prev); next.delete(wuId); return next; });
      }, 2000));
    }
  }), [onEvent, applyWorkunitEvent]);
  useEffect(() => onReconnect(() => { void loadWorkUnits(); void loadUnattributedCount(); void loadAllCount(); }), [onReconnect, loadWorkUnits, loadUnattributedCount, loadAllCount]);

  // 批次 E-2 空态分语境：过滤生效（状态/搜索/待人工/未归属）→ 「清除过滤」；全空 → 「新建任务」
  const isFilteredEmpty = humanOnly || statusFilter !== null || searchQuery !== null || unattributedOnly;
  const clearFilters = () => {
    setHumanOnly(false);
    setStatusFilter(null);
    setUnattributedOnly(false);
    setSearchInput('');
    setSearchQuery(null);
  };

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

        {/* Stats = 快速筛选 chip（Step 2 筛选合一；计数口径：总数走全量徽标 allTotal（过滤态不变脸），
            其余按已加载子集派生列计数——#472：分页未全量/筛选生效时在 chip 行内联标注口径，防数字撒谎） */}
        <div className="flex gap-2 mt-4 flex-wrap items-center">
          <StatChip
            label="总数" value={allTotal ?? total} color="var(--accent-primary)"
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
          {(statusFilter !== null || searchQuery !== null || humanOnly || workunits.length < total) && (
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

        {/* 批次 D-2 项4：标题搜索（300ms 防抖 → store searchQuery → 服务端 q 过滤；
            「已加载 X / 共 N」随过滤自然变化，total 已是服务端过滤计数） */}
        <div className="mt-3 max-w-sm">
          <input
            className="input w-full"
            placeholder="搜索任务标题…"
            aria-label="搜索任务标题"
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
          />
        </div>
      </div>

      {/* 列表区（抽屉已删：行点击直跳详情页） */}
      <div className="flex-1 overflow-auto u-page-px pb-8">
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
                  <Button
                    onClick={handleCreate}
                    loading={creating}
                    loadingLabel="创建中..."
                    disabled={!newScope.trim()}
                  >
                    创建
                  </Button>
                </div>
                {createError && <div className="mt-2 text-xs u-err">{createError}</div>}
              </div>
            )}

            {/* Error —— 批次 E-2：抄 PMOPage 错误条模式（红条 + 重试） */}
            {error && (
              <div className="mt-4 p-3 rounded u-err-dim u-err text-sm flex items-center justify-between">
                <span>{error}</span>
                <button onClick={() => void loadWorkUnits()} className="btn btn-secondary btn-sm">重试</button>
              </div>
            )}

            {/* List —— 无边框行列表（细分隔线 + 左侧状态色条）；待人工 = 派生维度客户端过滤 */}
            {loading && workunits.length === 0 ? (
              // 批次 E-2：静态骨架占位（零动画），贴近行列表形态
              <SkeletonText lines={6} className="mt-4 space-y-3" />
            ) : workunits.length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon"><IconClipboard size={32} /></div>
                {isFilteredEmpty ? (
                  <>
                    <p>没有符合当前过滤条件的任务</p>
                    <p className="text-sm mt-2">调整或清除过滤条件后再查看</p>
                    <button className="btn btn-primary mt-4" onClick={clearFilters}>清除过滤</button>
                  </>
                ) : (
                  <>
                    <p>暂无任务</p>
                    <p className="text-sm mt-2">点击"新建"创建第一个任务</p>
                    <button className="btn btn-primary mt-4" onClick={() => setShowCreate(true)}>新建任务</button>
                  </>
                )}
              </div>
            ) : (
              <div className="mt-4">
                {(humanOnly ? workunits.filter(w => deriveWu(w).needsHuman) : workunits).map(wu => (
                  <WorkUnitRow
                    key={wu.id}
                    wu={wu}
                    fresh={freshWuIds.has(wu.id)}
                    onOpen={() => navigate(`/workunits/${wu.id}`)}
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
                    <Button
                      variant="secondary"
                      size="sm"
                      loading={loading}
                      loadingLabel="加载中…"
                      onClick={() => void loadMoreWorkUnits()}
                    >
                      加载更多
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
      </div>
    </div>
  );
}

function WorkUnitRow({
  wu, fresh, onOpen, onReviewPassed, onReviewRejected, onConfirmPending, formatTime,
}: {
  wu: WorkUnit;
  /** 批次 E-3：SSE 新插入行渐隐高亮标记（.wu-row-new，2s 后页面自清） */
  fresh?: boolean;
  /** 2026-09-10 第二轮：行点击直跳 /workunits/:id 详情页 */
  onOpen: () => void;
  onReviewPassed: (summary?: string, assigneeId?: string, confirm?: ReviewConfirmPayload) => Promise<unknown>;
  onReviewRejected: (reason?: string) => Promise<unknown>;
  /** #284（决策 #250 D1）：pending 人闸确认（行内快速处置入口，与详情页同组件） */
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
      className={`wu-row${depBlocked ? ' u-dimmed' : ''}${derived.needsHuman ? ' wu-row-human' : ''}${fresh ? ' wu-row-new' : ''}`}
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
            {/* 标题（整行点击跳详情页）；长文 2 行折行 + title 悬停全文，不再单行截断 */}
            <span className="font-medium u-text wu-scope" title={wu.scope}>{wu.scope}</span>
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
              // stopPropagation：解析到时 AssigneeLabel 是 Link，防冒泡触发行点击跳详情
              <span onClick={e => e.stopPropagation()}>
                <AssigneeLabel assigneeId={wu.assigneeId} assigneeRoleId={wu.assigneeRoleId} className="font-mono" />
              </span>
            )}
            <span>创建: <span className="font-mono">{formatTime(wu.createdAt)}</span></span>
            {wu.claimedAt && <span>领取: <span className="font-mono">{formatTime(wu.claimedAt)}</span></span>}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* E2-4：行内闸门按钮 = 共享 WuGateActions（快速处置不进详情页；组件内吞冒泡） */}
          <WuGateActions
            wu={wu}
            onReviewPassed={onReviewPassed}
            onReviewRejected={onReviewRejected}
            onConfirmPending={onConfirmPending}
          />
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
