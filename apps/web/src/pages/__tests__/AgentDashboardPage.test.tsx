// Contract test: AgentDashboardPage — 角色（profile）中心视图（2026-07 频道角色修复）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return { ...actual, default: actual };
});

const { mockListAllAgents, mockGetAgentSummary, mockNavigate } = vi.hoisted(() => ({
  mockListAllAgents: vi.fn(),
  mockGetAgentSummary: vi.fn(),
  mockNavigate: vi.fn(),
}));

vi.mock('react-router-dom', () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => React.createElement('a', { href: to }, children),
  useNavigate: () => mockNavigate,
}));

vi.mock('../../api/monitoring', () => ({
  monitoringApi: { getAgentSummary: mockGetAgentSummary },
}));

vi.mock('../../api/channel', () => ({
  channelApi: { listAllAgents: mockListAllAgents },
}));

vi.mock('../../api/index', () => ({
  api: { post: vi.fn().mockResolvedValue({}) },
}));

import { AgentDashboardPage } from '../../pages/AgentDashboardPage';

describe('AgentDashboardPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListAllAgents.mockResolvedValue({ data: { data: [] } });
    mockGetAgentSummary.mockResolvedValue({
      data: { agents: [], summary: { total: 0, idle: 0, active: 0, error: 0, terminated: 0 } },
    });
  });

  it('renders page title', async () => {
    render(<AgentDashboardPage />);
    expect(await screen.findByText('Agent 管理')).toBeDefined();
  });

  it('shows empty state when no roles', async () => {
    render(<AgentDashboardPage />);
    expect(await screen.findByText('暂无角色')).toBeDefined();
  });

  it('renders refresh + create-role buttons', () => {
    render(<AgentDashboardPage />);
    expect(screen.getByText('刷新')).toBeDefined();
    expect(screen.getByText('创建角色')).toBeDefined();
  });

  it('merges profile provider + runtime status per role', async () => {
    mockListAllAgents.mockResolvedValue({
      data: {
        data: [
          { id: 'p1', name: 'dev-agent', description: 'writes code', status: 'active', provider: 'claude', isOnline: true },
        ],
      },
    });
    mockGetAgentSummary.mockResolvedValue({
      data: {
        agents: [
          { id: 'i1', roleId: 'p1', name: 'dev-agent', status: 'active', currentWorkUnitId: 'wu-12345678', startedAt: new Date().toISOString() },
        ],
        summary: { total: 1, idle: 0, active: 1, error: 0, terminated: 0 },
      },
    });
    render(<AgentDashboardPage />);
    expect(await screen.findByText('dev-agent')).toBeDefined();
    expect(screen.getByText('CLI: claude')).toBeDefined();
    // “执行中”同时出现在统计条与卡片 badge，多处出现即合理
    expect(screen.getAllByText('执行中').length).toBeGreaterThan(0);
  });
});
