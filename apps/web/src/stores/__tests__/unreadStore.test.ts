// unreadStore — 频道未读面共享 store（#413）：SSE channel.message_sent 增量 + 「正在看」语义。
// 关键契约：① active 频道（正在查看）不涨未读；② setActiveChannel 进频道即清零（打开即读，
// 对齐 notificationStore.markChannelRead 先例）；③ 计数存 store 而非 hook 实例私有 state，
// 断点跨越（<768 内联 ChannelRail ↔ SidebarNew 挂载实例切换）计数不丢。
import { describe, it, expect, beforeEach } from 'vitest';
import { useUnreadStore } from '../unreadStore';

beforeEach(() => {
  useUnreadStore.setState({ unreadCounts: {}, activeChannelId: null });
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
