// notificationStore — 行动中心共享 store（#468）：GET /action-center 一个端点三段数据
// （stateItems 状态派生 + notifications 事件持久 + unreadCount），整体替换；
// 已读动作本地乐观 + 后端 POST 同步，并同步维护 unreadCount。
// 关键契约：markChannelRead（打开频道即读）只清 channelId 匹配的未读通知，逐条 POST /:id/read。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockApi } = vi.hoisted(() => ({
  mockApi: { get: vi.fn(), post: vi.fn() },
}));

vi.mock('../../api', () => ({ api: mockApi }));

import { useNotificationStore, parseLinkTargets, needInputViewOf, type Notification, type StateItem } from '../notificationStore';

function notification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: 'n1', type: 'auditor_suggestion', channelId: 'ch-1', agentName: 'System',
    title: '审计建议', content: '建议一', time: '10:00', read: false,
    workUnitId: null, pmoId: null, messageId: null,
    ...overrides,
  };
}

function stateItem(overrides: Partial<StateItem> = {}): StateItem {
  return {
    kind: 'reply', wuId: 'WU-1', scope: '登录功能', channelId: 'ch-1',
    waitingQuestion: '选哪个方案？', since: '2026-09-09T08:00:00.000Z',
    ...overrides,
  };
}

const backendRow = {
  id: 'n1', userId: 'u1', type: 'auditor_suggestion', title: '审计建议 (1 项)',
  content: '建议一', link: '/channels/ch-1', wuId: null, channelId: null,
  createdAt: '2026-08-18T08:00:00.000Z', read: false, readAt: null,
};

const actionCenterPayload = (overrides: Record<string, unknown> = {}) => ({
  stateItems: [stateItem()],
  notifications: [backendRow],
  unreadCount: 1,
  ...overrides,
});

beforeEach(() => {
  useNotificationStore.setState({ stateItems: [], notifications: [], unreadCount: 0, loadedAt: null, inflight: null });
  mockApi.get.mockReset();
  mockApi.post.mockReset();
  mockApi.post.mockResolvedValue({ data: { success: true } });
});

describe('parseLinkTargets', () => {
  it('从 link 解析 WU/PMO/频道 id；null link 全 null', () => {
    expect(parseLinkTargets(null)).toEqual({ workUnitId: null, pmoId: null, channelId: null, messageId: null });
    expect(parseLinkTargets('/workunits/wu-1')).toEqual({ workUnitId: 'wu-1', pmoId: null, channelId: null, messageId: null });
    expect(parseLinkTargets('/pmo/project/p-1')).toEqual({ workUnitId: null, pmoId: 'p-1', channelId: null, messageId: null });
    expect(parseLinkTargets('/channels/ch-9')).toEqual({ workUnitId: null, pmoId: null, channelId: 'ch-9', messageId: null });
  });

  it('#439：频道 link 带 ?highlight=<mid> 时解析出 messageId', () => {
    expect(parseLinkTargets('/channels/ch-9?highlight=m-1'))
      .toEqual({ workUnitId: null, pmoId: null, channelId: 'ch-9', messageId: 'm-1' });
    // 非频道链接上的 highlight 不解析（避免 WU/PMO 链接误带）
    expect(parseLinkTargets('/workunits/wu-1?highlight=m-1'))
      .toEqual({ workUnitId: 'wu-1', pmoId: null, channelId: null, messageId: null });
  });
});

describe('load（GET /action-center 三段整体替换）', () => {
  it('映射 stateItems / notifications / unreadCount 三段', async () => {
    mockApi.get.mockResolvedValue({ data: actionCenterPayload() });

    await useNotificationStore.getState().load();

    expect(mockApi.get).toHaveBeenCalledWith('/action-center');
    const s = useNotificationStore.getState();
    expect(s.stateItems).toHaveLength(1);
    expect(s.stateItems[0]).toMatchObject({ kind: 'reply', wuId: 'WU-1', channelId: 'ch-1', waitingQuestion: '选哪个方案？' });
    expect(s.notifications.map(n => n.id)).toEqual(['n1']);
    expect(s.unreadCount).toBe(1);
  });

  it('整体替换：旧 stateItems 与新负载对齐（状态变即消，无合并）', async () => {
    useNotificationStore.setState({ stateItems: [stateItem({ wuId: 'WU-old' })] });
    mockApi.get.mockResolvedValue({ data: actionCenterPayload({ stateItems: [] }) });

    await useNotificationStore.getState().load();

    expect(useNotificationStore.getState().stateItems).toEqual([]);
  });

  it('#468：结构化 wuId/channelId 优先于 link 正则解析', async () => {
    mockApi.get.mockResolvedValue({
      data: actionCenterPayload({
        notifications: [{ ...backendRow, link: '/channels/ch-legacy', wuId: 'WU-9', channelId: 'ch-9' }],
      }),
    });

    await useNotificationStore.getState().load();

    const n = useNotificationStore.getState().notifications[0];
    expect(n.workUnitId).toBe('WU-9');
    expect(n.channelId).toBe('ch-9');
  });

  it('老数据行无结构化字段 → 回退 link 正则（pmoId/messageId 恒走 link）', async () => {
    mockApi.get.mockResolvedValue({
      data: actionCenterPayload({
        notifications: [
          { ...backendRow, id: 'n2', link: '/workunits/wu-3' },
          { ...backendRow, id: 'n3', link: '/pmo/project/p-7' },
          { ...backendRow, id: 'n4', link: '/channels/ch-5?highlight=m-42' },
        ],
      }),
    });

    await useNotificationStore.getState().load();

    const byId = Object.fromEntries(useNotificationStore.getState().notifications.map(n => [n.id, n]));
    expect(byId['n2'].workUnitId).toBe('wu-3');
    expect(byId['n3'].pmoId).toBe('p-7');
    expect(byId['n4'].channelId).toBe('ch-5');
    expect(byId['n4'].messageId).toBe('m-42');
  });

  it('拉取失败不抛错，保留现有三段', async () => {
    useNotificationStore.setState({
      stateItems: [stateItem()], notifications: [notification()], unreadCount: 3,
    });
    mockApi.get.mockRejectedValue(new Error('network'));

    await useNotificationStore.getState().load();

    const s = useNotificationStore.getState();
    expect(s.stateItems).toHaveLength(1);
    expect(s.notifications).toHaveLength(1);
    expect(s.unreadCount).toBe(3);
  });
});

