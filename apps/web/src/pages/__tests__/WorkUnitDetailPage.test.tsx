// Contract test: WorkUnitDetailPage — /workunits/:id 枢纽页（2026-07 agents-pmo-flow-ux §5.4）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return { ...actual, default: actual };
});

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }: { children: React.ReactNode; to: string; [k: string]: unknown }) =>
    React.createElement('a', { href: to, ...rest }, children),
  useParams: () => ({ id: 'wu-1' }),
  useNavigate: () => vi.fn(),
}));

const { mockWuGet, mockReqGet, mockReqGetChain, mockProjectGet, mockChannelList, mockAgentSummary } = vi.hoisted(() => ({
  mockWuGet: vi.fn(),
  mockReqGet: vi.fn(),
  mockReqGetChain: vi.fn(),
  mockProjectGet: vi.fn(),
  mockChannelList: vi.fn(),
  mockAgentSummary: vi.fn(),
}));

vi.mock('../../api/workunit', () => ({
  workunitApi: {
    get: mockWuGet,
    listExecutionStepEvents: vi.fn().mockResolvedValue({ data: { events: [], total: 0 } }),
    getMessages: vi.fn().mockResolvedValue({ data: { data: [] } }),
  },
}));

vi.mock('../../api/requirements', () => ({
  requirementApi: { get: mockReqGet, getChain: mockReqGetChain },
}));

vi.mock('../../api/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/index')>();
  return { ...actual, projectApi: { ...actual.projectApi, get: mockProjectGet } };
});

vi.mock('../../api/channel', () => ({
  channelApi: { list: mockChannelList },
}));

vi.mock('../../api/monitoring', () => ({
  monitoringApi: { getAgentSummary: mockAgentSummary },
}));

// WU 事件 hook（SSE）— 测试无 WebSocketProvider，置空
vi.mock('../../hooks/useWorkUnitEvents', () => ({ useWorkUnitEvents: () => {} }));
vi.mock('../../hooks/useWorkUnitStreamEvents', () => ({ useWorkUnitStreamEvents: () => [] }));

// #174: TranscriptViewer 桩（组件自身契约在 __tests__/TranscriptViewer.test.tsx 覆盖）
vi.mock('../../components/workunit/TranscriptViewer', () => ({
  TranscriptViewer: ({ workUnitId }: { workUnitId: string }) =>
    React.createElement('div', { 'data-testid': 'transcript-viewer' }, workUnitId),
}));

import { WorkUnitDetailPage } from '../WorkUnitDetailPage';

const baseWu = {
  id: 'wu-1',
  parentId: null,
  dependsOn: '',
  type: 'task',
  scope: '实现登录功能',
  assigneeId: 'inst-abcdefgh1234',
  status: 'done',
  failureType: null,
  retryCount: 0,
  timeoutAt: null,
  channelId: 'ch-1',
  reqId: 'REQ-0042',
  metadata: JSON.stringify({
    title: '登录功能开发',
    pmoId: 'proj-1',
    attestations: {
      l1: { verdict: 'approved', by: 'profile-aaa', at: '2026-07-30T10:00:00Z', kind: 'verify' },
      l2: { verdict: 'approved', by: 'profile-bbb', at: '2026-07-30T11:00:00Z', kind: 'agent-review', summary: 'LGTM' },
      l3: { verdict: 'approved', by: 'human-ccc', at: '2026-07-30T12:00:00Z', kind: 'human-confirm' },
    },
  }),
  createdAt: '2026-07-30T09:00:00Z',
  updatedAt: '2026-07-30T12:00:00Z',
  claimedAt: '2026-07-30T09:30:00Z',
  completedAt: '2026-07-30T12:00:00Z',
};

