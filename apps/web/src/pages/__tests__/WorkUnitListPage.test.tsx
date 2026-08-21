// Contract test: WorkUnitListPage — MVP-1 + MVP-3 + MVP-4
// #106 M7：analysis 确认弹窗（预填待决问题清单 → summary 随 reviewPassed 回传）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return { ...actual, default: actual };
});

const { mockSearchParamsValue } = vi.hoisted(() => ({ mockSearchParamsValue: { value: '' } }));

vi.mock('react-router-dom', () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => React.createElement('a', { href: to }, children),
  useNavigate: () => vi.fn(),
  useSearchParams: () => [new URLSearchParams(mockSearchParamsValue.value)],
}));

const mockStore = {
  workunits: [] as Array<Record<string, unknown>>,
  reviewPassed: vi.fn(),
  reviewRejected: vi.fn(),
  confirmPending: vi.fn(),
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
      confirmPending: mockStore.confirmPending,
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
    mockSearchParamsValue.value = '';
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

  // #184：监控页「需要处理」下钻链接（/workunits?status=blocked）初始化状态筛选
  it('URL ?status=blocked 初始化状态筛选', () => {
    mockSearchParamsValue.value = 'status=blocked';
    render(<WorkUnitListPage />);
    expect(mockStore.setStatusFilter).toHaveBeenCalledWith('blocked');
  });

  it('无 status query 时不触碰筛选', () => {
    render(<WorkUnitListPage />);
    expect(mockStore.setStatusFilter).not.toHaveBeenCalled();
  });
});

// #280：统计条口径覆盖（总数反映列表条数 + pending 单列「待确认」不再计入「待人工」）
describe('WorkUnitListPage - 统计条口径（#280）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.workunits = [];
    mockSearchParamsValue.value = '';
  });

  /** 找到 StatBadge（<span class="font-bold"/>value + <span class="text-sm u-text-3"/>label 结构）的数字。
   *  注意：filter pill 也会渲染同名标签（如「待确认」），所以用 font-bold sibling 定位 StatBadge。 */
  function statValue(label: string): string {
    const allLabels = screen.getAllByText(label);
    const statLabel = allLabels.find(el =>
      el.classList.contains('u-text-3') &&
      el.previousElementSibling?.classList.contains('font-bold')
    );
    if (!statLabel) throw new Error(`StatBadge label "${label}" not found`);
    return statLabel.previousElementSibling?.textContent ?? '';
  }

  it('「总数」等于列表实际条数', () => {
    mockStore.workunits = [
      makeWu({ id: 'wu-1', status: 'pending' }),
      makeWu({ id: 'wu-2', status: 'in_review' }),
      makeWu({ id: 'wu-3', status: 'active' }),
    ];
    render(<WorkUnitListPage />);
    expect(statValue('总数')).toBe('3');
  });

  it('pending 单列「待确认」，不计入「待人工」', () => {
    // 1 pending + 1 in_review（needsHuman）+ 1 active（非 needsHuman）
    // -> 待确认 = 1，待人工 = 1（仅 in_review）
    mockStore.workunits = [
      makeWu({ id: 'wu-p1', status: 'pending' }),
      makeWu({ id: 'wu-r1', status: 'in_review' }),
      makeWu({ id: 'wu-a1', status: 'active' }),
    ];
    render(<WorkUnitListPage />);
    expect(statValue('待确认')).toBe('1');
    expect(statValue('待人工')).toBe('1');
  });

  it('多个 pending 全计入「待确认」且不串到「待人工」', () => {
    mockStore.workunits = [
      makeWu({ id: 'wu-p1', status: 'pending' }),
      makeWu({ id: 'wu-p2', status: 'pending' }),
      makeWu({ id: 'wu-p3', status: 'pending' }),
    ];
    render(<WorkUnitListPage />);
    expect(statValue('待确认')).toBe('3');
    expect(statValue('待人工')).toBe('0');
  });

  it('done 缺 l3（attestations 已介入）计入「待人工」不计入「待确认」', () => {
    mockStore.workunits = [
      makeWu({
        id: 'wu-d1',
        status: 'done',
        metadata: JSON.stringify({
          attestations: {
            l1: { verdict: 'approved', by: 'dev', at: 't', kind: 'verify' },
            l2: { verdict: 'approved', by: 'rev', at: 't', kind: 'agent-review' },
            // l3 缺失 -> needsHuman
          },
        }),
      }),
    ];
    render(<WorkUnitListPage />);
    expect(statValue('待人工')).toBe('1');
    expect(statValue('待确认')).toBe('0');
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

// #284（决策 #250 D1）：pending 人闸确认入口补齐到行展开态（与频道抽屉同行为）
describe('WorkUnitListPage — pending 人闸入口（#284）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.workunits = [];
    mockSearchParamsValue.value = '';
  });

  it('pending 行展开态 → 「确认（进待认领）」→ confirmPending(id)', async () => {
    mockStore.workunits = [makeWu({ id: 'wu-p1', type: 'task', status: 'pending' })];
    render(<WorkUnitListPage />);

    fireEvent.click(screen.getByText('ID: wu-p1...')); // 行内展开
    fireEvent.click(await screen.findByText('确认（进待认领）'));

    expect(mockStore.confirmPending).toHaveBeenCalledWith('wu-p1');
  });

  it('非 pending 行展开态无确认按钮', async () => {
    mockStore.workunits = [makeWu({ id: 'wu-a9', type: 'task', status: 'active' })];
    render(<WorkUnitListPage />);

    fireEvent.click(screen.getByText('ID: wu-a9...'));
    await waitFor(() => expect(screen.getByText(/Assignee/)).toBeDefined()); // 展开已生效
    expect(screen.queryByText('确认（进待认领）')).toBeNull();
  });
});

