// Agent 作战视图数据 hook — 角色名册（profile × runtime 合并）+ SSE 事件路由 + 轮询兜底
// 从 AgentDashboardPage 抽取：页面只负责组合与渲染，数据获取/实时事件/内存纪律归这里。
// 实时：onEvent 订阅 agent.instance.status_changed / workunit.status_changed /
//   workunit.execution.step|stream（按 currentWorkUnitId 反查归属 agent），30s 轮询兜底。
// 内存纪律：每 agent 动态 ≤10 条（流式 thinking/text 逐 chunk 同 key 刷新同一行）。
// 已知 N+1：空闲角色逐个 workunitApi.list 查「最近完成」（GET /workunits 只支持单 assigneeId，
//   后端无批量接口，保持逐查行为）；活跃角色 currentWorkUnit 聚合字段暂缺时逐个 fillWorkUnit 补查。
import { useState, useEffect, useRef, useCallback } from 'react';
import { monitoringApi, type AgentInfo } from '../api/monitoring';
import { channelApi, type AgentProfile } from '../api/channel';
import {
  workunitApi,
  parseExecutionStreamChunk,
  formatExecutionStreamChunkText,
  type WorkUnit,
} from '../api/workunit';
import { useWebSocketContext, type WebSocketMessage } from '../api/websocketHooks';

/** 卡片「最近动态」条目（SSE 实时追加，内存每 agent 最多保留 MAX_ACTIVITIES 条） */
export interface RosterActivityItem {
  /** 去重键：相同键的新条目替换旧条目（流式 thinking/text 逐 chunk 刷新同一行） */
  key?: string;
  at: string;
  text: string;
}

export interface RosterRole {
  profile: AgentProfile;
  runtime: AgentInfo | null;
}

export interface UseAgentRosterResult {
  roles: RosterRole[];
  /** roleId → 动态列表（按时间升序，末尾最新） */
  activities: Record<string, RosterActivityItem[]>;
  /** roleId → 空闲角色最近完成的 WU */
  lastDone: Record<string, WorkUnit | null>;
  /** channelId → 频道名（卡片频道链接展示用） */
  channelNames: Record<string, string>;
  loading: boolean;
  error: string | null;
  /** 手动重拉（silent=true 不闪 loading；30s 轮询与 SSE 外的兜底） */
  refresh: (silent?: boolean) => Promise<void>;
  /** 强制停止实例（POST terminate 后静默重拉；失败写入 error，不抛出） */
  terminate: (instanceId: string) => Promise<void>;
}

export const MAX_ACTIVITIES = 10;
export const ROSTER_POLL_INTERVAL_MS = 30000;

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
export function pushActivity(list: RosterActivityItem[], item: RosterActivityItem): RosterActivityItem[] {
  const last = list[list.length - 1];
  const next = last?.key && last.key === item.key ? [...list.slice(0, -1), item] : [...list, item];
  return next.length > MAX_ACTIVITIES ? next.slice(next.length - MAX_ACTIVITIES) : next;
}

export function useAgentRoster(): UseAgentRosterResult {
  const { onEvent } = useWebSocketContext();
  const [roles, setRoles] = useState<RosterRole[]>([]);
  const [activities, setActivities] = useState<Record<string, RosterActivityItem[]>>({});
  const [lastDone, setLastDone] = useState<Record<string, WorkUnit | null>>({});
  const [channelNames, setChannelNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const rolesRef = useRef<RosterRole[]>([]);
  useEffect(() => {
    rolesRef.current = roles;
  }, [roles]);

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

  const refresh = useCallback(async (silent = false) => {
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
      const idle = merged.filter((r): r is RosterRole & { runtime: AgentInfo } =>
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
    void refresh();
    const timer = setInterval(() => void refresh(true), ROSTER_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  // SSE 实时：状态变更 / 执行动态（参考 useWorkUnitStreamEvents 的过滤模式：按 event_type 分流、按 workUnitId 反查归属）
  useEffect(() => {
    const findRoleByWorkUnit = (workUnitId: string) =>
      rolesRef.current.find((r) =>
        r.runtime?.currentWorkUnitId === workUnitId || r.runtime?.currentWorkUnit?.id === workUnitId);
    const appendActivity = (roleId: string, item: RosterActivityItem) =>
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
        // chunk→文案映射唯一出处：api/workunit.ts formatExecutionStreamChunkText
        const text = formatExecutionStreamChunkText(chunk);
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

  const terminate = useCallback(async (instanceId: string) => {
    try {
      await monitoringApi.terminateInstance(instanceId);
      await refresh(true);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to terminate agent');
    }
  }, [refresh]);

  return { roles, activities, lastDone, channelNames, loading, error, refresh, terminate };
}
