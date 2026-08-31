// Roster Store — #346 roster 数据面 store 化（对齐 workunitStore 先例）
// 三端点（channelApi.listAllAgents / monitoringApi.getAgentSummary / channelApi.list）TTL 缓存 +
// single-flight 去重（#403 起纪律走 stores/fetchDiscipline 底座，接线走 useDataPlaneSync）；
// agent.instance.status_changed / workunit.status_changed 的 SSE 就地更新唯一一份
// （合并 useAgentRoster 与 ChannelRail 两副本语义，未匹配实例合成条目取 ChannelRail #313 行为）。
// 切片独立拉取（Promise.allSettled）：getAgentSummary 是 Admin-only（#283），403 → forbidden 终态，
// 但 profiles/channels 照常落库——非 Admin 仍可用频道列表与角色档案。
// 轮询兜底与 SSE 路由的接线在 useRosterStoreSync；消费方用 selector 订阅（useAgentRoster / ChannelRail 等）。
import { create } from 'zustand';
import { monitoringApi, type AgentCurrentWorkUnit, type AgentInfo, type AgentPmoRef } from '../api/monitoring';
import { channelApi, type AgentProfile, type Channel } from '../api/channel';
import { isForbidden } from '../utils/http';
import { workunitApi, type WorkUnit } from '../api/workunit';
import { useAuthStore } from './authStore';
import { createFetchGate, disciplinedFetch } from './fetchDiscipline';

/** ensureFresh 默认 TTL：与 30s 兜底轮询同频——路由切换 TTL 内零重拉（#346 验收） */
export const ROSTER_TTL_MS = 30000;
/** #313：SSE 断开且页面 visible 时的兜底轮询周期（useRosterStoreSync 消费） */
export const ROSTER_POLL_INTERVAL_MS = 30000;

/** agent.instance.status_changed（§6.2）的 data 契约；#312 起 additive 带摘要快照（对齐 getAgentSummary） */
export interface AgentStatusChangedData {
  profileId?: string;
  instanceId?: string;
  name?: string;
  status?: string;
  currentWorkUnitId?: string | null;
  /** #312：当前 WU 快照（含 WU 时非 null；悬空 WU → null；旧事件无此字段 → undefined 走补查兜底） */
  currentWorkUnit?: AgentCurrentWorkUnit | null;
  /** #312：当前 WU 所在频道（无当前 WU → null） */
  channelId?: string | null;
  /** #318 additive：当前 WU 所属 PMO（缺键 = 旧形状，回退保留原值） */
  pmo?: AgentPmoRef | null;
  startedAt?: string;
  lastError?: string | null;
  lastErrorAt?: string | null;
}

/** WU 详情 → 卡片当前任务快照映射（roster 补查与 AgentDetailPage 补查共用） */
export function workUnitToCurrentWorkUnit(wu: WorkUnit): AgentCurrentWorkUnit {
  return { id: wu.id, title: wu.scope, type: wu.type, status: wu.status, claimedAt: wu.claimedAt };
}

/**
 * 客户端切片：listAllAgents 全量正本 → /agent-profiles?status=active 等价过滤（#403 ADR 决策 2）。
 * includeSystem=false 时排除 studio 角色（对齐服务端 AC-1.4 默认排除语义——旧 listAgents 消费方
 * 看不到 studio，切片必须一致，否则 mention/成员面板混入系统角色）。
 */
export function activeAgentsOf(profiles: AgentProfile[], includeSystem = false): AgentProfile[] {
  return profiles.filter((p) => p.status === 'active' && (includeSystem || p.name !== 'studio'));
}

interface RosterState {
  /** /agent-profiles 全量角色档案（listAllAgents，含系统角色与 inactive） */
  profiles: AgentProfile[];
  /** /monitoring/agents 运行实例摘要（按 startedAt 降序，含 terminated 历史实例；展示面自行过滤/去重） */
  agents: AgentInfo[];
  /** /channels 频道列表 */
  channels: Channel[];
  loading: boolean;
  error: string | null;
  /** #283：monitoring 接口 Admin-only，非 Admin 403 → true（终态：后续 ensureFresh 短路；换登录态解除） */
  forbidden: boolean;
  /** 任一切片成功落库的时间戳（TTL 锚点；全失败不更新，下次调用重试） */
  loadedAt: number | null;
  /** channels 切片已结算过至少一次（useChannelList 的 loading 只看频道自己，不被慢的 summary 拖住） */
  channelsLoadedOnce: boolean;
  /** agents 切片已结算过至少一次（ChannelRail 等的「加载中」只看 summary 自己） */
  agentsLoadedOnce: boolean;
  /** profiles 切片成功落库过至少一次（#403：App boot 角色检测的评估锚点——失败不置位，防误评空列表） */
  profilesLoadedOnce: boolean;
  /** 进行中的 ensureFresh（single-flight 去重锚点） */
  inflight: Promise<void> | null;
  /** 登录 token 指纹：变化时解除 forbidden / 强制下次重拉（换号不背上一账号的终态与缓存） */
  lastToken: string | null;

