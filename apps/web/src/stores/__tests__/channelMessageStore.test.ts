// channelMessageStore（#548，ADR 2026-08-31 数据面模式延伸）：
// messages 面收编 per-channelId store 后的独立单测——首拉替换/refetch 合并/hasMore 头部方向规则、
// id 游标翻页、SSE 插入与更新、乐观回显、降级/水合、agentAnsweredOf 派生。
// 行为口径 = 收编前 useChannelMessages 本地 state 语义（hook 侧旧测试一并兜底）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChannelMessage } from '../../api/channel';

const { mockListMessages, mockSendMessage, mockSink } = vi.hoisted(() => ({
  mockListMessages: vi.fn(),
  mockSendMessage: vi.fn(),
  mockSink: vi.fn(),
}));

vi.mock('../../api/channel', () => ({
  channelApi: { listMessages: mockListMessages, sendMessage: mockSendMessage },
}));

import {
  useChannelMessageStore,
  agentAnsweredOf,
  CHANNEL_MESSAGE_CACHE_STATS,
  CHANNEL_MESSAGE_HISTORY_CAP,
} from '../channelMessageStore';
import { setClientPerfSink, resetClientPerfSink } from '../../utils/clientPerf';

const iso = (s: number) => new Date(s * 1000).toISOString();

function msg(id: string, seq: number, over: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id,
    channelId: 'ch-1',
    authorType: 'agent',
    content: `内容-${id}`,
    replyToId: null,
    workUnitId: null,
    meta: {},
    createdAt: iso(seq),
    ...over,
  };
}

function sliceOf(channelId = 'ch-1') {
  return useChannelMessageStore.getState().channels[channelId];
}

