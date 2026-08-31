// notificationStore — 通知中心共享 store：后端持久面 + SSE 实时增量的读态与已读动作。
// 关键契约：markChannelRead（打开频道即读）只清 channelId 匹配的未读通知，
// 后端条目逐条 POST /:id/read，SSE 条目（backendId null）仅本地已读。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockApi } = vi.hoisted(() => ({
  mockApi: { get: vi.fn(), post: vi.fn() },
}));

vi.mock('../../api', () => ({ api: mockApi }));

import { useNotificationStore, parseLinkTargets, type Notification } from '../notificationStore';

function sseItem(overrides: Partial<Notification> = {}): Notification {
  return {
    id: 'sse-1', backendId: null, channelId: 'ch-1', agentName: 'pmo',
    title: null, content: '实时消息', time: '10:00', read: false,
    workUnitId: null, pmoId: null, messageId: 'sse-1',
    ...overrides,
  };
}

const backendRow = {
  id: 'n1', userId: 'u1', type: 'auditor_suggestion', title: '审计建议 (1 项)',
  content: '建议一', link: '/channels/ch-1', createdAt: '2026-08-18T08:00:00.000Z',
  read: false, readAt: null,
};

beforeEach(() => {
  useNotificationStore.setState({ notifications: [] });
  mockApi.get.mockReset();
  mockApi.post.mockReset();
  mockApi.post.mockResolvedValue({ data: { success: true } });
});

describe('parseLinkTargets', () => {
  it('从 link 解析 WU/PMO/频道 id；null link 全 null', () => {
    expect(parseLinkTargets(null)).toEqual({ workUnitId: null, pmoId: null, channelId: null });
    expect(parseLinkTargets('/workunits/wu-1')).toEqual({ workUnitId: 'wu-1', pmoId: null, channelId: null });
    expect(parseLinkTargets('/pmo/project/p-1')).toEqual({ workUnitId: null, pmoId: 'p-1', channelId: null });
    expect(parseLinkTargets('/channels/ch-9')).toEqual({ workUnitId: null, pmoId: null, channelId: 'ch-9' });
  });
});

describe('loadFromBackend', () => {
  it('后端行替换持久面，SSE 实时条目（backendId null）保留', async () => {
    useNotificationStore.getState().pushSse(sseItem());
    mockApi.get.mockResolvedValue({ data: [backendRow] });

    await useNotificationStore.getState().loadFromBackend();

    const list = useNotificationStore.getState().notifications;
    expect(list.map(n => n.id)).toEqual(['sse-1', 'n1']);
    expect(list[1].channelId).toBe('ch-1');
    expect(list[1].read).toBe(false);
  });

  it('拉取失败不抛错，保留现有列表', async () => {
    useNotificationStore.getState().pushSse(sseItem());
    mockApi.get.mockRejectedValue(new Error('network'));

    await useNotificationStore.getState().loadFromBackend();

    expect(useNotificationStore.getState().notifications.map(n => n.id)).toEqual(['sse-1']);
  });
});

describe('markRead / markAllRead', () => {
  it('markRead：本地已读；后端条目 POST /:id/read，SSE 条目不调后端', () => {
    useNotificationStore.setState({
      notifications: [sseItem(), sseItem({ id: 'n1', backendId: 'n1' })],
    });

    useNotificationStore.getState().markRead('sse-1');
    useNotificationStore.getState().markRead('n1');

    const list = useNotificationStore.getState().notifications;
    expect(list.every(n => n.read)).toBe(true);
    expect(mockApi.post).toHaveBeenCalledTimes(1);
    expect(mockApi.post).toHaveBeenCalledWith('/notifications/n1/read');
  });

  it('markAllRead：全部本地已读 + POST /read-all', () => {
    useNotificationStore.setState({ notifications: [sseItem(), sseItem({ id: 's2' })] });

    useNotificationStore.getState().markAllRead();

    expect(useNotificationStore.getState().notifications.every(n => n.read)).toBe(true);
    expect(mockApi.post).toHaveBeenCalledWith('/notifications/read-all');
  });
});

describe('markChannelRead（打开频道即读）', () => {
  it('只清 channelId 匹配的未读：本频道已读，其他频道/其他类型不动', () => {
    useNotificationStore.setState({
      notifications: [
        sseItem(),                                                  // ch-1 未读 SSE
        sseItem({ id: 'n1', backendId: 'n1' }),                     // ch-1 未读后端
        sseItem({ id: 's-other', channelId: 'ch-2' }),              // ch-2 未读
        sseItem({ id: 's-read', read: true }),                      // ch-1 已读
      ],
    });

    useNotificationStore.getState().markChannelRead('ch-1');

    const byId = Object.fromEntries(useNotificationStore.getState().notifications.map(n => [n.id, n.read]));
    expect(byId).toEqual({ 'sse-1': true, 'n1': true, 's-other': false, 's-read': true });
    // 仅后端条目同步后端
    expect(mockApi.post).toHaveBeenCalledTimes(1);
    expect(mockApi.post).toHaveBeenCalledWith('/notifications/n1/read');
  });

  it('无匹配未读 → 零后端调用', () => {
    useNotificationStore.setState({ notifications: [sseItem({ channelId: 'ch-2' })] });

    useNotificationStore.getState().markChannelRead('ch-1');

    expect(mockApi.post).not.toHaveBeenCalled();
  });
});
