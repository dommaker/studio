// Agent 作战视图数据 hook — 角色名册（profile × runtime 合并）+ 执行动态流（#346 瘦身后）
// 数据面已上移 rosterStore（#346）：三端点拉取/TTL 去重、agent.instance.status_changed 与
// workunit.status_changed 的 SSE 就地更新、30s 兜底轮询（useGatedPoll）全在 store + useRosterStoreSync；
// 本 hook 只保留作战视图私有面：执行动态（execution.step/stream → activities）、空闲卡「最近完成」
// （lastDone，已知 N+1：GET /workunits 只支持单 assigneeId，后端无批量接口）、当前 WU 快照补查写回。
// 内存纪律：每 agent 动态 ≤10 条（流式 thinking/text 逐 chunk 同 key 刷新同一行）。
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { monitoringApi, type AgentInfo } from '../api/monitoring';
import type { AgentProfile } from '../api/channel';
import {
  workunitApi,
  parseExecutionStreamChunk,
  formatExecutionStreamChunkText,
  type WorkUnit,
} from '../api/workunit';
import { useWebSocketContext, type WebSocketMessage } from '../api/websocketHooks';
import { fanOut } from '../utils/fanOut';
import {
  useRosterStore,
  ROSTER_POLL_INTERVAL_MS,
} from '../stores/rosterStore';
import { useRosterStoreSync } from './useRosterStoreSync';

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
  /** #283：monitoring 接口 Admin-only，非 Admin 403 → true（页面渲染「无权限」终态，轮询停止） */
  forbidden: boolean;
  /** 手动重拉（force）；30s 轮询与 SSE 兜底已由 useRosterStoreSync 接管 */
  refresh: (silent?: boolean) => Promise<void>;
  /** 强制停止实例（POST terminate 后强制重拉；失败写入 error，不抛出） */
  terminate: (instanceId: string) => Promise<void>;
}

export const MAX_ACTIVITIES = 10;

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
  // 数据面接线：SSE 状态事件 → store + 兜底轮询 + 重连对齐（store 化后唯一接线点）
  useRosterStoreSync();
  const profiles = useRosterStore((s) => s.profiles);
  const agents = useRosterStore((s) => s.agents);
  const channels = useRosterStore((s) => s.channels);
  const loadedAt = useRosterStore((s) => s.loadedAt);
  const forbidden = useRosterStore((s) => s.forbidden);
  const storeError = useRosterStore((s) => s.error);
  const { onEvent } = useWebSocketContext();

  const [activities, setActivities] = useState<Record<string, RosterActivityItem[]>>({});
  const [lastDone, setLastDone] = useState<Record<string, WorkUnit | null>>({});
  // terminate 等动作失败单独记（数据面错误在 store.error）；store 错误优先展示
  const [actionError, setActionError] = useState<string | null>(null);
  const error = storeError ?? actionError;

  // profile × runtime 按 roleId 合并（同一角色可能多条历史 state，agents 已按 startedAt 降序取最新）
  const roles = useMemo<RosterRole[]>(() => {
    const runtimeByRole = new Map<string, AgentInfo>();
    for (const a of agents) {
      if (!runtimeByRole.has(a.roleId)) runtimeByRole.set(a.roleId, a);
    }
    return profiles.map((p) => ({ profile: p, runtime: runtimeByRole.get(p.id) ?? null }));
  }, [profiles, agents]);

  const channelNames = useMemo(
    () => Object.fromEntries(channels.map((c) => [c.id, c.name])),
    [channels],
  );

  // 首拉增强（useGatedPoll 挂载首拉已含 ensureFresh；此处补作战视图私有面，按 role 最新 runtime 口径）：
  // ① 后端聚合字段暂缺的卡逐个补查当前 WU 详情写回 store；② 空闲卡「最近完成」N+1（保持既有行为：
  // GET /workunits 只支持单 assigneeId，后端无批量接口）
  const rolesRef = useRef<RosterRole[]>([]);
  useEffect(() => {
    rolesRef.current = roles;
  }, [roles]);
  const loadedAtRef = useRef(loadedAt);
  useEffect(() => {
    loadedAtRef.current = loadedAt;
  }, [loadedAt]);
  useEffect(() => {
    if (loadedAt === null || forbidden) return;
    const current = rolesRef.current;
    // ① 快照补查（best-effort：详情查不到时保留裸 ID 展示）
    for (const r of current) {
      if (r.runtime?.currentWorkUnitId && !r.runtime.currentWorkUnit) {
        useRosterStore.getState().backfillCurrentWorkUnit(r.runtime.id, r.runtime.currentWorkUnitId);
      }
    }
    // ② 空闲卡的「最近完成」：按 instance.id 查 assigneeId，取最近一条 done/completed
    const idle = current.filter((r): r is RosterRole & { runtime: NonNullable<RosterRole['runtime']> } =>
      r.runtime !== null && !r.runtime.currentWorkUnitId);
    void fanOut(idle, async (r) => {
      const res = await workunitApi.list({ assigneeId: r.runtime.id, limit: 20 });
      return res.data.data
        .filter((w) => w.status === 'done' || w.status === 'completed')
        .sort((x, y) => (y.completedAt ?? y.updatedAt).localeCompare(x.completedAt ?? x.updatedAt))[0] ?? null;
    }).then((results) => {
      // 失败口径（fanOut 统一）：该角色查询失败 → null（卡面无最近完成）
      const entries = idle.map((r, i): [string, WorkUnit | null] => {
        const e = results[i];
        return e.ok ? [r.profile.id, e.value] : [r.profile.id, null];
      });
      // 拉取期间又有新数据落地则放弃本次写回（等下轮 loadedAt 变更重算）
      if (loadedAtRef.current === loadedAt) setLastDone(Object.fromEntries(entries));
    });
  }, [loadedAt, forbidden]);

  // SSE 实时：仅执行动态（step/stream）；状态面事件由 useRosterStoreSync 路由进 store
  useEffect(() => {
    const findRoleByWorkUnit = (workUnitId: string) =>
      rolesRef.current.find((r) =>
        r.runtime?.currentWorkUnitId === workUnitId || r.runtime?.currentWorkUnit?.id === workUnitId);
    const appendActivity = (roleId: string, item: RosterActivityItem) =>
      setActivities((prev) => ({ ...prev, [roleId]: pushActivity(prev[roleId] ?? [], item) }));

    const unsub = onEvent((msg: WebSocketMessage) => {
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
  }, [onEvent]);

  const refresh = useCallback(async (silent = false) => {
    // silent（轮询/兜底路径）走 TTL 门禁；显式刷新强制
    await useRosterStore.getState().ensureFresh({ maxAgeMs: silent ? ROSTER_POLL_INTERVAL_MS : 0 });
  }, []);

  const terminate = useCallback(async (instanceId: string) => {
    try {
      await monitoringApi.terminateInstance(instanceId);
      await useRosterStore.getState().ensureFresh({ maxAgeMs: 0 });
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : 'Failed to terminate agent');
    }
  }, []);

  const loading = loadedAt === null && !forbidden && !storeError;
  return { roles, activities, lastDone, channelNames, loading, error, forbidden, refresh, terminate };
}
