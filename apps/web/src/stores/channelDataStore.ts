// Channel Data Store — #403 per-channelId 频道数据面 store（ADR 2026-08-31-channel-data-plane-store）
// 管三样：文件词表（/channels/:id/file-vocabulary）/ 当前 PMO（/channels/:id/current-pmo）/
// 频道成员 ID 列表（channel.members，源自 GET /channels/:id）。机制照 rosterStore（#346），
// 取数纪律走 fetchDiscipline 底座——按 (slice, channelId) 粒度各自 TTL 锚点 / single-flight / seq 守卫。
// 新鲜度 = TTL + 白捡触发器，不新增 SSE 事件（ADR 决策 3）：
// - current-pmo：requirement.created/updated 时 invalidateCurrentPmo（事件已桥接，零成本）
// - members：面板内修改成功后 setMembers 本地写穿，不做多端实时（现状亦无）
// - 词表：无失效事件（后端本有 60s 内存缓存，实时性从来不存在）
// 注意（ADR 决策 2）：agent 档案不进本 store——rosterStore.listAllAgents 是全量正本，
// 消费方读 rosterStore 客户端切片，「频道 members 为空 → 全部 active」回退语义在消费方实现。
import { create } from 'zustand';
import { channelApi, type ChannelCurrentPmo, type ChannelFileVocabulary } from '../api/channel';
import { createFetchGate, disciplinedFetch, type FetchGate, type FetchGateState } from './fetchDiscipline';

/** 缺省 TTL：与 rosterStore 30s 兜底同频——频道间路由切换 TTL 内零重拉（#403 验收） */
export const CHANNEL_DATA_TTL_MS = 30000;

/** 词表切片驻留上限（单条可达数千文件路径，FIFO 驱逐防会话期无界增长；members/pmo 为小对象不设限） */
const VOCAB_CACHE_CAP = 10;

