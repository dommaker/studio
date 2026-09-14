// ChannelDetailPage — channel 上下游优化 Phase 3（AC5，docs/plans/2026-09-channel-upstream-downstream-ux.md）：
// 消息级键盘导航——j 下一条 / k 上一条（.mc-msg-focused 焦点环）、r 起回复（replyTo 预览 + 输入框聚焦）、
// Esc 优先取消 replyTo 其次清焦点；输入框聚焦时 j/k/r 不劫持（Esc 仍生效取消回复）。
// jsdom 全量渲染（#325 seam），不依赖真实滚动，断言 focused 类与状态。
// mock 搭建复用 ChannelDetailPage-alert-group.test.tsx 的接缝。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const { mockSendMessage, mockListWorkunits, mockListReqs, mockApiGet, mockOnEvent, mockRefresh } = vi.hoisted(() => ({
  mockSendMessage: vi.fn(),
  mockListWorkunits: vi.fn(),
  mockListReqs: vi.fn(),
  mockApiGet: vi.fn(),
  mockOnEvent: vi.fn(),
  mockRefresh: vi.fn(),
}));

vi.mock('../../api', () => ({
  api: { get: mockApiGet },
}));

vi.mock('../../hooks/useChannelEvents', () => ({
  useChannelMessages: () => ({
    messages: currentMessages,
    loading: false,
    error: null,
    hasMore: false,
    sendMessage: mockSendMessage,
    loadMore: vi.fn(),
    refresh: mockRefresh,
  }),
}));

vi.mock('../../api/workunit', () => ({ workunitApi: { list: mockListWorkunits } }));
vi.mock('../../api/requirements', () => ({ requirementApi: { list: mockListReqs } }));
vi.mock('../../api/websocketHooks', () => ({
  useWebSocketContext: () => ({ onEvent: mockOnEvent, onReconnect: () => () => {} }),
}));

vi.mock('../../components/channel/ChannelRail', () => ({ ChannelRail: () => <div data-testid="channel-rail" /> }));
vi.mock('../../components/channel/WorkUnitDrawer', () => ({ WorkUnitDrawer: () => null }));
vi.mock('../../components/channel/ChannelMemberManager', () => ({ ChannelMemberManager: () => null }));
vi.mock('../../components/channel/ChannelDefaultProjectSelect', () => ({ ChannelDefaultProjectSelect: () => null }));
vi.mock('../../components/channel/ChannelCurrentPmoChip', () => ({ ChannelCurrentPmoChip: () => null }));
vi.mock('../../components/channel/ChannelActivityRail', () => ({ ChannelActivityRail: () => null }));
vi.mock('../../components/channel/RequirementsDocCard', () => ({ RequirementsDocCard: () => null }));
vi.mock('../../components/channel/KnowledgeConfirmCard', () => ({ KnowledgeConfirmCard: () => null }));
vi.mock('../../components/channel/ConvertToTaskDialog', () => ({ ConvertToTaskDialog: () => null }));

// ChannelInput 装配断言缝：真实 textarea（焦点断言 + editable 守卫）+ replyTo 预览条
vi.mock('../../components/channel/ChannelInput', () => ({
  ChannelInput: (props: { replyTo?: { id: string } | null; onCancelReply?: () => void }) => (
    <div className="mc-inputbar">
      {props.replyTo && (
        <div data-testid="reply-preview">
          回复 {props.replyTo.id}
          <button type="button" aria-label="取消回复" onClick={props.onCancelReply}>✕</button>
        </div>
      )}
      <textarea data-testid="composer" />
    </div>
  ),
}));

import { ChannelDetailPage } from '../ChannelDetailPage';
import { useNotificationStore } from '../../stores/notificationStore';
import type { ChannelMessage } from '../../api/channel';

const now = Date.now();
const iso = (offsetMin: number) => new Date(now + offsetMin * 60000).toISOString();

const msg = (id: string, offsetMin: number, over: Partial<ChannelMessage> = {}): ChannelMessage => ({
  id, channelId: 'ch-1', authorType: 'agent' as const, agentName: 'dev-agent',
  content: `消息-${id}`, workUnitId: null, replyToId: null,
  meta: '{}', createdAt: iso(offsetMin), ...over,
});

