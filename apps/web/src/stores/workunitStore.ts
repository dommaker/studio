// WorkUnit Store — Agent Network §3.28c-1
import { create } from 'zustand';
import { workunitApi, type PaginatedResponse, type WorkUnit } from '../api/workunit';

interface WorkUnitState {
  workunits: WorkUnit[];
  total: number;
  page: number;
  limit: number;
  statusFilter: string | null;
  typeFilter: string | null;
  loading: boolean;
  error: string | null;

  // Actions
  loadWorkUnits: (params?: { status?: string; type?: string; page?: number }) => Promise<void>;
  /**
   * #318：SSE 负载驱动行更新（对齐批 3 模式，替代 eventTick 整页重拉）。
   * status_changed 直替已有行（insertIfMissing: false——未知行不插入，防跨页重复）；
   * created 插头部（insertIfMissing: true）。与当前 status/type 过滤不符的行就地移除/不插入。
   * 取舍：total 本地 ±1 近似维护，页边界不追齐——靠兜底轮询（useGatedPoll）与重连 refetch 自愈
   * （docs/plans/2026-08-24-wu-events-payload-consumers.md）。
   */
  applyWorkunitEvent: (wu: WorkUnit, opts: { insertIfMissing: boolean }) => void;
  createWorkUnit: (data: { scope: string; type?: string }) => Promise<WorkUnit>;
  reviewPassed: (id: string, summary?: string, defaultAssigneeId?: string) => Promise<void>;
  reviewRejected: (id: string, reason?: string) => Promise<void>;
  /** #284（决策 #250 D1）：pending 人闸确认（→ unassigned 进 frontier 可认领），列表行展开态入口 */
  confirmPending: (id: string) => Promise<void>;
  setStatusFilter: (status: string | null) => void;
  setTypeFilter: (type: string | null) => void;
}

export const useWorkUnitStore = create<WorkUnitState>((set, get) => ({
  workunits: [],
  total: 0,
  page: 1,
  limit: 20,
  statusFilter: null,
  typeFilter: null,
  loading: false,
  error: null,

  loadWorkUnits: async (params) => {
    set({ loading: true, error: null });
    try {
      const { statusFilter, typeFilter, page, limit } = get();
      const { data } = await workunitApi.list({
        status: params?.status ?? statusFilter ?? undefined,
        type: params?.type ?? typeFilter ?? undefined,
        page: params?.page ?? page,
        limit,
      });
      const result = data as PaginatedResponse<WorkUnit>;
      set({
        workunits: result?.data ?? (result as unknown as WorkUnit[]) ?? [],
        total: result?.pagination?.total ?? 0,
        page: result?.pagination?.page ?? 1,
        loading: false,
      });
    } catch (e) {
      set({ error: e?.message ?? 'Failed to load workunits', loading: false });
    }
  },

  applyWorkunitEvent: (wu, { insertIfMissing }) => {
    const { workunits, total, statusFilter, typeFilter } = get();
    const matches = (statusFilter === null || wu.status === statusFilter)
      && (typeFilter === null || wu.type === typeFilter);
    const idx = workunits.findIndex(w => w.id === wu.id);
    if (idx >= 0) {
      if (!matches) {
        set({ workunits: workunits.filter(w => w.id !== wu.id), total: Math.max(0, total - 1) });
        return;
      }
      const next = [...workunits];
      // ADR D2 回退：旧形状负载（无 claimable）直替时保留行原值，不丢「被阻塞」徽标
      next[idx] = { ...wu, claimable: wu.claimable ?? workunits[idx].claimable };
      set({ workunits: next });
      return;
    }
    if (insertIfMissing && matches) {
      set({ workunits: [wu, ...workunits], total: total + 1 });
    }
  },

  createWorkUnit: async (data) => {
    const { data: wu } = await workunitApi.create(data);
    // Refresh list
    await get().loadWorkUnits();
    return wu;
  },

  reviewPassed: async (id, summary, defaultAssigneeId) => {
    await workunitApi.reviewPassed(id, summary, defaultAssigneeId);
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
}));
