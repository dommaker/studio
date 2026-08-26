// ChannelDetailPage — 知识审核闭环：handleAction 分发 knowledge_proposal approve/reject
// 契约（#355 通用端点）：approve → POST /review-proposals/knowledge/:proposalId/approve（整卡一次）；
// reject → POST /review-proposals/knowledge/:proposalId/reject
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
vi.mock('../../components/channel/ConvertToTaskDialog', () => ({ ConvertToTaskDialog: () => null }));

import { ChannelDetailPage } from '../ChannelDetailPage';

const STRING_META_MESSAGE = {
  id: 'msg-kp-1', channelId: 'ch-sys', authorType: 'agent' as const, agentName: 'KK',
  content: '知识提案 — 待人工审核', workUnitId: null, replyToId: null,
  meta: JSON.stringify({
    cardType: 'knowledge_proposal',
    status: 'ready',
    cardData: {
      proposalId: 'kp-1',
      workUnitId: 'WU-2042',
      entries: [
        { id: 'k-1', title: 'session 过期未刷新导致 401', type: 'pitfall' },
        { id: 'k-2', title: '登录流程统一走 auth-service', type: 'guideline' },
      ],
    },
  }),
  createdAt: new Date().toISOString(),
};

// #264：线上 REST/SSE 出口的 object 形态 meta（与 string 夹具内容相同，仅形态不同）
const OBJECT_META_MESSAGE = {
  ...STRING_META_MESSAGE,
  meta: JSON.parse(STRING_META_MESSAGE.meta) as Record<string, unknown>,
};

// useChannelMessages mock 的当前消息集（默认 string-meta 存量形态，单测可替换）
let currentMessages = [STRING_META_MESSAGE];

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
    currentMessages = [STRING_META_MESSAGE];
    mockApiGet.mockResolvedValue({ data: { data: { id: 'ch-sys', name: '系统', type: 'system', members: '[]' } } });
    mockListWorkunits.mockResolvedValue({ data: { data: [] } });
    mockListReqs.mockResolvedValue({ data: { data: [] } });
    mockApiPost.mockResolvedValue({ data: { success: true } });
  });

  it('approve → 整卡一次 POST /review-proposals/knowledge/:proposalId/approve，卡片显示已审核', async () => {
    renderPage();
    const btn = await screen.findByText('通过');
    fireEvent.click(btn);

    await waitFor(() => {
      expect(mockApiPost).toHaveBeenCalledWith('/review-proposals/knowledge/kp-1/approve');
    });
    expect(await screen.findByText(/已通过/)).toBeTruthy();
    expect(mockRefresh).toHaveBeenCalled();
  });

  it('reject → 整卡一次 POST /review-proposals/knowledge/:proposalId/reject，卡片显示已拒绝', async () => {
    renderPage();
    const btn = await screen.findByText('拒绝');
    fireEvent.click(btn);

    await waitFor(() => {
      expect(mockApiPost).toHaveBeenCalledWith('/review-proposals/knowledge/kp-1/reject');
    });
    expect(await screen.findByText(/已拒绝/)).toBeTruthy();
  });

  // #264：线上 meta 为 object（回归点 48d883d9）——approve/reject 必须同样拿到 cardData 生效
  it('object meta（线上形态）：卡片渲染 + approve 拿到 cardData 分发通用端点', async () => {
    currentMessages = [OBJECT_META_MESSAGE];
    renderPage();
    const btn = await screen.findByText('通过');
    fireEvent.click(btn);

    await waitFor(() => {
      expect(mockApiPost).toHaveBeenCalledWith('/review-proposals/knowledge/kp-1/approve');
    });
    expect(await screen.findByText(/已通过/)).toBeTruthy();
    expect(mockRefresh).toHaveBeenCalled();
  });
});
