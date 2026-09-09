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
  statusFilter: null as string | null,
  reviewPassed: vi.fn(),
  reviewRejected: vi.fn(),
  confirmPending: vi.fn(),
  loadWorkUnits: vi.fn(),
  createWorkUnit: vi.fn(),
  setStatusFilter: vi.fn(),
  setUnattributedOnly: vi.fn(),
  loadUnattributedCount: vi.fn(),
  unattributedOnly: false,
  unattributedTotal: null as number | null,
};

vi.mock('../../stores/workunitStore', () => ({
  useWorkUnitStore: Object.assign(
    (selector?: (s: Record<string, unknown>) => unknown) => {
      const state = {
        workunits: mockStore.workunits,
        total: mockStore.workunits.length,
        loading: false,
        error: null,
        statusFilter: mockStore.statusFilter,
        unattributedOnly: mockStore.unattributedOnly,
        unattributedTotal: mockStore.unattributedTotal,
        loadWorkUnits: mockStore.loadWorkUnits,
        createWorkUnit: mockStore.createWorkUnit,
        reviewPassed: mockStore.reviewPassed,
        reviewRejected: mockStore.reviewRejected,
        confirmPending: mockStore.confirmPending,
        setStatusFilter: mockStore.setStatusFilter,
        setUnattributedOnly: mockStore.setUnattributedOnly,
        loadUnattributedCount: mockStore.loadUnattributedCount,
        applyWorkunitEvent: vi.fn(),
      };
      return selector ? selector(state) : state;
    },
    { getState: vi.fn().mockReturnValue({ workunits: [], total: 0, loading: false, error: null, loadWorkUnits: vi.fn() }) }
  ),
}));

