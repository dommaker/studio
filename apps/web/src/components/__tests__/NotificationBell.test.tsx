/**
 * NotificationBell tests — #468 统一行动中心面板
 *
 * 面板 = GET /action-center 一个端点三段数据的视图：
 * 待回复/待验收/待确认（stateItems 状态派生，无已读概念）+ 通知与告警（事件持久，已读墓碑）。
 * SSE 只作失效触发（atHuman / workunit.status_changed → 重拉），断线重连重拉（#415 模式保留）。
 * 标题闪烁机制保留，停止条件 = unreadCount + stateItems.length === 0。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { WebSocketMessage } from '../../api/websocket';

const { mockNavigate, sseHandlers, reconnectHandlers, mockApi, stableOnEvent, stableOnReconnect } = vi.hoisted(() => {
  const handlers = new Set<(msg: unknown) => void>();
  const reconnects = new Set<() => void>();
  return {
    mockNavigate: vi.fn(),
    sseHandlers: handlers,
    reconnectHandlers: reconnects,
    mockApi: { get: vi.fn(), post: vi.fn() },
    // 真实 onEvent 是 useCallback([]) 稳定引用（websocket.tsx）；不稳定会导致
    // NotificationBell 的 [onEvent] effect 每次渲染重跑，cleanup 清掉 flash 定时器
    stableOnEvent: (handler: (msg: unknown) => void) => {
      handlers.add(handler);
      return () => { handlers.delete(handler); };
    },
    // #415：onReconnect 同为稳定注册（websocket.tsx）——重连处理器经此手工触发
    stableOnReconnect: (handler: () => void) => {
      reconnects.add(handler);
      return () => { reconnects.delete(handler); };
    },
  };
});

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('../../api/websocketHooks', () => ({
  useWebSocketContext: () => ({ onEvent: stableOnEvent, onReconnect: stableOnReconnect }),
}));

vi.mock('../../api', () => ({ api: mockApi }));

// D-2 项2/项3：抽屉自挂实例 —— stub WorkUnitDrawer（真实抽屉的取数/SSE 由 WorkUnitDrawer.test 覆盖），
// 本文件只断言「打开/切换/串办导航」的宿主行为
const { drawerPropsSpy } = vi.hoisted(() => ({ drawerPropsSpy: vi.fn() }));
vi.mock('../channel/WorkUnitDrawer', () => ({
  WorkUnitDrawer: (props: {
    drawer: { kind: string; id: string } | null;
    todoNav?: { next: { wuId: string; label: string } | null; onOpenNext: (wuId: string) => void };
  }) => {
    drawerPropsSpy(props);
    return props.drawer ? <div data-testid="ac-drawer">{props.drawer.id}</div> : null;
  },
}));

import { NotificationBell } from '../NotificationBell';
import { useNotificationStore, type StateItem } from '../../stores/notificationStore';
import { toast } from '../../utils/toast';

interface BackendNotification {
  id: string;
  userId: string;
  type: string;
  title: string;
  content: string;
  link: string | null;
  wuId?: string | null;
  channelId?: string | null;
  createdAt: string;
  read: boolean;
  readAt: string | null;
}

function stateItem(overrides: Partial<StateItem> = {}): StateItem {
  return {
    kind: 'reply', wuId: 'WU-1', scope: '登录功能', channelId: 'ch-1',
    waitingQuestion: '选哪个方案？', since: '2026-09-09T08:00:00.000Z',
    ...overrides,
  };
}

function backendNotification(overrides: Partial<BackendNotification> = {}): BackendNotification {
  return {
    id: 'n1', userId: 'u1', type: 'auditor_suggestion', title: '审计建议 (2 项)',
    content: '建议一 | 建议二', link: '/channels/ch-9', wuId: null, channelId: null,
    createdAt: '2026-08-18T08:00:00.000Z', read: false, readAt: null,
    ...overrides,
  };
}

interface Payload {
  stateItems?: StateItem[];
  notifications?: BackendNotification[];
  unreadCount?: number;
}

function mockActionCenter(p: Payload = {}) {
  mockApi.get.mockResolvedValue({
    data: { stateItems: p.stateItems ?? [], notifications: p.notifications ?? [], unreadCount: p.unreadCount ?? 0 },
  });
}

function emitSse(eventType: string, data: unknown, eventId = 'evt-1') {
  const msg: WebSocketMessage = {
    event_id: eventId,
    event_type: eventType,
    timestamp: new Date().toISOString(),
    data,
  };
  act(() => {
    sseHandlers.forEach(h => h(msg));
  });
}

function emitAtHuman(agentName = 'pmo') {
  emitSse('channel.message_sent', {
    channelId: 'ch-1',
    message: { id: 'm-1', agentName, content: '@人 请处理', meta: { atHuman: true } },
  });
}

/** #415：手工触发重连（真实 EventSource 非首次 onopen 才回调） */
function emitReconnect() {
  act(() => {
    reconnectHandlers.forEach(h => h());
  });
}

