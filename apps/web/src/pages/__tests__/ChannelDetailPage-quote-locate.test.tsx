// ChannelDetailPage — channel 上下游优化 Phase 1（AC1/AC4 定位部分，docs/plans/2026-09-channel-upstream-downstream-ux.md）：
// 页面抽通用 locateMessage(mid)（?highlight effect 改调它）；quote 引用块与 reply 预览条点击 → 定位高亮上游消息，
// 掉出已加载分页 → 翻页定位循环，翻到底 → toast 兜底。
// #548：手写有状态 mock（lastExternal 哨兵 + 手写翻页）已删——改播种 channelMessageStore 初态 +
// 真实 store action 取数（底层 channelApi → api 走本文件既有 mock，按 URL 分派）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const { mockListWorkunits, mockListReqs, mockApiGet, mockApiPost, mockOnEvent } = vi.hoisted(() => ({
  mockListWorkunits: vi.fn(),
  mockListReqs: vi.fn(),
  mockApiGet: vi.fn(),
  mockApiPost: vi.fn(),
  mockOnEvent: vi.fn(),
}));

vi.mock('../../api', () => ({
  api: { get: mockApiGet, post: mockApiPost },
}));

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
import { useChannelMessageStore } from '../../stores/channelMessageStore';
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

// #548：播种 store 初态（loaded=true，等同首拉已完成；挂载首拉合并空页 = 无操作）
function seedMessages(messages: ChannelMessage[], opts: { hasMore?: boolean } = {}) {
  useChannelMessageStore.setState(st => ({
    channels: {
      ...st.channels,
      'ch-1': { messages, hasMore: opts.hasMore ?? false, loading: false, error: null, loaded: true },
    },
  }));
}

/** api.get 按 URL 分派：messages（messagesImpl 可定制翻页；缺省空页）/ 其余 = 频道记录 */
function installApiGet(messagesImpl?: (before?: string) => unknown) {
  mockApiGet.mockImplementation((url: string, config?: { params?: { before?: string } }) => {
    if (String(url).endsWith('/messages')) {
      const result = messagesImpl
        ? messagesImpl(config?.params?.before)
        : { data: { data: [], hasMore: false, total: 0 } };
      return Promise.resolve(result);
    }
    return Promise.resolve({ data: { data: { id: 'ch-1', name: 'rnd-主研发', type: 'rnd', members: '[]' } } });
  });
}