describe('#517 取数纪律（TTL / single-flight / seq 守卫，照 rosterStore 模式）', () => {
  it('TTL 内重复 load 只发一次请求；maxAgeMs=0 强拉绕过 TTL', async () => {
    mockApi.get.mockResolvedValue({ data: actionCenterPayload() });

    await useNotificationStore.getState().load();
    await useNotificationStore.getState().load();
    expect(mockApi.get).toHaveBeenCalledTimes(1);

    await useNotificationStore.getState().load({ maxAgeMs: 0 });
    expect(mockApi.get).toHaveBeenCalledTimes(2);
  });

  it('并发 load 并入 single-flight：在途期间只发一次请求', async () => {
    let resolveGet!: (v: unknown) => void;
    mockApi.get.mockImplementation(() => new Promise(r => { resolveGet = r; }));

    const p1 = useNotificationStore.getState().load();
    const p2 = useNotificationStore.getState().load();
    expect(mockApi.get).toHaveBeenCalledTimes(1);

    resolveGet({ data: actionCenterPayload() });
    await Promise.all([p1, p2]);
    expect(useNotificationStore.getState().notifications).toHaveLength(1);
  });

  it('失败不更新 loadedAt 锚点：TTL 内下一次 load 立即重试（永不 reject）', async () => {
    mockApi.get.mockRejectedValueOnce(new Error('network'));
    await useNotificationStore.getState().load();
    expect(useNotificationStore.getState().loadedAt).toBeNull();

    mockApi.get.mockResolvedValue({ data: actionCenterPayload() });
    await useNotificationStore.getState().load();
    expect(mockApi.get).toHaveBeenCalledTimes(2);
    expect(useNotificationStore.getState().unreadCount).toBe(1);
  });

  it('seq 守卫：强拉在途时旧 fetch 晚到结果不落库', async () => {
    const resolvers: Array<(v: unknown) => void> = [];
    mockApi.get.mockImplementation(() => new Promise(r => { resolvers.push(r); }));

    const p1 = useNotificationStore.getState().load();
    const p2 = useNotificationStore.getState().load({ maxAgeMs: 0 }); // 强拉不并入在途
    expect(mockApi.get).toHaveBeenCalledTimes(2);

    // 新 fetch 先回 → 落库
    resolvers[1]({ data: actionCenterPayload({ unreadCount: 2 }) });
    await p2;
    expect(useNotificationStore.getState().unreadCount).toBe(2);

    // 旧 fetch 晚到 → seq 守卫拦截，不回写
    resolvers[0]({ data: actionCenterPayload({ unreadCount: 9 }) });
    await p1;
    expect(useNotificationStore.getState().unreadCount).toBe(2);
  });
});

describe('markRead / markAllRead（本地乐观 + unreadCount 同步）', () => {
  it('markRead：本地已读 + unreadCount 乐观递减 + POST /:id/read', () => {
    useNotificationStore.setState({
      notifications: [notification(), notification({ id: 'n2' })], unreadCount: 2,
    });

    useNotificationStore.getState().markRead('n1');

    const s = useNotificationStore.getState();
    expect(s.notifications.find(n => n.id === 'n1')?.read).toBe(true);
    expect(s.notifications.find(n => n.id === 'n2')?.read).toBe(false);
    expect(s.unreadCount).toBe(1);
    expect(mockApi.post).toHaveBeenCalledWith('/notifications/n1/read');
  });

  it('markRead 已读条目：计数不重复递减、不重复 POST', () => {
    useNotificationStore.setState({ notifications: [notification({ read: true })], unreadCount: 0 });

    useNotificationStore.getState().markRead('n1');

    expect(useNotificationStore.getState().unreadCount).toBe(0);
    expect(mockApi.post).not.toHaveBeenCalled();
  });

  it('markAllRead：全部本地已读 + unreadCount 归零 + POST /read-all', () => {
    useNotificationStore.setState({
      notifications: [notification(), notification({ id: 'n2' })], unreadCount: 2,
    });

    useNotificationStore.getState().markAllRead();

    const s = useNotificationStore.getState();
    expect(s.notifications.every(n => n.read)).toBe(true);
    expect(s.unreadCount).toBe(0);
    expect(mockApi.post).toHaveBeenCalledWith('/notifications/read-all');
  });
});

