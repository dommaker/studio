// Contract test: WorkUnitListPage — MVP-1 + MVP-3 + MVP-4
// #106 M7：analysis 确认弹窗（预填待决问题清单 → summary 随 reviewPassed 回传）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import React from 'react';

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return { ...actual, default: actual };
});

const { mockSearchParamsValue } = vi.hoisted(() => ({ mockSearchParamsValue: { value: '' } }));

vi.mock('react-router-dom', () => ({
  // 透传其余 props（onClick/aria-label 等）——E2-1 行尾 ↗ 依赖 onClick stopPropagation 不触发行点击
  Link: ({ children, to, ...rest }: { children: React.ReactNode; to: string; [k: string]: unknown }) =>
    React.createElement('a', { href: to, ...rest }, children),
  useNavigate: () => vi.fn(),
  useSearchParams: () => [new URLSearchParams(mockSearchParamsValue.value)],
}));

const mockStore = {
  workunits: [] as Array<Record<string, unknown>>,
  statusFilter: null as string | null,
  /** E2-5：分页测试用 total 覆盖（缺省 = 当页条数） */
  total: null as number | null,
  reviewPassed: vi.fn(),
  reviewRejected: vi.fn(),
  confirmPending: vi.fn(),
  loadWorkUnits: vi.fn(),
  loadMoreWorkUnits: vi.fn(),
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
        total: mockStore.total ?? mockStore.workunits.length,
        loading: false,
        error: null,
        statusFilter: mockStore.statusFilter,
        unattributedOnly: mockStore.unattributedOnly,
        unattributedTotal: mockStore.unattributedTotal,
        loadWorkUnits: mockStore.loadWorkUnits,
        loadMoreWorkUnits: mockStore.loadMoreWorkUnits,
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

// E2-1：行点击开右侧抽屉——抽屉本体契约在 WorkUnitDrawer.test.tsx 覆盖，本文件桩化只断言挂载/回调接线
const { mockDrawerProps } = vi.hoisted(() => ({ mockDrawerProps: vi.fn() }));
vi.mock('../../components/channel/WorkUnitDrawer', () => ({
  WorkUnitDrawer: (props: unknown) => { mockDrawerProps(props); return null; },
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

describe('WorkUnitListPage — analysis 确认弹窗（#106 M7；#463 起结构化评审表单）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.workunits = [];
    mockStore.total = null;
  });

  it('analysis 点通过 → 弹窗结构化预填待决清单与 TASK 预览；编辑后确认开图 → confirm 载荷回传', () => {
    mockStore.workunits = [makeWu({
      id: 'wu-a1',
      metadata: JSON.stringify({
        analysisDestination: '三仓特性联动上线',
        analysisFog: ['存储选型用哪个？', '部署形态先单机还是分布式？'],
        analysisTasks: ['实现存储层'],
      }),
    })];
    render(<WorkUnitListPage />);

    fireEvent.click(screen.getByText('通过验收'));

    // 结构化预填：目标/待决/派工预览各就各位
    expect((screen.getByLabelText('目标') as HTMLInputElement).value).toBe('三仓特性联动上线');
    expect((screen.getByLabelText('待决问题 1') as HTMLInputElement).value).toBe('存储选型用哪个？');
    expect((screen.getByLabelText('派工任务 1') as HTMLInputElement).value).toBe('实现存储层');

    // 人审改：删掉一条雾
    fireEvent.click(screen.getByLabelText('删除待决问题 2'));
    fireEvent.click(screen.getByText('确认开图'));

    expect(mockStore.reviewPassed).toHaveBeenCalledWith('wu-a1', undefined, undefined, {
      kind: 'analysis',
      destination: '三仓特性联动上线',
      fog: ['存储选型用哪个？'],
      tasks: ['实现存储层'],
    });
  });

  it('analysis 无清单 metadata → 弹窗全空（空手评或直接通过 = 非探路型）', () => {
    mockStore.workunits = [makeWu({ id: 'wu-a2' })];
    render(<WorkUnitListPage />);

    fireEvent.click(screen.getByText('通过验收'));
    expect((screen.getByLabelText('目标') as HTMLInputElement).value).toBe('');

    fireEvent.click(screen.getByText('确认开图'));
    expect(mockStore.reviewPassed).toHaveBeenCalledWith('wu-a2', undefined, undefined, {
      kind: 'analysis', fog: [], tasks: [],
    });
  });

  it('非 analysis（task）点通过 → 不开弹窗，直接调 reviewPassed（回归）', () => {
    mockStore.workunits = [makeWu({ id: 'wu-t1', type: 'task', scope: '实现登录' })];
    render(<WorkUnitListPage />);

    fireEvent.click(screen.getByText('通过验收'));

    expect(screen.queryByLabelText('目标')).toBeNull();
    expect(mockStore.reviewPassed).toHaveBeenCalledWith('wu-t1', undefined, undefined, undefined);
  });
});

// #284（决策 #250 D1）：pending 人闸确认入口（E2-4 起与抽屉/详情页同一 WuGateActions 组件，行内直出）
describe('WorkUnitListPage — pending 人闸入口（#284 / E2-4）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.workunits = [];
    mockStore.total = null;
    mockSearchParamsValue.value = '';
  });

  it('pending 行 → 行内「确认并开放领取」→ confirmPending(id)（不展开不开抽屉）', async () => {
    mockStore.workunits = [makeWu({ id: 'wu-p1', type: 'task', status: 'pending' })];
    render(<WorkUnitListPage />);

    fireEvent.click(await screen.findByText('确认并开放领取'));

    expect(mockStore.confirmPending).toHaveBeenCalledWith('wu-p1');
    // 闸门点击不触发行点击开抽屉（组件内吞冒泡）
    expect(mockDrawerProps).not.toHaveBeenCalledWith(expect.objectContaining({ drawer: expect.objectContaining({ kind: 'wu' }) }));
  });

  it('非 pending 行无确认按钮', () => {
    mockStore.workunits = [makeWu({ id: 'wu-a9', type: 'task', status: 'active' })];
    render(<WorkUnitListPage />);

    expect(screen.queryByText('确认并开放领取')).toBeNull();
  });
});

