// ChannelDetailPage — Mission Control 三栏 smoke test
// 覆盖：三栏渲染 / REQ chip 开抽屉 / WU 链接开抽屉 / 已完成折叠 / NEED_INPUT 内嵌回复链路 / 线程默认展开与收起持久化
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const { mockSendMessage, mockListWorkunits, mockListReqs, mockGetReq, mockApiGet, mockApiPost, mockDrawerSpy, mockOnEvent, mockOnReconnect, mockRefresh, mockActivityRailSpy, mockDispatchReview, mockClaim } = vi.hoisted(() => ({
  mockSendMessage: vi.fn(),
  mockListWorkunits: vi.fn(),
  mockListReqs: vi.fn(),
  mockGetReq: vi.fn(),
  mockApiGet: vi.fn(),
  mockApiPost: vi.fn(),
  mockDrawerSpy: vi.fn(),
  mockOnEvent: vi.fn(),
  mockOnReconnect: vi.fn(),
  mockRefresh: vi.fn(),
  mockActivityRailSpy: vi.fn(),
  mockDispatchReview: vi.fn(),
  mockClaim: vi.fn(),
}));

vi.mock('../../api', () => ({
  api: { get: mockApiGet, post: mockApiPost },
}));

vi.mock('../../hooks/useChannelEvents', async () => {
  const { useState, useRef } = await import('react');
  return {
    useChannelMessages: () => {
      // #439：mock 自持 messages/hasMore 状态——loadMore 翻页（prepend 历史页/到底）能驱动
      // 页面重渲染，供「highlight 目标掉出首页分页」用例走通 capped 游标循环。
      // 同时保留原契约：用例在挂载后重赋值 currentMessages + rerender 时跟随外部快照
      // （lastExternal 哨兵区分外部重赋值与内部 prepend，只跟前者）
      const [msgs, setMsgs] = useState(currentMessages);
      const [more, setMore] = useState(currentHasMore);
      const lastExternal = useRef(currentMessages);
      if (lastExternal.current !== currentMessages) {
        lastExternal.current = currentMessages;
        setMsgs(currentMessages);
      }
      return {
        messages: msgs,
        loading: false,
        hasMore: more,
        sendMessage: mockSendMessage,
        loadMore: () => mockLoadMore(setMsgs, setMore),
        refresh: mockRefresh,
      };
    },
  };
});

vi.mock('../../api/workunit', () => ({
  workunitApi: { list: mockListWorkunits, dispatchReview: mockDispatchReview, claim: mockClaim },
}));

vi.mock('../../api/requirements', () => ({
  requirementApi: { list: mockListReqs, get: mockGetReq },
}));

// #242：live 状态条的 SSE 事件源（onEvent 注册回调，用例手工驱动）；
// 决策 9：onReconnect 注册口（重连一次性 refetch，用例手工驱动）
vi.mock('../../api/websocketHooks', () => ({
  useWebSocketContext: () => ({ onEvent: mockOnEvent, onReconnect: mockOnReconnect }),
}));

// 左栏/右抽屉/顶栏控件：保留接口，隔离其内部 API 依赖
vi.mock('../../components/channel/ChannelRail', () => ({
  ChannelRail: ({ activeChannelId }: { activeChannelId?: string }) => <div data-testid="channel-rail" data-active={activeChannelId} />,
}));

// #394：右栏「频道动态」REQ 链路卡——保留接口（props spy），隔离其 chain/PMO/agent API 依赖
vi.mock('../../components/channel/ChannelActivityRail', () => ({
  ChannelActivityRail: (props: { reqs: { id: string }[]; onOpenReq: (id: string) => void; onOpenWu: (id: string) => void }) => {
    mockActivityRailSpy(props);
    return (
      <div data-testid="activity-rail">
        {props.reqs.map(r => (
          <button key={r.id} data-testid={`rail-req-${r.id}`} onClick={() => props.onOpenReq(r.id)}>{r.id}</button>
        ))}
      </div>
    );
  },
}));

vi.mock('../../components/channel/WorkUnitDrawer', () => ({
  WorkUnitDrawer: (props: { drawer: DrawerState }) => {
    mockDrawerSpy(props);
    return props.drawer ? <div data-testid="wu-drawer" data-kind={props.drawer.kind} data-id={props.drawer.id} /> : null;
  },
}));

vi.mock('../../components/channel/ChannelMemberManager', () => ({
  ChannelMemberManager: () => <div data-testid="member-manager" />,
}));

vi.mock('../../components/channel/ChannelDefaultProjectSelect', () => ({
  ChannelDefaultProjectSelect: () => <div data-testid="default-project-select" />,
}));

vi.mock('../../components/channel/ChannelCurrentPmoChip', () => ({
  ChannelCurrentPmoChip: () => <div data-testid="current-pmo-chip" />,
}));

vi.mock('../../components/channel/ChannelInput', () => ({
  // #440：prefill 通道（建议片点击 → 填入输入框）经 data 属性透出供断言
  ChannelInput: (props: { prefill?: { text: string; nonce: number } }) => (
    <div
      data-testid="channel-input"
      data-prefill={props.prefill?.text ?? ''}
      data-prefill-nonce={props.prefill?.nonce ?? 0}
    />
  ),
}));

// 卡片子组件与本测试无关
vi.mock('../../components/channel/RequirementsDocCard', () => ({ RequirementsDocCard: () => null }));
vi.mock('../../components/channel/KnowledgeConfirmCard', () => ({ KnowledgeConfirmCard: () => null }));
vi.mock('../../components/channel/ConvertToTaskDialog', () => ({ ConvertToTaskDialog: () => null }));

import { ChannelDetailPage } from '../ChannelDetailPage';
import { useNotificationStore } from '../../stores/notificationStore';
import { toast } from '../../utils/toast';
import type { ChannelMessage } from '../../api/channel';
import type { DrawerState } from '../../components/channel/WorkUnitDrawer';

const now = Date.now();
const iso = (offsetMin: number) => new Date(now + offsetMin * 60000).toISOString();

const MESSAGES: ChannelMessage[] = [
  // 活跃消息（NEED_INPUT 挂起，线程锚点）
  {
    id: 'm-1', channelId: 'ch-1', authorType: 'agent' as const, agentName: 'librarian',
    content: '检索到 3 条相关知识', workUnitId: 'WU-1018', replyToId: null,
    meta: JSON.stringify({ reqId: 'REQ-0042' }), createdAt: iso(0),
  },
  // 线程回复
  {
    id: 'm-2', channelId: 'ch-1', authorType: 'agent' as const, agentName: 'librarian',
    content: '补充：SDD-012 强相关', workUnitId: null, replyToId: 'm-1',
    meta: '{}', createdAt: iso(1),
  },
  // 已完成消息 ×3（默认折叠，只留最近 2 条）
  ...[3, 4, 5].map(i => ({
    id: `m-${i}`, channelId: 'ch-1', authorType: 'agent' as const, agentName: 'coder-1',
    content: `完成的工作 ${i}`, workUnitId: `WU-100${i}`, replyToId: null,
    meta: JSON.stringify({ status: 'done' }), createdAt: iso(i),
  })),
];

// 过程消息折叠夹具：锚点 + 4 条连续过程回复 + 最后一条（里程碑：最新状态恒显示）
const PROCESS_MESSAGES: ChannelMessage[] = [
  {
    id: 'p-1', channelId: 'ch-1', authorType: 'agent' as const, agentName: 'pm',
    content: '需求已收到，开始分析', workUnitId: 'WU-2000', replyToId: null,
    meta: '{}', createdAt: iso(0),
  },
  ...[2, 3, 4, 5].map(i => ({
    id: `p-${i}`, channelId: 'ch-1', authorType: 'agent' as const, agentName: 'pm',
    content: `过程步骤 ${i}`, workUnitId: 'WU-2000', replyToId: 'p-1',
    meta: '{}', createdAt: iso(i),
  })),
  {
    id: 'p-6', channelId: 'ch-1', authorType: 'agent' as const, agentName: 'pm',
    content: '分析结论：拆成 3 个任务', workUnitId: 'WU-2000', replyToId: 'p-1',
    meta: '{}', createdAt: iso(6),
  },
];

const REQS = [
  { id: 'REQ-0042', seq: 42, title: '主界面视觉方向稿', status: 'in-progress', createdAt: iso(-100), createdBy: '张弛' },
];

// useChannelEvents mock 的当前消息集（默认 MESSAGES，单测可替换为 PROCESS_MESSAGES 等夹具）
let currentMessages: ChannelMessage[] = MESSAGES;

// #439：mock 的 hasMore 初值 / loadMore spy。loadMore 实现签名 (setMsgs, setMore) => Promise<boolean>，
// 由用例决定 prepend 哪些历史消息、翻页后是否到底（setMore(false)）与返回值（是否真实前插）
let currentHasMore = false;
const mockLoadMore = vi.fn();

