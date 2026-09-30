// unreadStore — 频道未读面共享 store（#413）：SSE channel.message_sent 增量 + 「正在看」语义。
// 关键契约：① active 频道（正在查看）不涨未读；② setActiveChannel 进频道即清零（打开即读，
// 对齐 notificationStore.markChannelRead 先例）；③ 计数存 store 而非 hook 实例私有 state，
// 断点跨越（<768 内联 ChannelRail ↔ SidebarNew 挂载实例切换）计数不丢。
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockListMessages } = vi.hoisted(() => ({ mockListMessages: vi.fn() }));
vi.mock('../../api/channel', () => ({
  channelApi: { listMessages: mockListMessages },
}));

import { useUnreadStore } from '../unreadStore';

beforeEach(() => {
  useUnreadStore.setState({ unreadCounts: {}, activeChannelId: null, lastSeenAt: {} });
  mockListMessages.mockReset();
});

describe('applyMessageSent', () => {
  it('非人类消息按频道累加', () => {
    useUnreadStore.getState().applyMessageSent('ch-1', 'agent');
    useUnreadStore.getState().applyMessageSent('ch-1', 'agent');
    useUnreadStore.getState().applyMessageSent('ch-2', 'agent');
    expect(useUnreadStore.getState().unreadCounts).toEqual({ 'ch-1': 2, 'ch-2': 1 });
  });

  it('authorType 缺省按非人类放行（对齐既有 hook 行为）', () => {
    useUnreadStore.getState().applyMessageSent('ch-1');
    expect(useUnreadStore.getState().unreadCounts['ch-1']).toBe(1);
  });

  it('人类消息不计', () => {
    useUnreadStore.getState().applyMessageSent('ch-1', 'human');
    expect(useUnreadStore.getState().unreadCounts['ch-1']).toBeUndefined();
  });

  it('active 频道不计（正在看不涨徽章）', () => {
    useUnreadStore.setState({ activeChannelId: 'ch-1' });
    useUnreadStore.getState().applyMessageSent('ch-1', 'agent');
    expect(useUnreadStore.getState().unreadCounts['ch-1']).toBeUndefined();
    // 其他频道照常计
    useUnreadStore.getState().applyMessageSent('ch-2', 'agent');
    expect(useUnreadStore.getState().unreadCounts['ch-2']).toBe(1);
  });
});

describe('setActiveChannel', () => {
  it('写入 active 并清零该频道计数（打开即读）', () => {
    useUnreadStore.getState().applyMessageSent('ch-1', 'agent');
    expect(useUnreadStore.getState().unreadCounts['ch-1']).toBe(1);

    useUnreadStore.getState().setActiveChannel('ch-1');
    expect(useUnreadStore.getState().activeChannelId).toBe('ch-1');
    expect(useUnreadStore.getState().unreadCounts['ch-1']).toBeUndefined();
  });

  it('置 null 退出「正在看」，此后消息恢复累加', () => {
    useUnreadStore.getState().setActiveChannel('ch-1');
    useUnreadStore.getState().setActiveChannel(null);
    expect(useUnreadStore.getState().activeChannelId).toBeNull();

    useUnreadStore.getState().applyMessageSent('ch-1', 'agent');
    expect(useUnreadStore.getState().unreadCounts['ch-1']).toBe(1);
  });
});

describe('clearUnread', () => {
  it('移除指定频道计数，不动其他频道', () => {
    useUnreadStore.getState().applyMessageSent('ch-1', 'agent');
    useUnreadStore.getState().applyMessageSent('ch-2', 'agent');

    useUnreadStore.getState().clearUnread('ch-1');
    expect(useUnreadStore.getState().unreadCounts).toEqual({ 'ch-2': 1 });
  });
});

