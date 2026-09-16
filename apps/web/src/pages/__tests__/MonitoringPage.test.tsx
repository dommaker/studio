// Contract test: MonitoringPage — MVP-6 + #398 重构（spec §7：行动面首屏 / 区块裁决 / 图表化 / §7.5 文案）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import React from 'react';

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return { ...actual, default: actual };
});

vi.mock('react-router-dom', () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => React.createElement('a', { href: to }, children),
  useNavigate: () => vi.fn(),
}));

const { mockGetOverview, mockGetEfficiency, mockGetFlywheel, mockGetOverhead } = vi.hoisted(() => ({
  mockGetOverview: vi.fn(),
  mockGetEfficiency: vi.fn(),
  mockGetFlywheel: vi.fn(),
  mockGetOverhead: vi.fn(),
}));

vi.mock('../../api/monitoring', () => ({
  monitoringApi: {
    getOverview: mockGetOverview,
    getFlywheel: mockGetFlywheel.mockResolvedValue({
      data: {
        quality: 42, hitRate: 67, improvement: 10, freshness: 80,
        source: 'events',
        proposalsPendingReview: 3,
        extraction: { count30d: 2, totalTokens30d: 1500 },
        windowDays: 30,
        timestamp: '2026-07-19T00:00:00Z',
      },
    }),
    getOverhead: mockGetOverhead.mockResolvedValue({
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
    getEfficiency: mockGetEfficiency,
  },
}));

// 审核闭环：待审列表数据源（GET /knowledge-service/entries?maturity=draft）+ approve 走 /promote
// 批次A 项8：补拒绝（/demote，draft→archived）
const { mockListPendingReview, mockPromote, mockDemote } = vi.hoisted(() => ({
  mockListPendingReview: vi.fn(),
  mockPromote: vi.fn(),
  mockDemote: vi.fn(),
}));
vi.mock('../../api/knowledge', () => ({
  knowledgeApi: { listPendingReview: mockListPendingReview, promote: mockPromote, demote: mockDemote },
}));

// #180 事件检索 Tab 数据源（GET /events）
const { mockEventSearch } = vi.hoisted(() => ({ mockEventSearch: vi.fn() }));
vi.mock('../../api/events', () => ({
  eventsApi: { search: mockEventSearch },
}));

// #184「需要处理」区：桩件隔离（其数据加载契约见组件自身测试）；E4 起捕获 props 供下钻接线用例驱动
const { needsAttentionProps } = vi.hoisted(() => ({
  needsAttentionProps: { current: null as { onAlertClick?: (g: { level: string; message: string; count: number }) => void } | null },
}));
vi.mock('../../components/monitoring/NeedsAttentionSection', () => ({
  NeedsAttentionSection: (props: { onAlertClick?: (g: { level: string; message: string; count: number }) => void }) => {
    needsAttentionProps.current = props;
    return React.createElement('div', null, '需要处理');
  },
}));

import { MonitoringPage } from '../MonitoringPage';

/** 默认 overview 响应：evidence + roles + humanIntervention 三段（#398 起消费） */
function defaultOverview() {
  return {
    data: {
      evidence: {
        engaged: 6, l1Approved: 5, l2Approved: 4, l3Approved: 2,
        selfReviewCount: 1, needsHuman: 3, derivedMismatch: 0,
        derivedByColumn: { done: 3, in_review: 2, active: 1 },
      },
      roles: {
        roles: [
          { profileId: 'p-1', profileName: 'Analyst', claims: 8, completions: 5, avgDurationHours: 1.26, needInputClarify: 2, needInputExecution: 1 },
          { profileId: 'p-2', profileName: 'Executor', claims: 10, completions: 7, avgDurationHours: null, needInputClarify: 0, needInputExecution: 4 },
        ],
      },
      humanIntervention: {
        completedWorkUnits: 12, needInputCount: 7, reviewRejections: 3, mergeConflicts: 2,
        avgPerCompletedWu: 1.0,
      },
    },
  };
}

/** #120 输入缓存命中率（默认空数据形态；source='events' 形态见专项用例） */
function emptyEfficiency() {
  return {
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
  };
}

/** 展开「健康度量」默认折叠分区 */
async function openMetrics() {
  fireEvent.click(await screen.findByText('健康度量'));
}

describe('MonitoringPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetOverview.mockResolvedValue(defaultOverview());
    mockGetEfficiency.mockResolvedValue(emptyEfficiency());
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
    mockDemote.mockResolvedValue({ data: { success: true } });
    mockEventSearch.mockResolvedValue({ data: { events: [], total: 0, nextCursor: null } });
    document.querySelector('#toast-container')?.replaceChildren(); // 只清子节点——toast.ts 模块级缓存 container 引用，remove 会让后续 toast 挂到游离节点
  });

  it('renders page title', () => {
    render(<MonitoringPage />);
    expect(screen.getByText('监控')).toBeDefined();
  });

  // ── #398 行动面（§7.2 首屏）──

  it('首屏行动面：「需要处理」在「知识提案待审」之前，均在健康度量之上', async () => {
    render(<MonitoringPage />);
    const needsAttention = await screen.findByText('需要处理');
    const proposals = await screen.findByText('知识提案待审');
    expect(needsAttention.compareDocumentPosition(proposals) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 行动区不需要展开即可见（健康度量默认折叠，其区块此时不可见）
    expect(screen.queryByText('证据台账（信任分层）')).toBeNull();
  });

  it('知识提案待审：22px 主数字 = 待审提案数，附白话副标题', async () => {
    render(<MonitoringPage />);
    expect(await screen.findByText('知识提案待审')).toBeDefined();
    expect(screen.getByTestId('proposals-stat').textContent).toBe('2');
    expect(screen.getByText('Agent 提炼的新知识，等你确认')).toBeDefined();
  });

  // ── #398 区块裁决（§7.3）：删除四区块 ──

  it('删除区块不再出现（展开健康度量后也没有）', async () => {
    render(<MonitoringPage />);
    await openMetrics();
    await screen.findByText('证据台账（信任分层）');
    expect(screen.queryByText('WorkUnit 状态分布')).toBeNull();
    expect(screen.queryByText('Agent 状态')).toBeNull();
    expect(screen.queryByText('最近 24 小时')).toBeNull();
    expect(screen.queryByText('段 trim 率')).toBeNull();
    // 旧「封装开销」改名「注入预算占用」
    expect(screen.queryByText('封装开销')).toBeNull();
  });

  // ── #398 健康度量分区（§7.2 默认折叠）──

  it('健康度量默认折叠，点击展开后各区块出现（§7.5 文案：标题+副标题+主数字）', async () => {
    render(<MonitoringPage />);
    const toggle = await screen.findByText('健康度量');
    expect(toggle.closest('button')?.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('学习成效')).toBeNull();

    await openMetrics();
    expect(screen.getByText('学习成效')).toBeDefined();
    expect(screen.getByText('系统有没有越用越聪明')).toBeDefined();
    expect(screen.getByText('证据台账（信任分层）')).toBeDefined();
    expect(screen.getByText('每个任务有多少人/机器确认过')).toBeDefined();
    expect(screen.getByText('注入预算占用')).toBeDefined();
    expect(screen.getByText('每次执行任务，背景注入占了多少上下文预算')).toBeDefined();
    expect(screen.getByText('输入缓存命中率')).toBeDefined();
    expect(screen.getByText('角色效率')).toBeDefined();
    expect(screen.getByText('每个角色认领、完成了多少任务、平均多久')).toBeDefined();
    expect(screen.getByText('人工干预')).toBeDefined();
    expect(screen.getByText('每完成一个任务，平均需要人插手几次')).toBeDefined();
  });

  it('证据台账减卡：核心 5 张在，自评/已介入卡移除；主数字 = 已验收占比（L3 ÷ 已介入）', async () => {
    render(<MonitoringPage />);
    await openMetrics();
    await screen.findByText('证据台账（信任分层）');
    expect(screen.getByText('自动验证')).toBeDefined();
    expect(screen.getByText('Agent 评审')).toBeDefined();
    expect(screen.getByText('人工确认')).toBeDefined();
    expect(screen.getByText('待人工确认')).toBeDefined();
    expect(screen.getByText('状态不一致')).toBeDefined();
    expect(screen.queryByText('自评（L2）')).toBeNull();
    expect(screen.queryByText('已介入 WU')).toBeNull();
    // 2/6 = 33%
    expect(screen.getByTestId('evidence-stat').textContent).toBe('33%');
  });

  it('#472：「待人工确认」用 warning 不用 error 红（红留给真错误 blocked/failed）', async () => {
    render(<MonitoringPage />);
    await openMetrics();
    const label = await screen.findByText('待人工确认');
    // StatCard 结构：<div><span class="font-bold ${color}">值</span><span>label</span></div>
    const valueSpan = label.previousElementSibling!;
    expect(valueSpan.className).toContain('u-warn');
    expect(valueSpan.className).not.toContain('u-err');
  });

  it('学习成效减卡：hitRate / improvement / 待审三张在，质量分/新鲜度/提取移除；主数字 = 命中率', async () => {
    render(<MonitoringPage />);
    await openMetrics();
    await screen.findByText('学习成效');
    expect(screen.getByText('知识命中率')).toBeDefined();
    expect(screen.getByText('+10pp')).toBeDefined();
    expect(screen.getByText('待审提案')).toBeDefined();
    expect(screen.queryByText('质量分')).toBeNull();
    expect(screen.queryByText('新鲜度')).toBeNull();
    expect(screen.queryByText(/提取次数/)).toBeNull();
    expect(screen.getByTestId('flywheel-stat').textContent).toBe('67%');
  });

  it('注入预算占用图表化：主数字 + 预算用量条（caption 含平均注入/红线）', async () => {
    render(<MonitoringPage />);
    await openMetrics();
    await screen.findByText('注入预算占用');
    expect(screen.getByTestId('overhead-stat').textContent).toBe('40%');
    expect(screen.getByTestId('usage-bar-fill').style.width).toBe('40%');
    expect(screen.getByText(/平均注入 800 \/ 红线 2000 tokens/)).toBeDefined();
    expect(screen.getByText(/开销比 = 注入估算 \/ 执行 tokens：2.5%/)).toBeDefined();
  });

  it('输入缓存命中率：insufficient-data 形态显示数据不足文案', async () => {
    render(<MonitoringPage />);
    await openMetrics();
    expect(await screen.findByText(/命中率数据不足/)).toBeDefined();
  });

  it('输入缓存命中率图表化：byDay 柱 + byRole 横条（events 形态）', async () => {
    mockGetEfficiency.mockResolvedValue({
      data: {
        windowDays: 30,
        generatedAt: '2026-08-14T00:00:00Z',
        cacheHitRate: {
          description: '', windowDays: 30,
          overall: { cacheReadTokens: 1200, inputTokens: 3000, hitRatePct: 29, events: 8, workUnits: 2 },
          steps: [], byWorkUnit: [],
          byRole: [
            { profileId: 'p-1', profileName: 'Analyst', cacheReadTokens: 800, inputTokens: 2000, hitRatePct: 29, events: 5 },
          ],
          byDay: [
            { day: '2026-08-13', cacheReadTokens: 400, inputTokens: 1000, hitRatePct: 29, events: 3 },
          ],
          coveragePct: 80, source: 'events',
        },
        sectionTrim: emptyEfficiency().data.sectionTrim,
      },
    });
    render(<MonitoringPage />);
    await openMetrics();
    await screen.findByText('输入缓存命中率');
    expect(screen.getByTestId('cache-stat').textContent).toBe('29%');
    expect(screen.getByText('按天')).toBeDefined();
    expect(screen.getByText('08-13')).toBeDefined();
    expect(screen.getByText('按角色')).toBeDefined();
    expect(screen.getAllByText('Analyst').length).toBeGreaterThan(0); // HBars 行（角色效率表亦有同名行）
    // 覆盖率 <100% → 口径说明
    expect(screen.getByText(/覆盖率 80%/)).toBeDefined();
  });

  it('角色效率表：认领/完成/平均时长/NEED_INPUT 拆分（无均时 → N/A）', async () => {
    render(<MonitoringPage />);
    await openMetrics();
    await screen.findByText('角色效率');
    expect(screen.getByText('认领')).toBeDefined();
    expect(screen.getByText('完成')).toBeDefined();
    expect(screen.getByText('平均时长')).toBeDefined();
    expect(screen.getByText('提问（澄清/执行）')).toBeDefined();
    expect(screen.getByText('Executor')).toBeDefined();
    expect(screen.getByText('1.3h')).toBeDefined(); // 1.26 四舍五入
    expect(screen.getByText('N/A')).toBeDefined(); // Executor 无均时
    expect(screen.getByText('2 / 1')).toBeDefined();
    expect(screen.getByText('0 / 4')).toBeDefined();
  });

  it('人工干预北极星卡：主数字 = 每 WU 平均干预次数 + 分母与细分小字', async () => {
    render(<MonitoringPage />);
    await openMetrics();
    await screen.findByText('人工干预');
    expect(screen.getByTestId('intervention-stat').textContent).toBe('1');
    expect(screen.getByText(/窗口内完成 12 个任务/)).toBeDefined();
    expect(screen.getByText(/NEED_INPUT 挂起 7 次/)).toBeDefined();
    expect(screen.getByText(/review 驳回 3 次/)).toBeDefined();
    expect(screen.getByText(/合并冲突转人工 2 次/)).toBeDefined();
  });

  // ── 审核闭环：待审列表（标题/年龄/approve）──

  it('renders 待审提案列表：标题 + 年龄 + approve 按钮', async () => {
    render(<MonitoringPage />);
    expect(await screen.findByText('session 过期未刷新导致 401')).toBeDefined();
    expect(screen.getByText('登录流程统一走 auth-service')).toBeDefined();
    expect(screen.getByText(/2 小时前/)).toBeDefined();
    expect(screen.getByText(/1 天前/)).toBeDefined();
    expect(screen.getAllByText('通过').length).toBe(2);
  });

  it('approve → 调 /promote 并把该条目移出列表，主数字同步减一', async () => {
    render(<MonitoringPage />);
    const buttons = await screen.findAllByText('通过');
    fireEvent.click(buttons[0]); // 首次仅进待确认态
    fireEvent.click(await screen.findByText('再点一次确认通过'));
    await waitFor(() => {
      expect(mockPromote).toHaveBeenCalledWith('k-1');
    });
    await waitFor(() => {
      expect(screen.queryByText('session 过期未刷新导致 401')).toBeNull();
    });
    expect(screen.getByText('登录流程统一走 auth-service')).toBeDefined();
    expect(screen.getByTestId('proposals-stat').textContent).toBe('1');
  });

  // ── #473：审批前可见详情 + 两步确认（对照频道 ReviewProposalCard twoStepApprove）──

  it('两步确认：首次点「通过」不调 promote，仅转入待确认态；再次点击才执行', async () => {
    render(<MonitoringPage />);
    const buttons = await screen.findAllByText('通过');
    fireEvent.click(buttons[0]);
    expect(mockPromote).not.toHaveBeenCalled();
    expect(await screen.findByText('再点一次确认通过')).toBeDefined();
    fireEvent.click(screen.getByText('再点一次确认通过'));
    await waitFor(() => expect(mockPromote).toHaveBeenCalledWith('k-1'));
  });

  it('点击标题展开详情（类型白话标签 + 提交时间），再点收起', async () => {
    render(<MonitoringPage />);
    const title = await screen.findByText('session 过期未刷新导致 401');
    expect(screen.queryByText('踩坑记录')).toBeNull();
    fireEvent.click(title);
    expect(await screen.findByText(/踩坑记录/)).toBeDefined();
    expect(screen.getByText(/提交时间/)).toBeDefined();
    fireEvent.click(screen.getByText('session 过期未刷新导致 401'));
    await waitFor(() => expect(screen.queryByText('踩坑记录')).toBeNull());
  });

  // ── 批次A 项8：拒绝按钮 + 失败 toast + 刷新 loading ──

  it('拒绝 → 调 /demote 并把该条目移出列表（draft→archived）', async () => {
    render(<MonitoringPage />);
    const buttons = await screen.findAllByText('拒绝');
    fireEvent.click(buttons[0]);
    await waitFor(() => {
      expect(mockDemote).toHaveBeenCalledWith('k-1');
    });
    await waitFor(() => {
      expect(screen.queryByText('session 过期未刷新导致 401')).toBeNull();
    });
    expect(screen.getByTestId('proposals-stat').textContent).toBe('1');
  });

  it('approve 失败 → toast 提示 + 条目保留在列表可重试（原 catch 静默）', async () => {
    mockPromote.mockRejectedValue(Object.assign(new Error('Request failed with status code 500'), {
      isAxiosError: true,
      response: { status: 500, data: { error: { message: '知识库写入冲突' } } },
    }));
    render(<MonitoringPage />);
    const buttons = await screen.findAllByText('通过');
    fireEvent.click(buttons[0]); // 首次仅进待确认态
    fireEvent.click(await screen.findByText('再点一次确认通过'));
    expect(await screen.findByText('通过失败：知识库写入冲突')).toBeTruthy();
    expect(screen.getByText('session 过期未刷新导致 401')).toBeDefined();
    expect(screen.getByTestId('proposals-stat').textContent).toBe('2');
  });

  it('刷新按钮：数据在拉期间显示「刷新中…」并禁用，落地后恢复', async () => {
    render(<MonitoringPage />);
    // 首拉在途 → loading
    const btn = screen.getByRole('button', { name: /刷新/ });
    expect(btn.textContent).toBe('刷新中…');
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    // 全部落地后恢复
    await screen.findByText('知识提案待审');
    await waitFor(() => expect(screen.getByRole('button', { name: '刷新' })).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() => expect(mockGetOverview.mock.calls.length).toBe(2));
  });

  // ── #180 事件检索 Tab（#60 决策 Q3a：概览 / 事件检索）──

  it('渲染「概览 / 事件检索」Tab，默认概览', async () => {
    render(<MonitoringPage />);
    expect(screen.getByText('概览')).toBeDefined();
    expect(screen.getByText('事件检索')).toBeDefined();
    expect(await screen.findByText('知识提案待审')).toBeDefined();
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
});

// ── E4 告警下钻：点击告警组 → 事件检索 tab 预填签名过滤（NeedsAttentionSection 为桩件，经捕获的 props 驱动）──
describe('MonitoringPage — 告警下钻（E4）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetOverview.mockResolvedValue(defaultOverview());
    mockGetEfficiency.mockResolvedValue(emptyEfficiency());
    mockListPendingReview.mockResolvedValue({ data: { entries: [], total: 0 } });
    mockEventSearch.mockResolvedValue({ data: { events: [], total: 0, nextCursor: null } });
  });

  it('点击告警 → 切事件检索 tab，预填 type=monitor:alert + 签名关键词并自动检索', async () => {
    render(<MonitoringPage />);
    await screen.findByText('知识提案待审');
    act(() => {
      needsAttentionProps.current!.onAlertClick!({ level: 'warning', message: '未认领池滞留：最老任务已滞留 7h', count: 3 });
    });

    await waitFor(() => {
      expect(mockEventSearch).toHaveBeenCalledWith(expect.objectContaining({
        type: 'monitor:alert',
        level: 'warning',
        keyword: '未认领池滞留：最老任务已滞留',
      }));
    });
    expect((screen.getByPlaceholderText('类型（可选），如 workunit:failed') as HTMLInputElement).value).toBe('monitor:alert');
    expect((screen.getByPlaceholderText('关键词（可选）') as HTMLInputElement).value).toBe('未认领池滞留：最老任务已滞留');
  });

  it('下钻后回概览再手动进事件检索 → 旧预填不重放（不再自动检索）', async () => {
    render(<MonitoringPage />);
    await screen.findByText('知识提案待审');
    act(() => {
      needsAttentionProps.current!.onAlertClick!({ level: 'warning', message: '滞留 7h', count: 1 });
    });
    await waitFor(() => expect(mockEventSearch).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByText('概览'));
    fireEvent.click(screen.getByText('事件检索'));
    // 面板重挂但无 initialFilters：不自动检索，表单回到空
    expect(mockEventSearch).toHaveBeenCalledTimes(1);
    expect((screen.getByPlaceholderText('关键词（可选）') as HTMLInputElement).value).toBe('');
  });
});