// #242：onEvent 注册的 SSE 处理器（用例手工驱动事件）；
// 批 2（决策 5/6）后页面有多个订阅方（live 状态条 / waitingWus chip / REQ chips）→ 收集全部处理器统一派发
type SseHandler = (msg: { event_type: string; data?: unknown }) => void;
let sseHandlers: SseHandler[] = [];
const emitSse = (msg: { event_type: string; data?: unknown }) => { sseHandlers.forEach(h => h(msg)); };
// #394：REQ 呈现挪右栏——经 activity-rail mock 的 props spy 观察 channelReqs 状态
const railProps = () => mockActivityRailSpy.mock.calls.at(-1)?.[0] as { reqs: { id: string; title: string; status: string; projectId?: string | null }[] } | undefined;
const railReqIds = () => (railProps()?.reqs ?? []).map(r => r.id);
const railReq = (id: string) => (railProps()?.reqs ?? []).find(r => r.id === id);

// 决策 9：onReconnect 注册的重连处理器（用例手工触发）
let reconnectHandlers: Array<() => void> = [];
const emitReconnect = () => { reconnectHandlers.forEach(h => h()); };

/** #242 夹具：本频道 active WU 列表响应（deriveLiveExecutions 初始数据源） */
const activeWuList = (wus: Array<{ id: string; metadata: string | null }>) => ({ data: { data: wus } });

const renderPage = (entry = '/channels/ch-1') =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/channels/:id" element={<ChannelDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );

describe('ChannelDetailPage — Mission Control 三栏', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // 折叠状态按频道持久化（Step 3）——防跨用例 localStorage 泄漏
    window.localStorage.clear();
    currentMessages = MESSAGES;
    currentHasMore = false;
    // toast.dismiss() 是 200ms 动画后异步移除——有残留时等其落定，防跨用例 toast 文本污染断言
    toast.dismiss();
    if (document.getElementById('toast-container')?.childElementCount) {
      await new Promise(r => setTimeout(r, 250));
    }
    sseHandlers = [];
    // 通知 store 是模块单例，跨用例重置
    useNotificationStore.setState({ notifications: [] });
    mockApiPost.mockResolvedValue({ data: { success: true } });
    mockApiGet.mockResolvedValue({ data: { data: { id: 'ch-1', name: 'rnd-主研发', type: 'rnd', members: '[]' } } });
    // 同一 list 接口服务两种查询：blocked（NEED_INPUT 挂起集合）/ active（#242 live 状态条，默认无执行中）
    mockListWorkunits.mockImplementation((params?: { status?: string }) => Promise.resolve(
      params?.status === 'active'
        ? activeWuList([])
        : { data: { data: [{ id: 'WU-1018', metadata: JSON.stringify({ waitingForInput: true }) }] } },
    ));
    mockOnEvent.mockImplementation((cb: SseHandler) => { sseHandlers.push(cb); return () => {}; });
    mockOnReconnect.mockImplementation((cb: () => void) => { reconnectHandlers.push(cb); return () => {}; });
    reconnectHandlers = [];
    mockListReqs.mockResolvedValue({ data: { data: REQS } });
    mockSendMessage.mockResolvedValue({});
  });

  it('打开频道即读：本频道未读通知标记已读（后端条目 POST 同步），其他频道不动', async () => {
    useNotificationStore.setState({
      notifications: [
        { id: 'n-ch1', backendId: 'n-ch1', channelId: 'ch-1', agentName: 'System', title: '审计建议', content: 'x', time: '10:00', read: false, workUnitId: null, pmoId: null, messageId: null },
        { id: 'sse-ch1', backendId: null, channelId: 'ch-1', agentName: 'pmo', title: null, content: '@human', time: '10:01', read: false, workUnitId: null, pmoId: null, messageId: 'm-x' },
        { id: 'n-ch2', backendId: 'n-ch2', channelId: 'ch-2', agentName: 'System', title: '别频道', content: 'y', time: '10:02', read: false, workUnitId: null, pmoId: null, messageId: null },
      ],
    });

    renderPage();
    await waitFor(() => expect(screen.getByText('#rnd-主研发')).toBeTruthy());

    const byId = Object.fromEntries(useNotificationStore.getState().notifications.map(n => [n.id, n.read]));
    expect(byId).toEqual({ 'n-ch1': true, 'sse-ch1': true, 'n-ch2': false });
    expect(mockApiPost).toHaveBeenCalledTimes(1);
    expect(mockApiPost).toHaveBeenCalledWith('/notifications/n-ch1/read');
  });

  it('?highlight=<mid> 直达消息：滚动定位并高亮（通知中心点击跳转入参）', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    renderPage('/channels/ch-1?highlight=m-1');
    await waitFor(() => {
      const el = document.querySelector('[data-message-id="m-1"]');
      expect(el?.className).toContain('mc-msg-highlight');
    });
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it('#439：highlight 目标掉出首页分页 → 沿翻页游标加载所在页后定位高亮', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const oldMsg: ChannelMessage = {
      id: 'm-old', channelId: 'ch-1', authorType: 'agent' as const, agentName: 'Auditor',
      content: '审计建议卡（老消息）', workUnitId: null, replyToId: null,
      meta: '{}', createdAt: iso(-50),
    };
    currentHasMore = true;
    mockLoadMore.mockImplementation(async (setMsgs: (fn: (prev: ChannelMessage[]) => ChannelMessage[]) => void, setMore: (v: boolean) => void) => {
      setMsgs(prev => [oldMsg, ...prev]);
      setMore(false);
      return true;
    });

    renderPage('/channels/ch-1?highlight=m-old');

    await waitFor(() => {
      const el = document.querySelector('[data-message-id="m-old"]');
      expect(el?.className).toContain('mc-msg-highlight');
    });
    expect(mockLoadMore).toHaveBeenCalledTimes(1);
    // 目标已定位，无降级反馈
    expect(document.getElementById('toast-container')?.textContent ?? '').not.toContain('无法定位');
  });

  it('#439：翻页到底仍无目标 → toast 可见反馈，不静默', async () => {
    currentHasMore = true;
    // 翻一页后到底（hasMore → false），目标始终不存在
    mockLoadMore.mockImplementation(async (_setMsgs: unknown, setMore: (v: boolean) => void) => {
      setMore(false);
      return true;
    });

    renderPage('/channels/ch-1?highlight=m-ghost');

    await waitFor(() => {
      expect(document.getElementById('toast-container')?.textContent).toContain('无法定位');
    });
    expect(mockLoadMore).toHaveBeenCalledTimes(1);
  });

  it('#439：翻页上限（10 页）后停止并 toast 反馈——不无限翻页', async () => {
    currentHasMore = true;
    mockLoadMore.mockImplementation(async () => true); // 历史永远翻不完，但目标不存在

    renderPage('/channels/ch-1?highlight=m-ghost');

    // 先钉住页数上限（循环跑满 10 页才停），再查反馈——避免读到上一用例残留的 toast
    await waitFor(() => expect(mockLoadMore).toHaveBeenCalledTimes(10));
    await waitFor(() => {
      expect(document.getElementById('toast-container')?.textContent).toContain('无法定位');
    });
  });

  it('决策9：SSE 断线重连 → 当前频道一次性 refetch（messages refresh + waitingWus/REQ chips 打底面对齐）', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('#rnd-主研发')).toBeTruthy());
    expect(mockRefresh).not.toHaveBeenCalled();
    expect(reconnectHandlers.length).toBeGreaterThan(0);
    const wuCallsBefore = mockListWorkunits.mock.calls.length;
    const reqCallsBefore = mockListReqs.mock.calls.length;
    act(() => emitReconnect());
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    // chips 打底面强制对齐（批 4 收尾：reloadWaitingWus/reloadChannelReqs 挂进重连回调；
    // #440 起新增 channelWus 面（建议片/阶段条数据源）→ workunit list 调用 +2）
    expect(mockListWorkunits.mock.calls.length).toBe(wuCallsBefore + 2);
    expect(mockListReqs.mock.calls.length).toBe(reqCallsBefore + 1);
  });

  it('renders three-column IA: rail + main stream + input; drawer closed initially', async () => {
    renderPage();
    expect(screen.getByTestId('channel-rail').getAttribute('data-active')).toBe('ch-1');
    // #394：三栏 = 左频道栏 + 中对话流 + 右频道动态栏
    expect(screen.getByTestId('activity-rail')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('#rnd-主研发')).toBeTruthy());
    expect(screen.getByTestId('channel-input')).toBeTruthy();
    // E1 顶栏收敛：成员/PMO/默认工程收进 ⋯ 菜单，开菜单可见
    expect(screen.queryByTestId('member-manager')).toBeNull();
    fireEvent.click(screen.getByLabelText('更多操作'));
    expect(screen.getByTestId('member-manager')).toBeTruthy();
    expect(screen.getByTestId('current-pmo-chip')).toBeTruthy();
    expect(screen.getByTestId('default-project-select')).toBeTruthy();
    expect(screen.queryByTestId('wu-drawer')).toBeNull();
  });

  it('#394：REQ 呈现挪右栏链路卡——中栏 chips 条移除；右栏 onOpenReq 开 req 抽屉', async () => {
    renderPage();
    // 右栏收到本频道 REQ 集；中栏不再有 mc-reqs chips
    await waitFor(() => expect(screen.getByTestId('rail-req-REQ-0042')).toBeTruthy());
    expect(document.querySelector('.mc-reqs')).toBeNull();
    fireEvent.click(screen.getByTestId('rail-req-REQ-0042'));
    const drawer = screen.getByTestId('wu-drawer');
    expect(drawer.getAttribute('data-kind')).toBe('req');
    expect(drawer.getAttribute('data-id')).toBe('REQ-0042');
  });

  it('WU link on a message opens the wu drawer', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('WU-1018 ›')).toBeTruthy());
    fireEvent.click(screen.getByText('WU-1018 ›'));
    expect(screen.getByTestId('wu-drawer').getAttribute('data-kind')).toBe('wu');
    expect(screen.getByTestId('wu-drawer').getAttribute('data-id')).toBe('WU-1018');
  });

  it('REQ link on a message opens the req drawer', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('REQ-0042 ›')).toBeTruthy());
    fireEvent.click(screen.getByText('REQ-0042 ›'));
    expect(screen.getByTestId('wu-drawer').getAttribute('data-kind')).toBe('req');
  });

  it('collapses completed messages by default (keeps last 2) and expands on toggle', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('完成的工作 5')).toBeTruthy());
    expect(screen.queryByText('完成的工作 3')).toBeNull();
    fireEvent.click(screen.getByText('显示 1 条已完成消息'));
    expect(screen.getByText('完成的工作 3')).toBeTruthy();
  });

  // #264：线上 meta 为 object——已完成折叠与里程碑判定必须同样生效
  it('object meta：已完成消息仍正确折叠（默认留最近 2 条）', async () => {
    currentMessages = MESSAGES.map(m => ({ ...m, meta: JSON.parse(m.meta as string) as Record<string, unknown> }));
    renderPage();
    await waitFor(() => expect(screen.getByText('完成的工作 5')).toBeTruthy());
    expect(screen.queryByText('完成的工作 3')).toBeNull();
    fireEvent.click(screen.getByText('显示 1 条已完成消息'));
    expect(screen.getByText('完成的工作 3')).toBeTruthy();
  });

  it('object meta：卡片回复识别为里程碑，不被折叠进过程消息组', async () => {
    currentMessages = [
      {
        id: 'c-1', channelId: 'ch-1', authorType: 'agent' as const, agentName: 'pm',
        content: '需求已收到，开始分析', workUnitId: 'WU-2000', replyToId: null,
        meta: '{}', createdAt: iso(0),
      },
      ...[2, 3, 4].map(i => ({
        id: `c-${i}`, channelId: 'ch-1', authorType: 'agent' as const, agentName: 'pm',
        content: `过程步骤 ${i}`, workUnitId: 'WU-2000', replyToId: 'c-1',
        meta: '{}', createdAt: iso(i),
      })),
      {
        id: 'c-5', channelId: 'ch-1', authorType: 'agent' as const, agentName: 'librarian',
        content: '知识提案 — 待人工审核', workUnitId: 'WU-2000', replyToId: 'c-1',
        meta: {
          cardType: 'knowledge_proposal',
          status: 'ready',
          cardData: { entries: [{ id: 'k-1', title: 't', type: 'pitfall' }] },
        } as Record<string, unknown>,
        createdAt: iso(5),
      },
      {
        id: 'c-6', channelId: 'ch-1', authorType: 'agent' as const, agentName: 'pm',
        content: '分析结论：拆成 3 个任务', workUnitId: 'WU-2000', replyToId: 'c-1',
        meta: '{}', createdAt: iso(6),
      },
    ];
    renderPage();
    await waitFor(() => expect(screen.getByText('需求已收到，开始分析')).toBeTruthy());

    // 线程默认展开：3 条连续过程消息收成一组；卡片回复（非末位）是里程碑，直接可见
    expect(screen.getByText('▸ 3 条过程消息')).toBeTruthy();
    expect(screen.getByText('通过')).toBeTruthy();
    expect(screen.getByText('分析结论：拆成 3 个任务')).toBeTruthy();
  });

  it('NEED_INPUT: inline reply sends through the same replyTo link（E1：badge 已删，回复框即信号）', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByLabelText('回复 WU-1018')).toBeTruthy());
    const input = screen.getByLabelText('回复 WU-1018');
    fireEvent.change(input, { target: { value: '同意注入' } });
    fireEvent.click(screen.getByText('回复'));
    await waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalledWith('同意注入', 'm-1');
    });
  });

  it('thread replies visible by default; toggle collapses and persists across remount', async () => {
    const first = renderPage();
    await waitFor(() => expect(screen.getByText('检索到 3 条相关知识')).toBeTruthy());
    // 折叠层级 4→2：线程默认展开，普通回复直接可见
    expect(screen.getByText('补充：SDD-012 强相关')).toBeTruthy();

    // 手动收起
    fireEvent.click(screen.getByText('▾ 收起回复'));
    expect(screen.queryByText('补充：SDD-012 强相关')).toBeNull();
    expect(screen.getByText('▸ 1 条回复')).toBeTruthy();

    // 收起状态按频道持久化，重进频道恢复
    first.unmount();
    renderPage();
    await waitFor(() => expect(screen.getByText('检索到 3 条相关知识')).toBeTruthy());
    expect(screen.queryByText('补充：SDD-012 强相关')).toBeNull();
    expect(screen.getByText('▸ 1 条回复')).toBeTruthy();
  });

  it('collapses ≥3 consecutive process replies inside a thread; milestones stay visible', async () => {
    currentMessages = PROCESS_MESSAGES;
    renderPage();
    // 线程默认展开（无需再点「N 条回复」）
    await waitFor(() => expect(screen.getByText('需求已收到，开始分析')).toBeTruthy());

    // 4 条连续过程消息收成一组（保持一层折叠，默认收拢）；最后一条（最新状态）直接可见
    expect(screen.getByText('分析结论：拆成 3 个任务')).toBeTruthy();
    expect(screen.queryByText('过程步骤 3')).toBeNull();
    const toggle = screen.getByText('▸ 4 条过程消息');
    expect(toggle).toBeTruthy();

    // 展开组 → 过程消息可见；再收起
    fireEvent.click(toggle);
    expect(screen.getByText('过程步骤 3')).toBeTruthy();
    fireEvent.click(screen.getByText('收起 4 条过程消息'));
    expect(screen.queryByText('过程步骤 3')).toBeNull();
  });
});

