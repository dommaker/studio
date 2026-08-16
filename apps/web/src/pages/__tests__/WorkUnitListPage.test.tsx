// Contract test: WorkUnitListPage — MVP-1 + MVP-3 + MVP-4
// #106 M7：analysis 确认弹窗（预填待决问题清单 → summary 随 reviewPassed 回传）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return { ...actual, default: actual };
});

vi.mock('react-router-dom', () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => React.createElement('a', { href: to }, children),
  useNavigate: () => vi.fn(),
}));

const mockStore = {
  workunits: [] as Array<Record<string, unknown>>,
  reviewPassed: vi.fn(),
  reviewRejected: vi.fn(),
  loadWorkUnits: vi.fn(),
  createWorkUnit: vi.fn(),
  setStatusFilter: vi.fn(),
};

vi.mock('../../stores/workunitStore', () => ({
  useWorkUnitStore: Object.assign(
    () => ({
      workunits: mockStore.workunits,
      total: mockStore.workunits.length,
      loading: false,
      error: null,
      statusFilter: null,
      loadWorkUnits: mockStore.loadWorkUnits,
      createWorkUnit: mockStore.createWorkUnit,
      reviewPassed: mockStore.reviewPassed,
      reviewRejected: mockStore.reviewRejected,
      setStatusFilter: mockStore.setStatusFilter,
    }),
    { getState: vi.fn().mockReturnValue({ workunits: [], total: 0, loading: false, error: null, loadWorkUnits: vi.fn() }) }
  ),
}));

// WU 事件 hook（SSE）— 测试无 WebSocketProvider，置空
vi.mock('../../hooks/useWorkUnitEvents', () => ({
  useWorkUnitEvents: () => {},
}));

import { WorkUnitListPage } from '../WorkUnitListPage';

function makeWu(overrides: Record<string, unknown>) {
  return {
    id: 'wu-1',
    scope: '分析需求 PMO-1: 测试',
    type: 'analysis',
    status: 'in_review',
    metadata: null,
    channelId: null,
    assigneeId: null,
    reqId: null,
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-01T00:00:00Z',
    completedAt: null,
    claimedAt: null,
    retryCount: 0,
    failureType: null,
    ...overrides,
  };
}

describe('WorkUnitListPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.workunits = [];
  });

  it('renders page title', () => {
    render(<WorkUnitListPage />);
    expect(screen.getByText('WorkUnit')).toBeDefined();
  });

  it('renders create toggle button', () => {
    render(<WorkUnitListPage />);
    expect(screen.getByText('+ 新建')).toBeDefined();
  });

  it('shows empty state when no workunits', () => {
    render(<WorkUnitListPage />);
    expect(screen.getByText('暂无 WorkUnit')).toBeDefined();
  });
});

describe('WorkUnitListPage — analysis 确认弹窗（#106 M7）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.workunits = [];
  });

  it('analysis 点通过 → 弹窗预填 metadata 里的待决问题清单；编辑后确认 → summary 回传', () => {
    mockStore.workunits = [makeWu({
      id: 'wu-a1',
      metadata: JSON.stringify({
        analysisDestination: '三仓特性联动上线',
        analysisFog: ['存储选型用哪个？', '部署形态先单机还是分布式？'],
      }),
    })];
    render(<WorkUnitListPage />);

    fireEvent.click(screen.getByText('通过'));

    // 预填 = DESTINATION:/FOG: 逐行还原（map-opening 契约格式）
    const textarea = screen.getByPlaceholderText(/DESTINATION/) as HTMLTextAreaElement;
    expect(textarea.value).toBe(
      'DESTINATION: 三仓特性联动上线\nFOG: 存储选型用哪个？\nFOG: 部署形态先单机还是分布式？',
    );

    // 人审改：删掉一条雾
    fireEvent.change(textarea, { target: { value: 'FOG: 存储选型用哪个？' } });
    fireEvent.click(screen.getByText('确认通过'));

    expect(mockStore.reviewPassed).toHaveBeenCalledWith('wu-a1', 'FOG: 存储选型用哪个？', undefined);
  });

  it('analysis 无清单 metadata → 弹窗空文本（空手填或直接通过 = 非探路型）', () => {
    mockStore.workunits = [makeWu({ id: 'wu-a2' })];
    render(<WorkUnitListPage />);

    fireEvent.click(screen.getByText('通过'));
    const textarea = screen.getByPlaceholderText(/DESTINATION/) as HTMLTextAreaElement;
    expect(textarea.value).toBe('');

    fireEvent.click(screen.getByText('确认通过'));
    expect(mockStore.reviewPassed).toHaveBeenCalledWith('wu-a2', '', undefined);
  });

  it('非 analysis（task）点通过 → 不开弹窗，直接调 reviewPassed（回归）', () => {
    mockStore.workunits = [makeWu({ id: 'wu-t1', type: 'task', scope: '实现登录' })];
    render(<WorkUnitListPage />);

    fireEvent.click(screen.getByText('通过'));

    expect(screen.queryByPlaceholderText(/DESTINATION/)).toBeNull();
    expect(mockStore.reviewPassed).toHaveBeenCalledWith('wu-t1', undefined, undefined);
  });
});
