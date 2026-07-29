// Contract test: MonitoringPage — MVP-6
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
    getOverview: vi.fn().mockResolvedValue({
      data: {
        evidence: {
          engaged: 6, l1Approved: 5, l2Approved: 4, l3Approved: 2,
          selfReviewCount: 1, needsHuman: 3, derivedMismatch: 0,
          derivedByColumn: { done: 3, in_review: 2, active: 1 },
        },
      },
    }),
  },
}));

// 审核闭环：待审列表数据源（GET /knowledge-service/entries?maturity=draft）+ approve 走 /promote
const { mockListPendingReview, mockPromote } = vi.hoisted(() => ({
  mockListPendingReview: vi.fn(),
  mockPromote: vi.fn(),
}));
vi.mock('../../api/knowledge', () => ({
  knowledgeApi: { listPendingReview: mockListPendingReview, promote: mockPromote, demote: vi.fn() },
}));

import { MonitoringPage } from '../MonitoringPage';

describe('MonitoringPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListPendingReview.mockResolvedValue({
      data: {
        entries: [
          { id: 'k-1', title: 'session 过期未刷新导致 401', type: 'pitfall', maturity: 'draft', created: new Date(Date.now() - 2 * 3600_000).toISOString() },
          { id: 'k-2', title: '登录流程统一走 auth-service', type: 'guideline', maturity: 'draft', created: new Date(Date.now() - 26 * 3600_000).toISOString() },
        ],
        total: 2,
      },
    });
    mockPromote.mockResolvedValue({ data: { success: true } });
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

  it('renders F6 证据台账 block（信任分层 + 双轨偏差）', async () => {
    render(<MonitoringPage />);
    expect(await screen.findByText('证据台账（信任分层）')).toBeDefined();
    expect(screen.getByText('L1 自动验证')).toBeDefined();
    expect(screen.getByText('L2 agent 评审')).toBeDefined();
    expect(screen.getByText('L3 人工确认')).toBeDefined();
    expect(screen.getByText('待人工确认')).toBeDefined();
    expect(screen.getByText('双轨偏差')).toBeDefined();
    expect(screen.getByText('自评（L2）')).toBeDefined();
    expect(screen.getByText('6')).toBeDefined(); // engaged（已介入 WU，页面唯一）
  });

  // ── 审核闭环：待审区从纯计数升级为列表（标题/年龄/approve） ──

  it('renders 待审提案列表：标题 + 年龄 + approve 按钮', async () => {
    render(<MonitoringPage />);
    expect(await screen.findByText('知识提案待审')).toBeDefined();
    expect(await screen.findByText('session 过期未刷新导致 401')).toBeDefined();
    expect(screen.getByText('登录流程统一走 auth-service')).toBeDefined();
    // 年龄（2 小时前 / 1 天前）
    expect(screen.getByText(/2 小时前/)).toBeDefined();
    expect(screen.getByText(/1 天前/)).toBeDefined();
    // 每行一个 approve 按钮
    expect(screen.getAllByText('通过').length).toBe(2);
  });

  it('approve → 调 /promote 并把该条目移出列表', async () => {
    render(<MonitoringPage />);
    const buttons = await screen.findAllByText('通过');
    fireEvent.click(buttons[0]);
    await waitFor(() => {
      expect(mockPromote).toHaveBeenCalledWith('k-1');
    });
    await waitFor(() => {
      expect(screen.queryByText('session 过期未刷新导致 401')).toBeNull();
    });
    expect(screen.getByText('登录流程统一走 auth-service')).toBeDefined();
  });
});
