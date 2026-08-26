// ChannelDetailPage — 蒸馏提案人审闸口：handleAction 分发 distill_proposal approve/reject
// 契约：approve → POST /review-proposals/distill/:id/approve；reject → …/reject（#351 通用端点，一次整卡）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const { mockSendMessage, mockListWorkunits, mockListReqs, mockApiGet, mockApiPost, mockRefresh, mockDistillApprove, mockDistillReject, mockProposalStatus } = vi.hoisted(() => ({
  mockSendMessage: vi.fn(),
  mockListWorkunits: vi.fn(),
  mockListReqs: vi.fn(),
  mockApiGet: vi.fn(),
  mockApiPost: vi.fn(),
  mockRefresh: vi.fn(),
  mockDistillApprove: vi.fn(),
  mockDistillReject: vi.fn(),
  mockProposalStatus: vi.fn(),
}));

vi.mock('../../api', () => ({
  api: { get: mockApiGet, post: mockApiPost },
}));

vi.mock('../../api/distill', () => ({
  distillApi: { approve: mockDistillApprove, reject: mockDistillReject, proposalStatus: mockProposalStatus },
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
  useWebSocketContext: () => ({ onEvent: () => () => {}, onReconnect: () => () => {} }),
}));

vi.mock('../../components/channel/ChannelRail', () => ({ ChannelRail: () => null }));
vi.mock('../../components/channel/WorkUnitDrawer', () => ({ WorkUnitDrawer: () => null }));
vi.mock('../../components/channel/ChannelMemberManager', () => ({ ChannelMemberManager: () => null }));
vi.mock('../../components/channel/ChannelDefaultProjectSelect', () => ({ ChannelDefaultProjectSelect: () => null }));
vi.mock('../../components/channel/ChannelCurrentPmoChip', () => ({ ChannelCurrentPmoChip: () => null }));
vi.mock('../../components/channel/ChannelInput', () => ({ ChannelInput: () => null }));
// 其他卡片与本测试无关；ReviewProposalCard 用真实组件（#352 合一壳，其 API 已 mock）
vi.mock('../../components/channel/RequirementsDocCard', () => ({ RequirementsDocCard: () => null }));
vi.mock('../../components/channel/KnowledgeConfirmCard', () => ({ KnowledgeConfirmCard: () => null }));
vi.mock('../../components/channel/ConvertToTaskDialog', () => ({ ConvertToTaskDialog: () => null }));

import { ChannelDetailPage } from '../ChannelDetailPage';

const MESSAGES = [
  {
    id: 'msg-dp-1', channelId: 'ch-sys', authorType: 'agent' as const, agentName: 'KK',
    content: '知识蒸馏提案 — 待确认', workUnitId: null, replyToId: null,
    meta: JSON.stringify({
      cardType: 'distill_proposal',
      status: 'ready',
      cardData: {
        proposalId: 'dp-1',
        signals: { topicTags: ['session-summary'], manualCount: 0 },
        materials: [
          { id: 'ore-1', title: '[Session Fix] 修复竞态' },
          { id: 'ore-2', title: '[Session Fix] 修复超时' },
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

describe('ChannelDetailPage — distill_proposal 审核分发', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiGet.mockResolvedValue({ data: { data: { id: 'ch-sys', name: '系统', type: 'system', members: '[]' } } });
    mockListWorkunits.mockResolvedValue({ data: { data: [] } });
    mockListReqs.mockResolvedValue({ data: { data: [] } });
    mockProposalStatus.mockResolvedValue({ data: { success: true, statuses: { 'dp-1': 'pending' } } });
    mockDistillApprove.mockResolvedValue({ data: { success: true, productIds: ['p-1'] } });
    mockDistillReject.mockResolvedValue({ data: { success: true } });
  });

  it('approve → distillApi.approve(proposalId)，卡片显示已执行', async () => {
    renderPage();
    const btn = await screen.findByText('确认蒸馏');
    fireEvent.click(btn);

    await waitFor(() => {
      expect(mockDistillApprove).toHaveBeenCalledWith('dp-1');
    });
    expect(await screen.findByText(/已确认，蒸馏已执行/)).toBeTruthy();
    expect(mockRefresh).toHaveBeenCalled();
  });

  it('approve 预算熔断（success:false + skipped）→ 卡片保持待审', async () => {
    mockDistillApprove.mockResolvedValue({ data: { success: false, skipped: 'budget-exhausted' } });
    renderPage();
    const btn = await screen.findByText('确认蒸馏');
    fireEvent.click(btn);

    await waitFor(() => {
      expect(mockDistillApprove).toHaveBeenCalledWith('dp-1');
    });
    // 卡片保持待审：按钮仍在，无已审态
    await waitFor(() => expect(screen.getByText('确认蒸馏')).toBeTruthy());
    expect(screen.queryByText(/已确认/)).not.toBeTruthy();
  });

  it('reject → distillApi.reject(proposalId)，卡片显示已拒绝', async () => {
    renderPage();
    const btn = await screen.findByText('拒绝');
    fireEvent.click(btn);

    await waitFor(() => {
      expect(mockDistillReject).toHaveBeenCalledWith('dp-1');
    });
    expect(await screen.findByText(/已拒绝/)).toBeTruthy();
  });
});