// #116：被阻塞徽标在行上保留（E2-1 展开区删除后，依赖清单 BlockedByList 归详情页「依赖与验收」节，
// 等价断言在 WorkUnitDetailPage.test.tsx #116 用例）；mock 全文件生效（vi.mock 提升）
vi.mock('../../api/workunit', () => ({
  workunitApi: {
    get: vi.fn(),
    listExecutionStepEvents: vi.fn().mockResolvedValue({ data: { events: [], total: 0 } }),
    getMessages: vi.fn().mockResolvedValue({ data: { data: [] } }),
  },
}));

describe('WorkUnitListPage — claimable 置灰与被阻塞徽标（#116）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.workunits = [];
    mockStore.total = null;
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

  // E2-1：行内展开区已删除，行点击开右侧抽屉（等价断言：点击行 → 抽屉收到该 WU）
  it('点击被阻塞行 → 开右侧抽屉（依赖清单等深度信息挪抽屉/详情页）', () => {
    mockStore.workunits = [makeWu({
      id: 'wu-b2',
      status: 'unassigned',
      claimable: false,
      metadata: JSON.stringify({ blockedBy: ['wu-dep-1'] }),
    })];
    render(<WorkUnitListPage />);


    fireEvent.click(screen.getByText('ID: wu-b2...'));

    expect(mockDrawerProps).toHaveBeenCalledWith(expect.objectContaining({
      drawer: { kind: 'wu', id: 'wu-b2' },
    }));
  });

  it('#474：行内 Agent 不再拿截断 hash 当人名——走 AssigneeLabel 解析；ID 全文收进 title', () => {
    mockStore.workunits = [makeWu({
      id: 'wu-full-id-1234567890',
      assigneeId: 'agent-instance-abcdef123456',
    })];
    render(<WorkUnitListPage />);

    // 旧形态（裸「Agent: <8位hash>...」）不再出现
    expect(screen.queryByText(/Agent: /)).toBeNull();
    // ID 截断显示不变，全文收进 title
    const idSpan = screen.getByText(/ID: wu-full-/);
    expect(idSpan).toHaveAttribute('title', 'wu-full-id-1234567890');
    // AssigneeLabel 兜底形态：@短 id（解析为异步，查不到角色时回退；解析契约见 AssigneeLabel.test）
    expect(screen.getByText('@agent-in')).toBeTruthy();
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

// Step 2：行重设计（无边框行 wu-row + data-status 色条锚点）；
// E2-1（docs/plans/2026-09-page-redesign.md）：整行展开区删除，行点击 → 右侧抽屉（WorkUnitDrawer 桩化断言接线）
describe('WorkUnitListPage — 行形态与抽屉（Step 2 / E2-1）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.workunits = [];
    mockStore.statusFilter = null;
    mockStore.total = null;
    mockSearchParamsValue.value = '';
  });

  const lastDrawerProps = () => mockDrawerProps.mock.calls.at(-1)?.[0] as {
    drawer: { kind: string; id: string } | null;
    onClose: () => void;
    onOpenWu: (id: string) => void;
    onOpenReq: (id: string) => void;
  };

  it('行为 wu-row 无边框块（无 .card），挂 data-status = 派生列作状态色条锚点', () => {
    mockStore.workunits = [makeWu({ id: 'wu-ds', status: 'active' })];
    render(<WorkUnitListPage />);

    const title = screen.getByText('分析需求 PMO-1: 测试');
    const row = title.closest('.wu-row') as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.getAttribute('data-status')).toBe('active');
    expect(title.closest('.card')).toBeNull();
  });

  it('点击行 → 右侧抽屉收到 { kind: wu, id }（替代整行展开区）；初始 drawer=null', () => {
    mockStore.workunits = [makeWu({ id: 'wu-m1', type: 'task', status: 'active' })];
    render(<WorkUnitListPage />);

    expect(lastDrawerProps().drawer).toBeNull();

    fireEvent.click(screen.getByText('ID: wu-m1...'));
    expect(lastDrawerProps().drawer).toEqual({ kind: 'wu', id: 'wu-m1' });
  });

  it('行尾「↗」= 完整详情页链接（深链场景），点击不开抽屉', () => {
    mockStore.workunits = [makeWu({ id: 'wu-dl', type: 'task', status: 'active' })];
    render(<WorkUnitListPage />);

    // Link mock 透传 aria-label（与真实路由环境一致）
    const link = screen.getByRole('link', { name: '打开完整详情页' });
    expect(link.getAttribute('href')).toBe('/workunits/wu-dl');
    fireEvent.click(link);
    expect(lastDrawerProps().drawer).toBeNull();
  });

  it('抽屉回调接线：onClose 收抽屉；onOpenReq 切 REQ 全链路', () => {
    mockStore.workunits = [makeWu({ id: 'wu-cb', type: 'task', status: 'active' })];
    render(<WorkUnitListPage />);

    fireEvent.click(screen.getByText('ID: wu-cb...'));
    expect(lastDrawerProps().drawer).toEqual({ kind: 'wu', id: 'wu-cb' });

    act(() => lastDrawerProps().onClose());
    expect(lastDrawerProps().drawer).toBeNull();

    act(() => lastDrawerProps().onOpenReq('REQ-0042'));
    expect(lastDrawerProps().drawer).toEqual({ kind: 'req', id: 'REQ-0042' });

    act(() => lastDrawerProps().onOpenWu('wu-x9'));
    expect(lastDrawerProps().drawer).toEqual({ kind: 'wu', id: 'wu-x9' });
  });
});

