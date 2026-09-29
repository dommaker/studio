// Projects Store — /projects/discover 本地工程发现数据面（2026-09 B3 频道前端效率批）
// 收编前每开一次顶栏 ⋯ 菜单（ChannelDefaultProjectSelect）/ 转任务弹窗（ConvertToTaskDialog）
// 各拉一次；发现结果与频道无关（全局单 slice），慢变无 SSE 失效，TTL 自然过期。
// 机制照 rosterStore/channelDataStore：TTL + single-flight + seq 守卫走 fetchDiscipline 底座。
import { create } from 'zustand';
import { channelApi, type LocalProject } from '../api/channel';
import { createFetchGate, disciplinedFetch } from './fetchDiscipline';

/** 缺省 TTL：与 rosterStore / channelDataStore 30s 同频——重复打开 TTL 内零重拉 */
export const PROJECTS_TTL_MS = 30000;

interface ProjectsState {
  /** 本地工程发现结果（undefined = 未拉到：含拉取失败，消费方按空集降级） */
  projects: LocalProject[] | undefined;

  ensureProjects: (opts?: { maxAgeMs?: number }) => Promise<void>;
  /** 测试隔离：清空数据面 + 纪律簿记（模块级 loadedAt/inflight 不在 zustand 内） */
  __resetForTests: () => void;
}

// 纪律簿记模块级持有（全局单 slice，对齐 rosterStore 单 gate 模式）
const gate = createFetchGate();
let loadedAt: number | null = null;
let inflight: Promise<void> | null = null;

export const useProjectsStore = create<ProjectsState>((set) => ({
  projects: undefined,

  ensureProjects: (opts) => {
    return disciplinedFetch(
      gate,
      { read: () => ({ loadedAt, inflight }), setInflight: (p) => { inflight = p; } },
      { maxAgeMs: opts?.maxAgeMs ?? PROJECTS_TTL_MS },
      async (seq) => {
        try {
          const res = await channelApi.discoverProjects();
          if (!gate.isLatest(seq)) return;
          // 形状护栏：非数组按 [] 落库（消费方 map 无守卫）
          const raw = res.data?.data as LocalProject[] | undefined;
          set({ projects: Array.isArray(raw) ? raw : [] });
          loadedAt = Date.now();
        } catch {
          // 静默降级（对齐旧 catch 行为）：不落数据不落锚点 → 下次 ensure 重试
        }
      },
    );
  },

  __resetForTests: () => {
    loadedAt = null;
    inflight = null;
    set({ projects: undefined });
  },
}));
