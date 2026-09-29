// ChannelDetailPage — 约束提案卡（ADR-0033 子项 7/8）：handleAction 分发 constraint_proposal approve/reject
// 契约（review-proposal 通用端点）：approve → POST /review-proposals/constraint/:proposalId/approve；
// reject → POST /review-proposals/constraint/:proposalId/reject
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
  id: 'msg-cp-1', channelId: 'ch-sys', authorType: 'agent' as const, agentName: 'Evolution',
  content: '## 🔧 新约束提案 cp-1 — 待审核\n\n条文草稿：前端代码不得出现内网地址', workUnitId: null, replyToId: null,
  meta: JSON.stringify({
    cardType: 'constraint_proposal',
    cardData: {
      proposalId: 'cp-1',
      action: 'new',
      constraintId: 'app_no_internal_url',
      rule: '前端代码不得出现内网地址',
      checker: 'regex-scan',
      severity: 'warning',
      sourceEntry: { id: 'k-1', title: 'no internal url in web code' },
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

describe('ChannelDetailPage — constraint_proposal 审核分发', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentMessages = [STRING_META_MESSAGE];
    mockApiGet.mockResolvedValue({ data: { data: { id: 'ch-sys', name: '系统', type: 'system', members: '[]' } } });
    mockListWorkunits.mockResolvedValue({ data: { data: [] } });
    mockListReqs.mockResolvedValue({ data: { data: [] } });
    mockApiPost.mockResolvedValue({ data: { success: true } });
  });

  it('渲染卡面条目（约束 id + 条文 + 来源知识）', async () => {
    renderPage();
    expect(await screen.findByText('app_no_internal_url')).toBeTruthy();
    expect(screen.getByText('前端代码不得出现内网地址')).toBeTruthy();
    expect(screen.getByText(/来源知识：no internal url/)).toBeTruthy();
  });

  it('approve → POST /review-proposals/constraint/:proposalId/approve，卡片显示已审核', async () => {
    renderPage();
    const btn = await screen.findByText('批准');
    fireEvent.click(btn);

    await waitFor(() => {
      expect(mockApiPost).toHaveBeenCalledWith('/review-proposals/constraint/cp-1/approve');
    });
    expect(await screen.findByText(/已确认/)).toBeTruthy();
    expect(mockRefresh).toHaveBeenCalled();
  });

  it('reject → POST /review-proposals/constraint/:proposalId/reject，卡片显示已拒绝', async () => {
    renderPage();
    const btn = await screen.findByText('拒绝');
    fireEvent.click(btn);

    await waitFor(() => {
      expect(mockApiPost).toHaveBeenCalledWith('/review-proposals/constraint/cp-1/reject');
    });
    expect(await screen.findByText(/已拒绝/)).toBeTruthy();
  });
});
