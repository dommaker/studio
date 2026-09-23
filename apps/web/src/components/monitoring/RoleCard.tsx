// AgentDashboard 信息全卡（#397，redesign-2026-08 §6 定稿变体 B）：四层构成自上而下层级递减——
// ① 头行：状态 pill（色底+色字）+ 角色名（链角色详情）+ CLI chip + 运行时长（mono）；
// ② 视觉锚点：当前 WU 标题（批次 D-2 项7 起开就地抽屉 onOpenWu，不再整页跳；「↗ 详情页」深链在抽屉内）
//   + 类型 chip + 已耗时，次行 PMO · #频道（仍 ↗ 跳页，与右栏先例一致）；
// ③ 最近动态 3 条迷你列表，每条可点（有当前 WU → 开该 WU 抽屉，无 → 角色详情 ↗）；
// ④ 错误行（IconAlertTriangle + lastError，与卡片状态同色；批次 I-6 ⚠ → SVG）。
// 状态色经 data-status（4 态展示键）+ --st 驱动（§6.5 单义延续）：待处理整卡上色、空闲/离线压扁由 CSS 承担；
// 内部 7+1 细分态保留——细分=error 时角色名前加红点角标（.agd-dot-err）。
// 渲染边界（#348 契约不变）：动态订阅卡片自持（useRosterActivities 按 roleId 切片）——stream chunk
// 只重渲本卡，他卡静态壳零重渲；memo + 稳定 props 让轮询驱动的页面重渲也跳过未变卡（#322 三件套）。
// 「强制停止」不在卡面（§6.1 无操作位），能力保留在 AgentDetailPage 头部。
// #630（ADR 2026-09-23 决策 6，修订 #397 §6.1「卡面无操作位」）：卡头加悬停 ⋯ 菜单
// （编辑资料 / 编辑技能 / 删除，删除项对系统保留角色隐藏——服务端拒删 studio），
// 菜单行形态复用 ChannelTopbarMenu 的类名体系（agd-* 族镜像 mc-topbar-menu-*）。
// memo 契约（#348）：菜单开合是卡内局部 state、三个动作回调由页面以稳定引用传入（同 onOpenWu 先例），
// 不传回调则不渲染菜单（测试 Host 沿用旧 props 形态）。
import { memo, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { formatChannelName } from '@dommaker/studio-shared/web';
import { useRosterActivities } from '../../stores/rosterActivityStore';
import { AgentAvatar } from '../channel/AgentAvatar';
import { IconAlertTriangle } from '../ui/icons';
import type { RosterRole } from '../../hooks/useAgentRoster';
import type { WorkUnit } from '../../api/workunit';
import {
  resolveCardStatusKey,
  CARD_TO_DISPLAY_STATUS,
  DISPLAY_STATUS_LABELS,
  formatUptime,
  formatRelativeTime,
} from '../../utils/agentStatus';

export const RoleCard = memo(function RoleCard({ role, lastDone, channelNames, onOpenWu, onEditProfile, onEditSkills, onDelete }: {
  role: RosterRole;
  /** 空闲角色最近完成的 WU（页面按 roleId 切片传入，引用稳定） */
  lastDone: WorkUnit | null;
  channelNames: Record<string, string>;
  /** 批次 D-2 项7：WU 锚点/最近完成/动态行 → 开就地 WU 抽屉（页面须传稳定引用，memo 契约） */
  onOpenWu: (wuId: string) => void;
  /** #630 决策 6：卡头 ⋯ 菜单动作（页面宿主弹框；须稳定引用，memo 契约）。三者皆缺 → 不渲染菜单 */
  onEditProfile?: (role: RosterRole) => void;
  onEditSkills?: (role: RosterRole) => void;
  onDelete?: (role: RosterRole) => void;
}) {
  const activities = useRosterActivities(role.profile.id);
  const { profile, runtime } = role;
  const isSystemRole = profile.name === 'studio';
  // ⋯ 菜单开合（卡内局部 state，不触父级——#348 memo 口径不变）
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const hasMenu = Boolean(onEditProfile || onEditSkills || onDelete);

  // 点击组件外部收起（ChannelTopbarMenu 同款模式）
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      setMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);
  const wu = runtime?.currentWorkUnit ?? null;
  const statusKey = resolveCardStatusKey(profile.status, runtime?.status ?? null, wu?.status);
  const displayKey = CARD_TO_DISPLAY_STATUS[statusKey];
  const busy = runtime?.status === 'active' && Boolean(wu || runtime.currentWorkUnitId);
  const lastError = runtime?.lastError ?? profile.lastError;
  const recent = [...activities].reverse().slice(0, 3);
  // 动态条目落点（§6.1 + D-2 项7）：有当前 WU（含快照未补查回的裸 ID）→ 开该 WU 抽屉；否则 → 角色详情（交互不断链）
  const wuId = wu?.id ?? runtime?.currentWorkUnitId ?? null;

  return (
    <article className="card agd-card" data-testid="agent-card" data-status={displayKey}>
      {/* ① 头行（2026-09-10 第二轮：头像锚点 = 频道气泡/详情页同款 identicon） */}
      <header className="agd-head">
        <AgentAvatar name={profile.name} size={24} />
        <span className="agd-pill">{DISPLAY_STATUS_LABELS[displayKey]}</span>
        {/* 细分=error 时红点角标（4 态合并后保留异常可见性） */}
        {statusKey === 'error' && <span className="agd-dot-err" title="实例异常" />}
        <Link to={`/agents/${profile.id}`} className="agd-name u-text u-hover-accent agd-ellipsis">
          {profile.name}
        </Link>
        {isSystemRole && <span className="agd-chip">系统</span>}
        <span className="agd-chip" title="背后的 CLI">{profile.provider ?? '未配置'}</span>
        {runtime && <span className="agd-num u-text-3" data-visual-ignore>{formatUptime(runtime.startedAt)}</span>}
        {/* #630 决策 6：悬停 ⋯ 菜单（agd-* 族镜像 mc-topbar-menu 类名体系；删除项对系统角色隐藏） */}
        {hasMenu && (
          <div className="agd-menu-wrap" ref={menuRef}>
            <button
              type="button"
              className="agd-menu-btn u-text-3"
              aria-label="角色操作"
              aria-expanded={menuOpen}
              data-testid="role-card-menu-btn"
              onClick={() => setMenuOpen(v => !v)}
            >
              ⋯
            </button>
            {menuOpen && (
              <div className="agd-menu" data-testid="role-card-menu">
                {onEditProfile && (
                  <button type="button" className="agd-menu-item" onClick={() => { setMenuOpen(false); onEditProfile(role); }}>
                    编辑资料
                  </button>
                )}
                {onEditSkills && (
                  <button type="button" className="agd-menu-item" onClick={() => { setMenuOpen(false); onEditSkills(role); }}>
                    编辑技能
                  </button>
                )}
                {onDelete && !isSystemRole && (
                  <button type="button" className="agd-menu-item agd-menu-item-danger" onClick={() => { setMenuOpen(false); onDelete(role); }}>
                    删除
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </header>

      {/* ② 视觉锚点：在做什么 / 空态 */}
      {busy ? (
        <div>
          <div className="agd-wu-row">
            {wu ? (
              // D-2 项7：WU 锚点开就地抽屉（不整页跳；↗ 详情页深链在抽屉内 subject 行）
              <button type="button" className="agd-wu u-text u-hover-accent agd-ellipsis" onClick={() => onOpenWu(wu.id)}>
                {wu.title || wu.id}
              </button>
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
                  {formatChannelName(channelNames[runtime.channelId] ?? '频道')}
                </Link>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="agd-idle u-text-3 agd-ellipsis">
          {!runtime ? '未启动' : runtime.status === 'error' ? '实例异常，未在任务上' : '空闲 · 等待派活'}
          {/* §6.1：「最近完成」入口只属于空闲空态（异常/未启动不拼）；D-2 项7 起开抽屉不整页跳 */}
          {runtime?.status === 'idle' && lastDone && (
            <>
              {' · 最近完成 '}
              <button type="button" className="u-btn-reset u-text-2 u-hover-accent" onClick={() => onOpenWu(lastDone.id)}>{lastDone.scope}</button>
            </>
          )}
        </div>
      )}

      {/* ③ 最近动态 3 条（新→旧），每条可点：有当前 WU → 开抽屉（D-2 项7），无 → 角色详情 ↗ */}
      {recent.length > 0 && (
        <div className="agd-activity">
          {recent.map((a, i) => wuId ? (
            <button key={a.key ?? i} type="button" className="agd-activity-row" title={a.text} onClick={() => onOpenWu(wuId)}>
              <span className="agd-activity-text u-text-2 agd-ellipsis">{a.text}</span>
              <span className="agd-num u-text-3" data-visual-ignore>{formatRelativeTime(a.at)}</span>
            </button>
          ) : (
            <Link key={a.key ?? i} to={`/agents/${profile.id}`} className="agd-activity-row" title={a.text}>
              <span className="agd-activity-text u-text-2 agd-ellipsis">{a.text}</span>
              <span className="agd-num u-text-3" data-visual-ignore>{formatRelativeTime(a.at)}</span>
            </Link>
          ))}
        </div>
      )}

      {/* ④ 错误行（与卡片同色） */}
      {lastError && <div className="agd-error" title={lastError}><IconAlertTriangle size={12} /> {lastError}</div>}
    </article>
  );
});