// #242：频道 live 执行状态条——出现/更新/终态/点击开抽屉（事件驱动，复用 execution-rows 推导层）
describe('ChannelDetailPage — #242 live 执行状态条', () => {
  // 与上层 describe 同套的干净基线（本 describe 独立于外层，beforeEach 不共享）
  beforeEach(() => {
    vi.clearAllMocks();
    currentMessages = MESSAGES;
    sseHandlers = [];
    mockApiGet.mockResolvedValue({ data: { data: { id: 'ch-1', name: 'rnd-主研发', type: 'rnd', members: '[]' } } });
    mockListWorkunits.mockImplementation((params?: { status?: string }) => Promise.resolve(
      params?.status === 'active'
        ? activeWuList([])
        : { data: { data: [{ id: 'WU-1018', metadata: JSON.stringify({ waitingForInput: true }) }] } },
    ));
    mockOnEvent.mockImplementation((cb: SseHandler) => { sseHandlers.push(cb); return () => {}; });
    mockListReqs.mockResolvedValue({ data: { data: REQS } });
    mockSendMessage.mockResolvedValue({});
  });

  it('本频道有执行中 WU → 状态条出现（WU 标识 + 步号来自 metadata.stepCount）', async () => {
    mockListWorkunits.mockImplementation((params?: { status?: string }) => Promise.resolve(
      params?.status === 'active'
        ? activeWuList([{ id: 'WU-1018', metadata: JSON.stringify({ stepCount: 3 }) }])
        : { data: { data: [] } },
    ));
    renderPage();
    await waitFor(() => expect(screen.getByText(/WU-1018 正在执行 · 第 3 步/)).toBeTruthy());
  });

  it('无执行中 WU → 不出现状态条', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('#rnd-主研发')).toBeTruthy());
    expect(screen.queryByText(/正在执行/)).toBeNull();
  });

  it('SSE 步事件驱动更新：第 3 步 → 第 4 步（带 action）', async () => {
    mockListWorkunits.mockImplementation((params?: { status?: string }) => Promise.resolve(
      params?.status === 'active'
        ? activeWuList([{ id: 'WU-1018', metadata: JSON.stringify({ stepCount: 3 }) }])
        : { data: { data: [] } },
    ));
    renderPage();
    await waitFor(() => expect(screen.getByText(/第 3 步/)).toBeTruthy());
    act(() => emitSse({
      event_type: 'workunit.execution.step',
      data: { workUnitId: 'WU-1018', step: 4, action: 'progress' },
    }));
    expect(screen.getByText(/WU-1018 正在执行 · 第 4 步 · progress/)).toBeTruthy();
  });

  it('status_changed → active 事件让状态条出现（页面已打开时新开始的执行）', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('#rnd-主研发')).toBeTruthy());
    expect(screen.queryByText(/正在执行/)).toBeNull();
    act(() => emitSse({
      event_type: 'workunit.status_changed',
      data: { workunit: { id: 'WU-2020', status: 'active', channelId: 'ch-1', metadata: JSON.stringify({ stepCount: 1 }) } },
    }));
    expect(screen.getByText(/WU-2020 正在执行 · 第 1 步/)).toBeTruthy();
  });

  it('执行到达终态（status_changed → done）→ 状态条消失', async () => {
    mockListWorkunits.mockImplementation((params?: { status?: string }) => Promise.resolve(
      params?.status === 'active'
        ? activeWuList([{ id: 'WU-1018', metadata: JSON.stringify({ stepCount: 3 }) }])
        : { data: { data: [] } },
    ));
    renderPage();
    await waitFor(() => expect(screen.getByText(/WU-1018 正在执行/)).toBeTruthy());
    act(() => emitSse({
      event_type: 'workunit.status_changed',
      data: { workunit: { id: 'WU-1018', status: 'done', channelId: 'ch-1', metadata: '{}' } },
    }));
    expect(screen.queryByText(/正在执行/)).toBeNull();
  });

  it('其他频道的 status_changed / 未知 WU 的步事件 → 不产生状态条', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('#rnd-主研发')).toBeTruthy());
    act(() => emitSse({
      event_type: 'workunit.status_changed',
      data: { workunit: { id: 'WU-9999', status: 'active', channelId: 'ch-other', metadata: '{}' } },
    }));
    act(() => emitSse({
      event_type: 'workunit.execution.step',
      data: { workUnitId: 'WU-9999', step: 9 },
    }));
    expect(screen.queryByText(/正在执行/)).toBeNull();
  });

  it('点击状态条 → 打开对应 WU 右抽屉', async () => {
    mockListWorkunits.mockImplementation((params?: { status?: string }) => Promise.resolve(
      params?.status === 'active'
        ? activeWuList([{ id: 'WU-1018', metadata: JSON.stringify({ stepCount: 3 }) }])
        : { data: { data: [] } },
    ));
    renderPage();
    await waitFor(() => expect(screen.getByText(/WU-1018 正在执行/)).toBeTruthy());
    fireEvent.click(screen.getByText(/WU-1018 正在执行/));
    const drawer = screen.getByTestId('wu-drawer');
    expect(drawer.getAttribute('data-kind')).toBe('wu');
    expect(drawer.getAttribute('data-id')).toBe('WU-1018');
  });
});

