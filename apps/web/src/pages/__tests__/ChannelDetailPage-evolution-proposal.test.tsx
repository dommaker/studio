// ChannelDetailPage — 约束进化提案卡（#623 断点 3 遗留补丁）：handleAction 分发 evolution_proposal approve/reject
// 契约（review-proposal 通用端点）：approve → POST /review-proposals/evolution/:proposalId/approve；
// reject → POST /review-proposals/evolution/:proposalId/reject
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
  requirementApi: { list: mockListReqs },
}));

vi.mock('../../api/websocketHooks', () => ({
  useWebSocketContext: () => ({ onEvent: () => () => {}, onReconnect: () => () => {} }),
}));

vi.mock('../../components/channel/ChannelRail', () => ({ ChannelRail: () => null }));
vi.mock('../../components/channel/WorkUnitDrawer', () => ({ WorkUnitDrawer: () => null }));
vi.mock('../../components/channel/ChannelMemberManager', () => ({ ChannelMemberManager: () => null }));
vi.mock('../../components/channel/ChannelDefaultProjectSelect', () => ({ ChannelDefaultProjectSelect: () => null }));
vi.mock('../../components/channel/ChannelCurrentPmoChip', () => ({ ChannelCurrentPmoChip: () => null }));
vi.mock('../../components/channel/ChannelInput', () => ({ ChannelInput: () => null }));
// 其他卡片与本测试无关；ReviewProposalCard 用真实组件（#352 合一壳，无 API 副作用）
vi.mock('../../components/channel/RequirementsDocCard', () => ({ RequirementsDocCard: () => null }));
vi.mock('../../components/channel/KnowledgeConfirmCard', () => ({ KnowledgeConfirmCard: () => null }));
vi.mock('../../components/channel/ConvertToTaskDialog', () => ({ ConvertToTaskDialog: () => null }));

import { ChannelDetailPage } from '../ChannelDetailPage';

const STRING_META_MESSAGE = {
  id: 'msg-ep-1', channelId: 'ch-sys', authorType: 'agent' as const, agentName: 'Evolution',
  content: '## 🧬 约束进化提案 EP-0001 — 待审核\n\n证据：累计评估 60 次，拦到 0 次（从来没拦到过）',
  workUnitId: null, replyToId: null,
  meta: JSON.stringify({
    cardType: 'evolution_proposal',
    cardData: {
      proposalId: 'EP-0001',
      targetType: 'guideline',
      targetId: 'some_constraint',
      action: 'amend',
      constraintChange: 'retire',
      source: 'harness:usage-report',
    },
  }),
  createdAt: new Date().toISOString(),
};

let currentMessages = [STRING_META_MESSAGE];

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/channels/ch-sys']}>
      <Routes>
        <Route path="/channels/:id" element={<ChannelDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );

describe('ChannelDetailPage — evolution_proposal 审核分发', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentMessages = [STRING_META_MESSAGE];
    mockApiGet.mockResolvedValue({ data: { data: { id: 'ch-sys', name: '系统', type: 'system', members: '[]' } } });
    mockListWorkunits.mockResolvedValue({ data: { data: [] } });
    mockListReqs.mockResolvedValue({ data: { data: [] } });
    mockApiPost.mockResolvedValue({ data: { data: { success: true } } });
  });

  it('渲染卡面条目（目标约束 id + 白话动作标签）', async () => {
    renderPage();
    expect(await screen.findByText('some_constraint')).toBeTruthy();
    // countText 徽标 + 条目动作标签两处同文
    expect(screen.getAllByText('退役约束').length).toBeGreaterThanOrEqual(1);
  });

  it('approve → POST /review-proposals/evolution/:proposalId/approve，卡片显示已批准', async () => {
    renderPage();
    const btn = await screen.findByText('批准生效');
    fireEvent.click(btn);

    await waitFor(() => {
      expect(mockApiPost).toHaveBeenCalledWith('/review-proposals/evolution/EP-0001/approve');
    });
    expect(await screen.findByText(/已批准/)).toBeTruthy();
    expect(mockRefresh).toHaveBeenCalled();
  });

  it('reject → POST /review-proposals/evolution/:proposalId/reject，卡片显示已拒绝', async () => {
    renderPage();
    const btn = await screen.findByText('拒绝');
    fireEvent.click(btn);

    await waitFor(() => {
      expect(mockApiPost).toHaveBeenCalledWith('/review-proposals/evolution/EP-0001/reject');
    });
    expect(await screen.findByText(/已拒绝/)).toBeTruthy();
  });
});
