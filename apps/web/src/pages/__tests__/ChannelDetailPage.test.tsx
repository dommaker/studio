// ChannelDetailPage — Mission Control 三栏 smoke test
// 覆盖：三栏渲染 / REQ chip 开抽屉 / WU 链接开抽屉 / 已完成折叠 / NEED_INPUT 内嵌回复链路 / 线程展开
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const { mockSendMessage, mockListWorkunits, mockListReqs, mockGetReq, mockApiGet, mockApiPost, mockDrawerSpy, mockOnEvent, mockOnReconnect, mockRefresh, mockActivityRailSpy } = vi.hoisted(() => ({
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
}));

vi.mock('../../api', () => ({
  api: { get: mockApiGet, post: mockApiPost },
}));

vi.mock('../../hooks/useChannelEvents', () => ({
  useChannelMessages: () => ({
    messages: currentMessages,
    loading: false,
    hasMore: false,
    sendMessage: mockSendMessage,
    loadMore: vi.fn(),
    refresh: mockRefresh,
  }),
}));

vi.mock('../../api/workunit', () => ({
  workunitApi: { list: mockListWorkunits },
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
  ChannelInput: () => <div data-testid="channel-input" />,
}));

// 卡片子组件与本测试无关
vi.mock('../../components/channel/RequirementsDocCard', () => ({ RequirementsDocCard: () => null }));
vi.mock('../../components/channel/KnowledgeConfirmCard', () => ({ KnowledgeConfirmCard: () => null }));
vi.mock('../../components/channel/ConvertToTaskDialog', () => ({ ConvertToTaskDialog: () => null }));

import { ChannelDetailPage } from '../ChannelDetailPage';
import { useNotificationStore } from '../../stores/notificationStore';
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