// #279（决策 #250 D3/D4 + 走查 F4）：NEED_INPUT 选项卡通用化 + 顶栏待办 chip + 等待态清理
describe('ChannelDetailPage — #279 NEED_INPUT 待办 chip 与等待态清理', () => {
  // 派发 anchor + agent 追问（线程回复，带通用 options）
  const FOLLOWUP_MESSAGES: ChannelMessage[] = [
    {
      id: 'a-1', channelId: 'ch-1', authorType: 'agent' as const, agentName: 'pm',
      content: '任务已派发，开始执行', workUnitId: 'WU-3000', replyToId: null,
      meta: '{}', createdAt: iso(0),
    },
    {
      id: 'q-2', channelId: 'ch-1', authorType: 'agent' as const, agentName: 'pm',
      content: '需要输入: 使用 OAuth 还是账号密码？', workUnitId: 'WU-3000', replyToId: 'a-1',
      meta: { options: [{ label: 'OAuth' }, { label: '账号密码' }] } as Record<string, unknown>,
      createdAt: iso(1),
    },
  ];
  const waitingWu = (id: string, type: string, question: string) => ({
    id, type, scope: `scope of ${id}`,
    metadata: JSON.stringify({ waitingForInput: true, waitingQuestion: question }),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    currentMessages = FOLLOWUP_MESSAGES;
    sseHandlers = [];
    mockApiGet.mockResolvedValue({ data: { data: { id: 'ch-1', name: 'rnd-主研发', type: 'rnd', members: '[]' } } });
    mockListWorkunits.mockImplementation((params?: { status?: string }) => Promise.resolve(
      params?.status === 'active'
        ? activeWuList([])
        : { data: { data: [waitingWu('WU-3000', 'task', '使用 OAuth 还是账号密码？')] } },
    ));
    mockOnEvent.mockImplementation((cb: SseHandler) => { sseHandlers.push(cb); return () => {}; });
    mockListReqs.mockResolvedValue({ data: { data: [] } });
    mockSendMessage.mockResolvedValue({});
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('顶栏 chip 聚合 NEED_INPUT 等待计数；闸门类（decision/spec）不聚合', async () => {
    mockListWorkunits.mockImplementation((params?: { status?: string }) => Promise.resolve(
      params?.status === 'active'
        ? activeWuList([])
        : {
            data: {
              data: [
                waitingWu('WU-3000', 'task', '使用 OAuth 还是账号密码？'),
                waitingWu('WU-3001', 'decision', '决策单待批'),
                waitingWu('WU-3002', 'spec', 'spec 单待批'),
              ],
            },
          },
    ));
    renderPage();
    await waitFor(() => expect(screen.getByText('待回复 · 1')).toBeTruthy());
    fireEvent.click(screen.getByText('待回复 · 1'));
    expect(screen.getByText('WU-3000')).toBeTruthy();
    // 问题摘要来自 metadata.waitingQuestion
    expect(screen.getAllByText('使用 OAuth 还是账号密码？').length).toBeGreaterThan(0);
    expect(screen.queryByText('WU-3001')).toBeNull();
    expect(screen.queryByText('WU-3002')).toBeNull();
  });

  it('无 NEED_INPUT 等待 → chip 不渲染', async () => {
    mockListWorkunits.mockImplementation((params?: { status?: string }) => Promise.resolve(
      params?.status === 'active' ? activeWuList([]) : { data: { data: [] } },
    ));
    renderPage();
    await waitFor(() => expect(screen.getByText('#rnd-主研发')).toBeTruthy());
    expect(screen.queryByText(/待回复 ·/)).toBeNull();
  });

  it('agent 追问主流可见（不展开线程即可见），通用 options 渲染选项卡', async () => {
    renderPage();
    // 追问从折叠线程提升到主流：不点「▸ N 条回复」直接可见
    await waitFor(() => expect(screen.getByText(/需要输入: 使用 OAuth 还是账号密码？/)).toBeTruthy());
    expect(screen.queryByText(/条回复/)).toBeNull();
    // #279 AC1：通用 need_input（非归属问答）携带 options[] → 流内选项卡
    expect(screen.getByText('OAuth')).toBeTruthy();
    expect(screen.getByText('账号密码')).toBeTruthy();
    expect(screen.getByText('交给 agent 判断')).toBeTruthy();
  });

  it('回复区只落在当前提问消息（anchor 不再重复挂回复区）', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('OAuth')).toBeTruthy());
    // 选项卡只此一份（anchor 上没有第二份回复区）
    expect(screen.getAllByText('交给 agent 判断')).toHaveLength(1);
  });

  it('#276 点选项回答 -> 经 replyTo 走复活链路，await 成功后显示已回复（互斥）', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('OAuth')).toBeTruthy());
    fireEvent.click(screen.getByText('OAuth'));
    await waitFor(() => expect(mockSendMessage).toHaveBeenCalledWith('OAuth', 'q-2'));
    // await sendMessage resolve 后：needSent=true -> 已回复显示；选项卡收起（互斥）
    await waitFor(() => expect(screen.getByText(/已回复/)).toBeTruthy());
    expect(screen.queryByText('账号密码')).toBeNull();
  });

  // #276 AC3：追问再挂起后旧回复框不重复出现--#279 latestQuestionIdByWu 已结构性保证；
  // 本票补覆盖：场景 a-1 -> q-2 提问 -> r-1 人类回复 -> q-3 追问，仅 q-3 挂回复区
  it('#276 AC3 追问再挂起后旧回复框不重复出现（仅最新提问挂回复区）', async () => {
    // 场景：WU-3000 经历 a-1 派发 -> q-2 首次提问 -> r-1 人类回复 -> q-3 追问
    // 当前 WU 仍 blocked，最新提问 = q-3；q-2 已被回复过不再挂回复区
    currentMessages = [
      {
        id: 'a-1', channelId: 'ch-1', authorType: 'agent' as const, agentName: 'pm',
        content: '任务已派发', workUnitId: 'WU-3000', replyToId: null,
        meta: '{}', createdAt: iso(0),
      },
      {
        id: 'q-2', channelId: 'ch-1', authorType: 'agent' as const, agentName: 'pm',
        content: '需要输入: 使用 OAuth 还是账号密码？', workUnitId: 'WU-3000', replyToId: 'a-1',
        meta: { options: [{ label: 'OAuth' }, { label: '账号密码' }] } as Record<string, unknown>,
        createdAt: iso(1),
      },
      {
        id: 'r-1', channelId: 'ch-1', authorType: 'human' as const,
        content: '用 OAuth', workUnitId: 'WU-3000', replyToId: 'q-2',
        meta: '{}', createdAt: iso(2),
      },
      {
        id: 'q-3', channelId: 'ch-1', authorType: 'agent' as const, agentName: 'pm',
        content: '需要输入: OAuth 的回调地址是？', workUnitId: 'WU-3000', replyToId: 'q-2',
        meta: { options: [{ label: 'http://localhost' }] } as Record<string, unknown>,
        createdAt: iso(3),
      },
    ];
    renderPage();
    // q-3 是最新提问，提升到主流 + 挂回复区
    await waitFor(() => expect(screen.getByText(/回调地址/)).toBeTruthy());
    // 仅 q-3 挂选项卡回复区（q-2 已被回复过不再重复挂回复区）
    expect(screen.getAllByText('交给 agent 判断')).toHaveLength(1);
    // q-2 的选项（账号密码）不渲染--避免一屏多个相同回复框
    expect(screen.queryByText('账号密码')).toBeNull();
  });

  it('chip 点条目 → 滚动定位到该 WU 提问消息并高亮', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('待回复 · 1')).toBeTruthy());
    fireEvent.click(screen.getByText('待回复 · 1'));
    fireEvent.click(screen.getByText('WU-3000'));
    await waitFor(() => {
      const el = document.querySelector('[data-message-id="q-2"]');
      expect(el?.className).toContain('mc-msg-highlight');
    });
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });
});

