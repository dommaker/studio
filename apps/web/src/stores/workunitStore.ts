// WorkUnit Store — Agent Network §3.28c-1
import { create } from 'zustand';
import { workunitApi, type PaginatedResponse, type ReviewConfirmPayload, type WorkUnit } from '../api/workunit';

/**
 * #405：未归属判定 —— 无 reqId 且归因戳（canonical pmoId ‖ legacy ownershipProjectId）
 * 解析为 null。与 #428 服务端 parseWuPmoId 同口径（applyWorkunitEvent 的 SSE 增量
 * 匹配用；服务端过滤才是权威，本地判定只防增量事件混入）。
 */
function isUnattributedWu(wu: WorkUnit): boolean {
  if (wu.reqId) return false;
  if (!wu.metadata) return true;
  try {
    const meta = JSON.parse(wu.metadata) as { pmoId?: unknown; ownershipProjectId?: unknown };
    const stamp = (typeof meta.pmoId === 'string' && meta.pmoId) ||
      (typeof meta.ownershipProjectId === 'string' && meta.ownershipProjectId);
    return !stamp;
  } catch {
    return true; // 坏 JSON 按无戳处理（同服务端 parseWuPmoId 容错语义）
  }
}

interface WorkUnitState {
  workunits: WorkUnit[];
  total: number;
  page: number;
  limit: number;
  statusFilter: string | null;
  typeFilter: string | null;
  /** #405：未归属过滤开关（服务端 attributed=false，与 status/type 过滤交集组合） */
  unattributedOnly: boolean;
  /** #405：未归属 WU 总数徽标（服务端 total 口径，非当前页近似）；null = 未拉取 */
  unattributedTotal: number | null;
  /** 全量总数徽标（「总数」chip 专用）：total 是过滤态计数，切 tab 后不能冒充全量。
   *  无过滤的 loadWorkUnits 顺带同步；过滤态由 loadAllCount（limit=1 轻量查）补齐；null = 未拉取 */
  allTotal: number | null;
  /** 批次 D-2 项4：标题搜索词（服务端 q 过滤，与 status/type/attributed 交集）；null = 未激活 */
  searchQuery: string | null;
  loading: boolean;
  error: string | null;

  // Actions
  loadWorkUnits: (params?: { status?: string; type?: string; page?: number }) => Promise<void>;
  /**
   * E2-5（2026-09 页面重设计，承接批次 B-3）：追加式翻页——拉下一页拼接到现有列表尾部
   * （按 id 去重：SSE created 插头部会让后续页行与前页重叠），page 随响应前进。
   * 在途/已到底（workunits.length >= total）时 no-op；统计口径不变（total = pagination.total）。
   */
  loadMoreWorkUnits: () => Promise<void>;
  /**
   * #318：SSE 负载驱动行更新（对齐批 3 模式，替代 eventTick 整页重拉）。
   * status_changed 直替已有行（insertIfMissing: false——未知行不插入，防跨页重复，
   * 即使新进过滤集亦然：服务端过滤 + 分页下无法判定页内归属，取舍 c 见 CONTEXT.md 批 4）；
   * created 插头部（insertIfMissing: true）。与当前 status/type 过滤不符的行就地移除/不插入。
   * 取舍 a：total 本地 ±1 近似维护，页边界不追齐——本页无轮询兜底，自愈靠 SSE 重连 refetch
   * 与操作触发的 loadWorkUnits（docs/plans/2026-08-24-wu-events-payload-consumers.md）。
   */
  applyWorkunitEvent: (wu: WorkUnit, opts: { insertIfMissing: boolean }) => void;
  /** #538（ADR 2026-09-15 决策 5）：workunit:removed 删行分支——按 id 移除，total/allTotal
   *  各 -1 近似维护（同 applyWorkunitEvent 取舍 a：页边界不追齐，重连 refetch 自愈）；
   *  未知行/空 id no-op */
  removeWorkunit: (id: string) => void;
  createWorkUnit: (data: { scope: string; type?: string }) => Promise<WorkUnit>;
  reviewPassed: (id: string, summary?: string, defaultAssigneeId?: string, confirm?: ReviewConfirmPayload) => Promise<void>;
  reviewRejected: (id: string, reason?: string) => Promise<void>;
  /** #284（决策 #250 D1）：pending 人闸确认（→ unassigned 进 frontier 可认领），列表行展开态入口 */
  confirmPending: (id: string) => Promise<void>;
  setStatusFilter: (status: string | null) => void;
  setTypeFilter: (type: string | null) => void;
  /** #405：切换未归属过滤（重置到第 1 页并重拉；on 时顺带同步徽标计数） */
  setUnattributedOnly: (on: boolean) => void;
  /** 批次 D-2 项4：设置标题搜索词（重置到第 1 页并重拉；null/空白 = 清除搜索） */
  setSearchQuery: (q: string | null) => void;
  /** #405：轻量拉取未归属总数徽标（limit=1 只取 pagination.total，best-effort 失败留旧值） */
  loadUnattributedCount: () => Promise<void>;
  /** 轻量拉取全量总数徽标（无任何过滤，limit=1 只取 pagination.total，best-effort 失败留旧值） */
  loadAllCount: () => Promise<void>;
}

