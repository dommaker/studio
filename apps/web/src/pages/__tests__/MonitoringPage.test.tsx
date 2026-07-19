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
    getFlywheel: vi.fn().mockResolvedValue({
      data: {
        quality: 42, hitRate: 67, improvement: 10, freshness: 80,
        source: 'events',
        proposalsPendingReview: 3,
        extraction: { count30d: 2, totalTokens30d: 1500 },
        windowDays: 30,
        timestamp: '2026-07-19T00:00:00Z',
      },
    }),
    getOverhead: vi.fn().mockResolvedValue({
      data: {
        windowDays: 30, executions: 4, workUnits: 3,
        avgInjectedTokens: 800, injectedBudget: 2000, injectedBudgetUsedPct: 40,
        avgExecutionTokens: 20000, executionCoveragePct: 100,
        avgOverheadRatio: 0.025, overheadBudget: 0.2,
        extractionTokens: 1500,
        source: 'events',
        timestamp: '2026-07-19T00:00:00Z',
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

  it('renders M1 飞轮指标 block with real values', async () => {
    render(<MonitoringPage />);
    expect(await screen.findByText('飞轮指标')).toBeDefined();
    expect(screen.getByText('67%')).toBeDefined(); // hitRate
    expect(screen.getByText('+10pp')).toBeDefined(); // improvement
    expect(screen.getByText('proposal 待审')).toBeDefined();
  });

  it('renders M2 封装开销 block with threshold-colored values', async () => {
    render(<MonitoringPage />);
    expect(await screen.findByText('封装开销')).toBeDefined();
    expect(screen.getByText('800')).toBeDefined(); // avgInjectedTokens
    expect(screen.getByText('40%')).toBeDefined(); // injectedBudgetUsedPct
    expect(screen.getByText('2.5%')).toBeDefined(); // avgOverheadRatio
  });
});
