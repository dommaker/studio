// AgentDashboard — #397 信息全卡栅格（redesign-2026-08 §6 定稿变体 B）
// 数据/实时全部委托 useAgentRoster（名册合并 + SSE 事件路由 + 30s 轮询），本页只做组合与渲染。
// 渲染边界（#348 契约不变）：执行动态下沉 rosterActivityStore，RoleCard 自订切片——stream chunk
// 只重渲对应卡，不掀本页整树；stats/排序/筛选 useMemo，卡片 memo + 稳定 props（对齐 #322 三件套）。
// §6.3 页头统计行 = 快速筛选 chip（与卡面状态同口径同色，点击过滤/再点取消；「在线」正交维度移出）；
// §6.4 创建角色 = 弹框不跳页（保存=关弹框就地刷新名册）。
// 批次 D-2 项7（docs/plans/2026-09-ui-interaction-polish.md）：RoleCard 的 WU 锚点/最近完成/动态行
// 不再整页跳 /workunits/:id，改开本页自挂的 WorkUnitDrawer（懒加载 + .ac-drawer-host 全断点 fixed
// 覆盖宿主，同 NotificationBell D-2 项2 先例；「↗ 详情页」深链在抽屉 subject 行保留）。
import { lazy, Suspense, useCallback, useMemo, useState } from 'react';
import { useAgentRoster, type RosterRole } from '../hooks/useAgentRoster';
import { RoleCard } from '../components/monitoring/RoleCard';
import { CreateRoleModal } from '../components/monitoring/CreateRoleModal';
import { SkeletonCard } from '../components/ui';
import type { DrawerState } from '../components/channel/WorkUnitDrawer';
import {
  resolveCardStatusKey,
  resolveDisplayStatus,
  AGENT_STATUS_RANK,
  matchesStatusFilter,
  type StatusFilter,
} from '../utils/agentStatus';
import '../styles/agent-dashboard.css';

// D-2 项7：抽屉懒加载——不把 WorkUnitDrawer 依赖树打进本页首包（NotificationBell 同款）
const WorkUnitDrawer = lazy(() =>
  import('../components/channel/WorkUnitDrawer').then(m => ({ default: m.WorkUnitDrawer })),
);

/** 卡面细分状态键（筛选匹配用；pill/统计/排序走 4 态展示口径） */
const statusKeyOf = (r: RosterRole) =>
  resolveCardStatusKey(r.profile.status, r.runtime?.status ?? null, r.runtime?.currentWorkUnit?.status ?? null);

/** 展示状态键（页面侧统计/排序与卡面 pill 同 4 态口径） */
const displayKeyOf = (r: RosterRole) =>
  resolveDisplayStatus(r.profile.status, r.runtime?.status ?? null, r.runtime?.currentWorkUnit?.status ?? null);