export const useWorkUnitStore = create<WorkUnitState>((set, get) => ({
  workunits: [],
  total: 0,
  page: 1,
  limit: 20,
  statusFilter: null,
  typeFilter: null,
  unattributedOnly: false,
  unattributedTotal: null,
  allTotal: null,
  searchQuery: null,
  loading: false,
  error: null,

  loadWorkUnits: async (params) => {
    set({ loading: true, error: null });
    try {
      const { statusFilter, typeFilter, unattributedOnly, searchQuery, page, limit } = get();
      const { data } = await workunitApi.list({
        status: params?.status ?? statusFilter ?? undefined,
        type: params?.type ?? typeFilter ?? undefined,
        // #405：未归属过滤走服务端（#428 attributed 参数）
        attributed: unattributedOnly ? false : undefined,
        // 批次 D-2 项4：标题搜索走服务端 q 参数
        q: searchQuery ?? undefined,
        page: params?.page ?? page,
        limit,
      });
      const result = data as PaginatedResponse<WorkUnit>;
      set({
        workunits: result?.data ?? (result as unknown as WorkUnit[]) ?? [],
        total: result?.pagination?.total ?? 0,
        page: result?.pagination?.page ?? 1,
        // #405：仅无 status/type/q 过滤时本次 total 才是未归属总数，可同步徽标；
        // 交集过滤下 total 是交集计数，不能覆盖徽标（徽标由 loadUnattributedCount 维护）
        ...(unattributedOnly && !(params?.status ?? statusFilter) && !(params?.type ?? typeFilter) && !searchQuery
          ? { unattributedTotal: result?.pagination?.total ?? 0 } : {}),
        // 全量总数徽标：仅无任何过滤时本次 total 才是全量，可同步 allTotal；
        // 过滤态下 total 是过滤计数，「总数」chip 不得随之变脸（过滤态由 loadAllCount 补齐）
        ...(!unattributedOnly && !(params?.status ?? statusFilter) && !(params?.type ?? typeFilter) && !searchQuery
          ? { allTotal: result?.pagination?.total ?? 0 } : {}),
        loading: false,
      });
    } catch (e) {
      set({ error: e?.message ?? 'Failed to load workunits', loading: false });
    }
  },

  loadMoreWorkUnits: async () => {
    const { workunits, total, page, loading } = get();
    if (loading || workunits.length >= total) return;
    set({ loading: true, error: null });
    try {
      const { statusFilter, typeFilter, unattributedOnly, searchQuery, limit } = get();
      const { data } = await workunitApi.list({
        status: statusFilter ?? undefined,
        type: typeFilter ?? undefined,
        attributed: unattributedOnly ? false : undefined,
        q: searchQuery ?? undefined,
        page: page + 1,
        limit,
      });
      const result = data as PaginatedResponse<WorkUnit>;
      const incoming = result?.data ?? [];
      // SSE created 插头部会让下一页与前页行重叠——按 id 去重再拼接
      const seen = new Set(get().workunits.map(w => w.id));
      set({
        workunits: [...get().workunits, ...incoming.filter(w => !seen.has(w.id))],
        total: result?.pagination?.total ?? 0,
        page: result?.pagination?.page ?? page + 1,
        loading: false,
      });
    } catch (e) {
      set({ error: e?.message ?? 'Failed to load workunits', loading: false });
    }
  },

  applyWorkunitEvent: (wu, { insertIfMissing }) => {
    const { workunits, total, statusFilter, typeFilter, unattributedOnly, searchQuery } = get();
    const matches = (statusFilter === null || wu.status === statusFilter)
      && (typeFilter === null || wu.type === typeFilter)
      // #405：未归属过滤态下 SSE 增量不把已归属行混入（服务端口径的本地镜像判定）
      && (!unattributedOnly || isUnattributedWu(wu))
      // 批次 D-2 项4：搜索态下 SSE 增量不匹配 q 就不插入（scope 子串，大小写不敏感，与服务端同口径）
      && (!searchQuery || wu.scope.toLowerCase().includes(searchQuery.toLowerCase()));
    const idx = workunits.findIndex(w => w.id === wu.id);
    if (idx >= 0) {
      if (!matches) {
        // 过滤态下移出当前列表：过滤计数 -1；全局总数 allTotal 不受状态迁移影响
        set({ workunits: workunits.filter(w => w.id !== wu.id), total: Math.max(0, total - 1) });
        return;
      }
      const next = [...workunits];
      // ADR D2 回退：旧形状负载（无 claimable）直替时保留行原值，不丢「被阻塞」徽标
      next[idx] = { ...wu, claimable: wu.claimable ?? workunits[idx].claimable };
      set({ workunits: next });
      return;
    }
    if (insertIfMissing) {
      // created = 全局新增：allTotal 不论是否命中当前过滤都 +1（近似维护，重连 refetch 自愈）
      const allTotal = get().allTotal;
      set({
        ...(matches ? { workunits: [wu, ...workunits], total: total + 1 } : {}),
        ...(allTotal !== null ? { allTotal: allTotal + 1 } : {}),
      });
    }
  },

  removeWorkunit: (id) => {
    if (!id) return;
    const { workunits, total, allTotal } = get();
    if (!workunits.some(w => w.id === id)) return;
    set({
      workunits: workunits.filter(w => w.id !== id),
      total: Math.max(0, total - 1),
      ...(allTotal !== null ? { allTotal: Math.max(0, allTotal - 1) } : {}),
    });
  },

  createWorkUnit: async (data) => {
    const { data: wu } = await workunitApi.create(data);
    // Refresh list
    await get().loadWorkUnits();
    return wu;
  },

  reviewPassed: async (id, summary, defaultAssigneeId, confirm) => {
    await workunitApi.reviewPassed(id, summary, defaultAssigneeId, confirm);
    await get().loadWorkUnits();
  },

  reviewRejected: async (id, reason) => {
    await workunitApi.reviewRejected(id, reason);
    await get().loadWorkUnits();
  },

  confirmPending: async (id) => {
    await workunitApi.transitionStatus(id, 'unassigned');
    await get().loadWorkUnits();
  },

  setStatusFilter: (status) => {
    set({ statusFilter: status, page: 1 });
    get().loadWorkUnits({ status: status ?? undefined, page: 1 });
  },

  setTypeFilter: (type) => {
    set({ typeFilter: type, page: 1 });
    get().loadWorkUnits({ type: type ?? undefined, page: 1 });
  },

  setUnattributedOnly: (on) => {
    set({ unattributedOnly: on, page: 1 });
    get().loadWorkUnits({ page: 1 });
  },

  setSearchQuery: (q) => {
    const normalized = q && q.trim() ? q.trim() : null;
    if (normalized === get().searchQuery) return; // 词未变不重拉（防抖尾抖/重复提交）
    set({ searchQuery: normalized, page: 1 });
    get().loadWorkUnits({ page: 1 });
  },

  loadUnattributedCount: async () => {
    try {
      const { data } = await workunitApi.list({ attributed: false, page: 1, limit: 1 });
      const result = data as PaginatedResponse<WorkUnit>;
      set({ unattributedTotal: result?.pagination?.total ?? 0 });
    } catch {
      // best-effort：徽标留旧值（null = 不显示数字），下次加载/重连自愈
    }
  },

  loadAllCount: async () => {
    try {
      const { data } = await workunitApi.list({ page: 1, limit: 1 });
      const result = data as PaginatedResponse<WorkUnit>;
      set({ allTotal: result?.pagination?.total ?? 0 });
    } catch {
      // best-effort：徽标留旧值（null = chip 回退显示过滤态 total），下次加载/重连自愈
    }
  },
}));
