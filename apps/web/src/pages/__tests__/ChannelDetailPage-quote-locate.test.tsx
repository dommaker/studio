// ChannelDetailPage — channel 上下游优化 Phase 1（AC1/AC4 定位部分，docs/plans/2026-09-channel-upstream-downstream-ux.md）：
// 页面抽通用 locateMessage(mid)（?highlight effect 改调它）；quote 引用块与 reply 预览条点击 → 定位高亮上游消息，
// 掉出已加载分页 → 翻页定位循环，翻到底 → toast 兜底。mock 搭建复用 ChannelDetailPage.test.tsx 的接缝
// （useChannelMessages 自持 messages/hasMore 状态，loadMore(setMsgs, setMore) 驱动翻页）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const { mockSendMessage, mockListWorkunits, mockListReqs, mockApiGet, mockApiPost, mockOnEvent, mockRefresh } = vi.hoisted(() => ({
  mockSendMessage: vi.fn(),
  mockListWorkunits: vi.fn(),
  mockListReqs: vi.fn(),
  mockApiGet: vi.fn(),
  mockApiPost: vi.fn(),
  mockOnEvent: vi.fn(),
  mockRefresh: vi.fn(),
}));

vi.mock('../../api', () => ({
  api: { get: mockApiGet, post: mockApiPost },
}));

vi.mock('../../hooks/useChannelEvents', async () => {
  const { useState, useRef } = await import('react');
  return {
    useChannelMessages: () => {
      // #439 同款接缝：mock 自持 messages/hasMore 状态——loadMore 翻页（prepend 历史页/到底）
      // 能驱动页面重渲染，供「目标掉出已加载分页」用例走通翻页定位循环
      const [msgs, setMsgs] = useState(currentMessages);
      const [more, setMore] = useState(currentHasMore);
      const lastExternal = useRef(currentMessages);
      if (lastExternal.current !== currentMessages) {
        lastExternal.current = currentMessages;
        setMsgs(currentMessages);
      }
      return {
        messages: msgs,
        loading: false,
        error: null,
        hasMore: more,
        sendMessage: mockSendMessage,
        loadMore: () => mockLoadMore(setMsgs, setMore),
        refresh: mockRefresh,
      };
    },
  };
});

vi.mock('../../api/workunit', () => ({ workunitApi: { list: mockListWorkunits } }));
vi.mock('../../api/requirements', () => ({ requirementApi: { list: mockListReqs } }));
vi.mock('../../api/websocketHooks', () => ({
  useWebSocketContext: () => ({ onEvent: mockOnEvent, onReconnect: () => () => {} }),
}));

// 与本测试无关的子组件：保留接口，隔离其内部 API 依赖
vi.mock('../../components/channel/ChannelRail', () => ({ ChannelRail: () => <div data-testid="channel-rail" /> }));
vi.mock('../../components/channel/WorkUnitDrawer', () => ({ WorkUnitDrawer: () => null }));
vi.mock('../../components/channel/ChannelMemberManager', () => ({ ChannelMemberManager: () => null }));
vi.mock('../../components/channel/ChannelDefaultProjectSelect', () => ({ ChannelDefaultProjectSelect: () => null }));
vi.mock('../../components/channel/ChannelCurrentPmoChip', () => ({ ChannelCurrentPmoChip: () => null }));
vi.mock('../../components/channel/ChannelActivityRail', () => ({ ChannelActivityRail: () => null }));

vi.mock('../../components/channel/ChannelInput', () => ({
  // AC4 装配断言缝：透出 onReplyPreviewClick，点击即以 previewTargetId 调它
  // （replyTo 本体展示/取消的组件级行为在 ChannelInput-reply-preview.test.tsx 覆盖）
  ChannelInput: (props: { onReplyPreviewClick?: (messageId: string) => void }) => (
    <div data-testid="channel-input">
      <button type="button" data-testid="reply-preview-jump" onClick={() => props.onReplyPreviewClick?.(previewTargetId)}>
        reply-preview
      </button>
    </div>
  ),
}));

vi.mock('../../components/channel/RequirementsDocCard', () => ({ RequirementsDocCard: () => null }));
vi.mock('../../components/channel/KnowledgeConfirmCard', () => ({ KnowledgeConfirmCard: () => null }));
vi.mock('../../components/channel/ConvertToTaskDialog', () => ({ ConvertToTaskDialog: () => null }));

import { ChannelDetailPage } from '../ChannelDetailPage';
import { useNotificationStore } from '../../stores/notificationStore';
import { toast } from '../../utils/toast';
import type { ChannelMessage } from '../../api/channel';

const now = Date.now();
const iso = (offsetMin: number) => new Date(now + offsetMin * 60000).toISOString();

const BASE_MESSAGES: ChannelMessage[] = [
  {
    id: 'm-parent', channelId: 'ch-1', authorType: 'agent' as const, agentName: 'pm-agent',
    content: '上游结论：用方案 A', workUnitId: null, replyToId: null,
    meta: '{}', createdAt: iso(0),
  },
  {
    id: 'm-reply', channelId: 'ch-1', authorType: 'human' as const,
    content: '同意，就这么办', workUnitId: null, replyToId: 'm-parent',
    meta: '{}', createdAt: iso(1),
  },
];

