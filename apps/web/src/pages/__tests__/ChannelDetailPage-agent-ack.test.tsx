// #493：线程回复「已送达，等待 agent 响应」即时反馈——
// 线程回复送达且命中 WU（workUnitId 继承成功 = 会触达 agent）→ composer 上方出轻量状态条；
// 顶层消息 / 未命中 WU 的回复不出；该 WU 的 agent 新消息到达即清除。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const { mockApiGet, mockSendMessage } = vi.hoisted(() => ({
  mockApiGet: vi.fn(),
  mockSendMessage: vi.fn(),
}));

vi.mock('../../api', () => ({ api: { get: mockApiGet } }));

let currentMessages: ChannelMessage[] = [];
vi.mock('../../hooks/useChannelEvents', () => ({
  useChannelMessages: () => ({
    messages: currentMessages,
    loading: false,
    hasMore: false,
    sendMessage: mockSendMessage,
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
// 捕获 onSend 直驱 handleSend（ChannelInput 本体不渲染，仅出占位节点供 AC6 结构断言）
let capturedOnSend: ((content: string, replyToId?: string) => Promise<void>) | null = null;
vi.mock('../../components/channel/ChannelInput', () => ({
  ChannelInput: (props: { onSend: (content: string, replyToId?: string) => Promise<void> }) => {
    capturedOnSend = props.onSend;
    return <div data-testid="channel-input" />;
  },
}));
vi.mock('../../components/channel/RequirementsDocCard', () => ({ RequirementsDocCard: () => null }));
vi.mock('../../components/channel/KnowledgeConfirmCard', () => ({ KnowledgeConfirmCard: () => null }));
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

const tree = () => (
  <MemoryRouter initialEntries={['/channels/ch-1']}>
    <Routes>
      <Route path="/channels/:id" element={<ChannelDetailPage />} />
    </Routes>
  </MemoryRouter>
);

const ACK_TEXT = /已送达，等待 agent 响应/;

describe('#493: 线程回复「已送达/等待 agent」即时反馈', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedOnSend = null;
    currentMessages = [msg('t-1', 1, { workUnitId: 'WU-1' })];
    mockApiGet.mockResolvedValue({ data: { data: null } });
    mockSendMessage.mockResolvedValue({
      id: 'h-1', channelId: 'ch-1', authorType: 'human', content: '收到',
      replyToId: 't-1', workUnitId: 'WU-1', createdAt: new Date().toISOString(),
    });
  });

  it('线程回复送达且命中 WU → 出「已送达，等待 agent 响应」状态条', async () => {
    render(tree());
    await act(async () => { await capturedOnSend!('收到', 't-1'); });
    expect(screen.getByText(ACK_TEXT)).toBeTruthy();
  });

  // channel 上下游优化 Phase 4（AC6）：ack 条归组进 .mc-composer-stack，按序位于输入条之前
  it('AC6：ack 条在 composer-stack 容器内且位于输入条之前（ack → input）', async () => {
    render(tree());
    await act(async () => { await capturedOnSend!('收到', 't-1'); });
    const ack = screen.getByText(ACK_TEXT).closest('.mc-agent-ack')!;
    const stack = document.querySelector('.mc-composer-stack')!;
    expect(stack).not.toBeNull();
    expect(stack.contains(ack)).toBe(true);
    expect(ack.compareDocumentPosition(screen.getByTestId('channel-input')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('顶层消息（非回复）不出状态条', async () => {
    render(tree());
    await act(async () => { await capturedOnSend!('新话题'); });
    expect(screen.queryByText(ACK_TEXT)).toBeNull();
  });

  it('回复未命中 WU（workUnitId 为 null，如父消息已归档降级）不出状态条', async () => {
    mockSendMessage.mockResolvedValue({
      id: 'h-2', channelId: 'ch-1', authorType: 'human', content: '收到',
      replyToId: 't-1', workUnitId: null, createdAt: new Date().toISOString(),
    });
    render(tree());
    await act(async () => { await capturedOnSend!('收到', 't-1'); });
    expect(screen.queryByText(ACK_TEXT)).toBeNull();
  });

  it('该 WU 的 agent 新消息到达 → 状态条清除', async () => {
    const { rerender } = render(tree());
    await act(async () => { await capturedOnSend!('收到', 't-1'); });
    expect(screen.getByText(ACK_TEXT)).toBeTruthy();

    currentMessages = [
      ...currentMessages,
      msg('a-9', 2, { workUnitId: 'WU-1', createdAt: new Date().toISOString() }),
    ];
    rerender(tree());
    expect(screen.queryByText(ACK_TEXT)).toBeNull();
  });

  it('无关 WU 的 agent 消息到达 → 状态条不清除', async () => {
    const { rerender } = render(tree());
    await act(async () => { await capturedOnSend!('收到', 't-1'); });
    expect(screen.getByText(ACK_TEXT)).toBeTruthy();

    currentMessages = [
      ...currentMessages,
      msg('a-8', 2, { workUnitId: 'WU-OTHER', createdAt: new Date().toISOString() }),
    ];
    rerender(tree());
    expect(screen.getByText(ACK_TEXT)).toBeTruthy();
  });
});