/** 翻页调用 = messages GET 带 before 游标（首拉/refetch 不带） */
const pagingCalls = () =>
  mockApiGet.mock.calls.filter(c => String(c[0]).endsWith('/messages')
    && ((c[1] as { params?: { before?: string } } | undefined)?.params?.before));

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
    useChannelMessageStore.getState().__resetForTests();
    seedMessages(BASE_MESSAGES);
    previewTargetId = 'm-parent';
    // toast.dismiss() 是 200ms 动画后异步移除——有残留时等其落定，防跨用例 toast 文本污染断言
    toast.dismiss();
    if (document.getElementById('toast-container')?.childElementCount) {
      await new Promise(r => setTimeout(r, 250));
    }
    useNotificationStore.setState({ stateItems: [], notifications: [], unreadCount: 0 });
    mockApiPost.mockResolvedValue({ data: { success: true } });
    installApiGet();
    mockListWorkunits.mockResolvedValue({ data: { data: [] } });
    mockListReqs.mockResolvedValue({ data: { data: [] } });
    mockOnEvent.mockImplementation(() => () => {});
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
    expect(pagingCalls()).toHaveLength(0);
    expect(document.getElementById('toast-container')?.textContent ?? '').not.toContain('无法定位');
  });

  it('AC4：reply 预览条点击已加载目标 → 直接高亮，不翻页', async () => {
    seedMessages(BASE_MESSAGES, { hasMore: true });
    renderPage();
    await waitFor(() => expect(screen.getByText('#rnd-主研发')).toBeTruthy());

    fireEvent.click(screen.getByTestId('reply-preview-jump')); // previewTargetId = m-parent（已加载）

    await waitFor(() => {
      expect(document.querySelector('[data-message-id="m-parent"]')?.className).toContain('mc-msg-highlight');
    });
    expect(pagingCalls()).toHaveLength(0);
  });

  it('AC4：目标掉出已加载分页 → 沿翻页游标加载所在页后定位高亮', async () => {
    const oldMsg: ChannelMessage = {
      id: 'm-target', channelId: 'ch-1', authorType: 'agent' as const, agentName: 'pm-agent',
      content: '更早的上游消息', workUnitId: null, replyToId: null,
      meta: '{}', createdAt: iso(-50),
    };
    previewTargetId = 'm-target';
    seedMessages(BASE_MESSAGES, { hasMore: true });
    // 翻一页：before=最老消息 m-parent → 返回含目标的历史页并到底
    installApiGet((before) => before === 'm-parent'
      ? { data: { data: [oldMsg], hasMore: false, total: 1 } }
      : { data: { data: [], hasMore: true, total: 0 } });

    renderPage();
    await waitFor(() => expect(screen.getByText('#rnd-主研发')).toBeTruthy());
    fireEvent.click(screen.getByTestId('reply-preview-jump'));

    await waitFor(() => {
      expect(document.querySelector('[data-message-id="m-target"]')?.className).toContain('mc-msg-highlight');
    });
    expect(pagingCalls()).toHaveLength(1);
    expect(document.getElementById('toast-container')?.textContent ?? '').not.toContain('无法定位');
  });

  it('AC4：翻页到底仍无目标 → toast 可见反馈，不静默', async () => {
    previewTargetId = 'm-ghost';
    seedMessages(BASE_MESSAGES, { hasMore: true });
    // 翻一页后到底（空页 + hasMore=false），目标始终不存在
    installApiGet((before) => before
      ? { data: { data: [], hasMore: false, total: 0 } }
      : { data: { data: [], hasMore: true, total: 0 } });

    renderPage();
    await waitFor(() => expect(screen.getByText('#rnd-主研发')).toBeTruthy());
    fireEvent.click(screen.getByTestId('reply-preview-jump'));

    await waitFor(() => {
      expect(document.getElementById('toast-container')?.textContent).toContain('无法定位');
    });
    expect(pagingCalls()).toHaveLength(1);
  });

  // Phase 2（AC2）：多层线程 t-root → t-mid → t-leaf。t-root 无 WU——归组泛化后被回复即成 anchor；
  // 定位深层回复时 replyToId（t-mid）不是线程根，必须先解析根 anchor 再展开，否则线程仍收起、高亮不可见
  it('Phase 2：定位埋在多层线程里的消息 → 展开根线程 + 高亮目标', async () => {
    seedMessages([
      {
        id: 't-root', channelId: 'ch-1', authorType: 'agent' as const, agentName: 'pm-agent',
        content: '线程根：发布计划', workUnitId: null, replyToId: null,
        meta: '{}', createdAt: iso(0),
      },
      {
        id: 't-mid', channelId: 'ch-1', authorType: 'human' as const,
        content: '中层回复：同意', workUnitId: null, replyToId: 't-root',
        meta: '{}', createdAt: iso(1),
      },
      {
        id: 't-leaf', channelId: 'ch-1', authorType: 'agent' as const, agentName: 'pm-agent',
        content: '深层回复：定在周五', workUnitId: null, replyToId: 't-mid',
        meta: '{}', createdAt: iso(2),
      },
    ]);
    previewTargetId = 't-leaf';

    renderPage();
    // 线程默认展开：t-root 成 anchor（无 WU），多层回复拍平 → 「▾ 收起回复」在根上
    await waitFor(() => expect(screen.getByText('深层回复：定在周五')).toBeTruthy());
    fireEvent.click(screen.getByText('▾ 收起回复'));
    expect(screen.queryByText('深层回复：定在周五')).toBeNull();
    expect(screen.getByText('▸ 2 条回复')).toBeTruthy();

    // 定位深层回复 → 根线程重新展开 + 目标高亮
    fireEvent.click(screen.getByTestId('reply-preview-jump'));
    await waitFor(() => {
      const el = document.querySelector('[data-message-id="t-leaf"]');
      expect(el?.className).toContain('mc-msg-highlight');
    });
    expect(screen.getByText('深层回复：定在周五')).toBeTruthy(); // 线程已展开，目标可见
    expect(pagingCalls()).toHaveLength(0);
  });
});