// useChannelEvents mock 的当前消息集 / hasMore 初值 / loadMore spy（同 ChannelDetailPage.test.tsx 契约）
let currentMessages: ChannelMessage[] = BASE_MESSAGES;
let currentHasMore = false;
const mockLoadMore = vi.fn();

// AC4：ChannelInput mock 点击预览条时上送的消息 id（用例设定）
let previewTargetId = 'm-parent';

const renderPage = (entry = '/channels/ch-1') =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/channels/:id" element={<ChannelDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );

describe('ChannelDetailPage — quote/reply 预览点击定位上游消息（Phase 1 / AC1/AC4）', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    window.localStorage.clear();
    currentMessages = BASE_MESSAGES;
    currentHasMore = false;
    previewTargetId = 'm-parent';
    // toast.dismiss() 是 200ms 动画后异步移除——有残留时等其落定，防跨用例 toast 文本污染断言
    toast.dismiss();
    if (document.getElementById('toast-container')?.childElementCount) {
      await new Promise(r => setTimeout(r, 250));
    }
    useNotificationStore.setState({ stateItems: [], notifications: [], unreadCount: 0 });
    mockApiPost.mockResolvedValue({ data: { success: true } });
    mockApiGet.mockResolvedValue({ data: { data: { id: 'ch-1', name: 'rnd-主研发', type: 'rnd', members: '[]' } } });
    mockListWorkunits.mockResolvedValue({ data: { data: [] } });
    mockListReqs.mockResolvedValue({ data: { data: [] } });
    mockOnEvent.mockImplementation(() => () => {});
    mockSendMessage.mockResolvedValue({});
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('AC1：点击 quote 引用块 → 定位高亮被引用的上游消息（已加载）', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('#rnd-主研发')).toBeTruthy());

    const quote = document.querySelector('[data-message-id="m-reply"] .mc-quote');
    expect(quote?.tagName).toBe('BUTTON');
    fireEvent.click(quote!);

    await waitFor(() => {
      expect(document.querySelector('[data-message-id="m-parent"]')?.className).toContain('mc-msg-highlight');
    });
    // 已加载直接定位，不翻页、无降级反馈
    expect(mockLoadMore).not.toHaveBeenCalled();
    expect(document.getElementById('toast-container')?.textContent ?? '').not.toContain('无法定位');
  });

  it('AC4：reply 预览条点击已加载目标 → 直接高亮，不翻页', async () => {
    currentHasMore = true;
    renderPage();
    await waitFor(() => expect(screen.getByText('#rnd-主研发')).toBeTruthy());

    fireEvent.click(screen.getByTestId('reply-preview-jump')); // previewTargetId = m-parent（已加载）

    await waitFor(() => {
      expect(document.querySelector('[data-message-id="m-parent"]')?.className).toContain('mc-msg-highlight');
    });
    expect(mockLoadMore).not.toHaveBeenCalled();
  });

  it('AC4：目标掉出已加载分页 → 沿翻页游标加载所在页后定位高亮', async () => {
    const oldMsg: ChannelMessage = {
      id: 'm-target', channelId: 'ch-1', authorType: 'agent' as const, agentName: 'pm-agent',
      content: '更早的上游消息', workUnitId: null, replyToId: null,
      meta: '{}', createdAt: iso(-50),
    };
    previewTargetId = 'm-target';
    currentHasMore = true;
    mockLoadMore.mockImplementation(async (setMsgs: (fn: (prev: ChannelMessage[]) => ChannelMessage[]) => void, setMore: (v: boolean) => void) => {
      setMsgs(prev => [oldMsg, ...prev]);
      setMore(false);
      return true;
    });

    renderPage();
    await waitFor(() => expect(screen.getByText('#rnd-主研发')).toBeTruthy());
    fireEvent.click(screen.getByTestId('reply-preview-jump'));

    await waitFor(() => {
      expect(document.querySelector('[data-message-id="m-target"]')?.className).toContain('mc-msg-highlight');
    });
    expect(mockLoadMore).toHaveBeenCalledTimes(1);
    expect(document.getElementById('toast-container')?.textContent ?? '').not.toContain('无法定位');
  });

  it('AC4：翻页到底仍无目标 → toast 可见反馈，不静默', async () => {
    previewTargetId = 'm-ghost';
    currentHasMore = true;
    // 翻一页后到底（hasMore → false），目标始终不存在
    mockLoadMore.mockImplementation(async (_setMsgs: unknown, setMore: (v: boolean) => void) => {
      setMore(false);
      return true;
    });

    renderPage();
    await waitFor(() => expect(screen.getByText('#rnd-主研发')).toBeTruthy());
    fireEvent.click(screen.getByTestId('reply-preview-jump'));

    await waitFor(() => {
      expect(document.getElementById('toast-container')?.textContent).toContain('无法定位');
    });
    expect(mockLoadMore).toHaveBeenCalledTimes(1);
  });
});