// 批次 D-1.6（docs/plans/2026-09-ui-interaction-polish.md）：「待人工」行级提权 ——
// needsHuman（in_review ‖ done 缺 l3，与统计 chip 同口径）行加 wu-row-human 类，
// 视觉（warning-dim 底色 + hover 提亮）在 workunits.css
describe('WorkUnitListPage — 待人工行级提权（D-1.6）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.workunits = [];
    mockStore.statusFilter = null;
    mockSearchParamsValue.value = '';
  });

  const rowClass = (scope: string) =>
    (screen.getByText(scope).closest('.wu-row') as HTMLElement).className;

  it('in_review 行 → wu-row-human（待人工提权）', () => {
    mockStore.workunits = [makeWu({ id: 'wu-h1', scope: '待验收的活', status: 'in_review' })];
    render(<WorkUnitListPage />);
    expect(rowClass('待验收的活')).toContain('wu-row-human');
  });

  it('done 缺 l3（证据已介入）行 → wu-row-human；done 有 l3 行不提权', () => {
    const att = (l3: boolean) => JSON.stringify({
      attestations: {
        l1: { verdict: 'approved', by: 'dev', at: 't', kind: 'verify' },
        l2: { verdict: 'approved', by: 'rev', at: 't', kind: 'agent-review' },
        ...(l3 ? { l3: { verdict: 'approved', by: 'human', at: 't', kind: 'human-accept' } } : {}),
      },
    });
    mockStore.workunits = [
      makeWu({ id: 'wu-h2', scope: '缺人工验收的活', status: 'done', metadata: att(false) }),
      makeWu({ id: 'wu-h3', scope: '已人工验收的活', status: 'done', metadata: att(true) }),
    ];
    render(<WorkUnitListPage />);
    expect(rowClass('缺人工验收的活')).toContain('wu-row-human');
    expect(rowClass('已人工验收的活')).not.toContain('wu-row-human');
  });

  it('其他状态行不提权（active / pending / unassigned）', () => {
    mockStore.workunits = [
      makeWu({ id: 'wu-h4', scope: '进行中的活', status: 'active' }),
      makeWu({ id: 'wu-h5', scope: '待确认的活', status: 'pending' }),
      makeWu({ id: 'wu-h6', scope: '待领取的活', status: 'unassigned' }),
    ];
    render(<WorkUnitListPage />);
    for (const scope of ['进行中的活', '待确认的活', '待领取的活']) {
      expect(rowClass(scope)).not.toContain('wu-row-human');
    }
  });
});