  /**
   * 三端点拉取（TTL 门禁 + single-flight）。永不 reject（错误落 error/forbidden 状态）。
   * maxAgeMs 缺省 ROSTER_TTL_MS；传 0 强制重拉（terminate 后、SSE 重连对齐等）。
   */
  ensureFresh: (opts?: { maxAgeMs?: number }) => Promise<void>;
  /** agent.instance.status_changed 就地更新（唯一一份；未匹配实例合成条目插头部；旧形状事件带补查兜底） */
  applyInstanceStatusEvent: (d: AgentStatusChangedData) => void;
  /** workunit.status_changed 就地更新命中实例的当前任务快照（title/type/status 落加法） */
  applyWorkunitStatusEvent: (wu: { id: string } & Partial<WorkUnit>) => void;
  /** 补查写回：WU 详情落进对应实例的 currentWorkUnit（instanceId + currentWorkUnitId 双匹配防漂移） */
  patchAgentCurrentWorkUnit: (instanceId: string, snapshot: AgentCurrentWorkUnit) => void;
  /** 旧形状事件/聚合字段暂缺的补查兜底：拉 WU 详情并写回（best-effort，失败静默保留裸 ID） */
  backfillCurrentWorkUnit: (instanceId: string, workUnitId: string) => void;
  /** 创建频道后追加进 channels 切片（useChannelList.createChannel 写入） */
  appendChannel: (ch: Channel) => void;
}

/** 取数纪律底座（#403 决策 6）：seq 守卫锚点。TTL / single-flight / inflight 生命周期走 disciplinedFetch */
const rosterGate = createFetchGate();

