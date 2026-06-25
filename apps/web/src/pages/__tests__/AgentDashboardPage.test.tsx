// Contract test: AgentDashboardPage — MVP-2 + MVP-5
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return { ...actual, default: actual };
});

vi.mock('react-router-dom', () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => React.createElement('a', { href: to }, children),
}));

vi.mock('../../api/monitoring', () => ({
  monitoringApi: {
    getAgentSummary: vi.fn().mockResolvedValue({
      data: {
        agents: [],
        summary: { total: 0, idle: 0, active: 0, terminated: 0 },
      },
    }),
  },
}));

vi.mock('../../api/index', () => ({
  api: { post: vi.fn().mockResolvedValue({}) },
}));

import { AgentDashboardPage } from '../../pages/AgentDashboardPage';

describe('AgentDashboardPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders page title', () => {
    render(<AgentDashboardPage />);
    expect(screen.getByText('Agent Dashboard')).toBeDefined();
  });

  it('shows empty state when no agents', async () => {
    render(<AgentDashboardPage />);
    expect(await screen.findByText('暂无运行中的 Agent')).toBeDefined();
  });

  it('renders refresh button', () => {
    render(<AgentDashboardPage />);
    expect(screen.getByText('刷新')).toBeDefined();
  });
});
