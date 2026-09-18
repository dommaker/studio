// ChannelDetailPage — #547 新增断言：focusedId 翻牌只重渲焦点迁移涉及的消息项，
// 不扇出到其他消息项（#322 memo 契约在横切值改经 Context 下发后仍成立——
// env value 全稳定引用，翻牌不经 Context 通道）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const { mockSendMessage, mockListWorkunits, mockListReqs, mockApiGet, mockOnEvent, mockRefresh, mdRenderCounts } = vi.hoisted(() => ({
  mockSendMessage: vi.fn(),
  mockListWorkunits: vi.fn(),
  mockListReqs: vi.fn(),
  mockApiGet: vi.fn(),
  mockOnEvent: vi.fn(),
  mockRefresh: vi.fn(),
  mdRenderCounts: new Map<string, number>(),
}));

vi.mock('../../api', () => ({ api: { get: mockApiGet } }));

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

vi.mock('../../api/workunit', () => ({ workunitApi: { list: mockListWorkunits } }));
vi.mock('../../api/requirements', () => ({ requirementApi: { list: mockListReqs } }));
vi.mock('../../api/websocketHooks', () => ({ useWebSocketContext: () => ({ onEvent: mockOnEvent, onReconnect: () => () => {} }) }));

// 渲染探针：agent 正文走 MarkdownBody——按内容分别计数，消息项重渲则对应计数必增
vi.mock('../../components/knowledge/MarkdownBody', () => ({
  MarkdownBody: ({ content }: { content: string }) => {
    mdRenderCounts.set(content, (mdRenderCounts.get(content) ?? 0) + 1);
    return <div className="mc-md">{content}</div>;
  },
}));

vi.mock('../../components/channel/ChannelRail', () => ({ ChannelRail: () => <div data-testid="channel-rail" /> }));
vi.mock('../../components/channel/ChannelActivityRail', () => ({ ChannelActivityRail: () => null }));
vi.mock('../../components/channel/WorkUnitDrawer', () => ({ WorkUnitDrawer: () => null }));
vi.mock('../../components/channel/ChannelMemberManager', () => ({ ChannelMemberManager: () => null }));
vi.mock('../../components/channel/ChannelDefaultProjectSelect', () => ({ ChannelDefaultProjectSelect: () => null }));
vi.mock('../../components/channel/ChannelCurrentPmoChip', () => ({ ChannelCurrentPmoChip: () => null }));
vi.mock('../../components/channel/ChannelInput', () => ({ ChannelInput: () => null }));
vi.mock('../../components/channel/RequirementsDocCard', () => ({ RequirementsDocCard: () => null }));
vi.mock('../../components/channel/KnowledgeConfirmCard', () => ({ KnowledgeConfirmCard: () => null }));
vi.mock('../../components/channel/ConvertToTaskDialog', () => ({ ConvertToTaskDialog: () => null }));

import { ChannelDetailPage } from '../ChannelDetailPage';
import type { ChannelMessage } from '../../api/channel';

const t0 = new Date('2026-08-19T10:00:00.000Z').getTime();
const iso = (offsetMin: number) => new Date(t0 + offsetMin * 60000).toISOString();

const msg = (id: string, over: Partial<ChannelMessage> = {}): ChannelMessage => ({
  id, channelId: 'ch-1', authorType: 'agent', agentName: 'pm',
  content: `内容-${id}`, replyToId: null, meta: '{}', createdAt: iso(0), ...over,
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

const countOf = (id: string) => mdRenderCounts.get(`内容-${id}`) ?? 0;

describe('ChannelDetailPage — #547 focusedId 翻牌零扇出', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mdRenderCounts.clear();
    currentMessages = [msg('m1', { createdAt: iso(0) }), msg('m2', { createdAt: iso(10) }), msg('m3', { createdAt: iso(20) })];
    mockApiGet.mockResolvedValue({ data: { data: { id: 'ch-1', name: 'rnd', type: 'rnd', members: '[]' } } });
    mockListWorkunits.mockResolvedValue({ data: { data: [] } });
    mockListReqs.mockResolvedValue({ data: { data: [] } });
    mockOnEvent.mockImplementation(() => () => {});
    mockSendMessage.mockResolvedValue({});
  });

  it('j 移焦点：只有焦点迁移涉及的消息项重渲，其余零重渲', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('内容-m3')).toBeTruthy());
    // 初始渲染落定（页面装配期多次重渲不锁定基数，落定后快照）
    await act(async () => {});
    const before = { m1: countOf('m1'), m2: countOf('m2'), m3: countOf('m3') };

    // 第一次 j：焦点落到 m1 —— 只有 m1 可重渲
    act(() => { fireEvent.keyDown(document.body, { key: 'j' }); });
    await waitFor(() =>
      expect(document.querySelector('.mc-msg-focused')?.getAttribute('data-message-id')).toBe('m1'));
    expect(countOf('m2')).toBe(before.m2);
    expect(countOf('m3')).toBe(before.m3);

    // 第二次 j：焦点 m1 → m2 —— m1（失焦点）与 m2（得焦点）可重渲，m3 零重渲
    const mid = { m1: countOf('m1'), m2: countOf('m2'), m3: countOf('m3') };
    act(() => { fireEvent.keyDown(document.body, { key: 'j' }); });
    await waitFor(() =>
      expect(document.querySelector('.mc-msg-focused')?.getAttribute('data-message-id')).toBe('m2'));
    expect(countOf('m3')).toBe(mid.m3);
    expect(countOf('m2')).toBeGreaterThan(mid.m2); // 命中项确实重渲（翻牌生效的佐证）
  });
});
