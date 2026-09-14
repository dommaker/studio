// ChannelDetailPage — channel 上下游优化 Phase 3（AC3，docs/plans/2026-09-channel-upstream-downstream-ux.md）：
// 主流连续 ≥3 条 monitor 告警折叠为一行摘要（条数 + severity 计数 + 时间范围），点击展开/收起，
// 展开状态经 usePersistentStreamUI 按频道持久化（expandedAlertGroups 字段）。
// mock 搭建复用 ChannelDetailPage-quote-locate.test.tsx 的接缝。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const { mockSendMessage, mockListWorkunits, mockListReqs, mockApiGet, mockOnEvent, mockRefresh } = vi.hoisted(() => ({
  mockSendMessage: vi.fn(),
  mockListWorkunits: vi.fn(),
  mockListReqs: vi.fn(),
  mockApiGet: vi.fn(),
  mockOnEvent: vi.fn(),
  mockRefresh: vi.fn(),
}));

vi.mock('../../api', () => ({
  api: { get: mockApiGet },
}));

vi.mock('../../hooks/useChannelEvents', () => ({
  useChannelMessages: () => ({
    messages: currentMessages,
    loading: false,
    error: null,
    hasMore: false,
    sendMessage: mockSendMessage,
    loadMore: vi.fn(),
    refresh: mockRefresh,
  }),
}));

vi.mock('../../api/workunit', () => ({ workunitApi: { list: mockListWorkunits } }));
vi.mock('../../api/requirements', () => ({ requirementApi: { list: mockListReqs } }));
vi.mock('../../api/websocketHooks', () => ({
  useWebSocketContext: () => ({ onEvent: mockOnEvent, onReconnect: () => () => {} }),
}));

// 与本测试无关的子组件：保留接口，隔离其内部 API 依赖
vi.mock('../../components/channel/ChannelRail', () => ({ ChannelRail: () => <div data-testid="channel-rail" /> }));
vi.mock('../../components/channel/WorkUnitDrawer', () => ({ WorkUnitDrawer: () => null }));
vi.mock('../../components/channel/ChannelMemberManager', () => ({ ChannelMemberManager: () => null }));
vi.mock('../../components/channel/ChannelDefaultProjectSelect', () => ({ ChannelDefaultProjectSelect: () => null }));
vi.mock('../../components/channel/ChannelCurrentPmoChip', () => ({ ChannelCurrentPmoChip: () => null }));
vi.mock('../../components/channel/ChannelActivityRail', () => ({ ChannelActivityRail: () => null }));
vi.mock('../../components/channel/ChannelInput', () => ({ ChannelInput: () => <div data-testid="channel-input" /> }));
vi.mock('../../components/channel/RequirementsDocCard', () => ({ RequirementsDocCard: () => null }));
vi.mock('../../components/channel/KnowledgeConfirmCard', () => ({ KnowledgeConfirmCard: () => null }));
vi.mock('../../components/channel/ConvertToTaskDialog', () => ({ ConvertToTaskDialog: () => null }));

import { ChannelDetailPage } from '../ChannelDetailPage';
import { useNotificationStore } from '../../stores/notificationStore';
import type { ChannelMessage } from '../../api/channel';

const now = Date.now();
const iso = (offsetMin: number) => new Date(now + offsetMin * 60000).toISOString();

const alert = (id: string, level: 'CRITICAL' | 'WARNING', offsetMin: number): ChannelMessage => ({
  id, channelId: 'ch-1', authorType: 'agent' as const, agentName: 'Studio',
  content: `[${level}] **[Monitor]** 告警内容-${id}`, workUnitId: null, replyToId: null,
  meta: '{}', createdAt: iso(offsetMin),
});

const humanMsg = (id: string, offsetMin: number): ChannelMessage => ({
  id, channelId: 'ch-1', authorType: 'human' as const,
  content: `人类消息-${id}`, workUnitId: null, replyToId: null,
  meta: '{}', createdAt: iso(offsetMin),
});

let currentMessages: ChannelMessage[] = [];

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/channels/ch-1']}>
      <Routes>
        <Route path="/channels/:id" element={<ChannelDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );

const summaryRow = () => document.querySelector('.mc-alert-group-summary');

describe('ChannelDetailPage — monitor 告警主流折叠（Phase 3 / AC3）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    currentMessages = [
      alert('al1', 'CRITICAL', 0),
      alert('al2', 'WARNING', 1),
      alert('al3', 'CRITICAL', 2),
      alert('al4', 'WARNING', 3),
      humanMsg('h1', 4),
    ];
    useNotificationStore.setState({ stateItems: [], notifications: [], unreadCount: 0 });
    mockApiGet.mockResolvedValue({ data: { data: { id: 'ch-1', name: 'rnd-主研发', type: 'rnd', members: '[]' } } });
    mockListWorkunits.mockResolvedValue({ data: { data: [] } });
    mockListReqs.mockResolvedValue({ data: { data: [] } });
    mockOnEvent.mockImplementation(() => () => {});
    mockSendMessage.mockResolvedValue({});
  });

  it('连续 ≥3 条告警折叠为摘要行：文案含条数与 severity 计数与时间范围；组内消息不渲染', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('人类消息-h1')).toBeTruthy());

    const summary = summaryRow();
    expect(summary).not.toBeNull();
    expect(summary!.textContent).toContain('4 条监控告警');
    expect(summary!.textContent).toContain('2 CRITICAL');
    expect(summary!.textContent).toContain('2 WARNING');
    expect(summary!.textContent).toMatch(/\d{2}:\d{2}–\d{2}:\d{2}/);
    // 折叠态：组内告警正文不渲染
    expect(screen.queryByText(/告警内容-al1/)).toBeNull();
    expect(screen.queryByText(/告警内容-al4/)).toBeNull();
  });

  it('点击摘要行展开看到组内消息；再点收起恢复摘要', async () => {
    renderPage();
    await waitFor(() => expect(summaryRow()).not.toBeNull());

    fireEvent.click(summaryRow()!);
    await waitFor(() => expect(screen.getByText(/告警内容-al1/)).toBeTruthy());
    expect(screen.getByText(/告警内容-al4/)).toBeTruthy();
    // 展开态摘要行仍在（作收起入口之一）
    expect(summaryRow()).not.toBeNull();

    fireEvent.click(summaryRow()!);
    await waitFor(() => expect(screen.queryByText(/告警内容-al1/)).toBeNull());
  });

  it('展开状态按频道持久化：写 localStorage expandedAlertGroups，重挂载后保持展开', async () => {
    const first = renderPage();
    await waitFor(() => expect(summaryRow()).not.toBeNull());
    fireEvent.click(summaryRow()!);
    await waitFor(() => expect(screen.getByText(/告警内容-al1/)).toBeTruthy());

    const persisted = JSON.parse(window.localStorage.getItem('mc-stream-ui:v1:ch-1')!);
    expect(persisted.expandedAlertGroups).toEqual(['alerts-al1']);

    first.unmount();
    renderPage();
    await waitFor(() => expect(screen.getByText(/告警内容-al1/)).toBeTruthy());
  });

  it('仅 2 条连续告警不折叠（按普通系统播报逐条渲染）', async () => {
    currentMessages = [alert('al1', 'CRITICAL', 0), alert('al2', 'WARNING', 1)];
    renderPage();
    await waitFor(() => expect(screen.getByText(/告警内容-al1/)).toBeTruthy());
    expect(screen.getByText(/告警内容-al2/)).toBeTruthy();
    expect(summaryRow()).toBeNull();
  });
});