// SSE 上下文（#318 负载直更订阅口）— 测试无 WebSocketProvider，置空
vi.mock('../../api/websocketHooks', () => ({
  useWebSocketContext: () => ({
    onEvent: () => () => {},
    onReconnect: () => () => {},
  }),
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
    expect(screen.getByText('任务')).toBeDefined();
  });

  it('renders create toggle button', () => {
    render(<WorkUnitListPage />);
    expect(screen.getByText('+ 新建')).toBeDefined();
  });

  it('shows empty state when no workunits', () => {
    render(<WorkUnitListPage />);
    expect(screen.getByText('暂无任务')).toBeDefined();
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

  /** 找到统计 chip（wu-stat：<span class="font-bold"/>value + <span class="text-sm u-text-3"/>label 结构）的数字。 */
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

    // 预填 = 目标：/待决： 逐行还原（map-opening 契约中文别名，#401）
    const textarea = screen.getByPlaceholderText(/目标/) as HTMLTextAreaElement;
    expect(textarea.value).toBe(
      '目标：三仓特性联动上线\n待决：存储选型用哪个？\n待决：部署形态先单机还是分布式？',
    );

    // 人审改：删掉一条雾
    fireEvent.change(textarea, { target: { value: '待决：存储选型用哪个？' } });
    fireEvent.click(screen.getByText('确认通过'));

    expect(mockStore.reviewPassed).toHaveBeenCalledWith('wu-a1', '待决：存储选型用哪个？', undefined);
  });

  it('analysis 无清单 metadata → 弹窗空文本（空手填或直接通过 = 非探路型）', () => {
    mockStore.workunits = [makeWu({ id: 'wu-a2' })];
    render(<WorkUnitListPage />);

    fireEvent.click(screen.getByText('通过'));
    const textarea = screen.getByPlaceholderText(/目标/) as HTMLTextAreaElement;
    expect(textarea.value).toBe('');

    fireEvent.click(screen.getByText('确认通过'));
    expect(mockStore.reviewPassed).toHaveBeenCalledWith('wu-a2', '', undefined);
  });

  it('非 analysis（task）点通过 → 不开弹窗，直接调 reviewPassed（回归）', () => {
    mockStore.workunits = [makeWu({ id: 'wu-t1', type: 'task', scope: '实现登录' })];
    render(<WorkUnitListPage />);

    fireEvent.click(screen.getByText('通过'));

    expect(screen.queryByPlaceholderText(/目标/)).toBeNull();
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

  it('pending 行展开态 → 「确认（进待领取）」→ confirmPending(id)', async () => {
    mockStore.workunits = [makeWu({ id: 'wu-p1', type: 'task', status: 'pending' })];
    render(<WorkUnitListPage />);

    fireEvent.click(screen.getByText('ID: wu-p1...')); // 行内展开
    fireEvent.click(await screen.findByText('确认（进待领取）'));

    expect(mockStore.confirmPending).toHaveBeenCalledWith('wu-p1');
  });

  it('非 pending 行展开态无确认按钮', async () => {
    mockStore.workunits = [makeWu({ id: 'wu-a9', type: 'task', status: 'active' })];
    render(<WorkUnitListPage />);

    fireEvent.click(screen.getByText('ID: wu-a9...'));
    await waitFor(() => expect(screen.getByText(/Assignee/)).toBeDefined()); // 展开已生效
    expect(screen.queryByText('确认（进待领取）')).toBeNull();
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
    const row = badge.closest('.wu-row') as HTMLElement;
    expect(row.className).toContain('u-dimmed');
  });

  it('unassigned + claimable=true（依赖全了结）→ 无徽标不置灰（恢复可认领样式）', () => {
    mockStore.workunits = [makeWu({ id: 'wu-c1', status: 'unassigned', claimable: true })];
    render(<WorkUnitListPage />);

    expect(screen.queryByText('被阻塞')).toBeNull();
    const link = screen.getByText('分析需求 PMO-1: 测试');
    expect((link.closest('.wu-row') as HTMLElement).className).not.toContain('u-dimmed');
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

// #405：未归属 pill —— 服务端过滤开关 + 服务端 total 计数徽标（消费 #428 API）
describe('WorkUnitListPage — 未归属 pill（#405）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.workunits = [];
    mockStore.unattributedOnly = false;
    mockStore.unattributedTotal = null;
    mockSearchParamsValue.value = '';
  });

  it('渲染未归属 pill，徽标数字 = store 的服务端 total', () => {
    mockStore.unattributedTotal = 42;
    render(<WorkUnitListPage />);

    const pill = screen.getByRole('button', { name: /未归属/ });
    expect(pill.textContent).toContain('42');
  });

  it('点击未归属 pill → setUnattributedOnly(true)；过滤态再点 → false（取消恢复）', () => {
    const { unmount } = render(<WorkUnitListPage />);

    fireEvent.click(screen.getByRole('button', { name: /未归属/ }));
    expect(mockStore.setUnattributedOnly).toHaveBeenCalledWith(true);

    // mock store 非响应式：置过滤态后重渲染再点
    unmount();
    mockStore.unattributedOnly = true;
    render(<WorkUnitListPage />);
    fireEvent.click(screen.getByRole('button', { name: /未归属/ }));
    expect(mockStore.setUnattributedOnly).toHaveBeenCalledWith(false);
  });

  it('unattributedTotal 为 null（未拉取）时 pill 不带数字', () => {
    render(<WorkUnitListPage />);
    expect(screen.getByRole('button', { name: '未归属' })).toBeDefined();
  });

  it('挂载时拉取未归属计数（loadUnattributedCount）', () => {
    render(<WorkUnitListPage />);
    expect(mockStore.loadUnattributedCount).toHaveBeenCalled();
  });
});

// Step 2（docs/plans/2026-09-ui-smoothness.md）：筛选合一 —— 统计 chip 可点击过滤/再点取消回全部；
// 待确认/待领取/进行中/待验收 → 服务端 statusFilter；待人工 → humanOnly 客户端派生过滤
describe('WorkUnitListPage — 统计 chip 筛选（Step 2）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.workunits = [];
    mockStore.statusFilter = null;
    mockStore.unattributedOnly = false;
    mockSearchParamsValue.value = '';
  });

  it('点状态 chip → setStatusFilter(对应状态)（服务端过滤）', () => {
    render(<WorkUnitListPage />);

    fireEvent.click(screen.getByRole('button', { name: /待确认/ }));
    expect(mockStore.setStatusFilter).toHaveBeenCalledWith('pending');

    fireEvent.click(screen.getByRole('button', { name: /待验收/ }));
    expect(mockStore.setStatusFilter).toHaveBeenCalledWith('in_review');
  });

  it('激活态再点同 chip → setStatusFilter(null)（取消回全部）', () => {
    mockStore.statusFilter = 'pending';
    render(<WorkUnitListPage />);

    fireEvent.click(screen.getByRole('button', { name: /待确认/ }));
    expect(mockStore.setStatusFilter).toHaveBeenCalledWith(null);
  });

  it('「总数」chip = 回全部：清空状态筛选', () => {
    mockStore.statusFilter = 'active';
    render(<WorkUnitListPage />);

    fireEvent.click(screen.getByRole('button', { name: /总数/ }));
    expect(mockStore.setStatusFilter).toHaveBeenCalledWith(null);
  });

  it('激活 chip aria-pressed=true，其余 false', () => {
    mockStore.statusFilter = 'pending';
    render(<WorkUnitListPage />);

    expect(screen.getByRole('button', { name: /待确认/ }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: /待领取/ }).getAttribute('aria-pressed')).toBe('false');
  });

  it('「待人工」chip → 客户端过滤只剩 needsHuman 行；再点恢复全量', () => {
    mockStore.workunits = [
      makeWu({ id: 'wu-r1', scope: '待验收的活', status: 'in_review' }),
      makeWu({ id: 'wu-a1', scope: '进行中的活', status: 'active' }),
    ];
    render(<WorkUnitListPage />);

    fireEvent.click(screen.getByRole('button', { name: /待人工/ }));
    expect(screen.getByText('待验收的活')).toBeDefined();
    expect(screen.queryByText('进行中的活')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /待人工/ }));
    expect(screen.getByText('进行中的活')).toBeDefined();
  });

  it('选状态 chip 清除待人工过滤（互斥，与原 pill 行为一致）', () => {
    mockStore.workunits = [
      makeWu({ id: 'wu-r1', scope: '待验收的活', status: 'in_review' }),
      makeWu({ id: 'wu-a1', scope: '进行中的活', status: 'active' }),
    ];
    render(<WorkUnitListPage />);

    fireEvent.click(screen.getByRole('button', { name: /待人工/ }));
    expect(screen.queryByText('进行中的活')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /进行中/ }));
    expect(mockStore.setStatusFilter).toHaveBeenCalledWith('active');
    // humanOnly 已清 → 列表恢复全量（状态过滤本身走服务端，本地 mock 不重拉）
    expect(screen.getByText('进行中的活')).toBeDefined();
  });
});