describe('lastSeenAt 簿记（2026-09-25 断点修复）', () => {
  it('SSE 带消息 createdAt：推进簿记且幂等（≤簿记的事件不重复计）', () => {
    const s = useUnreadStore.getState;
    s().applyMessageSent('ch-1', 'agent', 1000);
    expect(s().unreadCounts['ch-1']).toBe(1);
    expect(s().lastSeenAt['ch-1']).toBe(1000);

    s().applyMessageSent('ch-1', 'agent', 900); // 早于簿记：resync 已覆盖
    s().applyMessageSent('ch-1', 'agent', 1000); // 等于簿记：同一消息重复事件
    expect(s().unreadCounts['ch-1']).toBe(1);

    s().applyMessageSent('ch-1', 'agent', 1001);
    expect(s().unreadCounts['ch-1']).toBe(2);
    expect(s().lastSeenAt['ch-1']).toBe(1001);
  });

  it('人类消息与 active 频道不计数但都推进簿记', () => {
    const s = useUnreadStore.getState;
    s().applyMessageSent('ch-1', 'human', 500);
    expect(s().unreadCounts['ch-1']).toBeUndefined();
    expect(s().lastSeenAt['ch-1']).toBe(500);

    useUnreadStore.setState({ activeChannelId: 'ch-2' });
    s().applyMessageSent('ch-2', 'agent', 700);
    expect(s().unreadCounts['ch-2']).toBeUndefined();
    expect(s().lastSeenAt['ch-2']).toBe(700);
  });

  it('setActiveChannel / clearUnread 记「已读到此刻」', () => {
    const s = useUnreadStore.getState;
    useUnreadStore.setState({ lastSeenAt: { 'ch-1': 100 } });
    s().setActiveChannel('ch-1');
    expect(s().lastSeenAt['ch-1']).toBeGreaterThan(100);

    useUnreadStore.setState({ lastSeenAt: { 'ch-2': 100 } });
    s().clearUnread('ch-2');
    expect(s().lastSeenAt['ch-2']).toBeGreaterThan(100);
  });
});

describe('resyncOnReconnect（断线补底数）', () => {
  const msg = (createdAt: number, authorType: 'human' | 'agent' = 'agent') => ({
    id: `m-${createdAt}`, channelId: 'ch', authorType, content: 'x', createdAt: new Date(createdAt).toISOString(),
  });
  const page = (list: unknown[]) => ({ data: { data: { messages: list, total: list.length, hasMore: false } } });

  it('无簿记频道时不发请求', async () => {
    await useUnreadStore.getState().resyncOnReconnect();
    expect(mockListMessages).not.toHaveBeenCalled();
  });

  it('数 lastSeenAt 之后的非人类消息并入计数，簿记推进到页内最大 createdAt', async () => {
    useUnreadStore.setState({ lastSeenAt: { 'ch-1': 1000, 'ch-2': 2000 } });
    mockListMessages.mockImplementation((id: string) => Promise.resolve(
      id === 'ch-1' ? page([msg(1500), msg(900), msg(1600, 'human')]) : page([]),
    ));

    await useUnreadStore.getState().resyncOnReconnect();
    const s = useUnreadStore.getState();
    expect(mockListMessages).toHaveBeenCalledWith('ch-1', { limit: 50 });
    expect(s.unreadCounts['ch-1']).toBe(1); // 只有 1500 的 agent 消息
    expect(s.unreadCounts['ch-2']).toBeUndefined();
    expect(s.lastSeenAt['ch-1']).toBe(1600); // 含 human 消息推进
    expect(s.lastSeenAt['ch-2']).toBe(2000);
  });

  it('二次 resync 不重复计；resync 后同消息的迟到 SSE 事件幂等跳过', async () => {
    useUnreadStore.setState({ lastSeenAt: { 'ch-1': 1000 } });
    mockListMessages.mockResolvedValue(page([msg(1500)]));

    await useUnreadStore.getState().resyncOnReconnect();
    await useUnreadStore.getState().resyncOnReconnect();
    expect(useUnreadStore.getState().unreadCounts['ch-1']).toBe(1);

    useUnreadStore.getState().applyMessageSent('ch-1', 'agent', 1500);
    expect(useUnreadStore.getState().unreadCounts['ch-1']).toBe(1);
  });

  it('active 频道只推进簿记不涨数', async () => {
    useUnreadStore.setState({ lastSeenAt: { 'ch-1': 1000 }, activeChannelId: 'ch-1' });
    mockListMessages.mockResolvedValue(page([msg(1500)]));

    await useUnreadStore.getState().resyncOnReconnect();
    const s = useUnreadStore.getState();
    expect(s.unreadCounts['ch-1']).toBeUndefined();
    expect(s.lastSeenAt['ch-1']).toBe(1500);
  });

  it('单频道拉取失败保留现状（计数与簿记不动），其他频道照常补', async () => {
    useUnreadStore.setState({ lastSeenAt: { 'ch-1': 1000, 'ch-2': 2000 } });
    mockListMessages.mockImplementation((id: string) =>
      id === 'ch-1' ? Promise.reject(new Error('net down')) : Promise.resolve(page([msg(2500)])),
    );

    await useUnreadStore.getState().resyncOnReconnect();
    const s = useUnreadStore.getState();
    expect(s.unreadCounts['ch-1']).toBeUndefined();
    expect(s.lastSeenAt['ch-1']).toBe(1000);
    expect(s.unreadCounts['ch-2']).toBe(1);
    expect(s.lastSeenAt['ch-2']).toBe(2500);
  });
});
