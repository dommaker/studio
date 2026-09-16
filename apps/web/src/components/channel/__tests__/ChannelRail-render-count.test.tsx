// ChannelRail — F4 渲染边界 render-count 测试（频道行 memo + per-channel unread selector）：
// ① 他频道 unread 变化只重渲对应行（其余行零重渲，以 formatChannelName 调用计数为探针）；
// ② 父级无关重渲（展开/收起新建表单）时 props 稳定的频道行 memo 零重渲。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { mockUseChannelList, mockNavigate, mockOnEvent, fmtCalls } = vi.hoisted(() => ({
  mockUseChannelList: vi.fn(),
  mockNavigate: vi.fn(),
  mockOnEvent: vi.fn(),
  fmtCalls: [] as string[],
}));

vi.mock('../../../hooks/useChannelList', () => ({
  useChannelList: () => mockUseChannelList(),
}));

vi.mock('../../../api/websocketHooks', () => ({
  useWebSocketContext: () => ({ onEvent: mockOnEvent, status: 'disconnected' }),
}));

vi.mock('../../../api/monitoring', () => ({
  monitoringApi: { getAgentSummary: vi.fn().mockResolvedValue({ data: { agents: [], summary: {} } }) },
}));

// CreateChannelForm 加载本地工程发现候选——单测置空；rosterStore 其余端点本套件不关心
vi.mock('../../../api/channel', () => ({
  channelApi: {
    discoverProjects: vi.fn().mockResolvedValue({ data: { success: true, data: [] } }),
    listAllAgents: vi.fn().mockRejectedValue(new Error('not mocked here')),
    list: vi.fn().mockRejectedValue(new Error('not mocked here')),
  },
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

// 探针：频道行每次渲染必调 formatChannelName（实现本体放行，行为不变）
vi.mock('@dommaker/studio-shared/web', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@dommaker/studio-shared/web')>();
  return {
    ...mod,
    formatChannelName: (name: string) => {
      fmtCalls.push(name);
      return mod.formatChannelName(name);
    },
  };
});

import { ChannelRail } from '../ChannelRail';
import { useRosterStore } from '../../../stores/rosterStore';
import { useUnreadStore } from '../../../stores/unreadStore';

const CHANNELS = [
  { id: 'ch-1', name: 'rnd-主研发', type: 'rnd' },
  { id: 'ch-2', name: 'decision-架构决策', type: 'decision' },
];

const callsFor = (name: string) => fmtCalls.filter(n => n === name).length;

describe('ChannelRail — F4 渲染边界', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fmtCalls.length = 0;
    useRosterStore.setState({
      profiles: [], agents: [], channels: [],
      loading: false, error: null, forbidden: false,
      loadedAt: null, channelsLoadedOnce: true, agentsLoadedOnce: true,
      inflight: null, lastToken: null,
    });
    useUnreadStore.setState({ unreadCounts: {}, activeChannelId: null });
    mockUseChannelList.mockReturnValue({
      channels: CHANNELS, loading: false,
      clearUnread: vi.fn(), createChannel: vi.fn(),
    });
  });

  const renderRail = () =>
    render(
      <MemoryRouter>
        <ChannelRail activeChannelId="ch-1" />
      </MemoryRouter>,
    );

  it('他频道 unread 变化 → 只重渲对应行，其余频道行零重渲', () => {
    renderRail();
    expect(callsFor('rnd-主研发')).toBe(1);
    expect(callsFor('decision-架构决策')).toBe(1);

    // ch-2 来一条 agent 消息（非 active 频道）→ unread 0→1
    act(() => useUnreadStore.getState().applyMessageSent('ch-2', 'agent'));

    // 对应行更新：badge 出现
    const ch2Row = screen.getByText('decision-架构决策').closest('button')!;
    expect(ch2Row.textContent).toContain('1');
    // 只重渲 ch-2 行；ch-1 行零重渲
    expect(callsFor('decision-架构决策')).toBe(2);
    expect(callsFor('rnd-主研发')).toBe(1);
  });

  it('父级无关重渲（展开新建表单）→ props 稳定的频道行 memo 零重渲', () => {
    renderRail();
    expect(fmtCalls).toHaveLength(2);

    fireEvent.click(screen.getByText('+ 新频道'));
    expect(screen.getByLabelText('频道名称')).toBeTruthy(); // 父级确实重渲（表单出现）

    // 频道行 props 全稳定 → memo 零重渲
    expect(fmtCalls).toHaveLength(2);
  });
});