// Step 2：行/展开区重设计 —— 无边框行（wu-row + data-status 色条锚点）、metadata toggle、分节小标题
describe('WorkUnitListPage — 行与展开区重设计（Step 2）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.workunits = [];
    mockStore.statusFilter = null;
    mockSearchParamsValue.value = '';
  });

  it('行为 wu-row 无边框块（无 .card），挂 data-status = 派生列作状态色条锚点', () => {
    mockStore.workunits = [makeWu({ id: 'wu-ds', status: 'active' })];
    render(<WorkUnitListPage />);

    const link = screen.getByText('分析需求 PMO-1: 测试');
    const row = link.closest('.wu-row') as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.getAttribute('data-status')).toBe('active');
    expect(link.closest('.card')).toBeNull();
  });

  it('metadata 默认收起；「查看 metadata」toggle 展开 JSON，再点收起', async () => {
    mockStore.workunits = [makeWu({
      id: 'wu-m1',
      type: 'task',
      status: 'active',
      metadata: JSON.stringify({ blockedBy: ['wu-hidden-dep'] }),
    })];
    render(<WorkUnitListPage />);

    fireEvent.click(screen.getByText('ID: wu-m1...')); // 行内展开
    const toggle = await screen.findByRole('button', { name: /查看 metadata/ });
    expect(screen.queryByText(/wu-hidden-dep/)).toBeNull(); // pre 默认不渲染

    fireEvent.click(toggle);
    expect(screen.getByText(/wu-hidden-dep/)).toBeDefined(); // JSON 展开
    expect(screen.getByRole('button', { name: /隐藏 metadata/ }).getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: /隐藏 metadata/ }));
    expect(screen.queryByText(/wu-hidden-dep/)).toBeNull();
  });

  it('展开区有「执行过程」「讨论」分节小标题', async () => {
    mockStore.workunits = [makeWu({ id: 'wu-s1', type: 'task', status: 'active' })];
    const { container } = render(<WorkUnitListPage />);

    fireEvent.click(screen.getByText('ID: wu-s1...'));
    // ExecutionSteps 组件内部也渲染「执行过程」原文，故用 .wu-sec 类定位分节标题
    await waitFor(() => expect(container.querySelectorAll('.wu-sec').length).toBe(2));
    const titles = Array.from(container.querySelectorAll('.wu-sec')).map(el => el.textContent);
    expect(titles).toEqual(['执行过程', '讨论']);
  });
});
