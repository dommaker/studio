// PMO Data Store — #456 company/project 数据面 store
// 收口三处「companyApi.list() → 取第一家 → projectApi.list({companyId})」复制链
// （PMOPage / LibraryPage / FileRefChip）：companies 全局单份 + projects per-companyId map，
// projects 口径统一 limit=100（triage 拍板；原 PMOPage 20 与 LibraryPage/FileRefChip 100 漂移）。
// 取数纪律走 fetchDiscipline 底座（TTL 锚点 / single-flight / seq 守卫）；
// 无 SSE 失效事件可用（ADR 2026-08-31 决策 3：不为词表/PMO/成员新增事件），
// 新鲜度 = TTL + 重连强刷 + 兜底轮询（接线在 hooks/usePmoDataStoreSync）。
// 错误语义：ensure 永不 reject，失败落 *Error 状态（PMOPage 错误条用）、不落 TTL 锚点（下次调用重试）。
import { create } from 'zustand';
import { companyApi, type Company } from '../api/company';
import { projectApi } from '../api';
import type { Project } from '../components/pmo/types';
import { createFetchGate, disciplinedFetch, type FetchGate, type FetchGateState } from './fetchDiscipline';

/** 缺省 TTL：与 rosterStore/channelDataStore 30s 同频——PMO ↔ 阅览室路由切换 TTL 内零重拉（#456 验收） */
export const PMO_DATA_TTL_MS = 30000;
/** 兜底轮询周期（usePmoDataStoreSync 消费） */
export const PMO_DATA_POLL_INTERVAL_MS = 30000;
/** projects 列表统一口径（triage 拍板 limit=100） */
export const PMO_PROJECTS_LIMIT = 100;

/**
 * PMO 项目列表行 = 共享领域类型 Project（components/pmo/types）+ FileRefChip 的
 * gitRepo 匹配字段。projectApi.list 响应无声明类型，后端返回全字段。
 */
export interface PmoProject extends Project {
  gitRepo?: string | null;
  deliveries?: { gitRepo?: string | null }[];
}

interface PmoDataState {
  /** 公司列表（服务端按 createdAt 倒序；消费方取 [0] 作为默认公司）。undefined = 未拉到 */
  companies: Company[] | undefined;
  /** companies 切片最近一次失败消息（成功落库即清） */
  companiesError: string | null;
  /** companyId → 项目列表（缺键 = 未拉到：含拉取失败，消费方按空列表降级） */
  projects: Record<string, PmoProject[] | undefined>;
  /** companyId → 最近一次失败消息（缺键/null = 无错误） */
  projectsError: Record<string, string | null>;

  ensureCompanies: (opts?: { maxAgeMs?: number }) => Promise<void>;
  ensureProjects: (companyId: string, opts?: { maxAgeMs?: number }) => Promise<void>;
  /** usePmoDataStoreSync 接线目标：companies + 已驻留 projects 键一起刷（各自 TTL 门禁） */
  ensureFresh: (opts?: { maxAgeMs?: number }) => Promise<void>;
  /** 测试隔离：清空数据面 + 纪律簿记（模块级 loadedAt/inflight/gate 不在 zustand 内） */
  __resetForTests: () => void;
}

// 纪律簿记模块级持有：数据在 zustand（消费方订阅），门禁状态不进响应式树
const companiesBook = { gate: createFetchGate(), state: { loadedAt: null, inflight: null } as FetchGateState };
const projectsBook = new Map<string, { gate: FetchGate; state: FetchGateState }>();

function projectsSliceOf(companyId: string): { gate: FetchGate; state: FetchGateState } {
  let s = projectsBook.get(companyId);
  if (!s) {
    s = { gate: createFetchGate(), state: { loadedAt: null, inflight: null } };
    projectsBook.set(companyId, s);
  }
  return s;
}

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : '加载失败，请重试');

export const usePmoDataStore = create<PmoDataState>((set, get) => ({
  companies: undefined,
  companiesError: null,
  projects: {},
  projectsError: {},

  ensureCompanies: (opts) => {
    const s = companiesBook;
    return disciplinedFetch(
      s.gate,
      { read: () => s.state, setInflight: (p) => { s.state.inflight = p; } },
      { maxAgeMs: opts?.maxAgeMs ?? PMO_DATA_TTL_MS },
      async (seq) => {
        try {
          const res = await companyApi.list();
          if (!s.gate.isLatest(seq)) return;
          set({ companies: res.data?.data ?? [], companiesError: null });
          s.state.loadedAt = Date.now();
        } catch (e) {
          if (!s.gate.isLatest(seq)) return;
          // 失败不落数据不落锚点（下次调用重试）；错误落状态供错误条展示
          set({ companiesError: errorMessage(e) });
        }
      },
    );
  },

  ensureProjects: (companyId, opts) => {
    const s = projectsSliceOf(companyId);
    return disciplinedFetch(
      s.gate,
      { read: () => s.state, setInflight: (p) => { s.state.inflight = p; } },
      { maxAgeMs: opts?.maxAgeMs ?? PMO_DATA_TTL_MS },
      async (seq) => {
        try {
          const res = await projectApi.list({ companyId, limit: PMO_PROJECTS_LIMIT });
          if (!s.gate.isLatest(seq)) return;
          set((st) => ({
            projects: { ...st.projects, [companyId]: (res.data?.data ?? []) as PmoProject[] },
            projectsError: { ...st.projectsError, [companyId]: null },
          }));
          s.state.loadedAt = Date.now();
        } catch (e) {
          if (!s.gate.isLatest(seq)) return;
          set((st) => ({ projectsError: { ...st.projectsError, [companyId]: errorMessage(e) } }));
        }
      },
    );
  },

  ensureFresh: async (opts) => {
    await get().ensureCompanies(opts);
    await Promise.all(
      Object.keys(get().projects).map((companyId) => get().ensureProjects(companyId, opts)),
    );
  },

  __resetForTests: () => {
    companiesBook.state.loadedAt = null;
    companiesBook.state.inflight = null;
    projectsBook.clear();
    set({ companies: undefined, companiesError: null, projects: {}, projectsError: {} });
  },
}));
