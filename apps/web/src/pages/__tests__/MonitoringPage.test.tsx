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
  useNavigate: () => vi.fn(),
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
    // #120 输入缓存命中率 + 段 trim 率（空数据形态，独立加载不阻塞主面板）
    getEfficiency: vi.fn().mockResolvedValue({
      data: {
        windowDays: 30,
        generatedAt: '2026-08-14T00:00:00Z',
        cacheHitRate: {
          description: '', windowDays: 30,
          overall: { cacheReadTokens: 0, inputTokens: 0, hitRatePct: null, events: 0, workUnits: 0 },
          steps: [], byWorkUnit: [], byRole: [], byDay: [],
          coveragePct: 0, source: 'insufficient-data',
        },
        sectionTrim: {
          description: '', windowDays: 30,
          bySection: [],
          totals: { trimEvents: 0, totalOriginalTokens: 0, totalTrimmedTokens: 0 },
          source: 'insufficient-data',
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

// 手动任务（健康巡检按钮 + 成本小字）
vi.mock('../../api/maintenance', () => ({
  maintenanceApi: {
    getCosts: vi.fn().mockResolvedValue({ days: 30, byTrigger: {}, bySource: {} }),
    fireTrigger: vi.fn(),
    runKnowledgeMaintenance: vi.fn(),
  },
}));

// #180 事件检索 Tab 数据源（GET /events）
const { mockEventSearch } = vi.hoisted(() => ({ mockEventSearch: vi.fn() }));
vi.mock('../../api/events', () => ({
  eventsApi: { search: mockEventSearch },
}));

// #184「需要处理」区：桩件隔离（其数据加载契约见组件自身测试）
vi.mock('../../components/monitoring/NeedsAttentionSection', () => ({
  NeedsAttentionSection: () => React.createElement('div', null, '需要处理'),
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

  // ── #180 事件检索 Tab（#60 决策 Q3a：概览 / 事件检索） ──

  it('渲染「概览 / 事件检索」Tab，默认概览', async () => {
    render(<MonitoringPage />);
    expect(screen.getByText('概览')).toBeDefined();
    expect(screen.getByText('事件检索')).toBeDefined();
    expect(await screen.findByText('WorkUnit 状态分布')).toBeDefined();
    // 默认不触发事件检索
    expect(mockEventSearch).not.toHaveBeenCalled();
  });

  it('切到事件检索 Tab 显示检索表单', async () => {
    render(<MonitoringPage />);
    fireEvent.click(screen.getByText('事件检索'));
    expect(await screen.findByPlaceholderText('关键词（可选）')).toBeDefined();
    expect(screen.getByPlaceholderText('类型（可选），如 workunit:failed')).toBeDefined();
    expect(screen.getByText('查询')).toBeDefined();
  });

  it('查询：带 level/type/keyword/until 调 eventsApi.search 并渲染结果', async () => {
    mockEventSearch.mockResolvedValue({
      data: {
        events: [
          { type: 'workunit:failed', source: 'agent-loop', level: 'warning', payload: JSON.stringify({ blockReason: 'Verify FAILED: tsc' }), createdAt: '2026-08-15T10:00:00.000Z' },
        ],
        total: 1,
        nextCursor: null,
      },
    });
    render(<MonitoringPage />);
    fireEvent.click(screen.getByText('事件检索'));

    fireEvent.change(screen.getByPlaceholderText('关键词（可选）'), { target: { value: 'tsc' } });
    fireEvent.change(screen.getByPlaceholderText('类型（可选），如 workunit:failed'), { target: { value: 'workunit:failed' } });
    fireEvent.change(screen.getByLabelText('截止时间（可选）'), { target: { value: '2026-08-16T00:00' } });
    fireEvent.click(screen.getByText('查询'));

    await waitFor(() => {
      expect(mockEventSearch).toHaveBeenCalledWith(expect.objectContaining({
        level: 'info',
        type: 'workunit:failed',
        keyword: 'tsc',
        until: new Date('2026-08-16T00:00').toISOString(),
      }));
    });
    expect(await screen.findByText('workunit:failed')).toBeDefined();
    expect(screen.getByText('警告')).toBeDefined();
    expect(screen.getByText(/Verify FAILED: tsc/)).toBeDefined();
    // nextCursor null → 无「加载更多」
    expect(screen.queryByText('加载更多')).toBeNull();
  });

  it('加载更多：带 nextCursor 续翻并追加结果', async () => {
    mockEventSearch
      .mockResolvedValueOnce({
        data: {
          events: [{ type: 'a', source: 's', payload: '{}', createdAt: '2026-08-15T10:00:00.000Z' }],
          total: 1,
          nextCursor: '1234',
        },
      })
      .mockResolvedValueOnce({
        data: {
          events: [{ type: 'b', source: 's', payload: '{}', createdAt: '2026-08-15T09:00:00.000Z' }],
          total: 1,
          nextCursor: null,
        },
      });
    render(<MonitoringPage />);
    fireEvent.click(screen.getByText('事件检索'));
    fireEvent.click(screen.getByText('查询'));

    expect(await screen.findByText('a')).toBeDefined();
    fireEvent.click(screen.getByText('加载更多'));

    await waitFor(() => {
      expect(mockEventSearch).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: '1234' }));
    });
    expect(await screen.findByText('b')).toBeDefined();
    expect(screen.getByText('a')).toBeDefined(); // 第一页结果保留
  });

  it('查询失败显示错误提示', async () => {
    mockEventSearch.mockRejectedValue(new Error('boom'));
    render(<MonitoringPage />);
    fireEvent.click(screen.getByText('事件检索'));
    fireEvent.click(screen.getByText('查询'));
    expect(await screen.findByText(/查询失败/)).toBeDefined();
  });

  // ── #184 概览 Tab 顶部「需要处理」区（#62 D4：首屏回答"有没有事需要我管"） ──

  it('概览 Tab 顶部出现「需要处理」区（位于 WorkUnit 状态分布之前）', async () => {
    render(<MonitoringPage />);
    const needsAttention = await screen.findByText('需要处理');
    const firstSection = await screen.findByText('WorkUnit 状态分布');
    expect(needsAttention.compareDocumentPosition(firstSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