function openDropdown() {
  fireEvent.click(screen.getByTitle('行动中心'));
}

async function renderLoaded(p: Payload = {}) {
  mockActionCenter(p);
  render(<NotificationBell />);
  await waitFor(() => expect(mockApi.get).toHaveBeenCalledWith('/action-center'));
}

beforeEach(() => {
  sseHandlers.clear();
  reconnectHandlers.clear();
  // store 是模块单例，跨用例重置三段
  useNotificationStore.setState({ stateItems: [], notifications: [], unreadCount: 0 });
  mockNavigate.mockClear();
  mockApi.get.mockReset();
  mockApi.post.mockReset();
  mockApi.post.mockResolvedValue({ data: { success: true } });
  drawerPropsSpy.mockClear();
  toast.dismiss(); // D-2 项3：toast 是全局 DOM 单例（#toast-container），跨用例清场
});

describe('#468 行动中心面板（四分区）', () => {
  it('挂载拉取 /action-center；角标 = unreadCount + stateItems 数', async () => {
    await renderLoaded({
      stateItems: [stateItem(), stateItem({ kind: 'confirm', wuId: 'WU-2', channelId: null })],
      notifications: [backendNotification()],
      unreadCount: 1,
    });
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('面板分区：待回复/待验收/待确认分区计数 + 分隔后的通知与告警', async () => {
    await renderLoaded({
      stateItems: [
        stateItem({ wuId: 'WU-1', scope: '登录功能' }),
        stateItem({ kind: 'review', wuId: 'WU-2', scope: '决策单待批', channelId: 'ch-2' }),
        stateItem({ kind: 'confirm', wuId: 'WU-3', scope: '新任务待确认', channelId: null }),
      ],
      notifications: [backendNotification()],
      unreadCount: 1,
    });
    openDropdown();

    expect(screen.getByText('行动中心')).toBeInTheDocument();
    expect(screen.getByText('待回复 (1)')).toBeInTheDocument();
    expect(screen.getByText('待验收 (1)')).toBeInTheDocument();
    expect(screen.getByText('待确认 (1)')).toBeInTheDocument();
    expect(screen.getByText('通知与告警')).toBeInTheDocument();
    expect(screen.getByText('登录功能')).toBeInTheDocument();
    expect(screen.getByText('选哪个方案？')).toBeInTheDocument();
    expect(screen.getByText('决策单待批')).toBeInTheDocument();
    expect(screen.getByText('新任务待确认')).toBeInTheDocument();
    expect(screen.getByText('审计建议 (2 项)')).toBeInTheDocument();
  });

  it('待回复点击：channelId 存在 → 跳频道；messageId 存在 → 带 ?highlight= 直达提问消息（D-2 项1）', async () => {
    await renderLoaded({
      stateItems: [
        stateItem({ wuId: 'WU-1', scope: '带锚点待回复', channelId: 'ch-1', messageId: 'm-9' }),
        stateItem({ wuId: 'WU-2', scope: '无锚点待回复', channelId: 'ch-2' }),
        stateItem({ wuId: 'WU-3', scope: '无频道待回复', channelId: null }),
      ],
    });
    openDropdown();

    fireEvent.click(screen.getByText('带锚点待回复'));
    expect(mockNavigate).toHaveBeenCalledWith('/channels/ch-1?highlight=m-9');

    openDropdown(); // 点击后面板收起，重新展开
    fireEvent.click(screen.getByText('无锚点待回复'));
    // fail-closed：messageId 缺失不拼参数（回退既有行为）
    expect(mockNavigate).toHaveBeenCalledWith('/channels/ch-2');

    openDropdown();
    fireEvent.click(screen.getByText('无频道待回复'));
    expect(mockNavigate).toHaveBeenCalledWith('/workunits/WU-3');
    // stateItems 无已读概念：点击不产生后端已读调用
    expect(mockApi.post).not.toHaveBeenCalled();
  });

  it('待验收/待确认点击 → 就地开抽屉覆盖当前页（D-2 项2），不再整页跳 /workunits/:id', async () => {
    await renderLoaded({
      stateItems: [
        stateItem({ kind: 'review', wuId: 'WU-7', scope: '验收单' }),
        stateItem({ kind: 'confirm', wuId: 'WU-8', scope: '确认单' }),
      ],
    });
    openDropdown();

    fireEvent.click(screen.getByText('验收单'));
    expect(await screen.findByTestId('ac-drawer')).toHaveTextContent('WU-7');
    expect(mockNavigate).not.toHaveBeenCalled();

    openDropdown(); // 点击后面板收起，重新展开（抽屉保持打开）
    fireEvent.click(screen.getByText('确认单'));
    expect(await screen.findByTestId('ac-drawer')).toHaveTextContent('WU-8');
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('D-2 项3（review/confirm 线）：当前 WU 掉出待办池 → 抽屉收 todoNav「下一个 →」，点击同抽屉换 WU', async () => {
    await renderLoaded({
      stateItems: [
        stateItem({ kind: 'review', wuId: 'WU-7', scope: '验收单' }),
        stateItem({ kind: 'confirm', wuId: 'WU-8', scope: '确认单' }),
      ],
    });
    openDropdown();
    fireEvent.click(screen.getByText('验收单'));
    await screen.findByTestId('ac-drawer');

    // 当前项仍在池里（未处理）→ 不出串办导航
    expect(drawerPropsSpy.mock.lastCall![0].todoNav).toBeUndefined();

    // 闸门动作成功 = SSE 触发重拉后 WU-7 掉出 stateItems（状态派生、状态变即消）
    act(() => {
      useNotificationStore.setState({
        stateItems: [stateItem({ kind: 'confirm', wuId: 'WU-8', scope: '确认单' })],
      });
    });
    const nav = drawerPropsSpy.mock.lastCall![0].todoNav;
    expect(nav.next).toEqual({ wuId: 'WU-8', label: '确认单' });

    // 「下一个 →」= 同抽屉换 WU（不关抽屉、不跳页）
    act(() => nav.onOpenNext('WU-8'));
    expect(await screen.findByTestId('ac-drawer')).toHaveTextContent('WU-8');
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('D-2 项3：待办池清空 → todoNav.next=null（抽屉内收口文案由抽屉渲染）', async () => {
    await renderLoaded({
      stateItems: [stateItem({ kind: 'review', wuId: 'WU-7', scope: '验收单' })],
    });
    openDropdown();
    fireEvent.click(screen.getByText('验收单'));
    await screen.findByTestId('ac-drawer');

    act(() => { useNotificationStore.setState({ stateItems: [] }); });
    expect(drawerPropsSpy.mock.lastCall![0].todoNav.next).toBeNull();
  });

  it('D-2 项3（reply 线）：处理完点击过的 reply 项 → toast 给「下一个 →」导航到下一条频道', async () => {
    await renderLoaded({
      stateItems: [
        stateItem({ wuId: 'WU-1', scope: '待回复甲', channelId: 'ch-1', messageId: 'm-1' }),
        stateItem({ wuId: 'WU-2', scope: '待回复乙', channelId: 'ch-2', messageId: 'm-2' }),
      ],
    });
    openDropdown();
    fireEvent.click(screen.getByText('待回复甲'));
    expect(mockNavigate).toHaveBeenCalledWith('/channels/ch-1?highlight=m-1');

    // 未处理完（仍在池里）→ 不出 toast（容器可能由前序用例创建但已清空）
    const idleContainer = document.querySelector('#toast-container');
    expect(idleContainer === null || idleContainer.children.length === 0).toBe(true);

    // 处理完 = WU-1 掉出池（回复后 WU 复活，状态派生项消失），还剩 WU-2
    act(() => {
      useNotificationStore.setState({
        stateItems: [stateItem({ wuId: 'WU-2', scope: '待回复乙', channelId: 'ch-2', messageId: 'm-2' })],
      });
    });
    const toastEl = document.querySelector('#toast-container');
    expect(toastEl?.textContent).toContain('已处理，还剩 1 条待回复');
    const actionBtn = toastEl?.querySelector('button');
    expect(actionBtn?.textContent).toBe('下一个 →');
    fireEvent.click(actionBtn!);
    expect(mockNavigate).toHaveBeenCalledWith('/channels/ch-2?highlight=m-2');
  });

  it('D-2 项3（reply 线）：reply 全清 → 收口文案 toast', async () => {
    await renderLoaded({
      stateItems: [stateItem({ wuId: 'WU-1', scope: '待回复甲', channelId: 'ch-1' })],
    });
    openDropdown();
    fireEvent.click(screen.getByText('待回复甲'));

    act(() => { useNotificationStore.setState({ stateItems: [] }); });
    expect(document.querySelector('#toast-container')?.textContent).toContain('待回复都处理完了');
  });

  it('通知条目：点击标记已读（POST /:id/read）并按 wuId 跳 WU 详情', async () => {
    await renderLoaded({
      notifications: [backendNotification({ id: 'n1', link: null, wuId: 'WU-3' })],
      unreadCount: 1,
    });
    openDropdown();

    fireEvent.click(screen.getByText('审计建议 (2 项)'));
    expect(mockApi.post).toHaveBeenCalledWith('/notifications/n1/read');
    expect(mockNavigate).toHaveBeenCalledWith('/workunits/WU-3');
    // 角标递减
    await waitFor(() => expect(screen.queryByText('1')).not.toBeInTheDocument());
  });

  it('通知跳转优先级：wuId > channelId(+?highlight=) > pmoId', async () => {
    await renderLoaded({
      notifications: [
        // 老数据行：无结构化字段，channelId/messageId 经 link 解析
        backendNotification({ id: 'n1', title: '频道通知', link: '/channels/ch-5?highlight=m-42' }),
        backendNotification({ id: 'n2', title: 'PMO 通知', link: '/pmo/project/p-7' }),
        backendNotification({ id: 'n3', title: 'WU 通知', link: '/pmo/project/p-9', wuId: 'WU-9', channelId: 'ch-9' }),
      ],
      unreadCount: 3,
    });
    openDropdown();

    fireEvent.click(screen.getByText('频道通知'));
    expect(mockNavigate).toHaveBeenCalledWith('/channels/ch-5?highlight=m-42');
    openDropdown(); // 点击后面板收起，重新展开
    fireEvent.click(screen.getByText('PMO 通知'));
    expect(mockNavigate).toHaveBeenCalledWith('/pmo/project/p-7');
    openDropdown();
    fireEvent.click(screen.getByText('WU 通知'));
    expect(mockNavigate).toHaveBeenCalledWith('/workunits/WU-9');
  });

  it('WU/PMO 小按钮直跳（stopPropagation，不触发本体跳转）', async () => {
    await renderLoaded({
      notifications: [backendNotification({ id: 'n1', link: '/pmo/project/p-5', wuId: 'WU-5' })],
      unreadCount: 1,
    });
    openDropdown();

    fireEvent.click(screen.getByText('任务'));
    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('/workunits/WU-5');

    openDropdown(); // 点击后面板收起，重新展开
    fireEvent.click(screen.getByText('PMO'));
    expect(mockNavigate).toHaveBeenCalledWith('/pmo/project/p-5');
  });

  it('全部已读：POST /read-all，unreadCount 归零；stateItems 不受影响', async () => {
    await renderLoaded({
      stateItems: [stateItem()],
      notifications: [backendNotification()],
      unreadCount: 1,
    });
    openDropdown();
    fireEvent.click(screen.getByText('全部已读'));

    expect(mockApi.post).toHaveBeenCalledWith('/notifications/read-all');
    expect(useNotificationStore.getState().unreadCount).toBe(0);
    // 待回复分区仍在（状态派生无已读概念）
    expect(screen.getByText('待回复 (1)')).toBeInTheDocument();
    // 角标只剩 stateItems 数
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  it('无待办无通知 → 空态', async () => {
    await renderLoaded();
    openDropdown();
    expect(screen.getByText('暂无待办与通知')).toBeInTheDocument();
    expect(screen.queryByText('全部已读')).not.toBeInTheDocument();
  });

  // 批次 F-2：Escape 收起面板
  it('Escape 收起行动中心面板', async () => {
    await renderLoaded({ stateItems: [stateItem()] });
    openDropdown();
    expect(screen.getByText('待回复 (1)')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText('待回复 (1)')).not.toBeInTheDocument();
  });

  it('后端请求失败不崩溃：展示空态', async () => {
    mockApi.get.mockRejectedValue(new Error('network'));
    render(<NotificationBell />);
    await waitFor(() => expect(mockApi.get).toHaveBeenCalled());
    openDropdown();
    expect(screen.getByText('暂无待办与通知')).toBeInTheDocument();
  });
});

describe('#468 SSE 只作失效触发（不直接入列）', () => {
  it('channel.message_sent 且 meta.atHuman → 重拉 /action-center', async () => {
    await renderLoaded();
    emitAtHuman();
    await waitFor(() => expect(mockApi.get).toHaveBeenCalledTimes(2));
    expect(mockApi.get).toHaveBeenLastCalledWith('/action-center');
  });

  it('非 atHuman 的 channel.message_sent 不重拉', async () => {
    await renderLoaded();
    emitSse('channel.message_sent', {
      channelId: 'ch-1',
      message: { id: 'm-2', agentName: 'pmo', content: '普通消息', meta: null },
    });
    await new Promise(r => setTimeout(r, 20));
    expect(mockApi.get).toHaveBeenCalledTimes(1);
  });

  it('workunit.status_changed → 重拉（stateItems 状态变即消）', async () => {
    await renderLoaded();
    emitSse('workunit.status_changed', { workunit: { id: 'WU-1', status: 'blocked' } });
    await waitFor(() => expect(mockApi.get).toHaveBeenCalledTimes(2));
  });

  it('断线重连 → 重拉（#415 模式保留）', async () => {
    await renderLoaded();
    mockActionCenter({ notifications: [backendNotification({ title: '断线期间落库' })], unreadCount: 1 });
    emitReconnect();
    await waitFor(() => expect(mockApi.get).toHaveBeenCalledTimes(2));
    openDropdown();
    expect(screen.getByText('断线期间落库')).toBeInTheDocument();
  });

  it('SSE 不重拉失败不崩溃：保留现有列表', async () => {
    await renderLoaded({ notifications: [backendNotification()], unreadCount: 1 });
    mockApi.get.mockRejectedValue(new Error('network'));
    emitSse('workunit.status_changed', { workunit: { id: 'WU-1', status: 'done' } });
    await waitFor(() => expect(mockApi.get).toHaveBeenCalledTimes(2));
    openDropdown();
    expect(screen.getByText('审计建议 (2 项)')).toBeInTheDocument();
  });
});

describe('B2-004 标题闪烁（flash 定时器生命周期）', () => {
  // fake timers 下 waitFor 会卡，用 act 刷 microtask 代替
  async function renderLoadedFlush(p: Payload = {}) {
    mockActionCenter(p);
    render(<NotificationBell />);
    await act(async () => {});
  }

  it('unreadCount + stateItems 归零 → 标题停止闪烁并恢复原样', async () => {
    vi.useFakeTimers();
    try {
      await renderLoadedFlush({
        notifications: [backendNotification()], unreadCount: 1,
      });
      const original = document.title;
      emitAtHuman();
      act(() => { vi.advanceTimersByTime(1000); });
      expect(document.title).not.toBe(original); // 确认在闪

      openDropdown();
      fireEvent.click(screen.getByText('全部已读'));

      expect(document.title).toBe(original);
      act(() => { vi.advanceTimersByTime(20000); });
      expect(document.title).toBe(original); // 不再闪
    } finally {
      vi.useRealTimers();
    }
  });

  it('仍有 stateItems（状态派生待办）→ 不因通知全读而停闪', async () => {
    vi.useFakeTimers();
    try {
      await renderLoadedFlush({
        stateItems: [stateItem()], notifications: [backendNotification()], unreadCount: 1,
      });
      const original = document.title;
      emitAtHuman();
      act(() => { vi.advanceTimersByTime(1000); });
      expect(document.title).not.toBe(original);

      openDropdown();
      fireEvent.click(screen.getByText('全部已读'));
      // 通知清零但仍有 1 条待回复 stateItem → 继续闪（直至 10s 自停）。
      // 注意闪烁是交替的：1000ms 后处于「灭灯相位」（标题=原文），再 1000ms 回到闪烁文案
      act(() => { vi.advanceTimersByTime(1000); });
      act(() => { vi.advanceTimersByTime(1000); });
      expect(document.title).not.toBe(original);
      act(() => { vi.advanceTimersByTime(20000); });
      expect(document.title).toBe(original);
    } finally {
      vi.useRealTimers();
    }
  });

  it('10s 内连续两条 @human：旧 interval 被清理，超时后标题稳定', async () => {
    vi.useFakeTimers();
    try {
      await renderLoadedFlush({ notifications: [backendNotification()], unreadCount: 1 });
      const original = document.title;
      emitAtHuman('pmo');
      act(() => { vi.advanceTimersByTime(500); });
      emitAtHuman('coder');

      // 两条消息的 10s 超时都过期后，标题必须稳定（有泄漏 interval 则会继续交替）
      act(() => { vi.advanceTimersByTime(20000); });
      expect(document.title).toBe(original);
      act(() => { vi.advanceTimersByTime(5000); });
      expect(document.title).toBe(original);
    } finally {
      vi.useRealTimers();
    }
  });
});
