// ChannelDetailPage — #277（决策 #248 D2/D6）：5 分钟同作者连续消息合并（省略重复头）。
// 规则：同作者（authorType + agentName）、≤5min、同线程/主流内、未参与折叠；
// 系统播报与卡片不参与合并也不被合并；日期分隔线切断合并。折叠三机制语义不动。
// vc8（2026-09-16 走查反转）：折叠组/回复链内同作者相邻也合并（一个头像 + 多条消息，
// ChannelStreamBody 渲染层计算，不改 deriveStreamView 折叠语义）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const { mockSendMessage, mockListWorkunits, mockListReqs, mockApiGet, mockOnEvent } = vi.hoisted(() => ({
  mockSendMessage: vi.fn(),
  mockListWorkunits: vi.fn(),
  mockListReqs: vi.fn(),
  mockApiGet: vi.fn(),
  mockOnEvent: vi.fn(),
}));

vi.mock('../../api', () => ({ api: { get: mockApiGet } }));

vi.mock('../../hooks/useChannelEvents', () => ({
  useChannelMessages: () => ({
    messages: currentMessages,
    loading: false,
    hasMore: false,
    sendMessage: mockSendMessage,
    loadMore: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock('../../api/workunit', () => ({ workunitApi: { list: mockListWorkunits } }));
vi.mock('../../api/requirements', () => ({ requirementApi: { list: mockListReqs } }));
vi.mock('../../api/websocketHooks', () => ({ useWebSocketContext: () => ({ onEvent: mockOnEvent, onReconnect: () => () => {} }) }));

vi.mock('../../components/channel/ChannelRail', () => ({ ChannelRail: () => <div data-testid="channel-rail" /> }));
// #394：右栏「频道动态」——与本测试无关，隔离其 chain/PMO/agent API 依赖
vi.mock('../../components/channel/ChannelActivityRail', () => ({ ChannelActivityRail: () => null }));
vi.mock('../../components/channel/WorkUnitDrawer', () => ({ WorkUnitDrawer: () => null }));
vi.mock('../../components/channel/ChannelMemberManager', () => ({ ChannelMemberManager: () => null }));
vi.mock('../../components/channel/ChannelDefaultProjectSelect', () => ({ ChannelDefaultProjectSelect: () => null }));
vi.mock('../../components/channel/ChannelCurrentPmoChip', () => ({ ChannelCurrentPmoChip: () => null }));
vi.mock('../../components/channel/ChannelInput', () => ({ ChannelInput: () => null }));
vi.mock('../../components/channel/RequirementsDocCard', () => ({ RequirementsDocCard: () => null }));
vi.mock('../../components/channel/KnowledgeConfirmCard', () => ({ KnowledgeConfirmCard: () => null }));
vi.mock('../../components/channel/ConvertToTaskDialog', () => ({ ConvertToTaskDialog: () => null }));

import { ChannelDetailPage } from '../ChannelDetailPage';
import type { ChannelMessage } from '../../api/channel';

const t0 = new Date('2026-08-19T10:00:00.000Z').getTime();
const iso = (offsetMin: number) => new Date(t0 + offsetMin * 60000).toISOString();

const msg = (id: string, over: Partial<ChannelMessage>): ChannelMessage => ({
  id, channelId: 'ch-1', authorType: 'agent', agentName: 'pm',
  content: `内容-${id}`, replyToId: null, meta: '{}', createdAt: iso(0), ...over,
});

let currentMessages: ChannelMessage[] = [];

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/channels/ch-1']}>
      <Routes>
        <Route path="/channels/:id" element={<ChannelDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );

const rootOf = (container: HTMLElement, id: string) =>
  container.querySelector(`[data-message-id="${id}"]`) as HTMLElement;

const hasHead = (container: HTMLElement, id: string) =>
  rootOf(container, id).querySelector('.mc-msg-head') !== null;

describe('ChannelDetailPage — 连续消息合并（#277 D2）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 折叠状态按频道持久化（Step 3）——防跨用例 localStorage 泄漏
    window.localStorage.clear();
    currentMessages = [];
    mockApiGet.mockResolvedValue({ data: { data: { id: 'ch-1', name: 'rnd', type: 'rnd', members: '[]' } } });
    mockListWorkunits.mockResolvedValue({ data: { data: [] } });
    mockListReqs.mockResolvedValue({ data: { data: [] } });
    mockOnEvent.mockImplementation(() => () => {});
    mockSendMessage.mockResolvedValue({});
  });

  it('同作者 5 分钟内连续消息：后一条省略头；跨作者不合并', async () => {
    currentMessages = [
      msg('a1', { authorType: 'human', agentName: undefined, createdAt: iso(0) }),
      msg('a2', { authorType: 'human', agentName: undefined, createdAt: iso(2) }),
      msg('a3', { createdAt: iso(3) }), // agent pm — 换作者
      msg('a4', { createdAt: iso(4) }), // 同 agent 1min → 合并
    ];
    const { container } = renderPage();
    await waitFor(() => expect(screen.getByText('内容-a4')).toBeTruthy());
    expect(hasHead(container, 'a1')).toBe(true);
    expect(hasHead(container, 'a2')).toBe(false);
    expect(hasHead(container, 'a3')).toBe(true);
    expect(hasHead(container, 'a4')).toBe(false);
  });

  it('超过 5 分钟不合并', async () => {
    currentMessages = [
      msg('b1', { createdAt: iso(0) }),
      msg('b2', { createdAt: iso(6) }),
    ];
    const { container } = renderPage();
    await waitFor(() => expect(screen.getByText('内容-b2')).toBeTruthy());
    expect(hasHead(container, 'b2')).toBe(true);
  });

  it('同 agent 名不同名不合并', async () => {
    currentMessages = [
      msg('c1', { agentName: 'pm', createdAt: iso(0) }),
      msg('c2', { agentName: 'coder', createdAt: iso(1) }),
    ];
    const { container } = renderPage();
    await waitFor(() => expect(screen.getByText('内容-c2')).toBeTruthy());
    expect(hasHead(container, 'c2')).toBe(true);
  });

  it('系统播报不参与合并：播报后的同作者消息仍带头', async () => {
    currentMessages = [
      msg('d1', { agentName: 'Studio', createdAt: iso(0) }),
      msg('d2', { agentName: 'Studio', createdAt: iso(1) }),
      msg('d3', { createdAt: iso(2) }),
      msg('d4', { agentName: 'Studio', createdAt: iso(3) }),
      msg('d5', { createdAt: iso(4) }), // 前一条是系统播报 → 不合并
    ];
    const { container } = renderPage();
    await waitFor(() => expect(screen.getByText('内容-d5')).toBeTruthy());
    expect(rootOf(container, 'd1').classList.contains('mc-msg-system')).toBe(true);
    expect(rootOf(container, 'd2').classList.contains('mc-msg-system')).toBe(true);
    expect(hasHead(container, 'd3')).toBe(true); // 前一条是系统播报
    expect(hasHead(container, 'd5')).toBe(true);
  });

  it('卡片消息不参与合并：卡片后同作者消息仍带头', async () => {
    currentMessages = [
      msg('e1', { createdAt: iso(0) }),
      msg('e2', {
        createdAt: iso(1),
        meta: {
          cardType: 'knowledge_proposal',
          status: 'ready',
          cardData: { entries: [{ id: 'k-1', title: 't', type: 'pitfall' }] },
        },
      }),
      msg('e3', { createdAt: iso(2) }),
    ];
    const { container } = renderPage();
    await waitFor(() => expect(screen.getByText('内容-e3')).toBeTruthy());
    expect(hasHead(container, 'e3')).toBe(true);
  });

  it('线程内同作者连续回复合并；线程首条回复不并入锚点', async () => {
    currentMessages = [
      msg('f1', { workUnitId: 'WU-9', createdAt: iso(0) }), // 线程锚点
      msg('f2', { workUnitId: 'WU-9', replyToId: 'f1', createdAt: iso(1) }),
      msg('f3', { workUnitId: 'WU-9', replyToId: 'f1', createdAt: iso(2) }),
    ];
    const { container } = renderPage();
    // 线程默认展开（折叠层级 4→2）：回复直接可见
    await waitFor(() => expect(screen.getByText('内容-f3')).toBeTruthy());
    expect(hasHead(container, 'f2')).toBe(true); // 线程首条回复不并入主流锚点
    expect(hasHead(container, 'f3')).toBe(false);
  });

  // vc8（2026-09-16 走查决策反转）：折叠组内同作者连续消息改合并——一个头像 + 多条消息，
  // 与主流 #277 D2 口径一致（原「组内不合并各自带头」是每条印一遍头像的噪音源）
  it('过程消息折叠组内同作者连续合并：展开后一个作者块只留一个头', async () => {
    currentMessages = [
      msg('g1', { workUnitId: 'WU-8', createdAt: iso(0) }),
      ...[2, 3, 4, 5].map(i => msg(`g${i}`, { workUnitId: 'WU-8', replyToId: 'g1', createdAt: iso(i - 1) })),
      msg('g6', { workUnitId: 'WU-8', replyToId: 'g1', createdAt: iso(5) }), // 末条里程碑
    ];
    const { container } = renderPage();
    // 线程默认展开：过程组保持一层折叠（默认收拢）
    await waitFor(() => expect(screen.getByText('▸ 4 条过程消息 · @pm')).toBeTruthy());
    fireEvent.click(screen.getByText('▸ 4 条过程消息 · @pm'));
    await waitFor(() => expect(screen.getByText('内容-g3')).toBeTruthy());
    expect(hasHead(container, 'g2')).toBe(true); // 组内首条留头
    for (const id of ['g3', 'g4', 'g5']) {
      expect(hasHead(container, id)).toBe(false); // 同作者连续 → 省略重复头
    }
    // 链式合并的紧随结论消息（同作者）：展开时紧跟组内过程消息，同样省略头
    expect(hasHead(container, 'g6')).toBe(false);
  });
});