/** channel.members（JSON string of agent ID 数组，历史数据可能坏值）→ ID 列表 */
export function parseChannelMembers(membersJson: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(membersJson || '[]');
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

interface ChannelDataState {
  /** channelId → 文件词表（缺键 = 未拉到：含拉取失败，消费方按无词表降级） */
  vocabulary: Record<string, ChannelFileVocabulary | undefined>;
  /** channelId → 当前 PMO 派生（null = 后端派生为空；缺键 = 未拉到） */
  currentPmo: Record<string, ChannelCurrentPmo | null | undefined>;
  /** channelId → 成员 ID 列表（[] = 空 = 所有 Agent 可见；缺键 = 未拉到） */
  members: Record<string, string[] | undefined>;

  ensureVocabulary: (channelId: string, opts?: { maxAgeMs?: number }) => Promise<void>;
  ensureCurrentPmo: (channelId: string, opts?: { maxAgeMs?: number }) => Promise<void>;
  ensureMembers: (channelId: string, opts?: { maxAgeMs?: number }) => Promise<void>;
  /** 面板修改成功 / 页面频道记录到位后的写穿（data + TTL 锚点一并更新） */
  setMembers: (channelId: string, members: string[]) => void;
  /** 白捡触发器：REQ 变更可能改变 current-pmo 派生 → 失效并立即强刷（订阅方自动跟上） */
  invalidateCurrentPmo: (channelId: string) => void;
  /** 测试隔离：清空数据面 + 纪律簿记（模块级 loadedAt/inflight/gate 不在 zustand 内） */
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

/** 词表 FIFO 驱逐：新键入超限时丢最早插入的频道 */
function capVocabulary(map: Record<string, ChannelFileVocabulary | undefined>): Record<string, ChannelFileVocabulary | undefined> {
  const keys = Object.keys(map);
  if (keys.length < VOCAB_CACHE_CAP) return map;
  const next = { ...map };
  delete next[keys[0]];
  return next;
}

export const useChannelDataStore = create<ChannelDataState>((set, get) => ({
  vocabulary: {},
  currentPmo: {},
  members: {},

  ensureVocabulary: (channelId, opts) => {
    const s = sliceOf(`vocab:${channelId}`);
    return disciplinedFetch(
      s.gate,
      { read: () => s.state, setInflight: (p) => { s.state.inflight = p; } },
      { maxAgeMs: opts?.maxAgeMs ?? CHANNEL_DATA_TTL_MS },
      async (seq) => {
        try {
          const res = await channelApi.getFileVocabulary(channelId);
          if (!s.gate.isLatest(seq)) return;
          // 形状护栏：非 {repos:[]} 形状按空词表落库（消费方 matchFileRefToken 对 repos 无守卫）
          const raw = res.data?.data as ChannelFileVocabulary | null | undefined;
          const data: ChannelFileVocabulary = raw && Array.isArray(raw.repos) ? raw : { repos: [] };
          set((st) => ({ vocabulary: { ...capVocabulary(st.vocabulary), [channelId]: data } }));
          s.state.loadedAt = Date.now();
        } catch {
          // 静默降级：词表拿不到则消费方走无词表现状（对齐旧 catch 行为）；不落 TTL 锚点 → 下次调用重试
        }
      },
    );
  },

  ensureCurrentPmo: (channelId, opts) => {
    const s = sliceOf(`pmo:${channelId}`);
    return disciplinedFetch(
      s.gate,
      { read: () => s.state, setInflight: (p) => { s.state.inflight = p; } },
      { maxAgeMs: opts?.maxAgeMs ?? CHANNEL_DATA_TTL_MS },
      async (seq) => {
        try {
          const res = await channelApi.getCurrentPmo(channelId);
          if (!s.gate.isLatest(seq)) return;
          // 形状护栏：非 {id,...} 派生对象按 null 落库（chip 渲染依赖 id/title/gitRepos 字段）
          const raw = res.data?.data as ChannelCurrentPmo | null | undefined;
          const data: ChannelCurrentPmo | null = raw && typeof raw === 'object' && typeof raw.id === 'string' ? raw : null;
          set((st) => ({ currentPmo: { ...st.currentPmo, [channelId]: data } }));
          s.state.loadedAt = Date.now();
        } catch {
          // 拉取失败不落数据也不落锚点（消费方不渲染 chip，对齐旧 catch 行为）
        }
      },
    );
  },

  ensureMembers: (channelId, opts) => {
    const s = sliceOf(`members:${channelId}`);
    return disciplinedFetch(
      s.gate,
      { read: () => s.state, setInflight: (p) => { s.state.inflight = p; } },
      { maxAgeMs: opts?.maxAgeMs ?? CHANNEL_DATA_TTL_MS },
      async (seq) => {
        try {
          // 成员关系事实源 = channel.members（与旧服务端 channelId 过滤同口径）
          const res = await channelApi.get(channelId);
          if (!s.gate.isLatest(seq)) return;
          const parsed = parseChannelMembers(res.data?.data?.members);
          set((st) => ({ members: { ...st.members, [channelId]: parsed } }));
          s.state.loadedAt = Date.now();
        } catch {
          // 缺键 = 未拉到：消费方按「成员面不可用」降级（不献 mention 候选），不落锚点
        }
      },
    );
  },

  setMembers: (channelId, members) => {
    sliceOf(`members:${channelId}`).state.loadedAt = Date.now();
    set((st) => ({ members: { ...st.members, [channelId]: members } }));
  },

  invalidateCurrentPmo: (channelId) => {
    sliceOf(`pmo:${channelId}`).state.loadedAt = null;
    // 强刷（不并入在途）：事件晚于任何在途 fetch 发起，旧结果必须作废（seq 守卫兜底）
    void get().ensureCurrentPmo(channelId, { maxAgeMs: 0 });
  },

  __resetForTests: () => {
    book.clear();
    set({ vocabulary: {}, currentPmo: {}, members: {} });
  },
}));
