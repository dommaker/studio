// Channel Work Store — #528 频道工作面数据面 store（ADR 2026-08-31-channel-data-plane-store）
// 收编 ChannelDetailPage 的 4 份 per-channel 服务端状态：频道 WU 全集 / 本频道 REQ / 建议端点
// （suggestions+currentWuId 同响应同 slice）/ per-wuId 产出文件集（仿 requirementChainStore per-reqId）。
// 与 channelDataStore 并列不扩它（ADR「域混淆」否决先例：TTL 型慢变数据与事件驱动数据不同质）。
// 纪律：wus/reqs 30s TTL + single-flight + seq 守卫走 fetchDiscipline；suggestions 无 TTL 纯事件驱动，
// SSE 触发面共享的 500ms trailing 防抖内化 store 私有（模块级定时器，见 markSuggestionsDirty）。
import { create } from 'zustand';
import { workunitApi, type WorkUnit } from '../api/workunit';
import { requirementApi, type Requirement, type RequirementStatus } from '../api/requirements';
import { channelApi, type ChannelSuggestion } from '../api/channel';
import { fanOut } from '../utils/fanOut';
import { createFetchGate, disciplinedFetch, type FetchGate, type FetchGateState } from './fetchDiscipline';

/** 缺省 TTL：与 rosterStore / channelDataStore / requirementChainStore 30s 同频——频道间切换 TTL 内零重拉 */
export const CHANNEL_WORK_TTL_MS = 30000;
/** SSE 兜底轮询周期（useChannelWorkStoreSync 消费，只覆盖 wus/reqs；suggestions 纯事件驱动不轮询） */
export const CHANNEL_WORK_POLL_INTERVAL_MS = 30000;

/** #489：建议端点 SSE 触发面共享的 trailing 防抖窗口——一次状态转换常伴随多类事件连发
 *  （status_changed / 里程碑 message_sent / requirement.*），合并为一次请求防风暴；
 *  挂载/重连/动作回扫仍即时重拉，不经防抖 */
export const SUGGESTIONS_RELOAD_DEBOUNCE_MS = 500;

/** 建议端点 slice（GET /channels/:id/suggestions 同响应同 slice，#443/#447） */
export interface SuggestionsSlice {
  suggestions: ChannelSuggestion[];
  /** 后端拣选的「频道当前工单」（阶段条与引导片同源消费，口径单源在后端） */
  currentWuId: string | null;
  /** #488 等价替代 suggestionsResolvedFor 台账：端点已成功返回（非 degraded）→ true；
   *  缺键/false = 加载态（ChannelWorkBar wuIdle 三态数据源） */
  resolved: boolean;
}

interface ChannelWorkState {
  /** channelId → 频道 WU 全集（缺键 = 未拉到：含拉取失败，消费方按空集降级） */
  wus: Record<string, WorkUnit[] | undefined>;
  /** channelId → 本频道 REQ 集（缺键 = 未拉到） */
  reqs: Record<string, Requirement[] | undefined>;
  /** channelId → 建议端点 slice（缺键 = 未拉到/首拉 degraded，消费方按加载态降级） */
  suggestions: Record<string, SuggestionsSlice | undefined>;
  /** wuId → 该 WU 产出/修改文件集（文件 chip 第一优先词表 #285 AC4；失败记 [] 不重试，该 WU 走候选集词表） */
  wuChangedFiles: Record<string, string[] | undefined>;

