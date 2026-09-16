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

import { useChannelMessageStore, agentAnsweredOf } from '../channelMessageStore';
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
    meta: '{}',
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
    mockListMessages.mockResolvedValue({ data: { data: [], hasMore: false } });
  });

  describe('fetchMessages（首拉替换 / refetch 合并）', () => {
    it('首拉：替换语义落库，loading 落位、loaded 置位', async () => {
      const m1 = msg('m1', 0);
      mockListMessages.mockResolvedValue({ data: { data: [m1], hasMore: true } });
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
      mockListMessages.mockResolvedValue({ data: { data: [m3], hasMore: true } });
      const store = useChannelMessageStore.getState();
      await store.fetchMessages('ch-1');
      // prepend 一页历史
      const m1 = msg('m1', 0);
      mockListMessages.mockResolvedValue({ data: { data: [m1], hasMore: false } });
      await store.loadMore('ch-1');
      // refetch：m3 服务端更新版 + 新到 m4
      const m3u = { ...m3, content: '服务端更新' };
      const m4 = msg('m4', 3);
      mockListMessages.mockResolvedValue({ data: { data: [m3u, m4], hasMore: true } });
      await store.fetchMessages('ch-1');

      const s = sliceOf()!;
      expect(s.messages.map(m => m.id)).toEqual(['m1', 'm3', 'm4']);
      expect(s.messages.find(m => m.id === 'm3')!.content).toBe('服务端更新');
    });

    it('prepend 方向上 hasMore 不被最新一页的 hasMore 错误重置', async () => {
      const m3 = msg('m3', 2);
      mockListMessages.mockResolvedValue({ data: { data: [m3], hasMore: true } });
      const store = useChannelMessageStore.getState();
      await store.fetchMessages('ch-1');
      const m1 = msg('m1', 0);
      mockListMessages.mockResolvedValue({ data: { data: [m1], hasMore: false } });
      await store.loadMore('ch-1');
      expect(sliceOf()!.hasMore).toBe(false);
      // 最新一页 hasMore=true 描述头部方向，不得覆盖 prepend 方向状态
      mockListMessages.mockResolvedValue({ data: { data: [m3], hasMore: true } });
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
      mockListMessages.mockResolvedValue({ data: { data: [m1], hasMore: false } });
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
      mockListMessages.mockResolvedValue({ data: { data: [m3], hasMore: true } });
      const store = useChannelMessageStore.getState();
      await store.fetchMessages('ch-1');

      const m1 = msg('m1', 0);
      const m2 = msg('m2', 1);
      mockListMessages.mockResolvedValue({ data: { data: [m1, m2], hasMore: false } });
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
      mockListMessages.mockResolvedValue({ data: { data: [], hasMore: true } });
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
      mockListMessages.mockResolvedValue({ data: { data: [m1], hasMore: false } });
      const store = useChannelMessageStore.getState();
      await store.fetchMessages('ch-1');

      const full = { ...m1, content: '新内容', meta: { k: 'v' } };
      store.applyMessageUpdated('ch-1', { messageId: 'm1', message: full });
      expect(sliceOf()!.messages[0]).toEqual(full);
    });

    it('legacy patch：仅 meta 整体替换、骨架不假复活；带 content 复活清 degraded', async () => {
      const m1 = msg('m1', 0, { content: '', meta: '{}', degraded: true });
      mockListMessages.mockResolvedValue({ data: { data: [m1], hasMore: false } });
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
      mockListMessages.mockResolvedValue({ data: { data: [msg('m3', 2)], hasMore: true } });
      await store.fetchMessages('ch-1');
      // prepend 一页更早历史
      mockListMessages.mockResolvedValue({ data: { data: [msg('m1', 0)], hasMore: false } });
      await store.loadMore('ch-1');
      // 乱序到达的 SSE 增量
      store.applyMessageSent('ch-1', msg('m5', 4));
      store.applyMessageSent('ch-1', msg('m4', 3));
      // refetch 合并进落在中间的新消息 m2
      mockListMessages.mockResolvedValue({
        data: { data: [msg('m2', 1), msg('m3', 2), msg('m4', 3), msg('m5', 4)], hasMore: false },
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
      mockListMessages.mockResolvedValue({ data: { data: batch(10), hasMore: false } });
      const store = useChannelMessageStore.getState();
      await store.fetchMessages('ch-1');
      store.syncPruning('ch-1', 'm8', OPTS); // 边界 7-2=5 → [m1..m5]
      const msgs = sliceOf()!.messages;
      expect(msgs.slice(0, 5).every(m => m.degraded && m.content === '')).toBe(true);
      expect(msgs.slice(5).every(m => !m.degraded)).toBe(true);
    });

    it('视口进入降级区 → 防抖后以首个非骨架 id 为游标整页水合，骨架原位复活、hasMore 不动', async () => {
      const list = batch(10);
      mockListMessages.mockResolvedValue({ data: { data: list, hasMore: false } });
      const store = useChannelMessageStore.getState();
      await store.fetchMessages('ch-1');
      store.syncPruning('ch-1', 'm8', OPTS);

      mockListMessages.mockResolvedValue({ data: { data: list.slice(0, 5), hasMore: true } });
      store.syncPruning('ch-1', 'm6', OPTS); // idx 5 < 5+1 → 触发水合
      expect(mockListMessages).toHaveBeenCalledTimes(1); // 首拉；防抖未点火
      await vi.advanceTimersByTimeAsync(250);
      expect(mockListMessages).toHaveBeenCalledWith('ch-1', { before: 'm6', limit: 100 });
      expect(sliceOf()!.messages.every(m => !m.degraded)).toBe(true);
      expect(sliceOf()!.messages.map(m => m.id)).toEqual(list.map(m => m.id));
      expect(sliceOf()!.hasMore).toBe(false); // 水合不触碰 hasMore
    });

    it('防抖窗口内连续触发只发一次水合请求', async () => {
      mockListMessages.mockResolvedValue({ data: { data: batch(10), hasMore: false } });
      const store = useChannelMessageStore.getState();
      await store.fetchMessages('ch-1');
      store.syncPruning('ch-1', 'm8', OPTS);
      mockListMessages.mockResolvedValue({ data: { data: [], hasMore: false } });
      store.syncPruning('ch-1', 'm6', OPTS);
      store.syncPruning('ch-1', 'm6', OPTS);
      await vi.advanceTimersByTimeAsync(250);
      expect(mockListMessages.mock.calls.filter(c => c[1]?.before === 'm6')).toHaveLength(1);
    });

    it('__resetForTests 清数据面 + 纪律簿记 + 水合计时器', async () => {
      mockListMessages.mockResolvedValue({ data: { data: batch(10), hasMore: false } });
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
});
