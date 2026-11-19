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
// #665（ADR 2026-08-24 落地）：workunit.status_changed 负载的 WU 快照 = 契约 WorkUnit，本地声明清零
import type { WorkUnit } from '../api/workunit';
import { createFetchGate, disciplinedFetch, type FetchGate, type FetchGateState } from './fetchDiscipline';
import { KeyedCacheLifecycle } from './keyedCacheLifecycle';

export const REQUIREMENT_CHAIN_CACHE_LIMIT = 32;
export const REQUIREMENT_CHAIN_INACTIVE_MS = 5 * 60 * 1000;

/** 缺省 TTL：与 rosterStore / channelDataStore 30s 同频——同 chain 会话内零重拉（#412 验收） */
export const REQUIREMENT_CHAIN_TTL_MS = 30000;
/** SSE 兜底轮询周期（useRequirementChainStoreSync 消费） */
export const REQUIREMENT_CHAIN_POLL_INTERVAL_MS = 30000;

interface RequirementChainState {
  /** reqId → chain（缺键 = 未拉到：含拉取失败，消费方按降级渲染） */
  chains: Record<string, RequirementChain | undefined>;
  /** reqId → 最近一次拉取失败消息（成功落库即清；消费方决定是否上屏） */
  errors: Record<string, string | undefined>;

  ensureChain: (reqId: string, opts?: { maxAgeMs?: number }) => Promise<void>;
  /** 只对齐当前有订阅者的 chain；非活跃驻留键等重新可见时再拉。 */
  ensureFresh: (opts?: { maxAgeMs?: number }) => Promise<void>;
  subscribeChain: (reqId: string) => () => void;
  /** workunit.status_changed 就地更新（唯一一份；见文件头推导规则） */
  applyWorkunitStatusChanged: (wu: WorkUnit | null | undefined) => void;
  /** 测试隔离：清空数据面 + 纪律簿记（模块级 loadedAt/inflight/gate 不在 zustand 内） */
  __resetForTests: () => void;
}

// 纪律簿记按 reqId 粒度模块级持有：数据在 zustand（消费方订阅），门禁状态不进响应式树
const book = new Map<string, { gate: FetchGate; state: FetchGateState }>();
const wuToReq = new Map<string, string>();
const reqToWus = new Map<string, Set<string>>();

function forgetChain(reqId: string): void {
  book.get(reqId)?.gate.nextSeq(); // 淘汰后晚到响应不得复活 key
  book.delete(reqId);
  for (const wuId of reqToWus.get(reqId) ?? []) wuToReq.delete(wuId);
  reqToWus.delete(reqId);
  useRequirementChainStore.setState(st => {
    const chains = { ...st.chains };
    const errors = { ...st.errors };
    delete chains[reqId];
    delete errors[reqId];
    return { chains, errors };
  });
}

const lifecycle = new KeyedCacheLifecycle({
  maxInactive: REQUIREMENT_CHAIN_CACHE_LIMIT,
  inactiveMs: REQUIREMENT_CHAIN_INACTIVE_MS,
  onEvict: forgetChain,
});

export const REQUIREMENT_CHAIN_CACHE_STATS = () => lifecycle.stats();

function indexChain(reqId: string, chain: RequirementChain): void {
  for (const id of reqToWus.get(reqId) ?? []) {
    if (wuToReq.get(id) === reqId) wuToReq.delete(id);
  }
  const ids = new Set(chain.workunits.map(w => w.id));
  reqToWus.set(reqId, ids);
  for (const id of ids) wuToReq.set(id, reqId);
}

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
    lifecycle.touch(reqId);
    const incarnation = lifecycle.incarnation(reqId);
    const s = sliceOf(reqId);
    return disciplinedFetch(
      s.gate,
      { read: () => s.state, setInflight: (p) => { s.state.inflight = p; } },
      { maxAgeMs: opts?.maxAgeMs ?? REQUIREMENT_CHAIN_TTL_MS },
      async (seq) => {
        try {
          const res = await requirementApi.getChain(reqId);
          if (!s.gate.isLatest(seq) || lifecycle.incarnation(reqId) !== incarnation) return;
          const chain = res.data?.data;
          indexChain(reqId, chain);
          set((st) => ({
            chains: { ...st.chains, [reqId]: chain },
            errors: { ...st.errors, [reqId]: undefined },
          }));
          s.state.loadedAt = Date.now();
        } catch (e) {
          if (!s.gate.isLatest(seq) || lifecycle.incarnation(reqId) !== incarnation) return;
          set((st) => ({
            errors: { ...st.errors, [reqId]: e instanceof Error ? e.message : String(e) },
          }));
          // 不落数据不落锚点：消费方按缺键降级，下次 ensure 重试
        }
      },
    );
  },

  subscribeChain: (reqId) => lifecycle.acquire(reqId),

  ensureFresh: async (opts) => {
    await Promise.all(lifecycle.activeKeys().map((id) => get().ensureChain(id, opts)));
  },

  applyWorkunitStatusChanged: (wu) => {
    // 坏负载防护：缺 id/status 一律 no-op（桥接层理论上恒有，防御旧桥/手工事件）
    if (!wu || typeof wu.id !== 'string' || !wu.id || typeof wu.status !== 'string') return;
    const reqId = (typeof wu.reqId === 'string' && wu.reqId) || wuToReq.get(wu.id);
    if (!reqId) return;
    const chain = get().chains[reqId];
    if (!chain) return;

    // wuId/reqId 索引点查：只读目标 chain，不扫描其他非活跃驻留链。
    const idx = chain.workunits.findIndex((w) => w.id === wu.id);
    if (idx < 0) {
      sliceOf(reqId).state.loadedAt = null;
      void get().ensureChain(reqId, { maxAgeMs: 0 });
      return;
    }
    set((st) => {
      const cur = chain.workunits[idx];
      const wus = [...chain.workunits];
      wus[idx] = {
        ...cur,
        status: wu.status,
        assigneeId: wu.assigneeId !== undefined ? wu.assigneeId : cur.assigneeId,
        assigneeRoleId: wu.assigneeRoleId !== undefined ? wu.assigneeRoleId : cur.assigneeRoleId,
        title: deriveWorkunitTitle(wu.metadata, wu.scope),
        metadata: wu.metadata !== undefined ? wu.metadata : cur.metadata,
        claimedAt: wu.claimedAt !== undefined ? wu.claimedAt : cur.claimedAt,
        completedAt: wu.completedAt !== undefined ? wu.completedAt : cur.completedAt,
      };
      return { chains: { ...st.chains, [reqId]: { ...chain, workunits: wus } } };
    });
  },

  __resetForTests: () => {
    lifecycle.dispose();
    book.clear();
    wuToReq.clear();
    reqToWus.clear();
    set({ chains: {}, errors: {} });
  },
}));
