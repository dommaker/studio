// PERF-05 监控共享数据面：页面各区块消费同一份 overview，TTL + single-flight + seq 守卫。
import { create } from 'zustand';
import type { OverviewMetrics } from '@dommaker/studio-contract';
import { monitoringApi } from '../api/monitoring';
import { createFetchGate, disciplinedFetch } from './fetchDiscipline';

export const MONITORING_OVERVIEW_TTL_MS = 30_000;

interface MonitoringState {
  overview: OverviewMetrics | null;
  overviewError: Error | null;
  overviewLoadedAt: number | null;
  overviewInflight: Promise<void> | null;
  loadOverview: (opts?: { maxAgeMs?: number }) => Promise<void>;
  __resetForTests: () => void;
}

const overviewGate = createFetchGate();

export const useMonitoringStore = create<MonitoringState>((set, get) => ({
  overview: null,
  overviewError: null,
  overviewLoadedAt: null,
  overviewInflight: null,

  loadOverview: async (opts) => disciplinedFetch(
    overviewGate,
    {
      read: () => ({ loadedAt: get().overviewLoadedAt, inflight: get().overviewInflight }),
      setInflight: promise => set({ overviewInflight: promise }),
    },
    { maxAgeMs: opts?.maxAgeMs ?? MONITORING_OVERVIEW_TTL_MS },
    async seq => {
      try {
        const response = await monitoringApi.getOverview();
        if (!overviewGate.isLatest(seq)) return;
        set({ overview: response.data.data, overviewError: null, overviewLoadedAt: Date.now() });
      } catch (error) {
        if (!overviewGate.isLatest(seq)) return;
        set({ overviewError: error instanceof Error ? error : new Error(String(error)) });
      }
    },
  ),

  __resetForTests: () => {
    overviewGate.nextSeq(); // 作废上一用例尚未落地的请求
    set({ overview: null, overviewError: null, overviewLoadedAt: null, overviewInflight: null });
  },
}));
