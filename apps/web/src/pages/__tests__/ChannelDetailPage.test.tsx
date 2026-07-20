// ChannelDetailPage — Mission Control 三栏 smoke test
// 覆盖：三栏渲染 / REQ chip 开抽屉 / WU 链接开抽屉 / 已完成折叠 / NEED_INPUT 内嵌回复链路 / 线程展开
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const { mockSendMessage, mockListWorkunits, mockListReqs, mockApiGet, mockDrawerSpy } = vi.hoisted(() => ({
  mockSendMessage: vi.fn(),
  mockListWorkunits: vi.fn(),
  mockListReqs: vi.fn(),
  mockApiGet: vi.fn(),
  mockDrawerSpy: vi.fn(),
}));

vi.mock('../../api', () => ({
  api: { get: mockApiGet },
}));

vi.mock('../../hooks/useChannelEvents', () => ({
  useChannelMessages: () => ({
    messages: MESSAGES,
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

// 左栏/右抽屉/顶栏控件：保留接口，隔离其内部 API 依赖
vi.mock('../../components/channel/ChannelRail', () => ({
  ChannelRail: ({ activeChannelId }: any) => <div data-testid="channel-rail" data-active={activeChannelId} />,
}));

vi.mock('../../components/channel/WorkUnitDrawer', () => ({
  WorkUnitDrawer: (props: any) => {
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
vi.mock('../../components/channel/DeployApprovalCard', () => ({ DeployApprovalCard: () => null }));
vi.mock('../../components/channel/ConvertToTaskDialog', () => ({ ConvertToTaskDialog: () => null }));

import { ChannelDetailPage } from '../ChannelDetailPage';

const now = Date.now();
const iso = (offsetMin: number) => new Date(now + offsetMin * 60000).toISOString();

const MESSAGES = [
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

const REQS = [
  { id: 'REQ-0042', seq: 42, title: '主界面视觉方向稿', status: 'in-progress', createdAt: iso(-100), createdBy: '张弛' },
];

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
    mockApiGet.mockResolvedValue({ data: { data: { id: 'ch-1', name: 'rnd-主研发', type: 'rnd', members: '[]' } } });
    mockListWorkunits.mockResolvedValue({
      data: { data: [{ id: 'WU-1018', metadata: JSON.stringify({ waitingForInput: true }) }] },
    });
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
});