// #242：onEvent 注册的 SSE 处理器（用例手工驱动事件）；
// 批 2（决策 5/6）后页面有多个订阅方（live 状态条 / waitingWus chip / REQ chips）→ 收集全部处理器统一派发
type SseHandler = (msg: { event_type: string; data?: unknown }) => void;
let sseHandlers: SseHandler[] = [];
const emitSse = (msg: { event_type: string; data?: unknown }) => { sseHandlers.forEach(h => h(msg)); };
// #394：REQ 呈现挪右栏——经 activity-rail mock 的 props spy 观察 channelReqs 状态
const railProps = () => mockActivityRailSpy.mock.calls.at(-1)?.[0] as { reqs: { id: string; title: string; status: string }[] } | undefined;
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
  beforeEach(() => {
    vi.clearAllMocks();
    currentMessages = MESSAGES;
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

  it('决策9：SSE 断线重连 → 当前频道一次性 refetch（messages refresh + waitingWus/REQ chips 打底面对齐）', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('#rnd-主研发')).toBeTruthy());
    expect(mockRefresh).not.toHaveBeenCalled();
    expect(reconnectHandlers.length).toBeGreaterThan(0);
    const wuCallsBefore = mockListWorkunits.mock.calls.length;
    const reqCallsBefore = mockListReqs.mock.calls.length;
    act(() => emitReconnect());
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    // chips 两个打底面也强制对齐（批 4 收尾：reloadWaitingWus/reloadChannelReqs 挂进重连回调）
    expect(mockListWorkunits.mock.calls.length).toBe(wuCallsBefore + 1);
    expect(mockListReqs.mock.calls.length).toBe(reqCallsBefore + 1);
  });

  it('renders three-column IA: rail + main stream + input; drawer closed initially', async () => {
    renderPage();
    expect(screen.getByTestId('channel-rail').getAttribute('data-active')).toBe('ch-1');
    // #394：三栏 = 左频道栏 + 中对话流 + 右频道动态栏
    expect(screen.getByTestId('activity-rail')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('#rnd-主研发')).toBeTruthy());
    expect(screen.getByTestId('channel-input')).toBeTruthy();
    expect(screen.getByTestId('member-manager')).toBeTruthy();
    // #272：顶栏 = 当前 PMO chip + 默认工程（本地 repo）下拉
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
    fireEvent.click(screen.getByText('▸ 5 条回复'));

    // 3 条连续过程消息收成一组；卡片回复（非末位）是里程碑，直接可见
    expect(screen.getByText('▸ 3 条过程消息')).toBeTruthy();
    expect(screen.getByText('通过')).toBeTruthy();
    expect(screen.getByText('分析结论：拆成 3 个任务')).toBeTruthy();
  });

  it('NEED_INPUT: waiting badge + inline reply sends through the same replyTo link', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('等待回复')).toBeTruthy());
    const input = screen.getByLabelText('回复 WU-1018');
    fireEvent.change(input, { target: { value: '同意注入' } });
    fireEvent.click(screen.getByText('回复'));
    await waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalledWith('同意注入', 'm-1');
    });
  });

  it('thread replies hidden by default and expand on toggle', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('检索到 3 条相关知识')).toBeTruthy());
    expect(screen.queryByText('补充：SDD-012 强相关')).toBeNull();
    fireEvent.click(screen.getByText('▸ 1 条回复'));
    expect(screen.getByText('补充：SDD-012 强相关')).toBeTruthy();
  });

  it('collapses ≥3 consecutive process replies inside a thread; milestones stay visible', async () => {
    currentMessages = PROCESS_MESSAGES;
    renderPage();
    // 展开线程
    await waitFor(() => expect(screen.getByText('需求已收到，开始分析')).toBeTruthy());
    fireEvent.click(screen.getByText('▸ 5 条回复'));

    // 4 条连续过程消息收成一组（默认折叠）；最后一条（最新状态）直接可见
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

  it('等待 badge 与回复区只落在当前提问消息（anchor 不再重复 badge/回复框）', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('等待回复')).toBeTruthy());
    expect(screen.getAllByText('等待回复')).toHaveLength(1);
    // 选项卡只此一份（anchor 上没有第二份回复区）
    expect(screen.getAllByText('交给 agent 判断')).toHaveLength(1);
  });

  it('#276 点选项回答 -> 经 replyTo 走复活链路，await 成功后显示已回复（互斥）', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('OAuth')).toBeTruthy());
    fireEvent.click(screen.getByText('OAuth'));
    await waitFor(() => expect(mockSendMessage).toHaveBeenCalledWith('OAuth', 'q-2'));
    // await sendMessage resolve 后：needSent=true -> 已回复显示；badge 消失（互斥）
    await waitFor(() => expect(screen.getByText(/已回复/)).toBeTruthy());
    expect(screen.queryByText('等待回复')).toBeNull();
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
    // 仅 q-3 挂「等待回复」badge 与选项卡（q-2 已被回复过不再重复挂回复区）
    expect(screen.getAllByText('等待回复')).toHaveLength(1);
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
    mockGetReq.mockResolvedValue({ data: { data: REQ_0043 } });
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

  it('requirement.created → 右栏 REQ 实时新增（经 get 补全全量）；他频道 created 忽略', async () => {
    renderPage();
    await waitFor(() => expect(railReqIds()).toContain('REQ-0042'));
    act(() => emitSse({ event_type: 'requirement.created', data: { id: 'REQ-0043', channelId: 'ch-1', title: '新需求', status: 'open' } }));
    await waitFor(() => expect(railReqIds()).toContain('REQ-0043'));
    expect(mockGetReq).toHaveBeenCalledWith('REQ-0043');
    act(() => emitSse({ event_type: 'requirement.created', data: { id: 'REQ-0099', channelId: 'ch-other', title: '他频道需求', status: 'open' } }));
    expect(railReqIds()).not.toContain('REQ-0099');
    expect(mockGetReq).not.toHaveBeenCalledWith('REQ-0099');
  });

  it('requirement.updated → 本频道 REQ title/status 增量合并；他频道 updated 忽略', async () => {
    renderPage();
    await waitFor(() => expect(railReq('REQ-0042')?.status).toBe('in-progress'));
    act(() => emitSse({ event_type: 'requirement.updated', data: { id: 'REQ-0042', channelId: 'ch-1', status: 'done' } }));
    await waitFor(() => expect(railReq('REQ-0042')?.status).toBe('done'));
    act(() => emitSse({ event_type: 'requirement.updated', data: { id: 'REQ-0042', channelId: 'ch-other', title: '篡改标题' } }));
    expect(railReq('REQ-0042')?.title).toBe('主界面视觉方向稿');
  });
});
