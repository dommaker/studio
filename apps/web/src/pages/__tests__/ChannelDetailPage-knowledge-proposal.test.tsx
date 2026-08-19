// ChannelDetailPage — 知识审核闭环：handleAction 分发 knowledge_proposal approve/reject
// 契约：approve → POST /knowledge-service/promote；reject → POST /knowledge-service/demote（逐条目）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const { mockSendMessage, mockListWorkunits, mockListReqs, mockApiGet, mockApiPost, mockRefresh } = vi.hoisted(() => ({
  mockSendMessage: vi.fn(),
  mockListWorkunits: vi.fn(),
  mockListReqs: vi.fn(),
  mockApiGet: vi.fn(),
  mockApiPost: vi.fn(),
  mockRefresh: vi.fn(),
}));

vi.mock('../../api', () => ({
  api: { get: mockApiGet, post: mockApiPost },
}));

vi.mock('../../hooks/useChannelEvents', () => ({
  useChannelMessages: () => ({
    messages: MESSAGES,
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
  requirementApi: { list: mockListReqs },
}));

// #242：页面新增 live 状态条走 WebSocketContext——测试环境无 Provider，置空订阅
vi.mock('../../api/websocketHooks', () => ({
  useWebSocketContext: () => ({ onEvent: () => () => {} }),
}));

vi.mock('../../components/channel/ChannelRail', () => ({ ChannelRail: () => null }));
vi.mock('../../components/channel/WorkUnitDrawer', () => ({ WorkUnitDrawer: () => null }));
vi.mock('../../components/channel/ChannelMemberManager', () => ({ ChannelMemberManager: () => null }));
vi.mock('../../components/ChannelWorkspaceSetting', () => ({ ChannelWorkspaceSetting: () => null }));
vi.mock('../../components/channel/ChannelInput', () => ({ ChannelInput: () => null }));
// 其他卡片与本测试无关；KnowledgeProposalCard 用真实组件（无 API 副作用）
vi.mock('../../components/channel/RequirementsDocCard', () => ({ RequirementsDocCard: () => null }));
vi.mock('../../components/channel/KnowledgeConfirmCard', () => ({ KnowledgeConfirmCard: () => null }));
vi.mock('../../components/channel/AuditorSuggestionCard', () => ({ AuditorSuggestionCard: () => null }));
vi.mock('../../components/channel/ConvertToTaskDialog', () => ({ ConvertToTaskDialog: () => null }));

import { ChannelDetailPage } from '../ChannelDetailPage';

const MESSAGES = [
  {
    id: 'msg-kp-1', channelId: 'ch-sys', authorType: 'agent' as const, agentName: 'KK',
    content: '知识提案 — 待人工审核', workUnitId: null, replyToId: null,
    meta: JSON.stringify({
      cardType: 'knowledge_proposal',
      status: 'ready',
      cardData: {
        workUnitId: 'WU-2042',
        entries: [
          { id: 'k-1', title: 'session 过期未刷新导致 401', type: 'pitfall' },
          { id: 'k-2', title: '登录流程统一走 auth-service', type: 'guideline' },
        ],
      },
    }),
    createdAt: new Date().toISOString(),
  },
];

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/channels/ch-sys']}>
      <Routes>
        <Route path="/channels/:id" element={<ChannelDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );

describe('ChannelDetailPage — knowledge_proposal 审核分发', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiGet.mockResolvedValue({ data: { data: { id: 'ch-sys', name: '系统', type: 'system', members: '[]' } } });
    mockListWorkunits.mockResolvedValue({ data: { data: [] } });
    mockListReqs.mockResolvedValue({ data: { data: [] } });
    mockApiPost.mockResolvedValue({ data: { success: true } });
  });

  it('approve → 对卡片每个条目 POST /knowledge-service/promote，卡片显示已审核', async () => {
    renderPage();
    const btn = await screen.findByText('通过');
    fireEvent.click(btn);

    await waitFor(() => {
      expect(mockApiPost).toHaveBeenCalledWith('/knowledge-service/promote', { entryId: 'k-1' });
      expect(mockApiPost).toHaveBeenCalledWith('/knowledge-service/promote', { entryId: 'k-2' });
    });
    expect(await screen.findByText(/已通过/)).toBeTruthy();
    expect(mockRefresh).toHaveBeenCalled();
  });

  it('reject → 对卡片每个条目 POST /knowledge-service/demote，卡片显示已拒绝', async () => {
    renderPage();
    const btn = await screen.findByText('拒绝');
    fireEvent.click(btn);

    await waitFor(() => {
      expect(mockApiPost).toHaveBeenCalledWith('/knowledge-service/demote', { entryId: 'k-1' });
      expect(mockApiPost).toHaveBeenCalledWith('/knowledge-service/demote', { entryId: 'k-2' });
    });
    expect(await screen.findByText(/已拒绝/)).toBeTruthy();
  });
});
