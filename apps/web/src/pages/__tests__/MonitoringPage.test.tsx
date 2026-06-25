// Contract test: MonitoringPage — MVP-6
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
    getStats: vi.fn().mockResolvedValue({
      data: {
        workunits: { total: 10, unassigned: 3, active: 2, in_review: 1, done: 3, blocked: 1, closed: 0 },
        agents: { total: 4, idle: 2, active: 1, terminated: 1 },
        recent: { completedLast24h: 5, failedLast24h: 1 },
      },
    }),
  },
}));

import { MonitoringPage } from '../MonitoringPage';

describe('MonitoringPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders page title', () => {
    render(<MonitoringPage />);
    expect(screen.getByText('监控')).toBeDefined();
  });

  it('renders section headers', async () => {
    render(<MonitoringPage />);
    expect(await screen.findByText('WorkUnit 状态分布')).toBeDefined();
    expect(screen.getByText('Agent 状态')).toBeDefined();
    expect(screen.getByText('最近 24 小时')).toBeDefined();
  });

  it('displays stat values', async () => {
    render(<MonitoringPage />);
    expect(await screen.findByText('10')).toBeDefined(); // total workunits
  });
});
