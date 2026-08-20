// ChannelDetailPage — #278（决策 #250 D2）：auditor_suggestion / retract_confirm 死按钮接线
// 契约：auditor_apply_* → POST /channels/:id/messages/:mid/card-decision {decision}；
//       retract_* → POST /skills/:skillId/retract/decide {decision, messageId}。成功后 refresh()。
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
vi.mock('../../components/channel/ChannelDefaultProjectSelect', () => ({ ChannelDefaultProjectSelect: () => null }));
vi.mock('../../components/channel/ChannelCurrentPmoChip', () => ({ ChannelCurrentPmoChip: () => null }));
vi.mock('../../components/channel/ChannelInput', () => ({ ChannelInput: () => null }));
// 其他卡片与本测试无关；AuditorSuggestionCard / KnowledgeConfirmCard 用真实组件（其 API 已 mock）
vi.mock('../../components/channel/RequirementsDocCard', () => ({ RequirementsDocCard: () => null }));
vi.mock('../../components/channel/KnowledgeProposalCard', () => ({ KnowledgeProposalCard: () => null }));
vi.mock('../../components/channel/MemoryProposalCard', () => ({ MemoryProposalCard: () => null }));
vi.mock('../../components/channel/DistillProposalCard', () => ({ DistillProposalCard: () => null }));
vi.mock('../../components/channel/ConvertToTaskDialog', () => ({ ConvertToTaskDialog: () => null }));

import { ChannelDetailPage } from '../ChannelDetailPage';

const MESSAGES = [
  {
    id: 'msg-aud-1', channelId: 'ch-sys', authorType: 'agent' as const, agentName: 'Auditor',
    content: '审计建议 — 1 条', workUnitId: null, replyToId: null,
    meta: JSON.stringify({
      cardType: 'auditor_suggestion',
      status: 'ready',
      cardData: {
        suggestions: [
          { type: 'param_tuning', risk: 'low', agentType: 'developer', detail: '调低重试上限到 2' },
        ],
      },
    }),
    createdAt: new Date().toISOString(),
  },
  {
    id: 'msg-rc-1', channelId: 'ch-sys', authorType: 'agent' as const, agentName: 'KK',
    content: '撤回确认: Skill legacy-x', workUnitId: null, replyToId: null,
    meta: JSON.stringify({
      cardType: 'retract_confirm',
      status: 'ready',
      cardData: { skillId: 'skill-1', skillName: 'legacy-x' },
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

describe('ChannelDetailPage — #278 auditor_suggestion / retract_confirm 接线', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiGet.mockResolvedValue({ data: { data: { id: 'ch-sys', name: '系统', type: 'system', members: '[]' } } });
    mockApiPost.mockResolvedValue({ data: { success: true, data: { status: 'confirmed' } } });
    mockListWorkunits.mockResolvedValue({ data: { data: [] } });
    mockListReqs.mockResolvedValue({ data: { data: [] } });
  });

  it('auditor 采纳 → POST card-decision {decision:confirm} + refresh', async () => {
    renderPage();
    fireEvent.click(await screen.findByText('确认执行'));

    await waitFor(() => {
      expect(mockApiPost).toHaveBeenCalledWith(
        '/channels/ch-sys/messages/msg-aud-1/card-decision',
        { decision: 'confirm' },
      );
    });
    expect(mockRefresh).toHaveBeenCalled();
  });

  it('auditor 拒绝 → POST card-decision {decision:reject}', async () => {
    renderPage();
    const auditorCard = (await screen.findByText('审计建议 — 待确认')).closest('.mc-card')!;
    fireEvent.click(auditorCard.querySelectorAll('button')[1]);

    await waitFor(() => {
      expect(mockApiPost).toHaveBeenCalledWith(
        '/channels/ch-sys/messages/msg-aud-1/card-decision',
        { decision: 'reject' },
      );
    });
  });

  it('retract 确认废弃 → POST /skills/:id/retract/decide {decision:confirm, messageId}', async () => {
    renderPage();
    fireEvent.click(await screen.findByText('确认废弃'));

    await waitFor(() => {
      expect(mockApiPost).toHaveBeenCalledWith(
        '/skills/skill-1/retract/decide',
        { decision: 'confirm', messageId: 'msg-rc-1' },
      );
    });
    expect(mockRefresh).toHaveBeenCalled();
  });

  it('retract 拒绝 → POST /skills/:id/retract/decide {decision:reject}', async () => {
    renderPage();
    const retractCard = (await screen.findByText('撤回确认')).closest('.mc-card')!;
    fireEvent.click(retractCard.querySelectorAll('button')[1]);

    await waitFor(() => {
      expect(mockApiPost).toHaveBeenCalledWith(
        '/skills/skill-1/retract/decide',
        { decision: 'reject', messageId: 'msg-rc-1' },
      );
    });
  });
});