describe('markChannelRead（打开频道即读）', () => {
  it('只清 channelId 匹配的未读：本频道已读 + unreadCount 递减，其他频道/已读不动', () => {
    useNotificationStore.setState({
      notifications: [
        notification(),                                       // ch-1 未读
        notification({ id: 'n2' }),                           // ch-1 未读
        notification({ id: 'n3', channelId: 'ch-2' }),        // ch-2 未读
        notification({ id: 'n4', read: true }),               // ch-1 已读
      ],
      unreadCount: 3,
    });

    useNotificationStore.getState().markChannelRead('ch-1');

    const s = useNotificationStore.getState();
    const byId = Object.fromEntries(s.notifications.map(n => [n.id, n.read]));
    expect(byId).toEqual({ 'n1': true, 'n2': true, 'n3': false, 'n4': true });
    expect(s.unreadCount).toBe(1);
    expect(mockApi.post).toHaveBeenCalledTimes(2);
    expect(mockApi.post).toHaveBeenCalledWith('/notifications/n1/read');
    expect(mockApi.post).toHaveBeenCalledWith('/notifications/n2/read');
  });

  it('无匹配未读 → 零后端调用、unreadCount 不动', () => {
    useNotificationStore.setState({ notifications: [notification({ channelId: 'ch-2' })], unreadCount: 1 });

    useNotificationStore.getState().markChannelRead('ch-1');

    expect(mockApi.post).not.toHaveBeenCalled();
    expect(useNotificationStore.getState().unreadCount).toBe(1);
  });
});

// #546：per-channel need-input 投影收口——needInputViewOf 纯函数（stateItems → 四种消费形状单源），
// 口径变更只落此处；ChannelDetailPage 退回订阅并渲染（页面内联 filter/map 派生已删）
describe('needInputViewOf（#546 per-channel need-input 投影单源）', () => {
  it('只取 kind=reply 且 channelId 匹配的条目；review/confirm 与他频道条目不进投影', () => {
    const view = needInputViewOf([
      stateItem({ wuId: 'WU-1', channelId: 'ch-1', messageId: 'm-1' }),
      stateItem({ wuId: 'WU-2', kind: 'review', channelId: 'ch-1', messageId: 'm-2' }),
      stateItem({ wuId: 'WU-3', kind: 'confirm', channelId: 'ch-1', messageId: 'm-3' }),
      stateItem({ wuId: 'WU-4', channelId: 'ch-2', messageId: 'm-4' }),
    ], 'ch-1');

    expect(view.waitingWus).toEqual([
      { wuId: 'WU-1', question: '选哪个方案？', messageId: 'm-1' },
    ]);
  });

  it('条目 channelId 为 null 不匹配任何频道；channelId 参数缺省 → 空投影（fail-closed）', () => {
    const items = [stateItem({ channelId: null, messageId: 'm-1' })];
    expect(needInputViewOf(items, 'ch-1').waitingWus).toEqual([]);
    expect(needInputViewOf(items, undefined).waitingWus).toEqual([]);
  });

  it('question = waitingQuestion ?? scope（waitingQuestion 缺省回落 scope 摘要）', () => {
    const view = needInputViewOf([
      stateItem({ wuId: 'WU-1', waitingQuestion: undefined, scope: '登录功能' }),
    ], 'ch-1');
    expect(view.waitingWus[0].question).toBe('登录功能');
  });

  it('messageId 缺省的 WU 不进 wu→mid 映射与提升集，isWaitingForInput 恒 false（fail-closed，不反推）', () => {
    const view = needInputViewOf([
      stateItem({ wuId: 'WU-1', messageId: undefined }),
      stateItem({ wuId: 'WU-2', messageId: 'm-2' }),
    ], 'ch-1');

    // 列表仍含两条（chip/右栏可见），但锚点映射只收有 messageId 的
    expect(view.waitingWus.map(w => w.wuId)).toEqual(['WU-1', 'WU-2']);
    expect(view.questionIdByWu.get('WU-1')).toBeUndefined();
    expect(view.questionIdByWu.get('WU-2')).toBe('m-2');
    expect([...view.promotedQuestionIds]).toEqual(['m-2']);
    expect(view.isWaitingForInput({ id: 'm-x', workUnitId: 'WU-1' })).toBe(false);
    expect(view.isWaitingForInput({ id: 'm-2', workUnitId: 'WU-2' })).toBe(true);
    // 无 workUnitId / id 不匹配 → false
    expect(view.isWaitingForInput({ id: 'm-2' })).toBe(false);
    expect(view.isWaitingForInput({ id: 'm-9', workUnitId: 'WU-2' })).toBe(false);
  });
});