// 批次A 项4 → E2-4：行闸门按钮三处合一为 WuGateActions——pending 锁存 + 失败内联错误（原 toast 统一为内联，方案「文案与视觉唯一」）；
// handleCreate 失败内联错误不变
describe('WorkUnitListPage — 行闸门反馈兜底（批次A 项4 / E2-4）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.workunits = [];
    mockStore.statusFilter = null;
    mockStore.total = null;
    mockSearchParamsValue.value = '';
  });

  it('行「通过验收」pending 锁存：未结算前连击只调一次，按钮禁用', async () => {
    let resolve: () => void = () => {};
    mockStore.reviewPassed.mockImplementation(() => new Promise<void>(r => { resolve = r; }));
    mockStore.workunits = [makeWu({ id: 'wu-l1', type: 'task', status: 'in_review' })];
    render(<WorkUnitListPage />);

    const btn = screen.getByText('通过验收').closest('button')!;
    fireEvent.click(btn);
    await waitFor(() => expect(btn.disabled).toBe(true));
    expect(screen.getByText('拒绝').closest('button')!.disabled).toBe(true);
    fireEvent.click(btn);
    expect(mockStore.reviewPassed).toHaveBeenCalledTimes(1);

    resolve();
    await waitFor(() => expect(btn.disabled).toBe(false));
  });

  it('行闸门按钮统一视觉（E2-4）：btn btn-primary btn-sm / btn btn-danger btn-sm', () => {
    mockStore.workunits = [makeWu({ id: 'wu-l0', type: 'task', status: 'in_review' })];
    render(<WorkUnitListPage />);

    expect(screen.getByText('通过验收').closest('button')!.className).toBe('btn btn-primary btn-sm');
    expect(screen.getByText('拒绝').closest('button')!.className).toBe('btn btn-danger btn-sm');
  });

  it('行「通过」失败 → 内联错误行透传服务端 error.message，按钮恢复可点', async () => {
    mockStore.reviewPassed.mockRejectedValue(Object.assign(new Error('Request failed with status code 409'), {
      isAxiosError: true,
      response: { status: 409, data: { error: { message: '状态机不允许该迁移' } } },
    }));
    mockStore.workunits = [makeWu({ id: 'wu-l2', type: 'task', status: 'in_review' })];
    render(<WorkUnitListPage />);

    const btn = screen.getByText('通过验收').closest('button')!;
    fireEvent.click(btn);
    expect(await screen.findByText('状态机不允许该迁移')).toBeTruthy();
    await waitFor(() => expect(btn.disabled).toBe(false));
  });

  it('pending 行「确认并开放领取」失败 → 内联错误行（Error.message 回退）不静默', async () => {
    mockStore.confirmPending.mockRejectedValue(new Error('boom'));
    mockStore.workunits = [makeWu({ id: 'wu-l3', type: 'task', status: 'pending' })];
    render(<WorkUnitListPage />);

    fireEvent.click(await screen.findByText('确认并开放领取'));
    expect(await screen.findByText('boom')).toBeTruthy();
  });

  it('handleCreate 失败 → 内联错误行进创建表单（原 console.error 静默）', async () => {
    mockStore.createWorkUnit.mockRejectedValue(Object.assign(new Error('Request failed with status code 400'), {
      isAxiosError: true,
      response: { status: 400, data: { error: { message: 'scope 不能为空' } } },
    }));
    render(<WorkUnitListPage />);

    fireEvent.click(screen.getByText('+ 新建'));
    fireEvent.change(screen.getByPlaceholderText('例：实现用户登录功能'), { target: { value: '新任务' } });
    fireEvent.click(screen.getByText('创建'));

    expect(await screen.findByText('scope 不能为空')).toBeTruthy();
    // 表单保持打开可重试
    expect(screen.getByPlaceholderText('例：实现用户登录功能')).toBeTruthy();
  });

  it('analysis 弹窗确认失败 → 弹窗不关 + 内联错误（批次A 项7 成功才关窗）', async () => {
    mockStore.reviewPassed.mockRejectedValue(new Error('服务端挂了'));
    mockStore.workunits = [makeWu({ id: 'wu-l4', status: 'in_review' })]; // 默认 type=analysis
    render(<WorkUnitListPage />);

    fireEvent.click(screen.getByText('通过验收'));
    fireEvent.click(await screen.findByText('确认开图'));

    // 错误行同时进闸门区与弹窗（两处同源 gateError/submitError）
    expect((await screen.findAllByText('服务端挂了')).length).toBeGreaterThan(0);
    // 弹窗仍在（成功才关窗）
    expect(screen.getByText('确认分析结论')).toBeTruthy();
  });
});

