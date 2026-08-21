// AgentDashboard — 角色（AgentProfile）作战视图（2026-07-31 全流程串联 UX 重构 §5.2）
// 每卡三段式：左=状态 pill/角色名/CLI badge；中=当前 WU + PMO/频道链接 + 最近动态；右=运行时长 + 强制停止
// 数据/实时全部委托 useAgentRoster（名册合并 + SSE 事件路由 + 30s 轮询），本页只做组合与渲染
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAgentRoster, type RosterRole, type RosterActivityItem } from '../hooks/useAgentRoster';
import { type WorkUnit } from '../api/workunit';
import { ConfirmDialog } from '../components/ui';
import {
  deriveAgentStatus,
  AGENT_STATUS_LABELS,
  AGENT_STATUS_COLORS,
  formatUptime,
  formatRelativeTime,
} from '../utils/agentStatus';

export function AgentDashboardPage() {
  const navigate = useNavigate();
  const { roles, activities, lastDone, channelNames, loading, error, forbidden, terminate } = useAgentRoster();
  // 强制停止二次确认（ui/ConfirmDialog，替代原生 window.confirm）
  const [terminateTarget, setTerminateTarget] = useState<string | null>(null);

  const handleConfirmTerminate = () => {
    const id = terminateTarget;
    setTerminateTarget(null);
    if (id) void terminate(id);
  };

  const stats = {
    total: roles.length,
    online: roles.filter((r) => r.profile.isOnline).length,
    active: roles.filter((r) => r.runtime?.status === 'active').length,
    error: roles.filter((r) => r.runtime?.status === 'error').length,
    inactive: roles.filter((r) => r.profile.status !== 'active').length,
  };

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--bg-primary)' }}>
      <div className="px-8 py-6" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="page-title">Agent 管理</h1>
            <p className="page-subtitle">角色清单（状态 / 当前任务 / 实时动态）</p>
          </div>
          <div className="flex gap-2">
            <button className="btn btn-primary" onClick={() => navigate('/setup/roles')}>创建角色</button>
            <Link to="/" className="btn btn-secondary">返回</Link>
          </div>
        </div>

        <div className="flex gap-6 mt-4">
          <StatBadge label="角色总数" value={stats.total} color="u-accent" />
          <StatBadge label="在线" value={stats.online} color="u-accent" />
          <StatBadge label="执行中" value={stats.active} color="u-accent" />
          <StatBadge label="不可用" value={stats.error} color="u-warn" />
          <StatBadge label="已停用" value={stats.inactive} color="u-err" />
        </div>
      </div>

      <div className="flex-1 overflow-auto px-8 pb-8">
        <div className="max-w-5xl">
          {error && (
            <div className="mt-4 p-3 rounded u-err-dim u-err text-sm">{error}</div>
          )}

          {forbidden ? (
            // #283：monitoring 接口 Admin-only，非 Admin 渲染「无权限」终态
            <div className="text-center py-20 u-text-2">
              <div className="text-4xl mb-4">🔒</div>
              <p>无权限查看 Agent 运行数据（需 Admin 权限）</p>
            </div>
          ) : loading && roles.length === 0 ? (
            <div className="text-center py-20 u-text-2">加载中...</div>
          ) : roles.length === 0 ? (
            <div className="text-center py-20 u-text-2">
              <div className="text-4xl mb-4">🤖</div>
              <p>暂无角色</p>
              <p className="text-sm mt-2">点击右上角"创建角色"，从检测到的 CLI 创建第一个 Agent</p>
            </div>
          ) : (
            <div className="space-y-2 mt-4">
              {roles.map((r) => (
                <RoleCard
                  key={r.profile.id}
                  role={r}
                  activities={activities[r.profile.id] ?? []}
                  lastDone={lastDone[r.profile.id] ?? null}
                  channelNames={channelNames}
                  onTerminate={setTerminateTarget}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={terminateTarget != null}
        title="强制停止"
        message="强制停止会将当前任务转人工处理，确认？"
        confirmLabel="确认停止"
        danger
        onConfirm={handleConfirmTerminate}
        onCancel={() => setTerminateTarget(null)}
      />
    </div>
  );
}

function RoleCard({ role, activities, lastDone, channelNames, onTerminate }: {
  role: RosterRole;
  activities: RosterActivityItem[];
  lastDone: WorkUnit | null;
  channelNames: Record<string, string>;
  onTerminate: (instanceId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { profile, runtime } = role;
  const isSystemRole = profile.name === 'studio';
  const wu = runtime?.currentWorkUnit ?? null;
  const statusKey: keyof typeof AGENT_STATUS_LABELS | 'disabled' = profile.status !== 'active'
    ? 'disabled'
    : deriveAgentStatus(runtime?.status ?? null, wu?.status);
  const pillClass = statusKey === 'disabled' ? 'u-surface-2 u-text-3' : AGENT_STATUS_COLORS[statusKey];
  const pillLabel = statusKey === 'disabled' ? '已停用' : AGENT_STATUS_LABELS[statusKey];
  const busy = runtime?.status === 'active' && (wu || runtime.currentWorkUnitId);
  const lastError = runtime?.lastError ?? profile.lastError;
  const latestActivity = activities[activities.length - 1] ?? null;

  return (
    <div className="rounded-lg" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }}>
      <div
        className="p-3 cursor-pointer flex items-start justify-between gap-4"
        onClick={() => setExpanded(!expanded)}
      >
        {/* 左段：状态 pill + 角色名 + CLI badge */}
        <div className="shrink-0" style={{ width: 180 }}>
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-xs px-2 py-0.5 rounded ${pillClass}`}>{pillLabel}</span>
            <Link
              to={`/agents/${profile.id}`}
              className="font-medium u-text u-hover-accent"
              onClick={(e) => e.stopPropagation()}
            >
              {profile.name}
            </Link>
            {isSystemRole && (
              <span className="text-xs px-2 py-0.5 rounded u-surface-2 u-text-3">系统</span>
            )}
          </div>
          <div className="mt-1">
            <span className="text-xs px-2 py-0.5 rounded u-surface-2 u-text-2" title="背后的 CLI">
              CLI: {profile.provider ?? '未配置'}
            </span>
          </div>
        </div>

        {/* 中段（主视觉）：当前 WU / PMO / 频道 / 最近动态；空闲时等待派活 + 最近完成 */}
        <div className="flex-1 min-w-0">
          {busy ? (
            <>
              <div className="flex items-center gap-2 flex-wrap">
                {wu?.type && (
                  <span className="text-xs px-2 py-0.5 rounded u-surface-2 u-text-2">{wu.type}</span>
                )}
                {wu ? (
                  <Link
                    to={`/workunits/${wu.id}`}
                    className="text-sm u-text u-hover-accent truncate"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {wu.title || wu.id}
                  </Link>
                ) : (
                  <span className="text-sm u-text-3 truncate">WorkUnit: {runtime!.currentWorkUnitId}</span>
                )}
                {wu?.claimedAt && (
                  <span className="text-xs u-text-3">已耗时 {formatUptime(wu.claimedAt)}</span>
                )}
              </div>
              <div className="flex items-center gap-2 mt-1 text-xs u-text-2 flex-wrap">
                {runtime?.pmo && (
                  <Link
                    to={`/pmo/project/${runtime.pmo.id}`}
                    className="u-text-2 u-hover-accent truncate"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {runtime.pmo.pmoNumber} · {runtime.pmo.title}
                  </Link>
                )}
                {runtime?.channelId && (
                  <Link
                    to={`/channels/${runtime.channelId}`}
                    className="u-text-2 u-hover-accent"
                    onClick={(e) => e.stopPropagation()}
                  >
                    #{channelNames[runtime.channelId] ?? '频道'}
                  </Link>
                )}
              </div>
              <div className="mt-1 text-xs u-text-3 truncate" title={latestActivity?.text}>
                {latestActivity ? `${latestActivity.text} · ${formatRelativeTime(latestActivity.at)}` : '暂无动态'}
              </div>
            </>
          ) : (
            <>
              <div className="text-sm u-text-2">空闲 · 等待派活</div>
              {lastDone && (
                <div className="mt-1 text-xs u-text-3 truncate">
                  最近完成：
                  <Link
                    to={`/workunits/${lastDone.id}`}
                    className="u-text-2 u-hover-accent"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {lastDone.scope}
                  </Link>
                </div>
              )}
            </>
          )}
          {lastError && (
            <div className="mt-1 text-xs u-warn truncate" title={lastError}>
              ⚠ {lastError}
            </div>
          )}
        </div>

        {/* 右段：运行时长 + 强制停止 */}
        <div className="flex items-center gap-2 shrink-0">
          {runtime && <span className="text-xs u-text-2">运行: {formatUptime(runtime.startedAt)}</span>}
          {runtime && runtime.status !== 'terminated' && (
            <button
              className="text-xs px-2 py-1 rounded u-err-dim u-err u-hover-bg"
              onClick={(e) => { e.stopPropagation(); onTerminate(runtime.id); }}
            >
              强制停止
            </button>
          )}
          <span className="u-text-2 text-sm">{expanded ? '▾' : '▸'}</span>
        </div>
      </div>

      {expanded && (
        <div className="px-3 pb-3 text-sm" style={{ borderTop: '1px solid var(--border-subtle)' }}>
          <div className="mt-2">
            <div className="text-xs u-text-2 mb-1">最近动态</div>
            {activities.length === 0 ? (
              <div className="text-xs u-text-3">暂无动态</div>
            ) : (
              <div className="space-y-0.5">
                {[...activities].reverse().map((a, i) => (
                  <div key={i} className="text-xs u-text-3 flex justify-between gap-2">
                    <span className="truncate" title={a.text}>{a.text}</span>
                    <span className="shrink-0">{formatRelativeTime(a.at)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2 mt-2 text-xs">
            <div><span className="u-text-2">Profile ID:</span> <span className="u-text-3">{profile.id}</span></div>
            <div><span className="u-text-2">CLI Provider:</span> <span className="u-text-3">{profile.provider ?? '未配置'}</span></div>
            <div><span className="u-text-2">Profile Status:</span> <span className="u-text-3">{profile.status}</span></div>
            <div><span className="u-text-2">Online:</span> <span className="u-text-3">{profile.isOnline ? '是' : '否'}</span></div>
            {profile.description && (
              <div className="col-span-2"><span className="u-text-2">描述:</span> <span className="u-text-3">{profile.description}</span></div>
            )}
            {runtime && (
              <>
                <div><span className="u-text-2">Instance ID:</span> <span className="u-text-3">{runtime.id}</span></div>
                <div><span className="u-text-2">Runtime Status:</span> <span className="u-text-3">{runtime.status}</span></div>
                <div><span className="u-text-2">Current WorkUnit:</span> <span className="u-text-3">{runtime.currentWorkUnitId ?? 'none'}</span></div>
                <div><span className="u-text-2">Started:</span> <span className="u-text-3">{new Date(runtime.startedAt).toLocaleString('zh-CN')}</span></div>
              </>
            )}
            {lastError && (
              <div className="col-span-2">
                <span className="u-text-2">Last Error:</span>{' '}
                <span className="u-warn">{lastError}</span>
                {runtime?.lastErrorAt && (
                  <span className="u-text-2"> ({new Date(runtime.lastErrorAt).toLocaleString('zh-CN')})</span>
                )}
              </div>
            )}
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