// #116：BlockedByList 经 workunitApi.get 拉依赖状态（行内展开时）；mock 全文件生效（vi.mock 提升）
const { mockDepGet } = vi.hoisted(() => ({ mockDepGet: vi.fn() }));
vi.mock('../../api/workunit', () => ({
  workunitApi: {
    get: mockDepGet,
    listExecutionStepEvents: vi.fn().mockResolvedValue({ data: { events: [], total: 0 } }),
    getMessages: vi.fn().mockResolvedValue({ data: { data: [] } }),
  },
}));
// ExecutionSteps（行内展开渲染）依赖的 SSE hook — 测试无 WebSocketProvider，置空
vi.mock('../../hooks/useWorkUnitStreamEvents', () => ({ useWorkUnitStreamEvents: () => [] }));

describe('WorkUnitListPage — claimable 置灰与被阻塞徽标（#116）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.workunits = [];
    mockSearchParamsValue.value = '';
  });

  it('unassigned + claimable=false → 被阻塞徽标（悬停 title 可见依赖 id）+ 行置灰', () => {
    mockStore.workunits = [makeWu({
      id: 'wu-b1',
      status: 'unassigned',
      claimable: false,
      metadata: JSON.stringify({ blockedBy: ['wu-dep-1', 'wu-dep-2'] }),
    })];
    render(<WorkUnitListPage />);

    const badge = screen.getByText('被阻塞');
    expect(badge.getAttribute('title')).toContain('wu-dep-1');
    expect(badge.getAttribute('title')).toContain('wu-dep-2');
    const card = badge.closest('.card') as HTMLElement;
    expect(card.className).toContain('u-dimmed');
  });

  it('unassigned + claimable=true（依赖全了结）→ 无徽标不置灰（恢复可认领样式）', () => {
    mockStore.workunits = [makeWu({ id: 'wu-c1', status: 'unassigned', claimable: true })];
    render(<WorkUnitListPage />);

    expect(screen.queryByText('被阻塞')).toBeNull();
    const link = screen.getByText('分析需求 PMO-1: 测试');
    expect((link.closest('.card') as HTMLElement).className).not.toContain('u-dimmed');
  });

  it('非 unassigned 行 claimable 恒 false（服务端口径）→ 不误标', () => {
    mockStore.workunits = [makeWu({ id: 'wu-a3', status: 'active', claimable: false })];
    render(<WorkUnitListPage />);

    expect(screen.queryByText('被阻塞')).toBeNull();
  });

  it('展开被阻塞行 → 依赖清单拉取并展示依赖状态', async () => {
    mockDepGet.mockResolvedValue({ data: { id: 'wu-dep-1', status: 'active', scope: '依赖任务一', metadata: null } });
    mockStore.workunits = [makeWu({
      id: 'wu-b2',
      status: 'unassigned',
      claimable: false,
      metadata: JSON.stringify({ blockedBy: ['wu-dep-1'] }),
    })];
    render(<WorkUnitListPage />);

    fireEvent.click(screen.getByText('ID: wu-b2...'));

    await waitFor(() => expect(screen.getByText('依赖任务一')).toBeDefined());
    expect(mockDepGet).toHaveBeenCalledWith('wu-dep-1');
  });
});