// SSE 事件负载深化 批 2（决策 5/6）：waitingWus / REQ chips 事件化，摘 messages.length 依赖
describe('ChannelDetailPage — SSE 负载深化批 2：waitingWus / REQ chips 事件化', () => {
  const REQ_0043 = { id: 'REQ-0043', seq: 43, title: '新需求', status: 'open', createdAt: iso(0), createdBy: 'x' };
  const wuStatusChanged = (wu: Record<string, unknown>) => ({
    event_type: 'workunit.status_changed',
    data: { workunit: wu },
  });
  const blockedCalls = () =>
    mockListWorkunits.mock.calls.filter(c => (c[0] as { status?: string })?.status === 'blocked').length;

  beforeEach(() => {
    vi.clearAllMocks();
    currentMessages = MESSAGES;
    sseHandlers = [];
    mockApiGet.mockResolvedValue({ data: { data: { id: 'ch-1', name: 'rnd-主研发', type: 'rnd', members: '[]' } } });
    mockListWorkunits.mockImplementation((params?: { status?: string }) => Promise.resolve(
      params?.status === 'active' ? activeWuList([]) : { data: { data: [] } },
    ));
    mockOnEvent.mockImplementation((cb: SseHandler) => { sseHandlers.push(cb); return () => {}; });
    mockListReqs.mockResolvedValue({ data: { data: REQS } });
    mockSendMessage.mockResolvedValue({});
  });

  it('messages.length 变化不再触发 waitingWus / REQ 的 REST 重拉', async () => {
    const { rerender } = renderPage();
    await waitFor(() => expect(screen.getByText(/REQ-0042/)).toBeTruthy());
    expect(blockedCalls()).toBe(1);
    expect(mockListReqs).toHaveBeenCalledTimes(1);
    // 模拟新消息到达（messages.length 增长）—— 旧实现两个 effect 依赖 messages.length 会重拉
    currentMessages = [...MESSAGES, {
      id: 'm-9', channelId: 'ch-1', authorType: 'agent' as const, agentName: 'pm',
      content: '新消息', workUnitId: null, replyToId: null, meta: '{}', createdAt: iso(9),
    }];
    rerender(
      <MemoryRouter initialEntries={['/channels/ch-1']}>
        <Routes>
          <Route path="/channels/:id" element={<ChannelDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('新消息')).toBeTruthy());
    expect(blockedCalls()).toBe(1);
    expect(mockListReqs).toHaveBeenCalledTimes(1);
  });

  it('status_changed：blocked + waitingForInput → 待回复 chip 出现；迁出 blocked → 消失', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('#rnd-主研发')).toBeTruthy());
    expect(screen.queryByText(/待回复 ·/)).toBeNull();
    act(() => emitSse(wuStatusChanged({
      id: 'WU-3000', status: 'blocked', channelId: 'ch-1', type: 'task', scope: 'scope-3000',
      metadata: JSON.stringify({ waitingForInput: true, waitingQuestion: '选哪个方案？' }),
    })));
    await waitFor(() => expect(screen.getByText('待回复 · 1')).toBeTruthy());
    // 状态迁出 blocked → 从列表移除
    act(() => emitSse(wuStatusChanged({ id: 'WU-3000', status: 'active', channelId: 'ch-1', type: 'task', metadata: '{}' })));
    expect(screen.queryByText(/待回复 ·/)).toBeNull();
  });

  it('status_changed：waitingForInput 消失（仍 blocked）→ 移除；闸门类不聚合；他频道忽略', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('#rnd-主研发')).toBeTruthy());
    // 闸门类（decision）不聚合
    act(() => emitSse(wuStatusChanged({
      id: 'WU-3001', status: 'blocked', channelId: 'ch-1', type: 'decision',
      metadata: JSON.stringify({ waitingForInput: true }),
    })));
    // 他频道事件忽略
    act(() => emitSse(wuStatusChanged({
      id: 'WU-3002', status: 'blocked', channelId: 'ch-other', type: 'task',
      metadata: JSON.stringify({ waitingForInput: true }),
    })));
    expect(screen.queryByText(/待回复 ·/)).toBeNull();
    // 正常加入后 waitingForInput 消失（仍 blocked）→ 移除
    act(() => emitSse(wuStatusChanged({
      id: 'WU-3003', status: 'blocked', channelId: 'ch-1', type: 'task',
      metadata: JSON.stringify({ waitingForInput: true }),
    })));
    await waitFor(() => expect(screen.getByText('待回复 · 1')).toBeTruthy());
    act(() => emitSse(wuStatusChanged({ id: 'WU-3003', status: 'blocked', channelId: 'ch-1', type: 'task', metadata: '{}' })));
    expect(screen.queryByText(/待回复 ·/)).toBeNull();
  });

  it('requirement.created → 右栏 REQ 就地新增（负载全量零补拉，#415）；他频道 created 忽略', async () => {
    renderPage();
    await waitFor(() => expect(railReqIds()).toContain('REQ-0042'));
    act(() => emitSse({ event_type: 'requirement.created', data: { requirement: { ...REQ_0043, channelId: 'ch-1', projectId: 'p-1' } } }));
    await waitFor(() => expect(railReqIds()).toContain('REQ-0043'));
    // #415：负载即全量（与 REST get 同源）→ 不再撬起补拉
    expect(mockGetReq).not.toHaveBeenCalled();
    expect(railReq('REQ-0043')?.status).toBe('open');
    act(() => emitSse({ event_type: 'requirement.created', data: { requirement: { ...REQ_0043, id: 'REQ-0099', channelId: 'ch-other', title: '他频道需求' } } }));
    expect(railReqIds()).not.toContain('REQ-0099');
    // 重复 created（桥重发/乱序）按 id 去重
    act(() => emitSse({ event_type: 'requirement.created', data: { requirement: { ...REQ_0043, channelId: 'ch-1' } } }));
    expect(railReqIds().filter(id => id === 'REQ-0043')).toHaveLength(1);
  });

  it('requirement.updated → 本频道 REQ 全量负载覆盖合并；他频道 updated 忽略；列表没有不撬拉', async () => {
    renderPage();
    await waitFor(() => expect(railReq('REQ-0042')?.status).toBe('in-progress'));
    act(() => emitSse({ event_type: 'requirement.updated', data: { requirement: { ...REQS[0], status: 'done', projectId: 'p-2' } } }));
    await waitFor(() => expect(railReq('REQ-0042')?.status).toBe('done'));
    expect(railReq('REQ-0042')?.projectId).toBe('p-2');
    act(() => emitSse({ event_type: 'requirement.updated', data: { requirement: { ...REQS[0], channelId: 'ch-other', title: '篡改标题' } } }));
    expect(railReq('REQ-0042')?.title).toBe('主界面视觉方向稿');
    // 列表没有的条目：忽略（交由重连 refetch 打底），不补拉
    act(() => emitSse({ event_type: 'requirement.updated', data: { requirement: { ...REQ_0043, channelId: 'ch-1' } } }));
    expect(railReqIds()).not.toContain('REQ-0043');
    expect(mockGetReq).not.toHaveBeenCalled();
  });

  it('#403: requirement.created/updated → current-pmo 失效强刷；他频道事件不触发', async () => {
    renderPage();
    await waitFor(() => expect(railReqIds()).toContain('REQ-0042'));
    const pmoCalls = () => mockApiGet.mock.calls.filter(([url]) => String(url).endsWith('/current-pmo')).length;
    // chip/rail 均为本文件替身：挂载期无 pmo 拉取
    expect(pmoCalls()).toBe(0);
    act(() => emitSse({ event_type: 'requirement.updated', data: { requirement: { ...REQS[0], status: 'done' } } }));
    await waitFor(() => expect(pmoCalls()).toBe(1));
    act(() => emitSse({ event_type: 'requirement.created', data: { requirement: { ...REQ_0043, id: 'REQ-0099', channelId: 'ch-other', title: '他频道' } } }));
    expect(pmoCalls()).toBe(1);
  });
});

