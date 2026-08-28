// AgentDashboard 作战卡（#348 自 AgentDashboardPage 下沉）：三段式——左=状态 pill/角色名/CLI badge；
// 中=当前 WU + PMO/频道链接 + 最近动态；右=运行时长 + 强制停止。
// 动态订阅卡片自持（useRosterActivities 按 roleId 切片）：stream chunk 只重渲本卡，
// 他卡静态壳零重渲；memo + 稳定 props 让轮询驱动的页面重渲也跳过未变卡（#322 三件套）。
import { memo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useRosterActivities, type RosterActivityItem } from '../../stores/rosterActivityStore';
import type { RosterRole } from '../../hooks/useAgentRoster';
import { type WorkUnit } from '../../api/workunit';
import { formatFullTime } from '../../utils/datetime';
import {
  deriveAgentStatus,
  AGENT_STATUS_LABELS,
  AGENT_STATUS_COLORS,
  formatUptime,
  formatRelativeTime,
} from '../../utils/agentStatus';

export const RoleCard = memo(function RoleCard({ role, lastDone, channelNames, onTerminate }: {
  role: RosterRole;
  /** 空闲角色最近完成的 WU（页面按 roleId 切片传入，引用稳定） */
  lastDone: WorkUnit | null;
  channelNames: Record<string, string>;
  onTerminate: (instanceId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const activities: RosterActivityItem[] = useRosterActivities(role.profile.id);
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
                <div><span className="u-text-2">Started:</span> <span className="u-text-3">{formatFullTime(runtime.startedAt)}</span></div>
              </>
            )}
            {lastError && (
              <div className="col-span-2">
                <span className="u-text-2">Last Error:</span>{' '}
                <span className="u-warn">{lastError}</span>
                {runtime?.lastErrorAt && (
                  <span className="u-text-2"> ({formatFullTime(runtime.lastErrorAt)})</span>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
});