describe('WorkUnitDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWuGet.mockResolvedValue({ data: baseWu });
    mockProjectGet.mockResolvedValue({ data: { id: 'proj-1', pmoNumber: 'PM-0007', title: '登录项目' } });
    mockReqGet.mockResolvedValue({ data: { success: true, data: { id: 'REQ-0042', projectId: 'proj-2' } } });
    mockChannelList.mockResolvedValue({ data: { success: true, data: [{ id: 'ch-1', name: '主频道' }] } });
    mockAgentSummary.mockResolvedValue({
      data: {
        agents: [{ id: 'inst-abcdefgh1234', roleId: 'role-1', name: 'coder-01', status: 'idle', currentWorkUnitId: null, startedAt: '2026-07-30T08:00:00Z' }],
        summary: { total: 1, idle: 1, active: 0, error: 0, terminated: 0 },
      },
    });
    mockReqGetChain.mockResolvedValue({
      data: { success: true, data: { requirement: { id: 'REQ-0042', seq: 42, title: '登录需求', status: 'in-progress', createdAt: '2026-07-29T09:00:00Z', createdBy: 'manual' }, workunits: [] } },
    });
  });

  it('加载态：WU 未返回时显示加载中', () => {
    mockWuGet.mockReturnValue(new Promise(() => {}));
    render(<WorkUnitDetailPage />);
    expect(screen.getByText('加载中...')).toBeDefined();
  });

  it('错误态：加载失败显示错误信息', async () => {
    mockWuGet.mockRejectedValue(new Error('Not Found'));
    render(<WorkUnitDetailPage />);
    expect(await screen.findByText(/加载失败: Not Found/)).toBeDefined();
  });

  it('Header：标题取 metadata.title，含类型 chip / 状态 pill / 时间信息', async () => {
    render(<WorkUnitDetailPage />);
    expect(await screen.findByText('登录功能开发')).toBeDefined();
    expect(screen.getByText('任务')).toBeDefined();
    expect(screen.getByText('已完成')).toBeDefined();
    expect(screen.getByText(/创建 07\/30/)).toBeDefined();
    expect(screen.getByText(/认领/)).toBeDefined();
    expect(screen.getByText(/完成 07\/30/)).toBeDefined();
  });

  it('归属条：四种 chip 全部解析成功时齐备且链接正确', async () => {
    render(<WorkUnitDetailPage />);
    // PMO chip（创建期戳 metadata.pmoId 直查）→ /pmo/project/:id
    const pmoLink = await screen.findByText('PM-0007 · 登录项目');
    expect(pmoLink.closest('a')?.getAttribute('href')).toBe('/pmo/project/proj-1');
    // REQ chip → 打开 RequirementChainPanel（非链接）
    expect(screen.getByText('REQ-0042')).toBeDefined();
    // 频道 chip → /channels/:channelId
    const channelLink = await screen.findByText('# 主频道');
    expect(channelLink.closest('a')?.getAttribute('href')).toBe('/channels/ch-1');
    // 认领 agent chip → /agents/:roleId
    const agentLink = await screen.findByText('@coder-01');
    expect(agentLink.closest('a')?.getAttribute('href')).toBe('/agents/role-1');
  });

  it('PMO 解析回落：metadata 无 pmoId 时经 reqId → requirement.projectId 解析', async () => {
    mockWuGet.mockResolvedValue({
      data: { ...baseWu, metadata: JSON.stringify({ title: '登录功能开发' }) },
    });
    mockProjectGet.mockImplementation((pid: string) =>
      Promise.resolve({ data: { id: pid, pmoNumber: 'PM-0009', title: '回落项目' } }),
    );
    render(<WorkUnitDetailPage />);
    const pmoLink = await screen.findByText('PM-0009 · 回落项目');
    expect(pmoLink.closest('a')?.getAttribute('href')).toBe('/pmo/project/proj-2');
    expect(mockReqGet).toHaveBeenCalledWith('REQ-0042');
    expect(mockProjectGet).toHaveBeenCalledWith('proj-2');
  });

  it('归属条：无 reqId/channelId/assigneeId/PMO 时整条不显示', async () => {
    mockWuGet.mockResolvedValue({
      data: { ...baseWu, reqId: null, channelId: null, assigneeId: null, metadata: '{}' },
    });
    render(<WorkUnitDetailPage />);
    await screen.findByText('实现登录功能'); // scope 兜底标题（metadata 无 title）
    await waitFor(() => expect(mockAgentSummary).not.toHaveBeenCalled());
    expect(screen.queryByText('归属')).toBeNull();
  });

  it('认领 agent 匹配不到：显示 instance id 前 8 位且不可点', async () => {
    mockAgentSummary.mockResolvedValue({
      data: { agents: [], summary: { total: 0, idle: 0, active: 0, error: 0, terminated: 0 } },
    });
    render(<WorkUnitDetailPage />);
    const chip = await screen.findByText('@inst-abc');
    expect(chip.closest('a')).toBeNull();
  });

  it('证据台账：L1/L2/L3 三层徽章与评审结论', async () => {
    render(<WorkUnitDetailPage />);
    expect(await screen.findByText('证据台账')).toBeDefined();
    expect(screen.getByText('L1 自动验证')).toBeDefined();
    expect(screen.getByText('L2 Agent 评审')).toBeDefined();
    expect(screen.getByText('L3 人工验收')).toBeDefined();
    expect(screen.getAllByText('✓ 通过').length).toBe(3);
    expect(screen.getByText('评审结论：LGTM')).toBeDefined();
  });

  it('证据台账：存量 WU（无 attestations）显示未介入说明', async () => {
    mockWuGet.mockResolvedValue({ data: { ...baseWu, metadata: '{}' } });
    render(<WorkUnitDetailPage />);
    expect(await screen.findByText('存量 WU，证据模型未介入（按存储状态展示）')).toBeDefined();
  });

  it('#174: 执行过程 section 之后挂 TranscriptViewer（传 WU id）', async () => {
    render(<WorkUnitDetailPage />);
    await screen.findByText('登录功能开发');
    expect(await screen.findByTestId('transcript-viewer')).toHaveTextContent('wu-1');
  });

  it('REQ chip 点击打开 REQ 全链路弹窗', async () => {
    render(<WorkUnitDetailPage />);
    fireEvent.click(await screen.findByText('REQ-0042'));
    expect(await screen.findByText(/REQ 全链路 · REQ-0042/)).toBeDefined();
    expect(await screen.findByText('登录需求')).toBeDefined();
  });
});