export function AgentDashboardPage() {
  const { roles, lastDone, channelNames, loading, error, forbidden, refresh } = useAgentRoster();
  // §6.3：快速筛选（'all' = 不过滤）
  const [statFilter, setStatFilter] = useState<StatusFilter>('all');
  // §6.4：创建角色弹框
  const [createOpen, setCreateOpen] = useState(false);
  // D-2 项7：WU 就地抽屉宿主；openWu 必须稳定引用（RoleCard memo + #348 渲染契约）
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const openWu = useCallback((wuId: string) => setDrawer({ kind: 'wu', id: wuId }), []);

  const stats = useMemo(() => ({
    total: roles.length,
    working: roles.filter((r) => displayKeyOf(r) === 'working').length,
    attention: roles.filter((r) => displayKeyOf(r) === 'attention').length,
    idle: roles.filter((r) => displayKeyOf(r) === 'idle').length,
    offline: roles.filter((r) => displayKeyOf(r) === 'offline').length,
  }), [roles]);

  // 注意力排序（待处理→工作中→空闲→离线）+ 筛选（4 态口径）
  const visibleRoles = useMemo(
    () => roles
      .filter((r) => matchesStatusFilter(statusKeyOf(r), statFilter))
      .sort((a, b) => AGENT_STATUS_RANK[displayKeyOf(a)] - AGENT_STATUS_RANK[displayKeyOf(b)]),
    [roles, statFilter],
  );

  const toggleFilter = (f: StatusFilter) => setStatFilter((prev) => (prev === f ? 'all' : f));

  return (
    <div className="h-full flex flex-col u-page-bg">
      <div className="u-page-head">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="page-title">角色管理</h1>
            <p className="page-subtitle">角色清单（状态 / 当前任务 / 实时动态）</p>
          </div>
          <div className="flex gap-2">
            <button className="btn btn-primary" onClick={() => setCreateOpen(true)}>创建角色</button>
          </div>
        </div>

        <div className="flex gap-2 mt-4 flex-wrap">
          <StatFilter label="总数" value={stats.total} active={statFilter === 'all'} onClick={() => setStatFilter('all')} />
          <StatFilter label="工作中" value={stats.working} color="var(--accent-primary)" active={statFilter === 'working'} onClick={() => toggleFilter('working')} />
          <StatFilter label="待处理" value={stats.attention} color="var(--warning)" active={statFilter === 'attention'} onClick={() => toggleFilter('attention')} />
          <StatFilter label="空闲" value={stats.idle} color="var(--text-muted)" active={statFilter === 'idle'} onClick={() => toggleFilter('idle')} />
          <StatFilter label="离线" value={stats.offline} color="var(--text-muted)" active={statFilter === 'offline'} onClick={() => toggleFilter('offline')} />
        </div>
      </div>

      <div className="flex-1 overflow-auto u-page-px pb-8">
        {error && (
          <div className="mt-4 p-3 rounded u-err-dim u-err text-sm">{error}</div>
        )}

        {forbidden ? (
          // #283：monitoring 接口 Admin-only，非 Admin 渲染「无权限」终态
          <div className="text-center py-20 u-text-2">
            <p>无权限查看 Agent 运行数据（需 Admin 权限）</p>
          </div>
        ) : loading && roles.length === 0 ? (
          // 批次 F-3：加载态骨架（批次 E-2 ui/Skeleton 正本）——贴近 agd-grid 卡栅格形态
          <div className="agd-grid">
            <SkeletonCard height={160} />
            <SkeletonCard height={160} />
            <SkeletonCard height={160} />
          </div>
        ) : roles.length === 0 ? (
          // 批次 D-3 项1：空态 = 说明 + 一个明确主行动（直挂 CreateRoleModal，同页头按钮入口）
          <div className="empty-state">
            <p>暂无角色</p>
            <p className="text-sm mt-2">从检测到的 CLI 创建第一个 Agent</p>
            <button className="btn btn-primary mt-4" onClick={() => setCreateOpen(true)}>创建角色</button>
          </div>
        ) : (
          <div className="agd-grid">
            {visibleRoles.map((r) => (
              <RoleCard
                key={r.profile.id}
                role={r}
                lastDone={lastDone[r.profile.id] ?? null}
                channelNames={channelNames}
                onOpenWu={openWu}
              />
            ))}
          </div>
        )}
      </div>

      <CreateRoleModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => void refresh()}
      />

      {/* D-2 项7：WU 就地抽屉（自挂实例 + .ac-drawer-host 全断点 fixed 覆盖宿主，
          同 NotificationBell 先例；仅打开时挂载——空 host div 不占位） */}
      {drawer && (
        <Suspense fallback={null}>
          <div className="ac-drawer-host">
            <WorkUnitDrawer
              drawer={drawer}
              onClose={() => setDrawer(null)}
              onOpenWu={openWu}
              onOpenReq={(reqId) => setDrawer({ kind: 'req', id: reqId })}
            />
          </div>
        </Suspense>
      )}
    </div>
  );
}

/** §6.3：可点击的统计筛选 chip；color = 对应卡面状态色（与卡面一一对应同色） */
function StatFilter({ label, value, color, active, onClick }: {
  label: string; value: number; color?: string; active: boolean; onClick: () => void;
}) {
  return (
    <button
      className={`agd-stat-filter${active ? ' agd-stat-filter-on' : ''}`}
      aria-pressed={active}
      onClick={onClick}
    >
      <span className="font-mono font-bold agd-stat-num" style={{ color: color ?? 'var(--text-primary)' }}>{value}</span>
      <span className="text-sm u-text-3">{label}</span>
    </button>
  );
}
