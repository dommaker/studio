// ChannelDetailPage 滚动行为集成测试 — #290（清单 #22 行锚点补偿 / #27 阅读位置持久化）
// jsdom 无布局：几何属性（getBoundingClientRect / scrollHeight / clientHeight）按
// 「测试接缝」约定在此 stub，断言外部可观察契约（scrollTop 校正量 / localStorage 存档内容）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';

const { mockSendMessage, mockListWorkunits, mockListReqs, mockApiGet, mockOnEvent, mockLoadMore } = vi.hoisted(() => ({
  mockSendMessage: vi.fn(),
  mockListWorkunits: vi.fn(),
  mockListReqs: vi.fn(),
  mockApiGet: vi.fn(),
  mockOnEvent: vi.fn(),
  mockLoadMore: vi.fn(),
}));

vi.mock('../../api', () => ({ api: { get: mockApiGet } }));

vi.mock('../../hooks/useChannelEvents', () => ({
  useChannelMessages: () => ({
    messages: currentMessages,
    loading: false,
    hasMore: currentHasMore,
    sendMessage: mockSendMessage,
    loadMore: mockLoadMore,
    refresh: vi.fn(),
  }),
}));

vi.mock('../../api/workunit', () => ({ workunitApi: { list: mockListWorkunits } }));
vi.mock('../../api/requirements', () => ({ requirementApi: { list: mockListReqs } }));
vi.mock('../../api/websocketHooks', () => ({ useWebSocketContext: () => ({ onEvent: mockOnEvent }) }));
vi.mock('../../components/channel/ChannelRail', () => ({ ChannelRail: () => <div data-testid="channel-rail" /> }));
vi.mock('../../components/channel/WorkUnitDrawer', () => ({ WorkUnitDrawer: () => null }));
vi.mock('../../components/channel/ChannelMemberManager', () => ({ ChannelMemberManager: () => null }));
vi.mock('../../components/channel/ChannelDefaultProjectSelect', () => ({ ChannelDefaultProjectSelect: () => null }));
vi.mock('../../components/channel/ChannelCurrentPmoChip', () => ({ ChannelCurrentPmoChip: () => null }));
vi.mock('../../components/channel/ChannelInput', () => ({ ChannelInput: () => <div data-testid="channel-input" /> }));
vi.mock('../../components/channel/RequirementsDocCard', () => ({ RequirementsDocCard: () => null }));
vi.mock('../../components/channel/KnowledgeConfirmCard', () => ({ KnowledgeConfirmCard: () => null }));
vi.mock('../../components/channel/AuditorSuggestionCard', () => ({ AuditorSuggestionCard: () => null }));
vi.mock('../../components/channel/ConvertToTaskDialog', () => ({ ConvertToTaskDialog: () => null }));

import { ChannelDetailPage } from '../ChannelDetailPage';
import type { ChannelMessage } from '../../api/channel';

const now = Date.now();
const iso = (offsetMin: number) => new Date(now + offsetMin * 60000).toISOString();
const msg = (id: string, offsetMin: number): ChannelMessage => ({
  id, channelId: 'ch-1', authorType: 'agent' as const, agentName: 'pm',
  content: `消息 ${id}`, workUnitId: null, replyToId: null, meta: '{}', createdAt: iso(offsetMin),
});

let currentMessages: ChannelMessage[] = [];
let currentHasMore = false;

const BASE_MESSAGES = [msg('m1', 0), msg('m2', 1), msg('m3', 2)];
const OLDER_MESSAGES = [msg('old1', -2), msg('old2', -1)];

// ── 几何 stub ────────────────────────────────────────────────
// 消息行矩形表（视口相对，容器 top 视为 0）；非消息元素一律 {top:0,bottom:600}
let rectMap: Record<string, { top: number; bottom: number }> = {};
const origGBCR = Element.prototype.getBoundingClientRect;
const scrollHeightDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight');
const clientHeightDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight');