  ensureWus: (channelId: string, opts?: { maxAgeMs?: number }) => Promise<void>;
  ensureReqs: (channelId: string, opts?: { maxAgeMs?: number }) => Promise<void>;
  /** sync 接线聚合入口：wus/reqs 走 TTL 门禁（兜底轮询消费）；maxAgeMs:0 = 重连语义全 slice 强刷 */
  ensureChannelWork: (channelId: string, opts?: { maxAgeMs?: number }) => Promise<void>;
  /** 建议即时重拉（挂载/重连/动作回扫，不经防抖）；无 TTL 纯事件驱动，seq 守卫晚到旧结果 */
  refreshSuggestions: (channelId: string) => Promise<void>;
  /** SSE 触发面统一入口：标脏 + 500ms trailing 防抖合并一次重拉（store 私有定时器） */
  markSuggestionsDirty: (channelId: string) => void;
  /** agent 消息所属 WU 的产出文件集（distinct wuId 各拉一次并缓存；模块级台账防重拉） */
  ensureWuChangedFiles: (wuIds: string[]) => void;
  /** SSE status_changed 与闸门动作（#545 gateWriter sink）共用快照落点：全量快照直替 upsert
   * （17 字段快照原样落库，删除编造时间戳）；未打底的频道 no-op（等 REST 打底）；坏负载 no-op */
  applyWorkunitSnapshot: (channelId: string, wu: WorkUnit | null | undefined) => void;
  /** #538（ADR 2026-09-15 决策 5）：workunit:removed 删行分支——GC/TTL 删除即时下榜，
   *  不再悬挂到 SSE 重连 refetch；未打底频道/未知 id/坏负载 no-op */
  applyWorkunitRemoved: (channelId: string, wuId: string) => void;
  /** requirement.created/updated 就地 upsert（#415：负载全量零补拉）：created 追加去重 /
   *  updated 全量覆盖已有条目（列表没有则不动，交由重连 refetch）；未打底频道 no-op */
  applyRequirementEvent: (channelId: string, kind: 'created' | 'updated', req: Requirement | null | undefined) => void;
  /** 测试隔离：清空数据面 + 纪律簿记（模块级 loadedAt/inflight/gate/防抖定时器不在 zustand 内） */
  __resetForTests: () => void;
}

// 纪律簿记按 (slice, channelId) 粒度模块级持有：数据在 zustand（消费方订阅），门禁状态不进响应式树
const book = new Map<string, { gate: FetchGate; state: FetchGateState }>();

function sliceOf(key: string): { gate: FetchGate; state: FetchGateState } {
  let s = book.get(key);
  if (!s) {
    s = { gate: createFetchGate(), state: { loadedAt: null, inflight: null } };
    book.set(key, s);
  }
  return s;
}

// 建议防抖簿记（模块级，store 私有）：单定时器 trailing 合并，dirtyChannelId 记最后一次标脏的频道
let suggestionsTimer: ReturnType<typeof setTimeout> | null = null;
let dirtyChannelId: string | null = null;

// wuChangedFiles 已拉台账（模块级）：失败记 [] 落库即占台账位，不重试（对齐旧 wuFilesFetchedRef 语义）
const wuFilesFetched = new Set<string>();

/** #488 工作条占位三态的派生（wuIdle 唯一口径，#528 边界：由 store 派生）：
 *  已 resolved（端点成功返回非 degraded）且 currentWuId=null → 空闲态；缺键/未 resolved/有当前工单 → 加载态 */
export function wuIdleOf(slice: SuggestionsSlice | undefined): boolean {
  return (slice?.resolved ?? false) && slice.currentWuId === null;
}

const REQ_STATUSES = new Set<RequirementStatus>(['open', 'in-progress', 'done', 'archived']);

/** requirement.created/updated SSE data（{ requirement } 信封，同 workunit.status_changed 的 { workunit }）
 *  → 全量 Requirement（#415：service 发布完整对象，与 REST get 同源 → 就地 upsert 零补拉，ADR D1）。
 *  必填字段缺失/坏数据 → null，跳过不编造；channelId 可选，缺省由调用方放行。
 *  ChannelDetailPage 的 invalidateCurrentPmo 白捡接线（边界 1 留页面）也复用本解析。 */
export function parseRequirementPayload(data: unknown): Requirement | null {
  try {
    const p = (typeof data === 'string' ? JSON.parse(data) : data) as Record<string, unknown> | null;
    const req = p?.requirement as Record<string, unknown> | undefined;
    if (!req || typeof req.id !== 'string' || !req.id) return null;
    if (typeof req.seq !== 'number' || !Number.isFinite(req.seq)) return null;
    if (typeof req.title !== 'string' || typeof req.createdAt !== 'string' || typeof req.createdBy !== 'string') return null;
    if (typeof req.status !== 'string' || !REQ_STATUSES.has(req.status as RequirementStatus)) return null;
    return {
      id: req.id,
      seq: req.seq,
      title: req.title,
      status: req.status as RequirementStatus,
      // channelId 缺省不落 key（legacy 记录可能无此字段）——updated 全量合并时不抹掉已有条目已知的归属
      ...(typeof req.channelId === 'string' ? { channelId: req.channelId } : {}),
      createdAt: req.createdAt,
      createdBy: req.createdBy,
      ...(Array.isArray(req.docs) ? { docs: req.docs.filter((d): d is string => typeof d === 'string') } : {}),
      ...(typeof req.description === 'string' ? { description: req.description } : {}),
      ...((typeof req.projectId === 'string' || req.projectId === null)
        ? { projectId: req.projectId as string | null } : {}),
    };
  } catch {
    return null;
  }
}