// #440 Phase 1：频道建议 prompt 片——WU 状态流转后出现对应建议，点击经 prefill 填入输入框，dismiss 会话级
// #447（spec #441 收尾）：前端静态建议映射（wuSuggestions）与 pickCurrentWu 本地副本已删——
// 引导片唯一来源 = GET /channels/:id/suggestions；前端只剩渲染与交互（预填/dismiss/确认弹窗）。
// 三形态渲染与点击行为见 #443/#444/#446 各 describe；本块锁「无静态兜底」与 dismiss 台账语义。
describe('ChannelDetailPage — #447 引导片唯一来源 = 建议端点', () => {
  const CHANNEL = { data: { data: { id: 'ch-1', name: 'rnd-主研发', type: 'rnd', members: '[]' } } };
  const PROMPT_SUGGESTION = (wuId: string) => ({
    data: {
      data: {
        currentWuId: wuId,
        suggestions: [{
          id: 'transcribe-review-checklist', kind: 'prompt',
          params: { wuId, wuTitle: '登录功能' },
          text: '@reviewer 把《登录功能》的验收标准转写成审查清单',
        }],
      },
    },
  });
  const EMPTY = { data: { data: { currentWuId: null, suggestions: [] } } };
  let suggestionPayload: unknown = EMPTY;
  const suggestionsCalls = () =>
    mockApiGet.mock.calls.filter(([url]) => String(url).endsWith('/suggestions')).length;

  beforeEach(() => {
    vi.clearAllMocks();
    currentMessages = MESSAGES;
    sseHandlers = [];
    suggestionPayload = EMPTY;
    useNotificationStore.setState({ notifications: [] });
    mockApiGet.mockImplementation((url: string) => Promise.resolve(
      String(url).endsWith('/suggestions') ? suggestionPayload : CHANNEL,
    ));
    mockListWorkunits.mockImplementation((params?: { status?: string }) => Promise.resolve(
      params?.status === 'active' ? activeWuList([]) : { data: { data: [] } },
    ));
    mockOnEvent.mockImplementation((cb: SseHandler) => { sseHandlers.push(cb); return () => {}; });
    mockOnReconnect.mockImplementation((cb: () => void) => { reconnectHandlers.push(cb); return () => {}; });
    reconnectHandlers = [];
    mockListReqs.mockResolvedValue({ data: { data: [] } });
    mockSendMessage.mockResolvedValue({});
  });

  it('端点无建议 → 不出现引导片（前端不再按 WU 状态自行映射出片，无静态兜底）', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('#rnd-主研发')).toBeTruthy());
    await waitFor(() => expect(suggestionsCalls()).toBe(1));
    expect(document.querySelector('.mc-suggest')).toBeNull();
    // SSE 状态流转只触发端点重拉，出不出片由后端推导决定（空负载 → 仍无片）
    act(() => emitSse({
      event_type: 'workunit.status_changed',
      data: { workunit: { id: 'WU-4001', status: 'in_review', channelId: 'ch-1', type: 'task', metadata: '{}' } },
    }));
    await waitFor(() => expect(suggestionsCalls()).toBe(2));
    expect(document.querySelector('.mc-suggest')).toBeNull();
  });

  it('dismiss 会话级：同片重拉不复活；端点产出新片（新 dismissKey）→ 重新出现', async () => {
    suggestionPayload = PROMPT_SUGGESTION('WU-4001');
    renderPage();
    const chip = await screen.findByText(/转写审查清单/);
    expect(chip).toBeTruthy();
    fireEvent.click(screen.getByLabelText('关闭建议'));
    expect(document.querySelector('.mc-suggest')).toBeNull();
    // 同片重拉（同 dismissKey ep:WU-4001:transcribe-review-checklist）→ 不复活
    act(() => emitSse({
      event_type: 'workunit.status_changed',
      data: { workunit: { id: 'WU-4001', status: 'in_review', channelId: 'ch-1', type: 'task', metadata: '{}' } },
    }));
    await waitFor(() => expect(suggestionsCalls()).toBe(2));
    expect(document.querySelector('.mc-suggest')).toBeNull();
    // 状况变化后端点产出新片（新 wuId → 新 dismissKey）→ 重新出现
    suggestionPayload = PROMPT_SUGGESTION('WU-4002');
    act(() => emitSse({
      event_type: 'workunit.status_changed',
      data: { workunit: { id: 'WU-4002', status: 'in_review', channelId: 'ch-1', type: 'task', metadata: '{}' } },
    }));
    await waitFor(() => expect(screen.getByText(/转写审查清单/)).toBeTruthy());
  });
});

// #440 Phase 2：频道阶段条——复用 StationStepper/buildLifecycle，deriveDisplayState 同口径；
// #447 起「频道当前工单」拣选唯一正本在后端建议端点（pickCurrentWu 前端副本已删），
// 阶段条与引导片同源消费端点 currentWuId（WU 数据本体仍取自 channelWus 面）
describe('ChannelDetailPage — #440 阶段条（#447 起 currentWuId 由建议端点驱动）', () => {
  const CHANNEL = { data: { data: { id: 'ch-1', name: 'rnd-主研发', type: 'rnd', members: '[]' } } };
  const WU_5001 = {
    id: 'WU-5001', parentId: null, dependsOn: '', type: 'task', scope: 's',
    assigneeId: null, status: 'active', failureType: null, retryCount: 0,
    timeoutAt: null, channelId: 'ch-1', metadata: null,
    createdAt: iso(-30), updatedAt: iso(-5), claimedAt: iso(-20), completedAt: null,
  };
  let suggestionPayload: unknown = { data: { data: { currentWuId: 'WU-5001', suggestions: [] } } };
  const suggestionsCalls = () =>
    mockApiGet.mock.calls.filter(([url]) => String(url).endsWith('/suggestions')).length;
  const stageBarSteps = () => [...screen.getByLabelText('工单阶段').querySelectorAll('.wu-bstep')];

  beforeEach(() => {
    vi.clearAllMocks();
    currentMessages = MESSAGES;
    sseHandlers = [];
    suggestionPayload = { data: { data: { currentWuId: 'WU-5001', suggestions: [] } } };
    useNotificationStore.setState({ notifications: [] });
    mockApiGet.mockImplementation((url: string) => Promise.resolve(
      String(url).endsWith('/suggestions') ? suggestionPayload : CHANNEL,
    ));
    mockListWorkunits.mockImplementation((params?: { status?: string }) => Promise.resolve(
      params?.status === 'active'
        ? activeWuList([])
        : params?.status === 'blocked'
          ? { data: { data: [] } }
          : { data: { data: [WU_5001] } },
    ));
    mockOnEvent.mockImplementation((cb: SseHandler) => { sseHandlers.push(cb); return () => {}; });
    mockOnReconnect.mockImplementation((cb: () => void) => { reconnectHandlers.push(cb); return () => {}; });
    reconnectHandlers = [];
    mockListReqs.mockResolvedValue({ data: { data: [] } });
    mockSendMessage.mockResolvedValue({});
  });

  it('端点 currentWuId 命中本频道 WU → 顶部渲染阶段条（当前站 = 进行中）', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByLabelText('工单阶段')).toBeTruthy());
    const steps = stageBarSteps();
    expect(steps).toHaveLength(4);
    expect(steps[1].className).toContain('wu-st-current');
  });

  it('端点 currentWuId=null → 不渲染阶段条（频道有 WU 也不自行拣选——拣选口径单源在后端）', async () => {
    suggestionPayload = { data: { data: { currentWuId: null, suggestions: [] } } };
    renderPage();
    await waitFor(() => expect(screen.getByText('#rnd-主研发')).toBeTruthy());
    await waitFor(() => expect(suggestionsCalls()).toBe(1));
    expect(screen.queryByLabelText('工单阶段')).toBeNull();
  });

  it('端点 currentWuId 指向 channelWus 外的 WU（时序 skew）→ 不渲染阶段条（fail-closed 不编造）', async () => {
    suggestionPayload = { data: { data: { currentWuId: 'WU-9999', suggestions: [] } } };
    renderPage();
    await waitFor(() => expect(screen.getByText('#rnd-主研发')).toBeTruthy());
    await waitFor(() => expect(suggestionsCalls()).toBe(1));
    expect(screen.queryByLabelText('工单阶段')).toBeNull();
  });

  it('WU 状态流转（SSE）→ channelWus upsert + 端点重拉 → 阶段条当前站随展示列移动', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByLabelText('工单阶段')).toBeTruthy());
    expect(stageBarSteps()[1].className).toContain('wu-st-current');
    act(() => emitSse({
      event_type: 'workunit.status_changed',
      data: { workunit: { id: 'WU-5001', status: 'in_review', channelId: 'ch-1', type: 'task', metadata: '{}' } },
    }));
    await waitFor(() => expect(stageBarSteps()[2].className).toContain('wu-st-current'));
  });
});

