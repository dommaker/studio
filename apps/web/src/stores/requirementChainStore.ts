// Requirement Chain Store — #412 REQ chain 数据面 store（ADR 2026-08-31-channel-data-plane-store 第三个使用者）
// getChain 的 5 处消费方（rail/PMO 徽章/项目页/抽屉/全链路面板；PMO 徽章 #387 已走 chainStats 批量端点）
// 收敛到 per-reqId 单份缓存：TTL / single-flight / seq 守卫走 fetchDiscipline 底座（机制照 channelDataStore）。
// 新鲜度（#412 开放问题定策）：workunit.status_changed 负载已带全量 WU 快照（含 reqId）→ 本地推导链增量，
// 不为状态变化重拉 getChain：
// - 已知 WU（某缓存 chain 含其 id）→ 就地 patch，零请求（右栏 stepper 的会话内新鲜度来源）
// - 未知 WU 但 wu.reqId 命中缓存 chain（chain 落库后新建 WU）→ 失效并强刷该 chain 一次
// - 与任何缓存 chain 无关 → no-op（无消费方挂载时不发请求）
// 失败语义：error 落 errors[key]（抽屉/面板显示「加载失败」），chains 缺键；不落 TTL 锚点 → 下次 ensure 重试。
import { create } from 'zustand';
import { requirementApi, type RequirementChain } from '../api/requirements';
import { createFetchGate, disciplinedFetch, type FetchGate, type FetchGateState } from './fetchDiscipline';

/** 缺省 TTL：与 rosterStore / channelDataStore 30s 同频——同 chain 会话内零重拉（#412 验收） */
export const REQUIREMENT_CHAIN_TTL_MS = 30000;
/** SSE 兜底轮询周期（useRequirementChainStoreSync 消费） */
export const REQUIREMENT_CHAIN_POLL_INTERVAL_MS = 30000;

/** workunit.status_changed 负载里的 WU 快照（snapshotToData 形状的消费子集；坏数据按 no-op 防护） */
export interface WorkunitStatusPayload {
  id: string;
  status: string;
  reqId?: string | null;
  scope?: string | null;
  assigneeId?: string | null;
  assigneeRoleId?: string | null;
  metadata?: string | null;
  claimedAt?: string | null;
  completedAt?: string | null;
}

interface RequirementChainState {
  /** reqId → chain（缺键 = 未拉到：含拉取失败，消费方按降级渲染） */
  chains: Record<string, RequirementChain | undefined>;
  /** reqId → 最近一次拉取失败消息（成功落库即清；消费方决定是否上屏） */
  errors: Record<string, string | undefined>;

  ensureChain: (reqId: string, opts?: { maxAgeMs?: number }) => Promise<void>;
  /** 已缓存 chain 全量对齐（SSE 重连强刷 / 兜底轮询 / 回 visible 补拉，useDataPlaneSync 消费） */
  ensureFresh: (opts?: { maxAgeMs?: number }) => Promise<void>;
  /** workunit.status_changed 就地更新（唯一一份；见文件头推导规则） */
  applyWorkunitStatusChanged: (wu: WorkunitStatusPayload | null | undefined) => void;
  /** 测试隔离：清空数据面 + 纪律簿记（模块级 loadedAt/inflight/gate 不在 zustand 内） */
  __resetForTests: () => void;
}

// 纪律簿记按 reqId 粒度模块级持有：数据在 zustand（消费方订阅），门禁状态不进响应式树
const book = new Map<string, { gate: FetchGate; state: FetchGateState }>();

function sliceOf(reqId: string): { gate: FetchGate; state: FetchGateState } {
  let s = book.get(reqId);
  if (!s) {
    s = { gate: createFetchGate(), state: { loadedAt: null, inflight: null } };
    book.set(reqId, s);
  }
  return s;
}