describe('channelMessageStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetClientPerfSink();
    useChannelMessageStore.getState().__resetForTests();
    mockListMessages.mockResolvedValue({ data: { data: { messages: [], hasMore: false } } });
  });

  describe('fetchMessages（首拉替换 / refetch 合并）', () => {
    it('首拉：替换语义落库，loading 落位、loaded 置位', async () => {
      const m1 = msg('m1', 0);
      mockListMessages.mockResolvedValue({ data: { data: { messages: [m1], hasMore: true } } });
      await useChannelMessageStore.getState().fetchMessages('ch-1');
      const s = sliceOf()!;
      expect(s.messages.map(m => m.id)).toEqual(['m1']);
      expect(s.hasMore).toBe(true);
      expect(s.loading).toBe(false);
      expect(s.loaded).toBe(true);
      expect(s.error).toBeNull();
    });

    it('同频道 refetch：合并语义——prepend 历史保留、已存在按服务端刷新、新消息有序插入', async () => {
      const m3 = msg('m3', 2);
      mockListMessages.mockResolvedValue({ data: { data: { messages: [m3], hasMore: true } } });
      const store = useChannelMessageStore.getState();
      await store.fetchMessages('ch-1');
      // prepend 一页历史
      const m1 = msg('m1', 0);
      mockListMessages.mockResolvedValue({ data: { data: { messages: [m1], hasMore: false } } });
      await store.loadMore('ch-1');
      // refetch：m3 服务端更新版 + 新到 m4
      const m3u = { ...m3, content: '服务端更新' };
      const m4 = msg('m4', 3);
      mockListMessages.mockResolvedValue({ data: { data: { messages: [m3u, m4], hasMore: true } } });
      await store.fetchMessages('ch-1');

      const s = sliceOf()!;
      expect(s.messages.map(m => m.id)).toEqual(['m1', 'm3', 'm4']);
      expect(s.messages.find(m => m.id === 'm3')!.content).toBe('服务端更新');
    });

    it('prepend 方向上 hasMore 不被最新一页的 hasMore 错误重置', async () => {
      const m3 = msg('m3', 2);
      mockListMessages.mockResolvedValue({ data: { data: { messages: [m3], hasMore: true } } });
      const store = useChannelMessageStore.getState();
      await store.fetchMessages('ch-1');
      const m1 = msg('m1', 0);
      mockListMessages.mockResolvedValue({ data: { data: { messages: [m1], hasMore: false } } });
      await store.loadMore('ch-1');
      expect(sliceOf()!.hasMore).toBe(false);
      // 最新一页 hasMore=true 描述头部方向，不得覆盖 prepend 方向状态
      mockListMessages.mockResolvedValue({ data: { data: { messages: [m3], hasMore: true } } });
      await store.fetchMessages('ch-1');
      expect(sliceOf()!.hasMore).toBe(false);
    });

    it('失败：error 置位、loading 落位、已加载消息保留；成功重试清 error', async () => {
      const store = useChannelMessageStore.getState();
      mockListMessages.mockRejectedValueOnce(new Error('network down'));
      await store.fetchMessages('ch-1');
      expect(sliceOf()!.error).toBe('network down');
      expect(sliceOf()!.loading).toBe(false);
      expect(sliceOf()!.messages).toHaveLength(0);

      const m1 = msg('m1', 0);
      mockListMessages.mockResolvedValue({ data: { data: { messages: [m1], hasMore: false } } });
      await store.fetchMessages('ch-1');
      expect(sliceOf()!.error).toBeNull();
      expect(sliceOf()!.messages.map(m => m.id)).toEqual(['m1']);
    });
  });

  describe('beginLoad（频道切换复位）', () => {
    it('置 loading、清 error、保留已有消息（旧频道缓存不闪空）', async () => {
      mockListMessages.mockRejectedValueOnce(new Error('down'));
      const store = useChannelMessageStore.getState();
      await store.fetchMessages('ch-1');
      expect(sliceOf()!.error).toBeTruthy();

      store.beginLoad('ch-1');
      expect(sliceOf()!.loading).toBe(true);
      expect(sliceOf()!.error).toBeNull();
    });
  });

  describe('loadMore（#319 id 游标 prepend）', () => {
    it('以最老非 pending 消息 id 为游标前插，返回是否真实前插', async () => {
      const m3 = msg('m3', 2);
      mockListMessages.mockResolvedValue({ data: { data: { messages: [m3], hasMore: true } } });
      const store = useChannelMessageStore.getState();
      await store.fetchMessages('ch-1');

      const m1 = msg('m1', 0);
      const m2 = msg('m2', 1);
      mockListMessages.mockResolvedValue({ data: { data: { messages: [m1, m2], hasMore: false } } });
      const inserted = await store.loadMore('ch-1');

      expect(mockListMessages).toHaveBeenLastCalledWith('ch-1', { before: 'm3' });
      expect(sliceOf()!.messages.map(m => m.id)).toEqual(['m1', 'm2', 'm3']);
      expect(sliceOf()!.hasMore).toBe(false);
      expect(inserted).toBe(true);
    });

    it('hasMore=false 时不发请求', async () => {
      const store = useChannelMessageStore.getState();
      await store.fetchMessages('ch-1');
      mockListMessages.mockClear();
      expect(await store.loadMore('ch-1')).toBe(false);
      expect(mockListMessages).not.toHaveBeenCalled();
    });

    it('pending 不作分页游标：列表仅 pending 时不发请求（#486）', async () => {
      mockListMessages.mockResolvedValue({ data: { data: { messages: [], hasMore: true } } });
      const store = useChannelMessageStore.getState();
      await store.fetchMessages('ch-1');
      let resolveSend!: (v: unknown) => void;
      mockSendMessage.mockImplementation(() => new Promise(r => { resolveSend = r; }));
      const sendP = store.sendMessage('ch-1', '你好');
      expect(sliceOf()!.messages.some(m => m.pending)).toBe(true);

      mockListMessages.mockClear();
      expect(await store.loadMore('ch-1')).toBe(false);
      expect(mockListMessages).not.toHaveBeenCalled();

      resolveSend({ data: { data: msg('s1', 10, { authorType: 'human' }) } });
      await sendP;
    });
  });

  describe('applyMessageSent（SSE 有序插入）', () => {
    it('按 createdAt 归位插入 + id 去重；缺切片时建切片', async () => {
      const store = useChannelMessageStore.getState();
      store.applyMessageSent('ch-1', msg('m1', 0));
      store.applyMessageSent('ch-1', msg('m3', 2));
      store.applyMessageSent('ch-1', msg('m2', 1)); // 乱序到达
      store.applyMessageSent('ch-1', msg('m2', 1)); // 回声去重
      expect(sliceOf()!.messages.map(m => m.id)).toEqual(['m1', 'm2', 'm3']);
    });

    it('#520：仅 agent 新消息记回执起点（回声/人类消息不记）', () => {
      setClientPerfSink(mockSink);
      const store = useChannelMessageStore.getState();
      const m1 = msg('m1', 0);
      store.applyMessageSent('ch-1', m1);
      store.applyMessageSent('ch-1', m1); // 回声
      store.applyMessageSent('ch-1', msg('h1', 1, { authorType: 'human' }));
      expect(mockSink).not.toHaveBeenCalled(); // mark 只记起点，sink 在渲染完成才发
      // markReceiptArrived 的配对语义由 useChannelMessages-perf.test.ts 端到端兜底
    });
  });

  describe('applyMessageUpdated（#315 全量本体优先 / legacy patch）', () => {
    it('全量 message 本体原位替换', async () => {
      const m1 = msg('m1', 0, { content: '旧内容' });
      mockListMessages.mockResolvedValue({ data: { data: { messages: [m1], hasMore: false } } });
      const store = useChannelMessageStore.getState();
      await store.fetchMessages('ch-1');

      const full = { ...m1, content: '新内容', meta: { k: 'v' } };
      store.applyMessageUpdated('ch-1', { messageId: 'm1', message: full });
      expect(sliceOf()!.messages[0]).toEqual(full);
    });

    it('legacy patch：仅 meta 整体替换、骨架不假复活；带 content 复活清 degraded', async () => {
      const m1 = msg('m1', 0, { content: '', meta: {}, degraded: true });
      mockListMessages.mockResolvedValue({ data: { data: { messages: [m1], hasMore: false } } });
      const store = useChannelMessageStore.getState();
      await store.fetchMessages('ch-1');

      store.applyMessageUpdated('ch-1', { messageId: 'm1', meta: { status: 'done' } });
      expect(sliceOf()!.messages[0].degraded).toBe(true);
      expect(sliceOf()!.messages[0].content).toBe('');
      expect(sliceOf()!.messages[0].meta).toEqual({ status: 'done' });

      store.applyMessageUpdated('ch-1', { messageId: 'm1', content: '更新后', meta: { status: 'done' } });
      expect(sliceOf()!.messages[0].degraded).toBe(false);
      expect(sliceOf()!.messages[0].content).toBe('更新后');
    });

    it('无匹配 id / 缺切片 → 不动其他消息', () => {
      const store = useChannelMessageStore.getState();
      store.applyMessageSent('ch-1', msg('m1', 0));
      store.applyMessageUpdated('ch-1', { messageId: 'ghost', message: msg('ghost', 9) });
      store.applyMessageUpdated('ch-2', { messageId: 'm1', content: '他频道' });
      expect(sliceOf()!.messages.map(m => m.id)).toEqual(['m1']);
      expect(sliceOf('ch-2')).toBeUndefined();
    });

    it('F5：未命中 id → 原 state 早退，messages/channels 引用均不变（不白触发下游全量派生）', () => {
      const store = useChannelMessageStore.getState();
      store.applyMessageSent('ch-1', msg('m1', 0));
      const stateBefore = useChannelMessageStore.getState();
      const messagesBefore = sliceOf()!.messages;
      // 三条未命中路径：全量本体 / legacy patch / 空负载
      store.applyMessageUpdated('ch-1', { messageId: 'ghost', message: msg('ghost', 9) });
      store.applyMessageUpdated('ch-1', { messageId: 'ghost', meta: { status: 'done' } });
      store.applyMessageUpdated('ch-1', {});
      expect(useChannelMessageStore.getState()).toBe(stateBefore);
      expect(sliceOf()!.messages).toBe(messagesBefore);
    });
  });

  describe('messages 升序不变量（deriveStreamView 免全量 sort 的前提，F1）', () => {
    it('prepend / 乱序 SSE 插入 / refetch 合并后恒按 createdAt 升序', async () => {
      const store = useChannelMessageStore.getState();
      mockListMessages.mockResolvedValue({ data: { data: { messages: [msg('m3', 2)], hasMore: true } } });
      await store.fetchMessages('ch-1');
      // prepend 一页更早历史
      mockListMessages.mockResolvedValue({ data: { data: { messages: [msg('m1', 0)], hasMore: false } } });
      await store.loadMore('ch-1');
      // 乱序到达的 SSE 增量
      store.applyMessageSent('ch-1', msg('m5', 4));
      store.applyMessageSent('ch-1', msg('m4', 3));
      // refetch 合并进落在中间的新消息 m2
      mockListMessages.mockResolvedValue({
        data: { data: { messages: [msg('m2', 1), msg('m3', 2), msg('m4', 3), msg('m5', 4)], hasMore: false, total: 4 } },
      });
      await store.fetchMessages('ch-1');

      const ts = sliceOf()!.messages.map(m => new Date(m.createdAt).getTime());
      expect(sliceOf()!.messages.map(m => m.id)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
      expect(ts).toEqual([...ts].sort((a, b) => a - b));
    });
  });

  describe('sendMessage（#486 乐观回显）', () => {
    it('发送即插 pending；成功后服务端本体原位替换', async () => {
      const store = useChannelMessageStore.getState();
      let resolveSend!: (v: unknown) => void;
      mockSendMessage.mockImplementation(() => new Promise(r => { resolveSend = r; }));

      const sendP = store.sendMessage('ch-1', '你好', 'r1');
      const pending = sliceOf()!.messages.find(m => m.pending)!;
      expect(pending.id).toMatch(/^pending-/);
      expect(pending.content).toBe('你好');
      expect(pending.replyToId).toBe('r1');
      expect(mockSendMessage).toHaveBeenCalledWith('ch-1', '你好', 'r1', undefined);

      const sent = msg('s1', 10, { authorType: 'human' });
      resolveSend({ data: { data: sent } });
      const ret = await sendP;
      expect(ret).toEqual(sent);
      expect(sliceOf()!.messages.some(m => m.pending)).toBe(false);
      expect(sliceOf()!.messages.filter(m => m.id === 's1')).toHaveLength(1);
    });

    it('失败回滚 pending + 上抛', async () => {
      const store = useChannelMessageStore.getState();
      mockSendMessage.mockRejectedValue(new Error('network down'));
      await expect(store.sendMessage('ch-1', '你好')).rejects.toThrow('network down');
      expect(sliceOf()!.messages.some(m => m.pending)).toBe(false);
      expect(sliceOf()!.messages).toHaveLength(0);
    });

    it('空内容 / 全空白 → 不发请求返回 null', async () => {
      const store = useChannelMessageStore.getState();
      expect(await store.sendMessage('ch-1', '   ')).toBeNull();
      expect(mockSendMessage).not.toHaveBeenCalled();
    });
  });

  describe('syncPruning（#326 降级/水合）', () => {
    const OPTS = { keepRecent: 3, degradeDistance: 2, hydrateDistance: 1 };
    const batch = (n: number) => Array.from({ length: n }, (_, i) => msg(`m${i + 1}`, i + 1));

    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('按 planPrune 降级视口上方历史为骨架', async () => {
      mockListMessages.mockResolvedValue({ data: { data: { messages: batch(10), hasMore: false } } });
      const store = useChannelMessageStore.getState();
      await store.fetchMessages('ch-1');
      store.syncPruning('ch-1', 'm8', OPTS); // 边界 7-2=5 → [m1..m5]
      const msgs = sliceOf()!.messages;
      expect(msgs.slice(0, 5).every(m => m.degraded && m.content === '')).toBe(true);
      expect(msgs.slice(5).every(m => !m.degraded)).toBe(true);
    });

    it('视口进入降级区 → 防抖后以首个非骨架 id 为游标整页水合，骨架原位复活、hasMore 不动', async () => {
      const list = batch(10);
      mockListMessages.mockResolvedValue({ data: { data: { messages: list, hasMore: false } } });
      const store = useChannelMessageStore.getState();
      await store.fetchMessages('ch-1');
      store.syncPruning('ch-1', 'm8', OPTS);

      mockListMessages.mockResolvedValue({ data: { data: { messages: list.slice(0, 5), hasMore: true } } });
      store.syncPruning('ch-1', 'm6', OPTS); // idx 5 < 5+1 → 触发水合
      expect(mockListMessages).toHaveBeenCalledTimes(1); // 首拉；防抖未点火
      await vi.advanceTimersByTimeAsync(250);
      expect(mockListMessages).toHaveBeenCalledWith('ch-1', { before: 'm6', limit: 100 });
      expect(sliceOf()!.messages.every(m => !m.degraded)).toBe(true);
      expect(sliceOf()!.messages.map(m => m.id)).toEqual(list.map(m => m.id));
      expect(sliceOf()!.hasMore).toBe(false); // 水合不触碰 hasMore
    });

    it('防抖窗口内连续触发只发一次水合请求', async () => {
      mockListMessages.mockResolvedValue({ data: { data: { messages: batch(10), hasMore: false } } });
      const store = useChannelMessageStore.getState();
      await store.fetchMessages('ch-1');
      store.syncPruning('ch-1', 'm8', OPTS);
      mockListMessages.mockResolvedValue({ data: { data: { messages: [], hasMore: false } } });
      store.syncPruning('ch-1', 'm6', OPTS);
      store.syncPruning('ch-1', 'm6', OPTS);
      await vi.advanceTimersByTimeAsync(250);
      expect(mockListMessages.mock.calls.filter(c => c[1]?.before === 'm6')).toHaveLength(1);
    });

    it('__resetForTests 清数据面 + 纪律簿记 + 水合计时器', async () => {
      mockListMessages.mockResolvedValue({ data: { data: { messages: batch(10), hasMore: false } } });
      const store = useChannelMessageStore.getState();
      await store.fetchMessages('ch-1');
      store.syncPruning('ch-1', 'm8', OPTS);
      store.syncPruning('ch-1', 'm6', OPTS); // 排上一个水合计时器
      store.__resetForTests();
      expect(sliceOf()).toBeUndefined();
      mockListMessages.mockClear();
      await vi.advanceTimersByTimeAsync(250);
      expect(mockListMessages).not.toHaveBeenCalled(); // 计时器已清
    });
  });

  describe('agentAnsweredOf（#493 派生判定，自页面迁出）', () => {
    const awaiting = { wuId: 'WU-1', since: new Date(iso(5)).getTime() };

    it('该 WU 的 agent 新消息（createdAt ≥ since）到达 → true', () => {
      const msgs = [msg('m1', 6, { authorType: 'agent', workUnitId: 'WU-1' })];
      expect(agentAnsweredOf(msgs, awaiting)).toBe(true);
    });

    it('无等待态 → false', () => {
      expect(agentAnsweredOf([msg('m1', 6, { workUnitId: 'WU-1' })], null)).toBe(false);
    });

    it('人类消息 / 他 WU 的 agent 消息 / since 之前的消息 → false', () => {
      expect(agentAnsweredOf([msg('m1', 6, { authorType: 'human', workUnitId: 'WU-1' })], awaiting)).toBe(false);
      expect(agentAnsweredOf([msg('m1', 6, { authorType: 'agent', workUnitId: 'WU-2' })], awaiting)).toBe(false);
      expect(agentAnsweredOf([msg('m1', 4, { authorType: 'agent', workUnitId: 'WU-1' })], awaiting)).toBe(false);
    });
  });

  describe('PERF-06 有界驻留与增量索引', () => {
    it('100 频道 × 50 页后 key/消息对象/定时器有界，重连只刷活跃键', async () => {
      const heapUsed = () => {
        (globalThis as { gc?: () => void }).gc?.();
        return process.memoryUsage().heapUsed;
      };
      const heapBefore = heapUsed();
      const store = useChannelMessageStore.getState();
      for (let c = 0; c < 100; c++) {
        const channelId = `scale-${c}`;
        const release = store.subscribeChannel(channelId);
        mockListMessages.mockImplementation((_id: string, opts?: { before?: string }) => {
          const parsed = opts?.before ? Number(opts.before.match(/(\d+)$/)?.[1]) : CHANNEL_MESSAGE_HISTORY_CAP;
          const before = Number.isFinite(parsed) ? parsed : CHANNEL_MESSAGE_HISTORY_CAP;
          const start = Math.max(0, before - 200);
          return Promise.resolve({ data: { data: {
            messages: Array.from({ length: before - start }, (_, i) => msg(`${channelId}-m${start + i}`, start + i, { channelId })),
            hasMore: start > 0,
          } } });
        });
        await store.fetchMessages(channelId);
        for (let p = 0; p < 49; p++) {
          if (!useChannelMessageStore.getState().channels[channelId]?.hasMore) break;
          await store.loadMore(channelId);
        }
        store.applyMessageSent(channelId, msg(`${channelId}-live`, CHANNEL_MESSAGE_HISTORY_CAP + 1, { channelId }));
        expect(useChannelMessageStore.getState().channels[channelId]?.messages).toHaveLength(CHANNEL_MESSAGE_HISTORY_CAP);
        expect(useChannelMessageStore.getState().channels[channelId]?.messages.at(-1)?.id).toBe(`${channelId}-live`);
        release();
      }
      const stats = CHANNEL_MESSAGE_CACHE_STATS();
      const heapAfter = heapUsed();
      console.info('[PERF-06] 100 channels × 50 pages', { ...stats, heapBefore, heapAfter, heapDelta: heapAfter - heapBefore });
      expect(stats.keys).toBeLessThanOrEqual(8);
      expect(stats.messages).toBeLessThanOrEqual(8 * CHANNEL_MESSAGE_HISTORY_CAP);
      expect(stats.timers).toBeLessThanOrEqual(1);
      const release = store.subscribeChannel('scale-99');
      mockListMessages.mockClear();
      await store.ensureFresh({ maxAgeMs: 0 });
      expect(mockListMessages).toHaveBeenCalledTimes(1);
      expect(mockListMessages).toHaveBeenCalledWith('scale-99');
      release();
    }, 60000);

    it('单频道历史对象有硬上限，淘汰后可继续按 id 游标分页', async () => {
      const store = useChannelMessageStore.getState();
      const page = Array.from({ length: CHANNEL_MESSAGE_HISTORY_CAP + 1 }, (_, i) => msg(`dense-${i}`, i));
      mockListMessages.mockResolvedValue({ data: { data: { messages: page, hasMore: false } } });
      await store.fetchMessages('ch-1');
      expect(sliceOf()!.messages).toHaveLength(CHANNEL_MESSAGE_HISTORY_CAP);
      expect(sliceOf()!.byId?.size).toBe(CHANNEL_MESSAGE_HISTORY_CAP);
      expect(sliceOf()!.hasMore).toBe(true);
      mockListMessages.mockResolvedValue({ data: { data: { messages: [msg('older', -1)], hasMore: false } } });
      await store.loadMore('ch-1');
      expect(mockListMessages).toHaveBeenLastCalledWith('ch-1', { before: 'dense-1' });
      expect(sliceOf()!.messages.length).toBeLessThanOrEqual(CHANNEL_MESSAGE_HISTORY_CAP + 1);
      expect(sliceOf()!.messages[0].id).toBe('older');
      expect(sliceOf()!.messages.at(-1)!.id).toBe('dense-10000');
      expect(sliceOf()!.hasMore).toBe(false);
    });

    it('SSE/乐观发送/水合/loadMore 均保最新端且可继续分页恢复', async () => {
      const store = useChannelMessageStore.getState();
      const page = Array.from({ length: CHANNEL_MESSAGE_HISTORY_CAP }, (_, i) => msg(`cap-${i}`, i));
      mockListMessages.mockResolvedValue({ data: { data: { messages: page, hasMore: true } } });
      await store.fetchMessages('ch-1');

      store.applyMessageSent('ch-1', msg('sse-live', 10001));
      expect(sliceOf()!.messages).toHaveLength(CHANNEL_MESSAGE_HISTORY_CAP);
      expect(sliceOf()!.messages.at(-1)!.id).toBe('sse-live');

      mockSendMessage.mockResolvedValue({ data: { data: msg('sent-live', 10002, { authorType: 'human' }) } });
      await store.sendMessage('ch-1', '最新');
      expect(sliceOf()!.messages).toHaveLength(CHANNEL_MESSAGE_HISTORY_CAP);
      expect(sliceOf()!.messages.at(-1)!.id).toBe('sent-live');

      vi.useFakeTimers();
      try {
        mockListMessages.mockResolvedValue({ data: { data: { messages: [msg('hydrated', 10000)], hasMore: true } } });
        store.syncPruning('ch-1', 'cap-5000', { keepRecent: 3, degradeDistance: 2, hydrateDistance: 1 });
        await vi.advanceTimersByTimeAsync(250);
        expect(sliceOf()!.messages.length).toBeLessThanOrEqual(CHANNEL_MESSAGE_HISTORY_CAP);
        expect(sliceOf()!.messages.at(-1)!.id).toBe('sent-live');
      } finally {
        vi.useRealTimers();
      }

      mockListMessages.mockResolvedValue({ data: { data: { messages: [msg('older-1', -1)], hasMore: true } } });
      await store.loadMore('ch-1');
      expect(sliceOf()!.messages.length).toBeLessThanOrEqual(CHANNEL_MESSAGE_HISTORY_CAP + 1);
      expect(sliceOf()!.messages[0].id).toBe('older-1');
      expect(sliceOf()!.messages.at(-1)!.id).toBe('sent-live');
      mockListMessages.mockResolvedValue({ data: { data: { messages: [msg('older-2', -2)], hasMore: false } } });
      await store.loadMore('ch-1');
      expect(mockListMessages).toHaveBeenLastCalledWith('ch-1', { before: 'older-1' });
      expect(sliceOf()!.messages.at(-1)!.id).toBe('sent-live');
    });

    it('SSE 在 hasMore=false 裁旧后恢复历史窗口，重拉页真实可见且最新端不丢', async () => {
      const store = useChannelMessageStore.getState();
      const page = Array.from({ length: CHANNEL_MESSAGE_HISTORY_CAP }, (_, i) => msg(`closed-${i}`, i));
      mockListMessages.mockResolvedValue({ data: { data: { messages: page, hasMore: false } } });
      await store.fetchMessages('ch-1');
      useChannelMessageStore.setState(st => ({
        channels: { ...st.channels, 'ch-1': { ...st.channels['ch-1']!, hasMore: false, beforeCursor: null } },
      }));
      store.applyMessageSent('ch-1', msg('after-close', 10001));
      expect(sliceOf()!.hasMore).toBe(true);
      mockListMessages.mockResolvedValue({ data: { data: { messages: [msg('recovered-old', -1)], hasMore: false } } });
      await store.loadMore('ch-1');
      expect(sliceOf()!.messages.some(m => m.id === 'recovered-old')).toBe(true);
      expect(sliceOf()!.messages.at(-1)!.id).toBe('after-close');
      expect(sliceOf()!.messages.length).toBeLessThanOrEqual(CHANNEL_MESSAGE_HISTORY_CAP + 1);
    });

    it('真实 before 排他时 cap 恢复有显式间隙且不丢最新端，水合可恢复间隙', async () => {
      vi.useFakeTimers();
      try {
        const store = useChannelMessageStore.getState();
        const base = Array.from({ length: CHANNEL_MESSAGE_HISTORY_CAP }, (_, i) => msg(`exclusive-${i}`, i));
        const live = msg('exclusive-10001', CHANNEL_MESSAGE_HISTORY_CAP + 1);
        const all = [...base, live];
        mockListMessages.mockImplementation((_id: string, opts?: { before?: string }) => {
          if (!opts?.before) return Promise.resolve({ data: { data: { messages: base, hasMore: false } } });
          const beforeSeq = Number(opts.before.match(/(\d+)$/)?.[1] ?? 0);
          const messages = all.filter(m => Number(m.id.match(/(\d+)$/)?.[1] ?? 0) < beforeSeq);
          return Promise.resolve({ data: { data: { messages, hasMore: false } } });
        });
        await store.fetchMessages('ch-1');
        useChannelMessageStore.setState(st => ({
          channels: { ...st.channels, 'ch-1': { ...st.channels['ch-1']!, hasMore: false, beforeCursor: null } },
        }));
        store.applyMessageSent('ch-1', live);
        await store.loadMore('ch-1');

        const window = sliceOf()!.messages;
        expect(window.at(-1)!.id).toBe(live.id);
        expect(window.length).toBeLessThanOrEqual(CHANNEL_MESSAGE_HISTORY_CAP + 1);
        expect(window.some(m => m.degraded)).toBe(true);
        expect(window.some(m => m.id === 'exclusive-0')).toBe(true);

        store.syncPruning('ch-1', 'exclusive-2', { keepRecent: 3, degradeDistance: 2, hydrateDistance: 1 });
        await vi.advanceTimersByTimeAsync(250);
        const recovered = sliceOf()!.messages;
        expect(recovered.at(-1)!.id).toBe(live.id);
        expect(recovered.length).toBeLessThanOrEqual(CHANNEL_MESSAGE_HISTORY_CAP + 1);
        expect(recovered.find(m => m.id === 'exclusive-9999')?.degraded).toBeFalsy();
        expect(recovered.find(m => m.id === 'exclusive-9999')?.content).toBe('内容-exclusive-9999');
        expect(recovered.some(m => m.id === 'exclusive-1')).toBe(true);
        expect(recovered.find(m => m.id === 'exclusive-2')?.degraded).toBeFalsy();
        expect(recovered.find(m => m.id === 'exclusive-2')?.content).toBe('内容-exclusive-2');
      } finally {
        vi.useRealTimers();
      }
    });

    it('水合旧响应不得覆盖重订阅后的同 id 新版本', async () => {
      vi.useFakeTimers();
      try {
        const store = useChannelMessageStore.getState();
        const initial = Array.from({ length: 10 }, (_, i) => msg(`m${i}`, i));
        mockListMessages.mockResolvedValue({ data: { data: { messages: initial, hasMore: false } } });
        await store.fetchMessages('ch-1');
        store.syncPruning('ch-1', 'm8', { keepRecent: 3, degradeDistance: 2, hydrateDistance: 1 });
        let resolveOld!: (v: unknown) => void;
        mockListMessages.mockImplementation(() => new Promise(r => { resolveOld = r; }));
        store.syncPruning('ch-1', 'm6', { keepRecent: 3, degradeDistance: 2, hydrateDistance: 1 });
        await vi.advanceTimersByTimeAsync(250);

        store.__resetForTests();
        store.applyMessageSent('ch-1', msg('m0', 0, { content: 'new-version' }));
        resolveOld({ data: { data: { messages: [msg('m0', 0, { content: 'stale-hydration' })], hasMore: false } } });
        await vi.advanceTimersByTimeAsync(0);
        expect(sliceOf()!.byId?.get('m0')?.content).toBe('new-version');
      } finally {
        vi.useRealTimers();
      }
    });

    it('loadMore 淘汰重订阅 ABA 与同键倒序响应均不得覆盖新缓存', async () => {
      const store = useChannelMessageStore.getState();
      mockListMessages.mockResolvedValue({ data: { data: { messages: [msg('newest', 10)], hasMore: true } } });
      await store.fetchMessages('ch-1');
      let resolveOld!: (v: unknown) => void;
      mockListMessages.mockImplementation(() => new Promise(r => { resolveOld = r; }));
      const oldRequest = store.loadMore('ch-1');
      store.__resetForTests();
      mockListMessages.mockResolvedValue({ data: { data: { messages: [msg('incarnation-b', 20)], hasMore: true } } });
      await store.fetchMessages('ch-1');
      resolveOld({ data: { data: { messages: [msg('stale-aba', -1)], hasMore: true } } });
      await oldRequest;
      expect(sliceOf()!.messages.map(m => m.id)).toEqual(['incarnation-b']);

      let resolveFirst!: (v: unknown) => void;
      let resolveSecond!: (v: unknown) => void;
      mockListMessages
        .mockImplementationOnce(() => new Promise(r => { resolveFirst = r; }))
        .mockImplementationOnce(() => new Promise(r => { resolveSecond = r; }));
      const first = store.loadMore('ch-1');
      useChannelMessageStore.setState(st => ({
        channels: { ...st.channels, 'ch-1': { ...st.channels['ch-1']!, beforeCursor: 'other-cursor' } },
      }));
      const second = store.loadMore('ch-1');
      resolveSecond({ data: { data: { messages: [msg('newer-page', 1)], hasMore: true } } });
      await second;
      resolveFirst({ data: { data: { messages: [msg('stale-page', 0)], hasMore: true } } });
      await first;
      expect(sliceOf()!.messages.map(m => m.id)).toEqual(['newer-page', 'incarnation-b']);
    });

    it('byId 与 threadIndex 使更新不扫描消息列表', () => {
      const store = useChannelMessageStore.getState();
      const anchor = msg('anchor', 0, { workUnitId: 'WU-1' });
      store.applyMessageSent('ch-1', anchor);
      store.applyMessageSent('ch-1', msg('reply', 1, { replyToId: 'anchor' }));
      const slice = sliceOf()!;
      expect(slice.byId?.get('reply')?.id).toBe('reply');
      expect(slice.threadIndex?.get('anchor')).toEqual(['anchor', 'reply']);
      const before = slice.byId;
      store.applyMessageUpdated('ch-1', { messageId: 'reply', content: '局部更新' });
      expect(sliceOf()!.byId).toBe(before);
      expect(sliceOf()!.byId?.get('reply')?.content).toBe('局部更新');
    });

    it('结构更新重建 threadIndex 子孙与 agentWorkUnitIds 旧值', () => {
      const store = useChannelMessageStore.getState();
      store.applyMessageSent('ch-1', msg('root-a', 0));
      store.applyMessageSent('ch-1', msg('root-b', 1));
      store.applyMessageSent('ch-1', msg('mid', 2, { replyToId: 'root-a', workUnitId: 'WU-old' }));
      store.applyMessageSent('ch-1', msg('leaf', 3, { replyToId: 'mid' }));
      store.applyMessageUpdated('ch-1', {
        messageId: 'mid',
        message: msg('mid', 2, { replyToId: 'root-b', workUnitId: 'WU-new', authorType: 'human' }),
      });
      const slice = sliceOf()!;
      expect(slice.threadIndex?.get('root-a')).toEqual(['root-a']);
      expect(slice.threadIndex?.get('root-b')).toEqual(['root-b', 'mid', 'leaf']);
      expect(slice.threadIndex?.has('mid')).toBe(false);
      expect(slice.agentWorkUnitIds?.has('WU-old')).toBe(false);
      expect(slice.agentWorkUnitIds?.has('WU-new')).toBe(false);
    });
  });
});
