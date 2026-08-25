// ChannelDetailPage — #322 render-count 测试：模拟 workunit.execution.step 事件到达，
// 断言既有消息项零重渲（MarkdownBody 渲染计数不变；live 状态条正常更新证明页面确有重渲）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const { mockSendMessage, mockListWorkunits, mockListReqs, mockApiGet, mockOnEvent, mockRefresh, mdRenderCount } = vi.hoisted(() => ({
  mockSendMessage: vi.fn(),
  mockListWorkunits: vi.fn(),
  mockListReqs: vi.fn(),
  mockApiGet: vi.fn(),
  mockOnEvent: vi.fn(),
  // refresh 必须稳定引用（与真实 useChannelMessages 的 useCallback 行为一致），
  // 否则 dispatch 每次重建、memo 被测试假件自己打破
  mockRefresh: vi.fn(),
  mdRenderCount: { n: 0 },
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

// 渲染探针：agent 正文走 MarkdownBody——消息项重渲则计数必增
vi.mock('../../components/knowledge/MarkdownBody', () => ({
  MarkdownBody: ({ content }: { content: string }) => { mdRenderCount.n++; return <div className="mc-md">{content}</div>; },
}));

vi.mock('../../components/channel/ChannelRail', () => ({ ChannelRail: () => <div data-testid="channel-rail" /> }));
vi.mock('../../components/channel/WorkUnitDrawer', () => ({ WorkUnitDrawer: () => null }));
vi.mock('../../components/channel/ChannelMemberManager', () => ({ ChannelMemberManager: () => null }));
vi.mock('../../components/channel/ChannelDefaultProjectSelect', () => ({ ChannelDefaultProjectSelect: () => null }));
vi.mock('../../components/channel/ChannelCurrentPmoChip', () => ({ ChannelCurrentPmoChip: () => null }));
vi.mock('../../components/channel/ChannelInput', () => ({ ChannelInput: () => null }));
vi.mock('../../components/channel/RequirementsDocCard', () => ({ RequirementsDocCard: () => null }));
vi.mock('../../components/channel/KnowledgeConfirmCard', () => ({ KnowledgeConfirmCard: () => null }));
vi.mock('../../components/channel/AuditorSuggestionCard', () => ({ AuditorSuggestionCard: () => null }));
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

type SseHandler = (msg: { event_type: string; data?: unknown }) => void;
let sseHandlers: SseHandler[] = [];
const emitSse = (msg: { event_type: string; data?: unknown }) => { sseHandlers.forEach(h => h(msg)); };

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/channels/ch-1']}>
      <Routes>
        <Route path="/channels/:id" element={<ChannelDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );

describe('ChannelDetailPage — #322 消息项 memo：step 事件零重渲', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mdRenderCount.n = 0;
    sseHandlers = [];
    currentMessages = [msg('m1', { createdAt: iso(0) }), msg('m2', { createdAt: iso(10) })];
    mockApiGet.mockResolvedValue({ data: { data: { id: 'ch-1', name: 'rnd', type: 'rnd', members: '[]' } } });
    // live 状态条有一个执行中 WU（第 1 步）
    mockListWorkunits.mockImplementation((params?: { status?: string }) => Promise.resolve(
      params?.status === 'active'
        ? { data: { data: [{ id: 'WU-1018', metadata: JSON.stringify({ stepCount: 1 }) }] } }
        : { data: { data: [] } },
    ));
    mockListReqs.mockResolvedValue({ data: { data: [] } });
    mockOnEvent.mockImplementation((cb: SseHandler) => { sseHandlers.push(cb); return () => {}; });
    mockSendMessage.mockResolvedValue({});
  });

  it('workunit.execution.step 到达：live 条更新，但既有消息项零重渲', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('内容-m2')).toBeTruthy());
    await waitFor(() => expect(screen.getByText(/第 1 步/)).toBeTruthy());
    const before = mdRenderCount.n;
    expect(before).toBeGreaterThan(0); // 初始渲染已解析过 MarkdownBody（页面多次重渲，基数不锁定）

    act(() => emitSse({
      event_type: 'workunit.execution.step',
      data: { workUnitId: 'WU-1018', step: 2, action: 'progress', channelId: 'ch-1' },
    }));

    // 页面确实因 step 事件重渲（live 条步号更新）……
    await waitFor(() => expect(screen.getByText(/第 2 步 · progress/)).toBeTruthy());
    // ……但既有消息项（含 MarkdownBody 解析）零重渲
    expect(mdRenderCount.n).toBe(before);
  });
});