/** WU 标题：metadata.title 优先，否则 scope 截断 80（对齐服务端 extractWorkUnitTitle，唯一口径不两份漂移） */
function deriveWorkunitTitle(metadata: string | null | undefined, scope: string | null | undefined): string {
  if (metadata) {
    try {
      const meta = JSON.parse(metadata) as { title?: unknown };
      if (typeof meta.title === 'string' && meta.title) return meta.title;
    } catch { /* fall through to scope */ }
  }
  const text = scope ?? '';
  return text.length > 80 ? text.slice(0, 80) : text;
}

export const useRequirementChainStore = create<RequirementChainState>((set, get) => ({
  chains: {},
  errors: {},

  ensureChain: (reqId, opts) => {
    const s = sliceOf(reqId);
    return disciplinedFetch(
      s.gate,
      { read: () => s.state, setInflight: (p) => { s.state.inflight = p; } },
      { maxAgeMs: opts?.maxAgeMs ?? REQUIREMENT_CHAIN_TTL_MS },
      async (seq) => {
        try {
          const res = await requirementApi.getChain(reqId);
          if (!s.gate.isLatest(seq)) return;
          set((st) => ({
            chains: { ...st.chains, [reqId]: res.data?.data },
            errors: { ...st.errors, [reqId]: undefined },
          }));
          s.state.loadedAt = Date.now();
        } catch (e) {
          set((st) => ({
            errors: { ...st.errors, [reqId]: e instanceof Error ? e.message : String(e) },
          }));
          // 不落数据不落锚点：消费方按缺键降级，下次 ensure 重试
        }
      },
    );
  },

  ensureFresh: async (opts) => {
    const ids = Object.keys(get().chains);
    await Promise.all(ids.map((id) => get().ensureChain(id, opts)));
  },

  applyWorkunitStatusChanged: (wu) => {
    // 坏负载防护：缺 id/status 一律 no-op（桥接层理论上恒有，防御旧桥/手工事件）
    if (!wu || typeof wu.id !== 'string' || !wu.id || typeof wu.status !== 'string') return;

    // ① 已知 WU：就地 patch（不改数组顺序——服务端链路按 createdAt 排序，原地替换保序）
    let patched = false;
    set((st) => {
      const next: Record<string, RequirementChain | undefined> = { ...st.chains };
      for (const [reqId, chain] of Object.entries(st.chains)) {
        if (!chain) continue;
        const idx = chain.workunits.findIndex((w) => w.id === wu!.id);
        if (idx < 0) continue;
        patched = true;
        const cur = chain.workunits[idx];
        const wus = [...chain.workunits];
        wus[idx] = {
          ...cur,
          status: wu!.status,
          assigneeId: wu!.assigneeId !== undefined ? wu!.assigneeId : cur.assigneeId,
          assigneeRoleId: wu!.assigneeRoleId !== undefined ? wu!.assigneeRoleId : cur.assigneeRoleId,
          title: deriveWorkunitTitle(wu!.metadata, wu!.scope),
          metadata: wu!.metadata !== undefined ? wu!.metadata : cur.metadata,
          claimedAt: wu!.claimedAt !== undefined ? wu!.claimedAt : cur.claimedAt,
          completedAt: wu!.completedAt !== undefined ? wu!.completedAt : cur.completedAt,
        };
        next[reqId] = { ...chain, workunits: wus };
      }
      return patched ? { chains: next } : {};
    });
    if (patched) return;

    // ② 未知 WU 但 reqId 命中缓存 chain：chain 落库后新建的 WU → 失效强刷一次（seq 守卫兜底旧结果）
    const reqId = typeof wu.reqId === 'string' ? wu.reqId : null;
    if (reqId && get().chains[reqId] !== undefined) {
      sliceOf(reqId).state.loadedAt = null;
      void get().ensureChain(reqId, { maxAgeMs: 0 });
    }
    // ③ 与任何缓存 chain 无关 → no-op（无消费方展示该链路，不发请求）
  },

  __resetForTests: () => {
    book.clear();
    set({ chains: {}, errors: {} });
  },
}));
