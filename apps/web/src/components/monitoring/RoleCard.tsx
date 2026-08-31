// AgentDashboard 信息全卡（#397，redesign-2026-08 §6 定稿变体 B）：四层构成自上而下层级递减——
// ① 头行：状态 pill（色底+色字）+ 角色名（链角色详情）+ CLI chip + 运行时长（mono）；
// ② 视觉锚点：当前 WU 标题（链 WU 详情）+ 类型 chip + 已耗时，次行 PMO · #频道；空闲/未启动/异常各有空态；
// ③ 最近动态 3 条迷你列表，每条可点（有当前 WU → WU 详情，无 → 角色详情）；
// ④ 错误行（⚠ lastError，与卡片状态同色）。
// 状态色经 data-status + --st 驱动（§6.5 单义）；阻塞/异常整卡上色、空闲/未启动压扁由 CSS 承担。
// 渲染边界（#348 契约不变）：动态订阅卡片自持（useRosterActivities 按 roleId 切片）——stream chunk
// 只重渲本卡，他卡静态壳零重渲；memo + 稳定 props 让轮询驱动的页面重渲也跳过未变卡（#322 三件套）。
// 「强制停止」不在卡面（§6.1 无操作位），能力保留在 AgentDetailPage 头部。
import { memo } from 'react';
import { Link } from 'react-router-dom';
import { useRosterActivities } from '../../stores/rosterActivityStore';
import type { RosterRole } from '../../hooks/useAgentRoster';
import type { WorkUnit } from '../../api/workunit';
import {
  resolveCardStatusKey,
  CARD_STATUS_LABELS,
  formatUptime,
  formatRelativeTime,
} from '../../utils/agentStatus';

export const RoleCard = memo(function RoleCard({ role, lastDone, channelNames }: {
  role: RosterRole;
  /** 空闲角色最近完成的 WU（页面按 roleId 切片传入，引用稳定） */
  lastDone: WorkUnit | null;
  channelNames: Record<string, string>;
}) {
  const activities = useRosterActivities(role.profile.id);
  const { profile, runtime } = role;
  const isSystemRole = profile.name === 'studio';
  const wu = runtime?.currentWorkUnit ?? null;
  const statusKey = resolveCardStatusKey(profile.status, runtime?.status ?? null, wu?.status);
  const busy = runtime?.status === 'active' && Boolean(wu || runtime.currentWorkUnitId);
  const lastError = runtime?.lastError ?? profile.lastError;
  const recent = [...activities].reverse().slice(0, 3);
  // 动态条目落点（§6.1）：有当前 WU（含快照未补查回的裸 ID）→ WU 详情；否则 → 角色详情（交互不断链）
  const wuId = wu?.id ?? runtime?.currentWorkUnitId ?? null;
  const activityTarget = wuId ? `/workunits/${wuId}` : `/agents/${profile.id}`;

  return (
    <article className="card agd-card" data-testid="agent-card" data-status={statusKey}>
      {/* ① 头行 */}
      <header className="agd-head">
        <span className="agd-pill">{CARD_STATUS_LABELS[statusKey]}</span>
        <Link to={`/agents/${profile.id}`} className="agd-name u-text u-hover-accent agd-ellipsis">
          {profile.name}
        </Link>
        {isSystemRole && <span className="agd-chip">系统</span>}
        <span className="agd-chip" title="背后的 CLI">{profile.provider ?? '未配置'}</span>
        {runtime && <span className="agd-num u-text-3" data-visual-ignore>{formatUptime(runtime.startedAt)}</span>}
      </header>

      {/* ② 视觉锚点：在做什么 / 空态 */}
      {busy ? (
        <div>
          <div className="agd-wu-row">
            {wu ? (
              <Link to={`/workunits/${wu.id}`} className="agd-wu u-text u-hover-accent agd-ellipsis">
                {wu.title || wu.id}
              </Link>
            ) : (
              <span className="agd-wu u-text-3 agd-ellipsis">WorkUnit: {runtime!.currentWorkUnitId}</span>
            )}
            {wu?.type && <span className="agd-chip">{wu.type}</span>}
            {wu?.claimedAt && (
              <span className="agd-num u-text-3" data-visual-ignore>已耗时 {formatUptime(wu.claimedAt)}</span>
            )}
          </div>
          {(runtime?.pmo || runtime?.channelId) && (
            <div className="agd-sub u-text-2 agd-ellipsis">
              {runtime?.pmo && (
                <Link to={`/pmo/project/${runtime.pmo.id}`} className="u-hover-accent">
                  {runtime.pmo.pmoNumber} · {runtime.pmo.title}
                </Link>
              )}
              {runtime?.pmo && runtime?.channelId && ' · '}
              {runtime?.channelId && (
                <Link to={`/channels/${runtime.channelId}`} className="u-hover-accent">
                  #{channelNames[runtime.channelId] ?? '频道'}
                </Link>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="agd-idle u-text-3 agd-ellipsis">
          {!runtime ? '未启动' : runtime.status === 'error' ? '实例异常，未在任务上' : '空闲 · 等待派活'}
          {/* §6.1：「最近完成」链接只属于空闲空态（异常/未启动不拼） */}
          {runtime?.status === 'idle' && lastDone && (
            <>
              {' · 最近完成 '}
              <Link to={`/workunits/${lastDone.id}`} className="u-text-2 u-hover-accent">{lastDone.scope}</Link>
            </>
          )}
        </div>
      )}

      {/* ③ 最近动态 3 条（新→旧），每条可点 */}
      {recent.length > 0 && (
        <div className="agd-activity">
          {recent.map((a, i) => (
            <Link key={a.key ?? i} to={activityTarget} className="agd-activity-row" title={a.text}>
              <span className="agd-activity-text u-text-2 agd-ellipsis">{a.text}</span>
              <span className="agd-num u-text-3" data-visual-ignore>{formatRelativeTime(a.at)}</span>
            </Link>
          ))}
        </div>
      )}

      {/* ④ 错误行（与卡片同色） */}
      {lastError && <div className="agd-error" title={lastError}>⚠ {lastError}</div>}
    </article>
  );
});
