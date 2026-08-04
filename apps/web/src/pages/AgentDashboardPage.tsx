// AgentDashboard — 角色（AgentProfile）作战视图（2026-07-31 全流程串联 UX 重构 §5.2）
// 每卡三段式：左=状态 pill/角色名/CLI badge；中=当前 WU + PMO/频道链接 + 最近动态；右=运行时长 + 强制停止
// 实时：WebSocketProvider onEvent 订阅 agent.instance.status_changed / workunit.status_changed /
//   workunit.execution.step|stream（按 currentWorkUnitId 反查归属 agent），30s 轮询兜底，不再手动刷新
import { useState, useEffect, useRef, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { monitoringApi, type AgentInfo } from '../api/monitoring';
import { channelApi, type AgentProfile } from '../api/channel';
import { workunitApi, parseExecutionStreamChunk, type WorkUnit } from '../api/workunit';
import { useWebSocketContext, type WebSocketMessage } from '../api/websocket';
import { api } from '../api/index';
import {
  deriveAgentStatus,
  AGENT_STATUS_LABELS,
  AGENT_STATUS_COLORS,
  formatUptime,
  formatRelativeTime,
} from '../utils/agentStatus';

/** 卡片「最近动态」条目（SSE 实时追加，内存每 agent 最多保留 10 条） */
interface ActivityItem {
  /** 去重键：相同键的新条目替换旧条目（流式 thinking/text 逐 chunk 刷新同一行） */
  key?: string;
  at: string;
  text: string;
}

const MAX_ACTIVITIES = 10;
const POLL_INTERVAL_MS = 30000;

interface MergedRole {
  profile: AgentProfile;
  runtime: AgentInfo | null;
}

/** agent.instance.status_changed（§6.2）的 data 契约 */
interface AgentStatusChangedData {
  profileId?: string;
  instanceId?: string;
  name?: string;
  status?: string;
  currentWorkUnitId?: string | null;
}

function truncate(text: string, max = 60): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** workunit.execution.step → 动态文案（工具调用优先，其次 text/action/步号） */
function stepActivityText(d: Record<string, unknown>): string {
  const toolCalls = Array.isArray(d.toolCalls) ? d.toolCalls : [];
  const first = toolCalls[0] as { tool?: unknown; summary?: unknown } | undefined;
  if (first && typeof first.tool === 'string') {
    return `🔧 ${first.tool}${typeof first.summary === 'string' && first.summary ? ` ${truncate(first.summary, 40)}` : ''}`;
  }
  if (typeof d.text === 'string' && d.text) return truncate(d.text);
  const step = typeof d.step === 'number' ? d.step : '?';
  if (typeof d.action === 'string' && d.action) return `第${step}步 · ${d.action}`;
  return `第${step}步`;
}

/** 追加动态：同 key 替换尾条（流式 chunk 刷新同一行），超出上限丢最旧 */
export function pushActivity(list: ActivityItem[], item: ActivityItem): ActivityItem[] {
  const last = list[list.length - 1];
  const next = last?.key && last.key === item.key ? [...list.slice(0, -1), item] : [...list, item];
  return next.length > MAX_ACTIVITIES ? next.slice(next.length - MAX_ACTIVITIES) : next;
}

export function AgentDashboardPage() {
  const navigate = useNavigate();
  const { onEvent } = useWebSocketContext();
  const [roles, setRoles] = useState<MergedRole[]>([]);
  const [activities, setActivities] = useState<Record<string, ActivityItem[]>>({});
  const [lastDone, setLastDone] = useState<Record<string, WorkUnit | null>>({});
  const [channelNames, setChannelNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const rolesRef = useRef<MergedRole[]>([]);
  rolesRef.current = roles;

  /** 增量补查某 WU 详情并写回对应卡片的 currentWorkUnit（后端聚合字段暂缺/SSE 切换任务时） */
  const fillWorkUnit = useCallback((roleId: string, workUnitId: string) => {
    workunitApi.get(workUnitId)
      .then((r) => {
        const wu = r.data;
        setRoles((prev) => prev.map((role) => {
          if (role.profile.id !== roleId || !role.runtime) return role;
          if (role.runtime.currentWorkUnitId !== workUnitId) return role;
          return {
            ...role,
            runtime: {
              ...role.runtime,
              currentWorkUnit: { id: wu.id, title: wu.scope, type: wu.type, status: wu.status, claimedAt: wu.claimedAt },
            },
          };
        }));
      })
      .catch(() => { /* best-effort：详情查不到时保留裸 ID 展示 */ });
  }, []);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [profilesRes, summaryRes, channelsRes] = await Promise.all([
        channelApi.listAllAgents(),
        monitoringApi.getAgentSummary(),
        channelApi.list(),
      ]);
      // 运行时状态按 roleId 合并（同一角色可能有多条历史 state，接口已按 startedAt 降序，取最新一条）
      const runtimeByRole = new Map<string, AgentInfo>();
      for (const a of summaryRes.data.agents) {
        if (!runtimeByRole.has(a.roleId)) runtimeByRole.set(a.roleId, a);
      }
      const merged = profilesRes.data.data.map((p) => ({ profile: p, runtime: runtimeByRole.get(p.id) ?? null }));
      setRoles(merged);
      setChannelNames(Object.fromEntries((channelsRes.data.data ?? []).map((c) => [c.id, c.name])));
      // 后端聚合字段暂缺时逐卡补查当前 WU 详情
      for (const r of merged) {
        if (r.runtime?.currentWorkUnitId && !r.runtime.currentWorkUnit) {
          fillWorkUnit(r.profile.id, r.runtime.currentWorkUnitId);
        }
      }
      // 空闲卡的「最近完成」：按 instance.id 查 assigneeId，取最近一条 done/completed
      const idle = merged.filter((r): r is MergedRole & { runtime: AgentInfo } =>
        r.runtime !== null && !r.runtime.currentWorkUnitId);
      const doneEntries = await Promise.all(idle.map(async (r) => {
        try {
          const res = await workunitApi.list({ assigneeId: r.runtime.id, limit: 20 });
          const done = res.data.data
            .filter((w) => w.status === 'done' || w.status === 'completed')
            .sort((a, b) => (b.completedAt ?? b.updatedAt).localeCompare(a.completedAt ?? a.updatedAt))[0] ?? null;
          return [r.profile.id, done] as const;
        } catch {
          return [r.profile.id, null] as const;
        }
      }));
      setLastDone(Object.fromEntries(doneEntries));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load agents');
    } finally {
      setLoading(false);
    }
  }, [fillWorkUnit]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(true), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load]);

  // SSE 实时：状态变更 / 执行动态（参考 useWorkUnitStreamEvents 的过滤模式：按 event_type 分流、按 workUnitId 反查归属）
  useEffect(() => {
    const findRoleByWorkUnit = (workUnitId: string) =>
      rolesRef.current.find((r) =>
        r.runtime?.currentWorkUnitId === workUnitId || r.runtime?.currentWorkUnit?.id === workUnitId);
    const appendActivity = (roleId: string, item: ActivityItem) =>
      setActivities((prev) => ({ ...prev, [roleId]: pushActivity(prev[roleId] ?? [], item) }));

    const unsub = onEvent((msg: WebSocketMessage) => {
      if (msg.event_type === 'agent.instance.status_changed') {
        const d = (msg.data ?? {}) as AgentStatusChangedData;
        if (!d.profileId) return;
        setRoles((prev) => prev.map((role) => {
          if (role.profile.id !== d.profileId) return role;
          const base: AgentInfo = role.runtime ?? {
            id: d.instanceId ?? '', roleId: role.profile.id, name: d.name ?? role.profile.name,
            status: 'idle', currentWorkUnitId: null, startedAt: new Date().toISOString(),
          };
          const nextWorkUnitId = d.currentWorkUnitId !== undefined ? d.currentWorkUnitId : base.currentWorkUnitId;
          return {
            ...role,
            runtime: {
              ...base,
              id: d.instanceId ?? base.id,
              status: d.status ?? base.status,
              currentWorkUnitId: nextWorkUnitId,
              // 任务切换 → 清掉旧 WU 快照，等补查写回
              currentWorkUnit: nextWorkUnitId !== base.currentWorkUnitId ? null : base.currentWorkUnit,
            },
          };
        }));
        if (d.currentWorkUnitId) fillWorkUnit(d.profileId, d.currentWorkUnitId);
        return;
      }
      if (msg.event_type === 'workunit.status_changed') {
        const wu = (msg.data as { workunit?: Partial<WorkUnit> } | null)?.workunit;
        if (!wu?.id) return;
        setRoles((prev) => prev.map((role) => {
          const cur = role.runtime?.currentWorkUnit;
          if (!role.runtime || (cur?.id !== wu.id && role.runtime.currentWorkUnitId !== wu.id)) return role;
          const next = cur ?? { id: wu.id, title: '', type: '', status: '', claimedAt: null };
          return {
            ...role,
            runtime: {
              ...role.runtime,
              currentWorkUnit: {
                id: next.id,
                title: typeof wu.scope === 'string' ? wu.scope : next.title,
                type: typeof wu.type === 'string' ? wu.type : next.type,
                status: typeof wu.status === 'string' ? wu.status : next.status,
                claimedAt: next.claimedAt,
              },
            },
          };
        }));
        return;
      }
      if (msg.event_type === 'workunit.execution.step') {
        const d = (msg.data ?? {}) as Record<string, unknown>;
        if (typeof d.workUnitId !== 'string') return;
        const role = findRoleByWorkUnit(d.workUnitId);
        if (!role) return;
        appendActivity(role.profile.id, {
          key: `step:${typeof d.step === 'number' ? d.step : '?'}`,
          at: typeof d.at === 'string' ? d.at : new Date().toISOString(),
          text: stepActivityText(d),
        });
        return;
      }
      if (msg.event_type === 'workunit.execution.stream') {
        const chunk = parseExecutionStreamChunk(msg.data);
        if (!chunk) return;
        const role = findRoleByWorkUnit(chunk.workUnitId);
        if (!role) return;
        const text = chunk.kind === 'tool' && chunk.tool
          ? `🔧 ${chunk.tool}${chunk.summary ? ` ${truncate(chunk.summary, 40)}` : ''}`
          : chunk.kind === 'thinking' && chunk.text
            ? `思考：${truncate(chunk.text, 40)}`
            : chunk.kind === 'text' && chunk.text
              ? truncate(chunk.text)
              : null;
        if (!text) return;
        appendActivity(role.profile.id, {
          key: chunk.kind === 'tool' ? undefined : `stream:${chunk.step}:${chunk.kind}`,
          at: chunk.at || new Date().toISOString(),
          text,
        });
      }
    });
    return unsub;
  }, [onEvent, fillWorkUnit]);

  const handleTerminate = async (instanceId: string) => {
    if (!window.confirm('强制停止会将当前任务转人工处理，确认？')) return;
    try {
      await api.post(`/agent-instances/${instanceId}/terminate`);
      await load(true);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to terminate agent');
    }
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

          {loading && roles.length === 0 ? (
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
                  onTerminate={handleTerminate}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function RoleCard({ role, activities, lastDone, channelNames, onTerminate }: {
  role: MergedRole;
  activities: ActivityItem[];
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