// E2-5 分页（承接批次 B-3）：底部「加载更多」追加式加载 + 「已加载 X / 共 N」明示（共 N = pagination.total）
describe('WorkUnitListPage — 分页底栏（E2-5）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.workunits = [];
    mockStore.total = null;
    mockStore.statusFilter = null;
    mockSearchParamsValue.value = '';
  });

  it('底栏明示「已加载 X / 共 N」（N = pagination.total，非当页条数）', () => {
    mockStore.workunits = [makeWu({ id: 'wu-pg1', status: 'active' }), makeWu({ id: 'wu-pg2', status: 'done' })];
    mockStore.total = 42;
    render(<WorkUnitListPage />);

    expect(screen.getByText(/已加载/).textContent).toContain('2');
    expect(screen.getByText(/已加载/).textContent).toContain('42');
    // 「总数」chip 同样对齐 pagination.total
    expect(screen.getByRole('button', { name: /总数/ }).textContent).toContain('42');
  });

  it('已加载 < total → 渲染「加载更多」，点击调 loadMoreWorkUnits（追加式）', () => {
    mockStore.workunits = [makeWu({ id: 'wu-pg1', status: 'active' })];
    mockStore.total = 21;
    render(<WorkUnitListPage />);

    fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
    expect(mockStore.loadMoreWorkUnits).toHaveBeenCalledTimes(1);
  });

  it('已加载 >= total → 不渲染「加载更多」', () => {
    mockStore.workunits = [makeWu({ id: 'wu-pg1', status: 'active' }), makeWu({ id: 'wu-pg2', status: 'done' })];
    mockStore.total = 2;
    render(<WorkUnitListPage />);

    expect(screen.queryByRole('button', { name: '加载更多' })).toBeNull();
    expect(screen.getByText(/已加载/).textContent).toContain('2');
  });
});