// #443（spec #441 情境引导 02）：端点驱动的只读状态说明——频道建议改由
// GET /channels/:id/suggestions 驱动；workunit.status_changed SSE 后重拉（不新增事件类型）；
// status 形态只读、不可点、无发送语义
describe('ChannelDetailPage — #443 端点驱动只读状态说明', () => {
  const CHANNEL = { data: { data: { id: 'ch-1', name: 'rnd-主研发', type: 'rnd', members: '[]' } } };
  const STATUS_SUGGESTION = {
    data: {
      data: {
        currentWuId: 'WU-4001',
        suggestions: [{
          id: 'auto-review-in-flight', kind: 'status',
          params: { wuId: 'WU-4001', wuTitle: '登录功能' },
        }],
      },
    },
  };
  const suggestionsCalls = () =>
    mockApiGet.mock.calls.filter(([url]) => String(url).endsWith('/suggestions')).length;

  beforeEach(() => {
    vi.clearAllMocks();
    currentMessages = MESSAGES;
    sseHandlers = [];
    useNotificationStore.setState({ notifications: [] });
    mockApiGet.mockImplementation((url: string) => Promise.resolve(
      String(url).endsWith('/suggestions') ? STATUS_SUGGESTION : CHANNEL,
    ));
    mockListWorkunits.mockImplementation((params?: { status?: string }) => Promise.resolve(
      params?.status === 'active' ? activeWuList([]) : { data: { data: [] } },
    ));
    mockOnEvent.mockImplementation((cb: SseHandler) => { sseHandlers.push(cb); return () => {}; });
    mockOnReconnect.mockImplementation((cb: () => void) => { reconnectHandlers.push(cb); return () => {}; });
    reconnectHandlers = [];
    mockListReqs.mockResolvedValue({ data: { data: [] } });
    mockSendMessage.mockResolvedValue({});
  });

  it('端点回 status 建议 → 渲染只读状况说明：可见、非按钮、点击不进输入框', async () => {
    renderPage();
    const note = await screen.findByText('等待自动评审：《登录功能》');
    expect(note.closest('button')).toBeNull();
    fireEvent.click(note);
    expect(screen.getByTestId('channel-input').getAttribute('data-prefill')).toBe('');
    expect(Number(screen.getByTestId('channel-input').getAttribute('data-prefill-nonce'))).toBe(0);
  });

  it('挂载拉取一次；本频道 workunit.status_changed SSE → 重拉；他频道事件不重拉（不新增事件类型）', async () => {
    renderPage();
    await waitFor(() => expect(suggestionsCalls()).toBe(1));
    act(() => emitSse({
      event_type: 'workunit.status_changed',
      data: { workunit: { id: 'WU-4001', status: 'in_review', channelId: 'ch-1', type: 'task', metadata: '{}' } },
    }));
    await waitFor(() => expect(suggestionsCalls()).toBe(2));
    act(() => emitSse({
      event_type: 'workunit.status_changed',
      data: { workunit: { id: 'WU-9', status: 'in_review', channelId: 'ch-other', type: 'task', metadata: '{}' } },
    }));
    await new Promise(r => setTimeout(r, 20));
    expect(suggestionsCalls()).toBe(2);
  });

  it('端点负载畸形（缺 suggestions 数组）→ 不出片不炸（fail-closed）', async () => {
    mockApiGet.mockResolvedValue(CHANNEL); // 所有 GET 都回频道对象
    renderPage();
    await waitFor(() => expect(screen.getByText('#rnd-主研发')).toBeTruthy());
    await waitFor(() => expect(suggestionsCalls()).toBe(1));
    expect(screen.queryByText(/等待自动评审/)).toBeNull();
  });

  it('端点请求失败 → 静默不出片（引导只是引导，不阻断频道使用）', async () => {
    mockApiGet.mockImplementation((url: string) => (
      String(url).endsWith('/suggestions') ? Promise.reject(new Error('boom')) : Promise.resolve(CHANNEL)
    ));
    renderPage();
    await waitFor(() => expect(screen.getByText('#rnd-主研发')).toBeTruthy());
    await waitFor(() => expect(suggestionsCalls()).toBe(1));
    expect(screen.queryByText(/等待自动评审/)).toBeNull();
  });
});

// #446（spec #441 情境引导 05）：prompt 建议片——本质是发给 agent 的自然语言任务；
// 点击预填进输入框（指令本体由后端 text 字段承载），人可编辑后发送，走既有 @mention 消息路由
describe('ChannelDetailPage — #446 prompt 建议片（预填进输入框，不自动发送）', () => {
  const CHANNEL = { data: { data: { id: 'ch-1', name: 'rnd-主研发', type: 'rnd', members: '[]' } } };
  const PROMPT_TEXT = '@reviewer 把《登录功能》的验收标准转写成审查清单';
  const PROMPT_SUGGESTION = {
    data: {
      data: {
        currentWuId: 'WU-4001',
        suggestions: [{
          id: 'transcribe-review-checklist', kind: 'prompt',
          params: { wuId: 'WU-4001', wuTitle: '登录功能' },
          text: PROMPT_TEXT,
        }],
      },
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    currentMessages = MESSAGES;
    sseHandlers = [];
    useNotificationStore.setState({ notifications: [] });
    mockApiGet.mockImplementation((url: string) => Promise.resolve(
      String(url).endsWith('/suggestions') ? PROMPT_SUGGESTION : CHANNEL,
    ));
    mockListWorkunits.mockImplementation((params?: { status?: string }) => Promise.resolve(
      params?.status === 'active' ? activeWuList([]) : { data: { data: [] } },
    ));
    mockOnEvent.mockImplementation((cb: SseHandler) => { sseHandlers.push(cb); return () => {}; });
    mockOnReconnect.mockImplementation((cb: () => void) => { reconnectHandlers.push(cb); return () => {}; });
    reconnectHandlers = [];
    mockListReqs.mockResolvedValue({ data: { data: [] } });
    mockSendMessage.mockResolvedValue({});
  });

  it('端点回 prompt 建议 → 渲染可点片：可选标注 + 工单上下文 + hint 说清点击后果', async () => {
    renderPage();
    const chip = await screen.findByText('可选：转写审查清单：《登录功能》');
    expect(chip.closest('button')).not.toBeNull();
    expect(screen.getByText(/预填到输入框/)).toBeTruthy();
  });

  it('点击 → 预填指令本体进输入框（可编辑），不自动发送、不走接口', async () => {
    renderPage();
    fireEvent.click(await screen.findByText('可选：转写审查清单：《登录功能》'));
    expect(screen.getByTestId('channel-input').getAttribute('data-prefill')).toBe(PROMPT_TEXT);
    expect(Number(screen.getByTestId('channel-input').getAttribute('data-prefill-nonce'))).toBeGreaterThan(0);
    // 不自动发送：人过目编辑后按 Enter，发送走既有 @mention 消息路由（输入框既有路径）
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockApiPost).not.toHaveBeenCalled();
  });

  it('prompt 片缺 text（畸形负载）→ 不渲染（fail-closed，不点空指令）', async () => {
    mockApiGet.mockImplementation((url: string) => Promise.resolve(
      String(url).endsWith('/suggestions')
        ? { data: { data: { currentWuId: 'WU-4001', suggestions: [{ id: 'transcribe-review-checklist', kind: 'prompt', params: { wuId: 'WU-4001', wuTitle: '登录功能' } }] } } }
        : CHANNEL,
    ));
    renderPage();
    await waitFor(() => expect(screen.getByText('#rnd-主研发')).toBeTruthy());
    await waitFor(() => expect(
      mockApiGet.mock.calls.some(([url]) => String(url).endsWith('/suggestions')),
    ).toBe(true));
    expect(screen.queryByText(/转写审查清单/)).toBeNull();
  });
});

// #444（spec #441 情境引导 03）：确定性动作片「补派评审」——断链时后端产出 action 建议；
// 点击 → 一次确认 → 直调 dispatch-review 端点（与自动派发同原语），不经消息路由；
// 生效后重拉建议，片随前置条件转假消失
describe('ChannelDetailPage — #444 确定性动作片：补派评审', () => {
  const CHANNEL = { data: { data: { id: 'ch-1', name: 'rnd-主研发', type: 'rnd', members: '[]' } } };
  const ACTION_SUGGESTION = {
    data: {
      data: {
        currentWuId: 'WU-4001',
        suggestions: [{
          id: 'redispatch-review', kind: 'action',
          params: { wuId: 'WU-4001', wuTitle: '登录功能' },
        }],
      },
    },
  };
  const EMPTY_SUGGESTION = { data: { data: { currentWuId: 'WU-4001', suggestions: [] } } };
  let suggestionFetchCount = 0;
  const suggestionsCalls = () =>
    mockApiGet.mock.calls.filter(([url]) => String(url).endsWith('/suggestions')).length;

  beforeEach(() => {
    vi.clearAllMocks();
    currentMessages = MESSAGES;
    sseHandlers = [];
    suggestionFetchCount = 0;
    useNotificationStore.setState({ notifications: [] });
    // 首次拉取回动作片；动作生效后的重拉回空（子单已建出，前置条件转假）
    mockApiGet.mockImplementation((url: string) => Promise.resolve(
      String(url).endsWith('/suggestions')
        ? (++suggestionFetchCount === 1 ? ACTION_SUGGESTION : EMPTY_SUGGESTION)
        : CHANNEL,
    ));
    mockListWorkunits.mockImplementation((params?: { status?: string }) => Promise.resolve(
      params?.status === 'active' ? activeWuList([]) : { data: { data: [] } },
    ));
    mockOnEvent.mockImplementation((cb: SseHandler) => { sseHandlers.push(cb); return () => {}; });
    mockOnReconnect.mockImplementation((cb: () => void) => { reconnectHandlers.push(cb); return () => {}; });
    reconnectHandlers = [];
    mockListReqs.mockResolvedValue({ data: { data: [] } });
    mockSendMessage.mockResolvedValue({});
    mockDispatchReview.mockResolvedValue({ data: { data: { reviewWorkUnitId: 'WU-4009' } } });
  });

  it('端点回 action 建议 → 渲染可点动作片，文案带工单上下文、说清点击后果', async () => {
    renderPage();
    const chip = await screen.findByText('补派评审：《登录功能》');
    expect(chip.closest('button')).not.toBeNull();
    expect(screen.getByText(/点击确认后会立即创建审查工单/)).toBeTruthy();
  });

  it('点击 → 确认弹窗（说清会发生什么）；确认 → 直调 dispatch-review，不走消息路由；生效后片消失', async () => {
    renderPage();
    fireEvent.click(await screen.findByText('补派评审：《登录功能》'));
    // 一次确认：弹窗确认前不调接口
    expect(mockDispatchReview).not.toHaveBeenCalled();
    expect(screen.getByText(/不会新建普通工单，也不会在频道里发消息/)).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: '确认补派' }));
    // 直调 dispatch-review 端点（同原语）；不经 @mention 消息路由、不产生频道噪音
    await waitFor(() => expect(mockDispatchReview).toHaveBeenCalledWith('WU-4001'));
    expect(mockDispatchReview).toHaveBeenCalledTimes(1);
    expect(mockSendMessage).not.toHaveBeenCalled();
    // 动作生效、状态回扫（重拉端点回空）→ 片消失
    await waitFor(() => expect(screen.queryByText('补派评审：《登录功能》')).toBeNull());
    expect(suggestionsCalls()).toBe(2);
  });

  it('点击后取消 → 不调接口、不发消息、片保留', async () => {
    renderPage();
    fireEvent.click(await screen.findByText('补派评审：《登录功能》'));
    fireEvent.click(await screen.findByRole('button', { name: '取消' }));
    expect(mockDispatchReview).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(screen.getByText('补派评审：《登录功能》')).toBeTruthy();
  });

  it('dispatch-review 失败（如与自动化抢建 409）→ 错误文案进弹窗，不静默', async () => {
    mockDispatchReview.mockRejectedValue(new Error('Review child already in flight — 已有未完结的评审子 WU'));
    renderPage();
    fireEvent.click(await screen.findByText('补派评审：《登录功能》'));
    fireEvent.click(await screen.findByRole('button', { name: '确认补派' }));
    await screen.findByText(/已有未完结的评审子 WU/);
    expect(suggestionsCalls()).toBe(1); // 未成功不重拉
  });
});

