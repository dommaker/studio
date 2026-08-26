// ChannelDetailPage — 角色记忆人审闸口：handleAction 分发 memory_proposal approve/reject
// 契约（#353 通用端点）：approve → POST /review-proposals/memory/:draftId/approve（逐草稿）；reject → 同 reject
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const { mockSendMessage, mockListWorkunits, mockListReqs, mockApiGet, mockApiPost, mockRefresh, mockMemoryApprove, mockMemoryReject } = vi.hoisted(() => ({
  mockSendMessage: vi.fn(),
  mockListWorkunits: vi.fn(),
  mockListReqs: vi.fn(),
  mockApiGet: vi.fn(),
  mockApiPost: vi.fn(),
  mockRefresh: vi.fn(),
  mockMemoryApprove: vi.fn(),
  mockMemoryReject: vi.fn(),
}));

vi.mock('../../api', () => ({
  api: { get: mockApiGet, post: mockApiPost },
}));

vi.mock('../../api/memory', () => ({
  memoryApi: { approve: mockMemoryApprove, reject: mockMemoryReject, status: vi.fn().mockResolvedValue({ data: { success: true, statuses: {} } }) },
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
// 其他卡片与本测试无关；ReviewProposalCard 用真实组件（#352 合一壳，无 API 副作用）
vi.mock('../../components/channel/RequirementsDocCard', () => ({ RequirementsDocCard: () => null }));
vi.mock('../../components/channel/KnowledgeConfirmCard', () => ({ KnowledgeConfirmCard: () => null }));
vi.mock('../../components/channel/AuditorSuggestionCard', () => ({ AuditorSuggestionCard: () => null }));
vi.mock('../../components/channel/ConvertToTaskDialog', () => ({ ConvertToTaskDialog: () => null }));

import { ChannelDetailPage } from '../ChannelDetailPage';

const MESSAGES = [
  {
    id: 'msg-mp-1', channelId: 'ch-sys', authorType: 'agent' as const, agentName: 'KK',
    content: '角色记忆提案 — 待确认', workUnitId: null, replyToId: null,
    meta: JSON.stringify({
      cardType: 'memory_proposal',
      status: 'ready',
      cardData: {
        roleId: 'role-1',
        workUnitId: 'WU-2042',
        entries: [
          { draftId: 'd-1', title: '测试命令', topicSlug: 'testing-command', topicPath: 'topics/testing-command.md', kind: 'execution-knowledge' },
          { draftId: 'd-2', title: '命名约定', topicSlug: 'naming', topicPath: 'topics/naming.md', kind: 'preference' },
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

describe('ChannelDetailPage — memory_proposal 审核分发', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiGet.mockResolvedValue({ data: { data: { id: 'ch-sys', name: '系统', type: 'system', members: '[]' } } });
    mockListWorkunits.mockResolvedValue({ data: { data: [] } });
    mockListReqs.mockResolvedValue({ data: { data: [] } });
    mockApiPost.mockResolvedValue({ data: { success: true } });
    mockMemoryApprove.mockResolvedValue({ data: { success: true } });
    mockMemoryReject.mockResolvedValue({ data: { success: true } });
  });

  it('approve → 逐 draftId POST 通用端点 approve，卡片显示已确认', async () => {
    renderPage();
    const btn = await screen.findByText('确认写入');
    fireEvent.click(btn);

    await waitFor(() => {
      expect(mockMemoryApprove).toHaveBeenCalledWith('d-1');
      expect(mockMemoryApprove).toHaveBeenCalledWith('d-2');
    });
    expect(await screen.findByText(/已确认/)).toBeTruthy();
    expect(mockRefresh).toHaveBeenCalled();
  });

  it('reject → 逐 draftId POST 通用端点 reject，卡片显示已丢弃', async () => {
    renderPage();
    const btn = await screen.findByText('丢弃');
    fireEvent.click(btn);

    await waitFor(() => {
      expect(mockMemoryReject).toHaveBeenCalledWith('d-1');
      expect(mockMemoryReject).toHaveBeenCalledWith('d-2');
    });
    expect(await screen.findByText(/已丢弃/)).toBeTruthy();
  });
});