// #472：统计 chip 颜色语义 + 计数口径标注
describe('WorkUnitListPage — 统计 chip 语义与口径（#472）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.workunits = [];
    mockStore.total = null;
    mockStore.statusFilter = null;
    mockSearchParamsValue.value = '';
  });

  /** chip 数字 span（wu-stat-num）的内联色 */
  function chipColor(label: string): string {
    const chip = screen.getByRole('button', { name: new RegExp(label) });
    const num = chip.querySelector('.wu-stat-num') as HTMLElement | null;
    if (!num) throw new Error(`chip "${label}" 无数字 span`);
    return num.style.color;
  }

  it('「待人工」chip 用 warning 不用 error 红（红留给真错误）', () => {
    mockStore.workunits = [makeWu({ id: 'wu-1', status: 'in_review' })];
    render(<WorkUnitListPage />);
    expect(chipColor('待人工')).toBe('var(--warning)');
  });

  it('「待确认」chip 用中性色（与「待验收」warning 区分开）', () => {
    mockStore.workunits = [makeWu({ id: 'wu-1', status: 'pending' })];
    render(<WorkUnitListPage />);
    expect(chipColor('待确认')).not.toBe('var(--warning)');
    expect(chipColor('待验收')).toBe('var(--warning)');
  });

  it('分页未全量 → chip 行标注计数口径（防数字撒谎）', () => {
    mockStore.workunits = [makeWu({ id: 'wu-1', status: 'active' }), makeWu({ id: 'wu-2', status: 'done' })];
    mockStore.total = 42;
    render(<WorkUnitListPage />);
    expect(screen.getByText(/计数口径/).textContent).toContain('2/42');
  });

  it('全量加载且无筛选 → 不标注（计数即全量，无需解释）', () => {
    mockStore.workunits = [makeWu({ id: 'wu-1', status: 'active' }), makeWu({ id: 'wu-2', status: 'done' })];
    mockStore.total = 2;
    render(<WorkUnitListPage />);
    expect(screen.queryByText(/计数口径/)).toBeNull();
  });

  it('状态筛选生效 → 同样标注（其余 chip 数的是筛选后子集）', () => {
    mockStore.workunits = [makeWu({ id: 'wu-1', status: 'active' })];
    mockStore.total = 1;
    mockStore.statusFilter = 'active';
    render(<WorkUnitListPage />);
    expect(screen.getByText(/计数口径/)).toBeTruthy();
  });
});