// #445（spec #441 情境引导 04）：认领动作片——当前工单 unassigned 且无在线 loop（或超宽限）时
// 后端产出 claim-wu action 建议；点击 → 一次确认 → 直调 claim 端点（认领即发声原语，
// 与 loop 自动认领同一路径），不经消息路由；生效后重拉建议，片随状态流转消失
describe('ChannelDetailPage — #445 认领动作片', () => {
  const CHANNEL = { data: { data: { id: 'ch-1', name: 'rnd-主研发', type: 'rnd', members: '[]' } } };
  const ACTION_SUGGESTION = {
    data: {
      data: {
        currentWuId: 'WU-4001',
        suggestions: [{
          id: 'claim-wu', kind: 'action',
          params: { wuId: 'WU-4001', wuTitle: '登录功能' },
        }],
      },
    },
  };
  const EMPTY_SUGGESTION = { data: { data: { currentWuId: 'WU-4001', suggestions: [] } } };
  let suggestionFetchCount = 0;
  const suggestionsCalls = () =>
    mockApiGet.mock.calls.filter(([url]) => String(url).endsWith('/suggestions')).length;

  beforeEach(() => {
    vi.clearAllMocks();
    currentMessages = MESSAGES;
    sseHandlers = [];
    suggestionFetchCount = 0;
    useNotificationStore.setState({ notifications: [] });
    // 首次拉取回认领动作片；认领生效后的重拉回空（已 active，前置条件转假）
    mockApiGet.mockImplementation((url: string) => Promise.resolve(
      String(url).endsWith('/suggestions')
        ? (++suggestionFetchCount === 1 ? ACTION_SUGGESTION : EMPTY_SUGGESTION)
        : CHANNEL,
    ));
    mockListWorkunits.mockImplementation((params?: { status?: string }) => Promise.resolve(
      params?.status === 'active' ? activeWuList([]) : { data: { data: [] } },
    ));
    mockOnEvent.mockImplementation((cb: SseHandler) => { sseHandlers.push(cb); return () => {}; });
    mockOnReconnect.mockImplementation((cb: () => void) => { reconnectHandlers.push(cb); return () => {}; });
    reconnectHandlers = [];
    mockListReqs.mockResolvedValue({ data: { data: [] } });
    mockSendMessage.mockResolvedValue({});
    mockClaim.mockResolvedValue({ data: { id: 'WU-4001', status: 'active' } });
  });

  it('端点回 claim-wu action 建议 → 渲染可点动作片，文案带工单上下文、说清点击后果', async () => {
    renderPage();
    const chip = await screen.findByText('认领工单：《登录功能》');
    expect(chip.closest('button')).not.toBeNull();
    expect(screen.getByText(/点击确认后会把它认领给你/)).toBeTruthy();
  });

  it('点击 → 确认弹窗（说清会发生什么）；确认 → 直调 claim 端点（前端不带身份），不走消息路由；生效后片消失', async () => {
    renderPage();
    fireEvent.click(await screen.findByText('认领工单：《登录功能》'));
    // 一次确认：弹窗确认前不调接口
    expect(mockClaim).not.toHaveBeenCalled();
    expect(screen.getByText(/频道里会发一条认领说明/)).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: '确认认领' }));
    // 直调 claim 端点（认领人由服务端按会话用户解析）；不经 @mention 消息路由
    await waitFor(() => expect(mockClaim).toHaveBeenCalledWith('WU-4001'));
    expect(mockClaim).toHaveBeenCalledTimes(1);
    expect(mockSendMessage).not.toHaveBeenCalled();
    // 认领生效、状态回扫（重拉端点回空）→ 片消失
    await waitFor(() => expect(screen.queryByText('认领工单：《登录功能》')).toBeNull());
    expect(suggestionsCalls()).toBe(2);
  });

  it('点击后取消 → 不调接口、不发消息、片保留', async () => {
    renderPage();
    fireEvent.click(await screen.findByText('认领工单：《登录功能》'));
    fireEvent.click(await screen.findByRole('button', { name: '取消' }));
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(screen.getByText('认领工单：《登录功能》')).toBeTruthy();
  });

  it('claim 失败（如已被他人认领 409）→ 错误文案进弹窗，不静默', async () => {
    mockClaim.mockRejectedValue(new Error('Claim failed'));
    renderPage();
    fireEvent.click(await screen.findByText('认领工单：《登录功能》'));
    fireEvent.click(await screen.findByRole('button', { name: '确认认领' }));
    await screen.findByText(/Claim failed/);
    expect(suggestionsCalls()).toBe(1); // 未成功不重拉
  });
});

// 频道页视觉优化批次 2 ⑥（docs/plans/2026-09-channel-visual-polish.md）：
// 空频道态在两行引导文案下给 2-3 个低调示例提示 chip，点击走既有 prefill 通道
// （与 #446 prompt 建议片同一 setInputPrefill 机制）填入输入框，不自动发送
describe('ChannelDetailPage — 空频道态示例提示 chip（视觉批次 2 ⑥）', () => {
  const CHANNEL = { data: { data: { id: 'ch-1', name: 'rnd-主研发', type: 'rnd', members: '[]' } } };

  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    currentMessages = []; // 空频道
    currentHasMore = false;
    sseHandlers = [];
    useNotificationStore.setState({ notifications: [] });
    mockApiGet.mockImplementation((url: string) => Promise.resolve(
      String(url).endsWith('/suggestions') ? { data: { data: { currentWuId: null, suggestions: [] } } } : CHANNEL,
    ));
    mockListWorkunits.mockImplementation((params?: { status?: string }) => Promise.resolve(
      params?.status === 'active' ? activeWuList([]) : { data: { data: [] } },
    ));
    mockOnEvent.mockImplementation((cb: SseHandler) => { sseHandlers.push(cb); return () => {}; });
    mockOnReconnect.mockImplementation((cb: () => void) => { reconnectHandlers.push(cb); return () => {}; });
    reconnectHandlers = [];
    mockListReqs.mockResolvedValue({ data: { data: [] } });
    mockSendMessage.mockResolvedValue({});
  });

  it('空频道 → 两行引导文案 + 2-3 个可点示例 chip', async () => {
    renderPage();
    await screen.findByText('发送消息开始对话');
    const chips = document.querySelectorAll('.mc-empty-chip');
    expect(chips.length).toBeGreaterThanOrEqual(2);
    expect(chips.length).toBeLessThanOrEqual(3);
  });

  it('点击示例 chip → prefill 填入输入框（nonce 递增），不自动发送', async () => {
    renderPage();
    const chip = (await screen.findByText('发送消息开始对话'))
      .closest('.mc-stream-empty')!.querySelector<HTMLButtonElement>('.mc-empty-chip')!;
    fireEvent.click(chip);
    const input = screen.getByTestId('channel-input');
    expect(input.getAttribute('data-prefill')).toBe(chip.textContent);
    expect(Number(input.getAttribute('data-prefill-nonce'))).toBeGreaterThan(0);
    expect(mockSendMessage).not.toHaveBeenCalled();
    // 再点一次另一 chip → nonce 继续递增（同 nonce 不覆盖用户编辑的契约靠 nonce 保证）
    const chips = document.querySelectorAll<HTMLButtonElement>('.mc-empty-chip');
    const before = Number(input.getAttribute('data-prefill-nonce'));
    fireEvent.click(chips[chips.length - 1]);
    expect(Number(screen.getByTestId('channel-input').getAttribute('data-prefill-nonce'))).toBe(before + 1);
  });
});