export const useRosterStore = create<RosterState>((set, get) => ({
  profiles: [],
  agents: [],
  channels: [],
  loading: false,
  error: null,
  forbidden: false,
  loadedAt: null,
  channelsLoadedOnce: false,
  agentsLoadedOnce: false,
  profilesLoadedOnce: false,
  inflight: null,
  lastToken: null,

  ensureFresh: async (opts) => {
    const maxAgeMs = opts?.maxAgeMs ?? ROSTER_TTL_MS;
    const state = get();
    // 换号（登出/换登录）后不背上一账号的 403 终态与 TTL 缓存
    const token = useAuthStore.getState().token;
    const tokenChanged = token !== state.lastToken;
    if (state.forbidden && !tokenChanged) return;
    return disciplinedFetch(
      rosterGate,
      { read: () => ({ loadedAt: get().loadedAt, inflight: get().inflight }), setInflight: (p) => set({ inflight: p }) },
      // tokenChanged 只跳过 TTL（对齐旧序：single-flight 并入在前，换号不绕过在途 fetch）
      { maxAgeMs, bypassTtl: tokenChanged },
      async (seq) => {
        set({ loading: true });
        // try/finally 兜底：mock 缺端点等同步异常也不破坏「ensureFresh 永不 reject」契约
        try {
          const [profilesRes, summaryRes, channelsRes] = await Promise.allSettled([
            channelApi.listAllAgents(),
            monitoringApi.getAgentSummary(),
            channelApi.list(),
          ]);
          const patch: Partial<RosterState> = { loading: false, lastToken: token };
          let anyFulfilled = false;
          let firstError: string | null = null;

          if (profilesRes.status === 'fulfilled') {
            patch.profiles = profilesRes.value.data?.data ?? [];
            patch.profilesLoadedOnce = true;
            anyFulfilled = true;
          } else {
            firstError = profilesRes.reason instanceof Error ? profilesRes.reason.message : 'Failed to load agent profiles';
          }

          if (summaryRes.status === 'fulfilled') {
            patch.agents = summaryRes.value.data?.agents ?? [];
            patch.agentsLoadedOnce = true;
            patch.forbidden = false;
            anyFulfilled = true;
          } else if (isForbidden(summaryRes.reason)) {
            // #283：403 是无权限终态——短路后续请求，不刷 403
            patch.forbidden = true;
            patch.agentsLoadedOnce = true;
            patch.error = null;
          } else {
            patch.agentsLoadedOnce = true;
            firstError ??= summaryRes.reason instanceof Error ? summaryRes.reason.message : 'Failed to load agents';
          }

          if (channelsRes.status === 'fulfilled') {
            patch.channels = channelsRes.value.data?.data ?? [];
            patch.channelsLoadedOnce = true;
            anyFulfilled = true;
          } else {
            patch.channelsLoadedOnce = true;
            firstError ??= channelsRes.reason instanceof Error ? channelsRes.reason.message : 'Failed to load channels';
          }

          if (patch.forbidden) {
            // 终态不写 error（页面渲染「无权限」而非错误横幅）
            patch.error = null;
          } else if (firstError) {
            patch.error = firstError;
          } else {
            patch.error = null;
          }
          if (anyFulfilled) patch.loadedAt = Date.now();
          if (rosterGate.isLatest(seq)) set(patch);
        } catch (e) {
          if (rosterGate.isLatest(seq)) set({ loading: false, error: e instanceof Error ? e.message : 'Failed to load roster' });
        }
      },
    );
  },

  applyInstanceStatusEvent: (d) => {
    if (!d.profileId && !d.instanceId) return;
    const { agents } = get();
    // error 事件可能携带新建 error state 的 instanceId（≠列表里的 id），roleId 兜底匹配（ChannelRail #312 语义）
    const idx = agents.findIndex((a) =>
      (d.instanceId && a.id === d.instanceId) || (!!d.profileId && a.roleId === d.profileId));
    if (idx >= 0) {
      const base = agents[idx];
      const nextWorkUnitId = d.currentWorkUnitId !== undefined ? d.currentWorkUnitId : base.currentWorkUnitId;
      const next: AgentInfo = {
        ...base,
        id: d.instanceId ?? base.id,
        name: d.name ?? base.name,
        status: d.status ?? base.status,
        currentWorkUnitId: nextWorkUnitId,
        // #312：负载带快照（含 null）以负载为准；无快照字段（旧事件）才退回
        // 原行为——任务切换清掉旧 WU 快照，等补查写回
        currentWorkUnit: d.currentWorkUnit !== undefined
          ? (d.currentWorkUnit ?? null)
          : (nextWorkUnitId !== base.currentWorkUnitId ? null : base.currentWorkUnit),
        channelId: d.channelId !== undefined ? d.channelId : base.channelId,
        pmo: d.pmo !== undefined ? d.pmo : base.pmo,
        startedAt: d.startedAt ?? base.startedAt,
        lastError: d.lastError !== undefined ? d.lastError : base.lastError,
        lastErrorAt: d.lastErrorAt !== undefined ? d.lastErrorAt : base.lastErrorAt,
      };
      const nextAgents = [...agents];
      nextAgents[idx] = next;
      set({ agents: nextAgents });
    } else {
      // #313：新实例合成（负载字段够渲染状态点/名字；agents 按 startedAt 降序，插头部；
      // 轮询不再承担发现职责——SSE 连着时它不起表）
      const synth: AgentInfo = {
        id: d.instanceId ?? d.profileId ?? '',
        roleId: d.profileId ?? '',
        name: d.name ?? d.profileId ?? '',
        status: d.status ?? 'idle',
        currentWorkUnitId: d.currentWorkUnitId ?? null,
        currentWorkUnit: d.currentWorkUnit ?? null,
        channelId: d.channelId ?? null,
        startedAt: new Date().toISOString(),
        lastError: d.lastError ?? null,
        lastErrorAt: d.lastErrorAt ?? null,
      };
      set({ agents: [synth, ...agents] });
    }
    // #312：负载未带快照字段（旧事件/异常）才补查兜底；带快照（含悬空 null）不补查
    if (d.currentWorkUnitId && d.currentWorkUnit === undefined) {
      get().backfillCurrentWorkUnit(d.instanceId ?? d.profileId ?? '', d.currentWorkUnitId);
    }
  },

  applyWorkunitStatusEvent: (wu) => {
    if (!wu?.id) return;
    set((state) => ({
      agents: state.agents.map((a) => {
        const cur = a.currentWorkUnit;
        if (cur?.id !== wu.id && a.currentWorkUnitId !== wu.id) return a;
        const next = cur ?? { id: wu.id, title: '', type: '', status: '', claimedAt: null };
        return {
          ...a,
          currentWorkUnit: {
            id: next.id,
            title: typeof wu.scope === 'string' ? wu.scope : next.title,
            type: typeof wu.type === 'string' ? wu.type : next.type,
            status: typeof wu.status === 'string' ? wu.status : next.status,
            claimedAt: next.claimedAt,
          },
        };
      }),
    }));
  },

  patchAgentCurrentWorkUnit: (instanceId, snapshot) => {
    set((state) => ({
      agents: state.agents.map((a) => {
        if (a.id !== instanceId || a.currentWorkUnitId !== snapshot.id) return a;
        return { ...a, currentWorkUnit: snapshot };
      }),
    }));
  },

  backfillCurrentWorkUnit: (instanceId, workUnitId) => {
    // best-effort：详情查不到时保留裸 ID 展示
    workunitApi.get(workUnitId)
      .then((r) => {
        useRosterStore.getState().patchAgentCurrentWorkUnit(instanceId, workUnitToCurrentWorkUnit(r.data));
      })
      .catch(() => {});
  },

  appendChannel: (ch) => {
    set((state) => ({ channels: [...state.channels, ch], channelsLoadedOnce: true }));
  },
}));