export const useChannelWorkStore = create<ChannelWorkState>((set, get) => ({
  wus: {},
  reqs: {},
  suggestions: {},
  wuChangedFiles: {},

  ensureWus: (channelId, opts) => {
    const s = sliceOf(`wus:${channelId}`);
    return disciplinedFetch(
      s.gate,
      { read: () => s.state, setInflight: (p) => { s.state.inflight = p; } },
      { maxAgeMs: opts?.maxAgeMs ?? CHANNEL_WORK_TTL_MS },
      async (seq) => {
        try {
          const res = await workunitApi.list({ channelId, limit: 100 });
          if (!s.gate.isLatest(seq)) return;
          set((st) => ({ wus: { ...st.wus, [channelId]: res.data?.data } }));
          s.state.loadedAt = Date.now();
        } catch {
          // 静默降级（对齐旧 reloadChannelWus catch 行为）：不落数据不落锚点 → 下次 ensure 重试
        }
      },
    );
  },

  ensureReqs: (channelId, opts) => {
    const s = sliceOf(`reqs:${channelId}`);
    return disciplinedFetch(
      s.gate,
      { read: () => s.state, setInflight: (p) => { s.state.inflight = p; } },
      { maxAgeMs: opts?.maxAgeMs ?? CHANNEL_WORK_TTL_MS },
      async (seq) => {
        try {
          const res = await requirementApi.list({ channelId });
          if (!s.gate.isLatest(seq)) return;
          set((st) => ({ reqs: { ...st.reqs, [channelId]: res.data?.data } }));
          s.state.loadedAt = Date.now();
        } catch {
          // 静默降级：不落数据不落锚点 → 下次 ensure 重试
        }
      },
    );
  },

  refreshSuggestions: (channelId) => {
    // 无 TTL（纯事件驱动）：maxAgeMs:0 = force 语义恒强拉（不并入在途），晚到旧结果靠 seq 守卫收敛
    const s = sliceOf(`suggestions:${channelId}`);
    return disciplinedFetch(
      s.gate,
      { read: () => s.state, setInflight: (p) => { s.state.inflight = p; } },
      { maxAgeMs: 0 },
      async (seq) => {
        try {
          const res = await channelApi.getSuggestions(channelId);
          if (!s.gate.isLatest(seq)) return;
          // #490：推导失败被吞（degraded=true）≠「确实无建议」——仅 console 记录不打扰用户；
          // 不落数据不置 resolved（ChannelWorkBar 占位保持加载态，不误显空闲），建议面保持上一份
          if (res.data?.data?.degraded === true) {
            console.warn('[channelWorkStore] suggestions derive degraded (fail-closed)', { channelId });
            return;
          }
          // fail-closed：负载畸形/条目缺字段 → 空集，不渲染不编造
          const raw: unknown = res.data?.data?.suggestions;
          const list = Array.isArray(raw) ? raw : [];
          const suggestions = list.filter((x): x is ChannelSuggestion =>
            !!x && typeof x.id === 'string' && typeof x.kind === 'string'
            && !!x.params && typeof x.params === 'object',
          );
          const rawWuId: unknown = res.data?.data?.currentWuId;
          const currentWuId = typeof rawWuId === 'string' ? rawWuId : null;
          set((st) => ({ suggestions: { ...st.suggestions, [channelId]: { suggestions, currentWuId, resolved: true } } }));
          s.state.loadedAt = Date.now();
        } catch {
          // 静默（对齐旧 reloadSuggestions catch 行为）：旧数据保留，不置 resolved
        }
      },
    );
  },

  markSuggestionsDirty: (channelId) => {
    dirtyChannelId = channelId;
    if (suggestionsTimer) clearTimeout(suggestionsTimer);
    suggestionsTimer = setTimeout(() => {
      suggestionsTimer = null;
      const id = dirtyChannelId;
      dirtyChannelId = null;
      if (id) void get().refreshSuggestions(id);
    }, SUGGESTIONS_RELOAD_DEBOUNCE_MS);
  },

  ensureChannelWork: async (channelId, opts) => {
    await Promise.all([
      get().ensureWus(channelId, opts),
      get().ensureReqs(channelId, opts),
      // suggestions 无 TTL 纯事件驱动：仅重连语义（maxAgeMs:0）随全 slice 强刷，兜底轮询不带它
      ...(opts?.maxAgeMs === 0 ? [get().refreshSuggestions(channelId)] : []),
    ]);
  },

  ensureWuChangedFiles: (wuIds) => {
    const pending = wuIds.filter((id) => !wuFilesFetched.has(id));
    if (pending.length === 0) return;
    for (const id of pending) wuFilesFetched.add(id);
    void (async () => {
      const results = await fanOut(pending, (wuId) => workunitApi.getChangedFiles(wuId));
      set((st) => {
        const next = { ...st.wuChangedFiles };
        for (let i = 0; i < pending.length; i++) {
          const r = results[i];
          next[pending[i]] = r.ok ? r.value.data?.data?.files ?? [] : []; // 失败静默降级：该 WU 走候选集词表
        }
        return { wuChangedFiles: next };
      });
    })();
  },

  applyWorkunitSnapshot: (channelId, wu) => {
    // 坏负载防护：缺 id/status 一律 no-op（桥接层理论上恒有，防御旧桥/手工事件）
    if (!wu || typeof wu.id !== 'string' || !wu.id || typeof wu.status !== 'string') return;
    set((st) => {
      const list = st.wus[channelId];
      if (!list) return {}; // 未打底不建 slice：REST 打底会带上该 WU（事件先于落库到达属时序常态）
      const idx = list.findIndex((w) => w.id === wu.id);
      if (idx < 0) {
        // 新 WU：全量快照原样插入（dependsOn 不在快照契约内补空串，时间戳取快照原值不编造）
        return { wus: { ...st.wus, [channelId]: [...list, { dependsOn: '', ...wu }] } };
      }
      // 既有 WU：全量直替（快照缺失字段保留旧值——快照契约无 dependsOn/claimable），数组顺序不变
      const next = [...list];
      next[idx] = { ...next[idx], ...wu };
      return { wus: { ...st.wus, [channelId]: next } };
    });
  },

  applyWorkunitRemoved: (channelId, wuId) => {
    if (!wuId) return;
    set((st) => {
      const list = st.wus[channelId];
      if (!list) return {}; // 未打底不建 slice：REST 打底/重连 refetch 自带终态
      if (!list.some((w) => w.id === wuId)) return {};
      return { wus: { ...st.wus, [channelId]: list.filter((w) => w.id !== wuId) } };
    });
  },

  applyRequirementEvent: (channelId, kind, req) => {
    if (!req || typeof req.id !== 'string' || !req.id) return;
    set((st) => {
      const list = st.reqs[channelId];
      if (!list) return {}; // 未打底不建 slice：交由 REST 打底/重连 refetch
      if (kind === 'created') {
        // 负载即全量（与 REST get 同源）→ 就地 upsert（按 id 去重），零补拉（#415）
        if (list.some((x) => x.id === req.id)) return {};
        return { reqs: { ...st.reqs, [channelId]: [...list, req] } };
      }
      const idx = list.findIndex((r) => r.id === req.id);
      if (idx < 0) return {}; // updated miss：打底/created 未覆盖，交由重连 refetch
      const next = [...list];
      next[idx] = { ...next[idx], ...req };
      return { reqs: { ...st.reqs, [channelId]: next } };
    });
  },

  __resetForTests: () => {
    book.clear();
    wuFilesFetched.clear();
    if (suggestionsTimer) clearTimeout(suggestionsTimer);
    suggestionsTimer = null;
    dirtyChannelId = null;
    set({ wus: {}, reqs: {}, suggestions: {}, wuChangedFiles: {} });
  },
}));