const domRect = (top: number, bottom: number) =>
  ({ top, bottom, left: 0, right: 0, width: 0, height: bottom - top, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;

const streamEl = () => document.querySelector('.mc-stream') as HTMLElement;

let navigateTo: (to: string) => void = () => {};
function NavCapture() {
  navigateTo = useNavigate();
  return null;
}

const renderPage = (entry = '/channels/ch-1') =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <NavCapture />
      <Routes>
        <Route path="/channels/:id" element={<ChannelDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );

/** 模拟读者滚动：写 scrollTop 并派发 scroll（经 observed-top 台账判定为读者滚动） */
const readerScrollTo = (top: number) => {
  const el = streamEl();
  el.scrollTop = top;
  fireEvent.scroll(el);
};

describe('ChannelDetailPage — #290 滚动锚点与阅读位置', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    currentMessages = [...BASE_MESSAGES];
    currentHasMore = false;
    rectMap = { m1: { top: -150, bottom: -10 }, m2: { top: 10, bottom: 90 }, m3: { top: 100, bottom: 220 } };
    mockApiGet.mockResolvedValue({ data: { data: { id: 'ch-1', name: 'rnd-主研发', type: 'rnd', members: '[]' } } });
    mockListWorkunits.mockResolvedValue({ data: { data: [] } });
    mockListReqs.mockResolvedValue({ data: { data: [] } });
    mockOnEvent.mockImplementation(() => () => {});
    mockSendMessage.mockResolvedValue({});
    mockLoadMore.mockResolvedValue(true);
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const mid = this.getAttribute('data-message-id');
      if (mid && rectMap[mid]) return domRect(rectMap[mid].top, rectMap[mid].bottom);
      return domRect(0, 600);
    };
    Object.defineProperty(Element.prototype, 'scrollHeight', {
      configurable: true,
      get(this: Element) { return this.classList?.contains('mc-stream') ? 2000 : 0; },
    });
    Object.defineProperty(Element.prototype, 'clientHeight', {
      configurable: true,
      get(this: Element) { return this.classList?.contains('mc-stream') ? 600 : 0; },
    });
  });

  afterEach(() => {
    Element.prototype.getBoundingClientRect = origGBCR;
    if (scrollHeightDesc) Object.defineProperty(Element.prototype, 'scrollHeight', scrollHeightDesc);
    if (clientHeightDesc) Object.defineProperty(Element.prototype, 'clientHeight', clientHeightDesc);
  });

  // ── #22：加载更早行锚点补偿 ──

  it('#22 prepend 落地后 scrollTop 按锚行位移校正（视口停在原消息行）', async () => {
    currentHasMore = true;
    renderPage();
    await waitFor(() => expect(screen.getByText('加载更早的消息')).toBeTruthy());
    // 初始定位底部（scrollHeight 2000）；模拟读者上翻到 100
    readerScrollTo(100);

    fireEvent.click(screen.getByText('加载更早的消息'));
    await waitFor(() => expect(mockLoadMore).toHaveBeenCalled());
    // prepend 落地：更早消息进入，锚行 m2 被挤到 310（位移 +300）
    currentMessages = [...OLDER_MESSAGES, ...BASE_MESSAGES];
    rectMap = {
      old1: { top: 110, bottom: 190 }, old2: { top: 200, bottom: 300 },
      m1: { top: 150, bottom: 290 }, m2: { top: 310, bottom: 390 }, m3: { top: 400, bottom: 520 },
    };
    // 驱动重渲染让 useLayoutEffect 看到新消息集
    act(() => navigateTo('/channels/ch-1'));

    await waitFor(() => expect(streamEl().scrollTop).toBe(100 + 300));
  });

  it('#22 加载更早失败时锚点被清理，视口不跳', async () => {
    currentHasMore = true;
    mockLoadMore.mockResolvedValue(false); // 失败/无更多：未前插
    renderPage();
    await waitFor(() => expect(screen.getByText('加载更早的消息')).toBeTruthy());
    readerScrollTo(100);

    fireEvent.click(screen.getByText('加载更早的消息'));
    await waitFor(() => expect(mockLoadMore).toHaveBeenCalled());
    // 消息集不变地重渲染：不应有任何补偿写入
    act(() => navigateTo('/channels/ch-1'));
    expect(streamEl().scrollTop).toBe(100);
  });

  // ── #27：阅读位置持久化 ──

  it('#27 切频道时按 channelId 写入阅读位置存档（首个可见行锚点）', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('#rnd-主研发')).toBeTruthy());
    readerScrollTo(100); // 读者上翻，脱离钉底

    act(() => navigateTo('/channels/ch-2'));
    // 存档 = 首个可见行（m1 底部 -10 不可见，m2 底部 90 首个可见）+ 其视口相对 top
    expect(window.localStorage.getItem('studio-channel-reading-pos:ch-1'))
      .toBe(JSON.stringify({ mid: 'm2', top: 10 }));
  });

  it('#27 钉在底部时切频道存 null', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('#rnd-主研发')).toBeTruthy());
    // 不模拟读者滚动：保持钉底

    act(() => navigateTo('/channels/ch-2'));
    expect(window.localStorage.getItem('studio-channel-reading-pos:ch-1')).toBe('null');
  });

  it('#27 回到频道时有存档恢复锚行（scrollTop 按位移校正），并浮出「回到底部」', async () => {
    window.localStorage.setItem('studio-channel-reading-pos:ch-1', JSON.stringify({ mid: 'm2', top: 10 }));
    // 存档时 m2 在 top=10；如今它被挤到 310 → 恢复后 scrollTop = 0 + (310-10)
    rectMap.m2 = { top: 310, bottom: 390 };
    renderPage();
    await waitFor(() => expect(streamEl().scrollTop).toBe(300));
    await waitFor(() => expect(screen.getByText('↓ 回到底部')).toBeTruthy());
  });

  it('#27 无存档时定位底部', async () => {
    renderPage();
    await waitFor(() => expect(streamEl().scrollTop).toBe(2000));
  });

  it('#27 钉底存档（null）定位底部', async () => {
    window.localStorage.setItem('studio-channel-reading-pos:ch-1', 'null');
    renderPage();
    await waitFor(() => expect(streamEl().scrollTop).toBe(2000));
  });
});