const alert = (id: string, offsetMin: number): ChannelMessage =>
  msg(id, offsetMin, { agentName: 'Studio', content: `[WARNING] **[Monitor]** 告警-${id}` });

let currentMessages: ChannelMessage[] = [];

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/channels/ch-1']}>
      <Routes>
        <Route path="/channels/:id" element={<ChannelDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );

const focusedEl = () => document.querySelector('.mc-msg-focused');
const key = (k: string, target: EventTarget = document.body) =>
  fireEvent.keyDown(target, { key: k });

describe('ChannelDetailPage — 消息级键盘导航（Phase 3 / AC5）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    currentMessages = [msg('m1', 0), msg('m2', 1), msg('m3', 2)];
    useNotificationStore.setState({ stateItems: [], notifications: [], unreadCount: 0 });
    mockApiGet.mockResolvedValue({ data: { data: { id: 'ch-1', name: 'rnd-主研发', type: 'rnd', members: '[]' } } });
    mockListWorkunits.mockResolvedValue({ data: { data: [] } });
    mockListReqs.mockResolvedValue({ data: { data: [] } });
    mockOnEvent.mockImplementation(() => () => {});
    mockSendMessage.mockResolvedValue({});
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('j/k 移动焦点环：j 依次向下，k 回上一条', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('消息-m3')).toBeTruthy());

    key('j');
    expect(focusedEl()?.getAttribute('data-message-id')).toBe('m1');
    key('j');
    expect(focusedEl()?.getAttribute('data-message-id')).toBe('m2');
    key('j');
    expect(focusedEl()?.getAttribute('data-message-id')).toBe('m3');
    key('j'); // 末条停住不环绕
    expect(focusedEl()?.getAttribute('data-message-id')).toBe('m3');
    key('k');
    expect(focusedEl()?.getAttribute('data-message-id')).toBe('m2');
  });

  it('折叠的告警组整组跳过（焦点从组前直接到组后）', async () => {
    currentMessages = [msg('m1', 0), alert('al1', 1), alert('al2', 2), alert('al3', 3), msg('m2', 4)];
    renderPage();
    await waitFor(() => expect(document.querySelector('.mc-alert-group-summary')).not.toBeNull());

    key('j');
    expect(focusedEl()?.getAttribute('data-message-id')).toBe('m1');
    key('j');
    expect(focusedEl()?.getAttribute('data-message-id')).toBe('m2');
  });

  it('r 对焦点消息起回复：replyTo 预览条出现 + 输入框聚焦', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('消息-m2')).toBeTruthy());

    key('j');
    key('j'); // 焦点 m2
    key('r');
    await waitFor(() => expect(screen.getByTestId('reply-preview').textContent).toContain('m2'));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('composer')));
  });

  it('Esc 优先取消 replyTo（输入框聚焦时也生效）；无 replyTo 时清焦点', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('消息-m2')).toBeTruthy());

    key('j'); // 焦点 m1
    key('r');
    await waitFor(() => expect(screen.getByTestId('reply-preview')).toBeTruthy());
    const composer = screen.getByTestId('composer');
    await waitFor(() => expect(document.activeElement).toBe(composer));

    // 输入框聚焦下 Esc → 取消回复（焦点保留）
    key('Escape', composer);
    await waitFor(() => expect(screen.queryByTestId('reply-preview')).toBeNull());
    expect(focusedEl()?.getAttribute('data-message-id')).toBe('m1');

    // 再无 replyTo → Esc 清焦点环
    key('Escape');
    expect(focusedEl()).toBeNull();
  });

  it('输入框聚焦时 j/k/r 不触发导航（不劫持文本输入）', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('消息-m1')).toBeTruthy());
    const composer = screen.getByTestId('composer');
    (composer as HTMLElement).focus();

    key('j', composer);
    key('k', composer);
    key('r', composer);
    expect(focusedEl()).toBeNull();
    expect(screen.queryByTestId('reply-preview')).toBeNull();
  });
});
