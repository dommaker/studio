// ChannelDetailPage — Mission Control 三栏 smoke test
// 覆盖：三栏渲染 / REQ chip 开抽屉 / WU 链接开抽屉 / 已完成折叠 / NEED_INPUT 内嵌回复链路 / 线程展开
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const { mockSendMessage, mockListWorkunits, mockListReqs, mockApiGet, mockDrawerSpy, mockOnEvent } = vi.hoisted(() => ({
  mockSendMessage: vi.fn(),
  mockListWorkunits: vi.fn(),
  mockListReqs: vi.fn(),
  mockApiGet: vi.fn(),
  mockDrawerSpy: vi.fn(),
  mockOnEvent: vi.fn(),
}));

vi.mock('../../api', () => ({
  api: { get: mockApiGet },
}));

vi.mock('../../hooks/useChannelEvents', () => ({
  useChannelMessages: () => ({
    messages: currentMessages,
    loading: false,
    hasMore: false,
    sendMessage: mockSendMessage,
    loadMore: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock('../../api/workunit', () => ({
  workunitApi: { list: mockListWorkunits },
}));

vi.mock('../../api/requirements', () => ({
  requirementApi: { list: mockListReqs },
}));

// #242：live 状态条的 SSE 事件源（onEvent 注册回调，用例手工驱动）
vi.mock('../../api/websocketHooks', () => ({
  useWebSocketContext: () => ({ onEvent: mockOnEvent }),
}));

// 左栏/右抽屉/顶栏控件：保留接口，隔离其内部 API 依赖
vi.mock('../../components/channel/ChannelRail', () => ({
  ChannelRail: ({ activeChannelId }: { activeChannelId?: string }) => <div data-testid="channel-rail" data-active={activeChannelId} />,
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

vi.mock('../../components/ChannelWorkspaceSetting', () => ({
  ChannelWorkspaceSetting: () => <div data-testid="workspace-setting" />,
}));

vi.mock('../../components/channel/ChannelInput', () => ({
  ChannelInput: () => <div data-testid="channel-input" />,
}));

// 卡片子组件与本测试无关
vi.mock('../../components/channel/RequirementsDocCard', () => ({ RequirementsDocCard: () => null }));
vi.mock('../../components/channel/KnowledgeConfirmCard', () => ({ KnowledgeConfirmCard: () => null }));
vi.mock('../../components/channel/AuditorSuggestionCard', () => ({ AuditorSuggestionCard: () => null }));
vi.mock('../../components/channel/ConvertToTaskDialog', () => ({ ConvertToTaskDialog: () => null }));

import { ChannelDetailPage } from '../ChannelDetailPage';
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

// #242：onEvent 注册的 SSE 处理器（用例手工驱动事件）
type SseHandler = (msg: { event_type: string; data?: unknown }) => void;
let wuEventHandler: SseHandler | null = null;

/** #242 夹具：本频道 active WU 列表响应（deriveLiveExecutions 初始数据源） */
const activeWuList = (wus: Array<{ id: string; metadata: string | null }>) => ({ data: { data: wus } });

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/channels/ch-1']}>
      <Routes>
        <Route path="/channels/:id" element={<ChannelDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );

describe('ChannelDetailPage — Mission Control 三栏', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentMessages = MESSAGES;
    wuEventHandler = null;
    mockApiGet.mockResolvedValue({ data: { data: { id: 'ch-1', name: 'rnd-主研发', type: 'rnd', members: '[]' } } });
    // 同一 list 接口服务两种查询：blocked（NEED_INPUT 挂起集合）/ active（#242 live 状态条，默认无执行中）
    mockListWorkunits.mockImplementation((params?: { status?: string }) => Promise.resolve(
      params?.status === 'active'
        ? activeWuList([])
        : { data: { data: [{ id: 'WU-1018', metadata: JSON.stringify({ waitingForInput: true }) }] } },
    ));
    mockOnEvent.mockImplementation((cb: SseHandler) => { wuEventHandler = cb; return () => {}; });
    mockListReqs.mockResolvedValue({ data: { data: REQS } });
    mockSendMessage.mockResolvedValue({});
  });

  it('renders three-column IA: rail + main stream + input; drawer closed initially', async () => {
    renderPage();
    expect(screen.getByTestId('channel-rail').getAttribute('data-active')).toBe('ch-1');
    await waitFor(() => expect(screen.getByText('#rnd-主研发')).toBeTruthy());
    expect(screen.getByTestId('channel-input')).toBeTruthy();
    expect(screen.getByTestId('member-manager')).toBeTruthy();
    expect(screen.getByTestId('workspace-setting')).toBeTruthy();
    expect(screen.queryByTestId('wu-drawer')).toBeNull();
  });

  it('REQ chip opens the req drawer (replacing the old Modal)', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText(/REQ-0042 · 主界面视觉方向稿/)).toBeTruthy());
    fireEvent.click(screen.getByText(/REQ-0042 · 主界面视觉方向稿/));
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
    wuEventHandler = null;
    mockApiGet.mockResolvedValue({ data: { data: { id: 'ch-1', name: 'rnd-主研发', type: 'rnd', members: '[]' } } });
    mockListWorkunits.mockImplementation((params?: { status?: string }) => Promise.resolve(
      params?.status === 'active'
        ? activeWuList([])
        : { data: { data: [{ id: 'WU-1018', metadata: JSON.stringify({ waitingForInput: true }) }] } },
    ));
    mockOnEvent.mockImplementation((cb: SseHandler) => { wuEventHandler = cb; return () => {}; });
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
    act(() => wuEventHandler!({
      event_type: 'workunit.execution.step',
      data: { workUnitId: 'WU-1018', step: 4, action: 'progress' },
    }));
    expect(screen.getByText(/WU-1018 正在执行 · 第 4 步 · progress/)).toBeTruthy();
  });

  it('status_changed → active 事件让状态条出现（页面已打开时新开始的执行）', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('#rnd-主研发')).toBeTruthy());
    expect(screen.queryByText(/正在执行/)).toBeNull();
    act(() => wuEventHandler!({
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
    act(() => wuEventHandler!({
      event_type: 'workunit.status_changed',
      data: { workunit: { id: 'WU-1018', status: 'done', channelId: 'ch-1', metadata: '{}' } },
    }));
    expect(screen.queryByText(/正在执行/)).toBeNull();
  });

  it('其他频道的 status_changed / 未知 WU 的步事件 → 不产生状态条', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('#rnd-主研发')).toBeTruthy());
    act(() => wuEventHandler!({
      event_type: 'workunit.status_changed',
      data: { workunit: { id: 'WU-9999', status: 'active', channelId: 'ch-other', metadata: '{}' } },
    }));
    act(() => wuEventHandler!({
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
