// #326 骨架占位行渲染：degraded 消息（含 thread anchor）渲染为固定占位行，
// 保留 data-message-id（锚点捕获/阅读位置仍可按 mid 定位），正文不渲染。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const { mockApiGet } = vi.hoisted(() => ({ mockApiGet: vi.fn() }));

vi.mock('../../api', () => ({ api: { get: mockApiGet } }));

let currentMessages: ChannelMessage[] = [];
vi.mock('../../hooks/useChannelEvents', () => ({
  useChannelMessages: () => ({
    messages: currentMessages,
    loading: false,
    hasMore: false,
    sendMessage: vi.fn(),
    loadMore: vi.fn(),
    refresh: vi.fn(),
    syncPruning: vi.fn(),
  }),
}));

vi.mock('../../api/workunit', () => ({ workunitApi: { list: vi.fn().mockResolvedValue({ data: { data: [] } }) } }));
vi.mock('../../api/requirements', () => ({ requirementApi: { list: vi.fn().mockResolvedValue({ data: { data: [] } }), get: vi.fn() } }));
vi.mock('../../api/websocketHooks', () => ({
  useWebSocketContext: () => ({ onEvent: vi.fn(() => () => {}), onReconnect: vi.fn(() => () => {}) }),
}));
vi.mock('../../components/channel/ChannelRail', () => ({ ChannelRail: () => <div /> }));
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

const iso = (s: number) => new Date(s * 1000).toISOString();

function msg(id: string, seq: number, over: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id, channelId: 'ch-1', authorType: 'agent', agentName: 'pm',
    content: `正文-${id}`, createdAt: iso(seq), ...over,
  };
}

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/channels/ch-1']}>
      <Routes>
        <Route path="/channels/:id" element={<ChannelDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );

describe('ChannelDetailPage — 骨架占位行（#326）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiGet.mockResolvedValue({ data: { data: null } });
  });

  it('degraded 消息渲染占位行：保留 data-message-id，正文不渲染', () => {
    currentMessages = [
      msg('m-1', 1, { degraded: true, content: '' }),
      msg('m-2', 2),
    ];
    const { container } = renderPage();
    const skeleton = container.querySelector('[data-message-id="m-1"]');
    expect(skeleton).not.toBeNull();
    expect(skeleton!.className).toContain('mc-msg-skeleton');
    expect(screen.queryByText('正文-m-1')).toBeNull();
    expect(screen.getByText('正文-m-2')).toBeTruthy();
  });

  it('thread anchor degraded → 整个线程项渲染为占位行', () => {
    currentMessages = [
      msg('t-1', 1, { workUnitId: 'WU-1', degraded: true, content: '' }),
      msg('t-2', 2, { replyToId: 't-1' }),
    ];
    const { container } = renderPage();
    expect(container.querySelector('[data-message-id="t-1"]')?.className).toContain('mc-msg-skeleton');
    // 骨架锚点的回复不渲染（随锚点水合后整体恢复）
    expect(screen.queryByText('正文-t-2')).toBeNull();
  });

  it('骨架保留的 meta status 仍计入已完成折叠（completedCount 不失真）', () => {
    currentMessages = [
      ...[1, 2, 3].map(i => msg(`d-${i}`, i, { degraded: true, content: '', meta: { status: 'done' }, workUnitId: `WU-d${i}` })),
      msg('a-1', 4),
    ];
    renderPage();
    // 3 条已完成骨架：默认折叠只留最近 2 条，toggle 文案 = 3-2=1
    expect(screen.getByText(/显示 1 条已完成消息/)).toBeTruthy();
  });
});