// ── 2026-09 web-ux-optional-fixes Step 1：子拉取失败不再静默 null——区块内最小错误行 + 重试 ──
describe('MonitoringPage — 子拉取失败错误行（web-ux-optional-fixes Step 1）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetOverview.mockResolvedValue(defaultOverview());
    mockGetEfficiency.mockResolvedValue(emptyEfficiency());
    mockListPendingReview.mockResolvedValue({ data: { entries: [], total: 0 } });
    mockEventSearch.mockResolvedValue({ data: { events: [], total: 0, nextCursor: null } });
  });

  it('待审列表拉取失败：区块内错误行 + 重试，点击后重拉恢复（原 .catch(() => null) 静默）', async () => {
    mockListPendingReview
      .mockRejectedValueOnce(new Error('proposals boom'))
      .mockResolvedValue({
        data: {
          entries: [{ id: 'k-9', title: '恢复后的提案', type: 'pitfall', maturity: 'draft', created: new Date().toISOString() }],
          total: 1,
        },
      });
    render(<MonitoringPage />);

    expect(await screen.findByText('proposals boom')).toBeTruthy();
    // 失败不再落「待审列表不可用」静态文案（分不清没数据与加载失败）
    expect(screen.queryByText('待审列表不可用')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('恢复后的提案')).toBeTruthy();
    expect(screen.queryByText('proposals boom')).toBeNull();
    await waitFor(() => expect(mockListPendingReview).toHaveBeenCalledTimes(2));
  });

  it('学习成效拉取失败：展开健康度量见错误行，重试后恢复主数字', async () => {
    mockGetFlywheel.mockRejectedValueOnce(new Error('flywheel boom'));
    render(<MonitoringPage />);
    await openMetrics();

    expect(await screen.findByText('flywheel boom')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));

    await waitFor(() => expect(screen.getByTestId('flywheel-stat').textContent).toBe('67%'));
    expect(screen.queryByText('flywheel boom')).toBeNull();
    await waitFor(() => expect(mockGetFlywheel).toHaveBeenCalledTimes(2));
  });

  it('概览拉取失败：健康度量区错误行（证据台账同源三区块不凭空消失），重试后恢复', async () => {
    mockGetOverview.mockRejectedValueOnce(new Error('overview boom'));
    render(<MonitoringPage />);
    await openMetrics();

    expect(await screen.findByText('overview boom')).toBeTruthy();
    expect(screen.queryByText('证据台账（信任分层）')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('证据台账（信任分层）')).toBeTruthy();
    expect(screen.queryByText('overview boom')).toBeNull();
  });
});
