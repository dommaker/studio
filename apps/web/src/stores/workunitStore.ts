// WorkUnit Store — Agent Network §3.28c-1
import { create } from 'zustand';
import { workunitApi, type WorkUnit } from '../api/workunit';

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
  createWorkUnit: (data: { scope: string; type?: string }) => Promise<WorkUnit>;
  reviewPassed: (id: string) => Promise<void>;
  reviewRejected: (id: string, reason?: string) => Promise<void>;
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
      const result = data as any;
      set({
        workunits: result?.data ?? result ?? [],
        total: result?.total ?? 0,
        page: result?.page ?? 1,
        loading: false,
      });
    } catch (e: any) {
      set({ error: e?.message ?? 'Failed to load workunits', loading: false });
    }
  },

  createWorkUnit: async (data) => {
    const { data: wu } = await workunitApi.create(data);
    // Refresh list
    await get().loadWorkUnits();
    return wu as any;
  },

  reviewPassed: async (id) => {
    await workunitApi.reviewPassed(id);
    await get().loadWorkUnits();
  },

  reviewRejected: async (id, reason) => {
    await workunitApi.reviewRejected(id, reason);
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
