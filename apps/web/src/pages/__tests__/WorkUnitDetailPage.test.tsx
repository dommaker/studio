// Contract test: WorkUnitDetailPage — /workunits/:id（#396 重构：四站 stepper + 左右分栏 + ExecutionFlow + Token 图表化）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return { ...actual, default: actual };
});

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }: { children: React.ReactNode; to: string; [k: string]: unknown }) =>
    React.createElement('a', { href: to, ...rest }, children),
  useParams: () => ({ id: 'wu-1' }),
  useNavigate: () => vi.fn(),
}));

const { mockWuGet, mockReqGet, mockReqGetChain, mockProjectGet, mockChannelList, mockAgentSummary, mockGetAgentInstance, mockListAllAgents, mockResume, mockClose, mockTransitionStatus, mockReviewPassed, mockReviewRejected, mockGetTreeTokens } = vi.hoisted(() => ({
  mockWuGet: vi.fn(),
  mockReqGet: vi.fn(),
  mockReqGetChain: vi.fn(),
  mockProjectGet: vi.fn(),
  mockChannelList: vi.fn(),
  mockAgentSummary: vi.fn(),
  mockGetAgentInstance: vi.fn(),
  mockListAllAgents: vi.fn(),
  mockResume: vi.fn(),
  mockClose: vi.fn(),
  mockTransitionStatus: vi.fn(),
  mockReviewPassed: vi.fn(),
  mockReviewRejected: vi.fn(),
  mockGetTreeTokens: vi.fn(),
}));

vi.mock('../../api/workunit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/workunit')>();
  return {
    ...actual,
    workunitApi: {
      ...actual.workunitApi,
      get: mockWuGet,
      listExecutionStepEvents: vi.fn().mockResolvedValue({ data: { events: [], total: 0 } }),
      getMessages: vi.fn().mockResolvedValue({ data: { data: [] } }),
      resume: mockResume,
      close: mockClose,
      transitionStatus: mockTransitionStatus,
      reviewPassed: mockReviewPassed,
      reviewRejected: mockReviewRejected,
      getTreeTokens: mockGetTreeTokens,
    },
  };
});

vi.mock('../../api/requirements', () => ({
  requirementApi: { get: mockReqGet, getChain: mockReqGetChain },
}));

vi.mock('../../api/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/index')>();
  return { ...actual, projectApi: { ...actual.projectApi, get: mockProjectGet } };
});

vi.mock('../../api/channel', () => ({
  channelApi: {
    list: mockChannelList,
    // #284：in_review analysis「通过」弹 AnalysisApproveDialog（channelId 非空时拉成员候选）
    get: vi.fn().mockResolvedValue({ data: { data: { id: 'ch-1', members: '[]' } } }),
    listAllAgents: mockListAllAgents,
  },
}));

vi.mock('../../api/monitoring', () => ({
  monitoringApi: { getAgentSummary: mockAgentSummary, getAgentInstance: mockGetAgentInstance },
}));

// SSE context — 测试无 WebSocketProvider，置空（ExecutionFlow 经此订阅步事件/重连）
vi.mock('../../api/websocketHooks', () => ({
  useWebSocketContext: () => ({ onEvent: () => () => {}, onReconnect: () => () => {} }),
}));

// #174: TranscriptViewer 桩（组件自身契约在 __tests__/TranscriptViewer.test.tsx 覆盖）
vi.mock('../../components/workunit/TranscriptViewer', () => ({
  TranscriptViewer: ({ workUnitId }: { workUnitId: string }) =>
    React.createElement('div', { 'data-testid': 'transcript-viewer' }, workUnitId),
}));

import { WorkUnitDetailPage } from '../WorkUnitDetailPage';

const baseWu = {
  id: 'wu-1',
  parentId: null,
  dependsOn: '',
  type: 'task',
  scope: '实现登录功能',
  assigneeId: 'inst-abcdefgh1234',
  status: 'done',
  failureType: null,
  retryCount: 0,
  timeoutAt: null,
  channelId: 'ch-1',
  reqId: 'REQ-0042',
  metadata: JSON.stringify({
    title: '登录功能开发',
    pmoId: 'proj-1',
    attestations: {
      l1: { verdict: 'approved', by: 'profile-aaa', at: '2026-07-30T10:00:00Z', kind: 'verify' },
      l2: { verdict: 'approved', by: 'profile-bbb', at: '2026-07-30T11:00:00Z', kind: 'agent-review', summary: 'LGTM' },
      l3: { verdict: 'approved', by: 'human-ccc', at: '2026-07-30T12:00:00Z', kind: 'human-confirm' },
    },
  }),
  createdAt: '2026-07-30T09:00:00Z',
  updatedAt: '2026-07-30T12:00:00Z',
  claimedAt: '2026-07-30T09:30:00Z',
  completedAt: '2026-07-30T12:00:00Z',
};

const treeTokenReport = {
  rootId: 'wu-1',
  rootTotal: 12000,
  budgetRemaining: 8000,
  nodes: [
    { workUnitId: 'wu-1', profileName: 'coder-01', status: 'done', injectedTokens: 5000, executionTokens: 7000, totalTokens: 12000 },
  ],
};

describe('WorkUnitDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWuGet.mockResolvedValue({ data: baseWu });
    mockProjectGet.mockResolvedValue({ data: { id: 'proj-1', pmoNumber: 'PM-0007', title: '登录项目' } });
    mockReqGet.mockResolvedValue({ data: { success: true, data: { id: 'REQ-0042', projectId: 'proj-2' } } });
    mockChannelList.mockResolvedValue({ data: { success: true, data: [{ id: 'ch-1', name: '主频道' }] } });
    mockAgentSummary.mockResolvedValue({
      data: {
        agents: [{ id: 'inst-abcdefgh1234', roleId: 'role-1', name: 'coder-01', status: 'idle', currentWorkUnitId: null, startedAt: '2026-07-30T08:00:00Z' }],
        summary: { total: 1, idle: 1, active: 0, error: 0, terminated: 0 },
      },
    });
    mockReqGetChain.mockResolvedValue({
      data: { success: true, data: { requirement: { id: 'REQ-0042', seq: 42, title: '登录需求', status: 'in-progress', createdAt: '2026-07-29T09:00:00Z', createdBy: 'manual' }, workunits: [] } },
    });
    mockResume.mockResolvedValue({ data: { ...baseWu, status: 'active' } });
    mockClose.mockResolvedValue({ data: { ...baseWu, status: 'closed' } });
    mockTransitionStatus.mockResolvedValue({ data: { ...baseWu, status: 'unassigned' } });
    mockReviewPassed.mockResolvedValue({ data: { ...baseWu, status: 'done' } });
    mockReviewRejected.mockResolvedValue({ data: { ...baseWu, status: 'active' } });
    mockGetTreeTokens.mockResolvedValue({ data: treeTokenReport });
    // #290（清单 #24）：负责人解析回退级默认「查无」——实例档案 404、profile 列表空
    mockGetAgentInstance.mockRejectedValue(new Error('404'));
    mockListAllAgents.mockResolvedValue({ data: { data: [] } });
  });

  it('加载态：WU 未返回时显示加载中', () => {
    mockWuGet.mockReturnValue(new Promise(() => {}));
    render(<WorkUnitDetailPage />);
    expect(screen.getByText('加载中...')).toBeDefined();
  });

  it('错误态：加载失败显示错误信息', async () => {
    mockWuGet.mockRejectedValue(new Error('Not Found'));
    render(<WorkUnitDetailPage />);
    expect(await screen.findByText(/加载失败: Not Found/)).toBeDefined();
  });

  it('Header：标题取 metadata.title，含类型 chip / 状态 pill；头栏不再有「Token 开销」按钮（入口挪左栏事实行）', async () => {
    render(<WorkUnitDetailPage />);
    expect(await screen.findByText('登录功能开发')).toBeDefined();
    expect(screen.getByText('任务')).toBeDefined();
    expect(screen.getAllByText('已完成').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Token 开销' })).toBeNull();
  });

  it('四站 stepper：待领取→进行中→待验收→完成全渲染；done WU 各站时间戳正确（待验收口径 = l2.at）', async () => {
    render(<WorkUnitDetailPage />);
    await screen.findByText('登录功能开发');
    expect(screen.getByText('待领取')).toBeDefined();
    expect(screen.getByText('进行中')).toBeDefined();
    expect(screen.getByText('待验收')).toBeDefined();
    expect(screen.getByText('完成')).toBeDefined();
    // 待领取=创建 09:00 / 进行中=认领 09:30 / 待验收=l2.at 11:00 / 完成=completedAt 12:00
    expect(screen.getAllByText('07/30 09:00').length).toBeGreaterThan(0);
    expect(screen.getAllByText('07/30 09:30').length).toBeGreaterThan(0);
    expect(screen.getAllByText('07/30 11:00').length).toBeGreaterThan(0);
    expect(screen.getAllByText('07/30 12:00').length).toBeGreaterThan(0);
  });

  it('生命周期关键事件 = stepper 下横排 chip（证据 L1/L2/L3 事件）', async () => {
    render(<WorkUnitDetailPage />);
    await screen.findByText('登录功能开发');
    expect(screen.getByText('L1 自动验证通过')).toBeDefined();
    expect(screen.getByText('L2 Agent 评审通过')).toBeDefined();
    expect(screen.getByText('L3 人工验收通过')).toBeDefined();
  });

  it('分栏骨架：左栏 关键事实→证据台账，右栏 执行过程→会话原文（节标题有序）', async () => {
    const { container } = render(<WorkUnitDetailPage />);
    await screen.findByText('登录功能开发');
    const titles = [...container.querySelectorAll('.wu-detail-sec-title')].map(el => el.textContent);
    expect(titles).toEqual(['关键事实', '证据台账', '执行过程', '会话原文']);
    expect(container.querySelector('.wu-detail-rail')).not.toBeNull();
    expect(container.querySelector('.wu-detail-content')).not.toBeNull();
  });

  it('关键事实卡：PMO/REQ/频道/认领人/时间/Token 行齐备且链接正确', async () => {
    render(<WorkUnitDetailPage />);
    // PMO 行（创建期戳 metadata.pmoId 直查）→ /pmo/project/:id
    const pmoLink = await screen.findByText('PM-0007');
    expect(pmoLink.closest('a')?.getAttribute('href')).toBe('/pmo/project/proj-1');
    // REQ 行 → 打开 RequirementChainPanel（非链接）
    expect(screen.getByText('REQ-0042')).toBeDefined();
    // 频道行 → /channels/:channelId
    const channelLink = await screen.findByText('# 主频道');
    expect(channelLink.closest('a')?.getAttribute('href')).toBe('/channels/ch-1');
    // 认领人行 → /agents/:roleId
    const agentLink = await screen.findByText('@coder-01');
    expect(agentLink.closest('a')?.getAttribute('href')).toBe('/agents/role-1');
    // 时间行 + Token 行（mono 总耗，整行可点开图表面板）
    expect(screen.getByText('创建')).toBeDefined();
    expect(screen.getByText('认领')).toBeDefined();
    expect(screen.getByText('Token')).toBeDefined();
    expect(await screen.findByRole('button', { name: /12\.0k/ })).toBeDefined();
  });

  it('Token 事实行点击打开图表面板（双 stat + 堆叠条）', async () => {
    render(<WorkUnitDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: /12\.0k/ }));
    expect(await screen.findByText('协作树 Token 开销')).toBeDefined();
    expect(screen.getByText('树总耗')).toBeDefined();
    expect(screen.getByText('预算剩余')).toBeDefined();
  });

  it('PMO 解析回落：metadata 无 pmoId 时经 reqId → requirement.projectId 解析', async () => {
    mockWuGet.mockResolvedValue({
      data: { ...baseWu, metadata: JSON.stringify({ title: '登录功能开发' }) },
    });
    mockProjectGet.mockImplementation((pid: string) =>
      Promise.resolve({ data: { id: pid, pmoNumber: 'PM-0009', title: '回落项目' } }),
    );
    render(<WorkUnitDetailPage />);
    const pmoLink = await screen.findByText('PM-0009');
    expect(pmoLink.closest('a')?.getAttribute('href')).toBe('/pmo/project/proj-2');
    expect(mockReqGet).toHaveBeenCalledWith('REQ-0042');
    expect(mockProjectGet).toHaveBeenCalledWith('proj-2');
  });

  it('关键事实卡：无 reqId/channelId/assigneeId/PMO 时归属行不渲染（创建/Token 行仍在）', async () => {
    mockWuGet.mockResolvedValue({
      data: { ...baseWu, reqId: null, channelId: null, assigneeId: null, metadata: '{}' },
    });
    render(<WorkUnitDetailPage />);
    await screen.findByText('实现登录功能'); // scope 兜底标题（metadata 无 title）
    await waitFor(() => expect(mockAgentSummary).not.toHaveBeenCalled());
    expect(screen.queryByText('PMO')).toBeNull();
    expect(screen.queryByText('认领人')).toBeNull();
    expect(screen.queryByText('频道')).toBeNull();
    expect(screen.getByText('创建')).toBeDefined();
  });

  it('认领 agent 匹配不到：显示 instance id 前 8 位且不可点', async () => {
    mockAgentSummary.mockResolvedValue({
      data: { agents: [], summary: { total: 0, idle: 0, active: 0, error: 0, terminated: 0 } },
    });
    render(<WorkUnitDetailPage />);
    const chip = await screen.findByText('@inst-abc');
    expect(chip.closest('a')).toBeNull();
  });

  // #290（清单 #24）：负责人解析三级口径——运行实例 → 离线实例 profile → 短 UUID
  it('#290 认领 agent 为离线实例：经实例档案 roleId + profile 名解析，仍链到角色页', async () => {
    mockAgentSummary.mockResolvedValue({
      data: { agents: [], summary: { total: 0, idle: 0, active: 0, error: 0, terminated: 0 } },
    });
    mockGetAgentInstance.mockResolvedValue({ data: { id: 'inst-abcdefgh1234', roleId: 'role-9', status: 'terminated' } });
    mockListAllAgents.mockResolvedValue({ data: { data: [{ id: 'role-9', name: 'Analyst' }] } });
    render(<WorkUnitDetailPage />);
    const chip = await screen.findByText('@Analyst');
    expect(chip.closest('a')?.getAttribute('href')).toBe('/agents/role-9');
  });

  it('证据台账：L1/L2/L3 三层紧凑行（drawer 变体）与评审结论', async () => {
    render(<WorkUnitDetailPage />);
    expect((await screen.findAllByText('证据台账')).length).toBeGreaterThan(0);
    expect(screen.getByText('L1 自动验证')).toBeDefined();
    expect(screen.getByText('L2 Agent 评审')).toBeDefined();
    expect(screen.getByText('L3 人工验收')).toBeDefined();
    expect(screen.getByText(/✓ verify · profile-a/)).toBeDefined();
    expect(screen.getByText(/✓ agent-review · profile-b/)).toBeDefined();
    expect(screen.getByText(/✓ human-confirm · human-cc/)).toBeDefined();
    expect(screen.getByText('评审结论：LGTM')).toBeDefined();
  });

  it('证据台账：存量 WU（无 attestations）显示未介入说明', async () => {
    mockWuGet.mockResolvedValue({ data: { ...baseWu, metadata: '{}' } });
    render(<WorkUnitDetailPage />);
    expect(await screen.findByText('存量 WU，证据模型未介入（按存储状态展示）')).toBeDefined();
  });

  it('#174: 执行过程 section 之后挂 TranscriptViewer（传 WU id）', async () => {
    render(<WorkUnitDetailPage />);
    await screen.findByText('登录功能开发');
    expect(await screen.findByTestId('transcript-viewer')).toHaveTextContent('wu-1');
  });

  it('REQ chip 点击打开 REQ 全链路弹窗', async () => {
    render(<WorkUnitDetailPage />);
    fireEvent.click(await screen.findByText('REQ-0042'));
    expect(await screen.findByText(/REQ 全链路 · REQ-0042/)).toBeDefined();
    expect(await screen.findByText('登录需求')).toBeDefined();
  });

  it('#185（决策 #87 D4）：blocked 卡住型 WU 显示处置组件（继续执行/关闭任务），点继续执行调 resume 并重拉；stepper 下出阻塞 chip', async () => {
    mockWuGet.mockResolvedValue({
      data: {
        ...baseWu,
        status: 'blocked',
        completedAt: null,
        metadata: JSON.stringify({ title: '登录功能开发', blockReason: 'stuck: 连续 3 步无进展' }),
      },
    });
    render(<WorkUnitDetailPage />);
    // 关键事件 chip：阻塞
    expect(await screen.findByText('阻塞')).toBeDefined();
    const resumeBtn = await screen.findByRole('button', { name: '继续执行' });
    expect(screen.getByRole('button', { name: '关闭任务' })).toBeDefined();
    fireEvent.click(resumeBtn);
    await waitFor(() => expect(mockResume).toHaveBeenCalledWith('wu-1'));
    // 动作成功后 onChanged 触发重拉详情
    await waitFor(() => expect(mockWuGet.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('#185（决策 #87 D3）：blocked NEED_INPUT 型不显示「继续执行」，仅「关闭任务」；挂起 chip 带问题 detail', async () => {
    mockWuGet.mockResolvedValue({
      data: {
        ...baseWu,
        status: 'blocked',
        completedAt: null,
        metadata: JSON.stringify({ title: '登录功能开发', waitingForInput: true, waitingQuestion: '用 OAuth 吗？' }),
      },
    });
    render(<WorkUnitDetailPage />);
    await screen.findByRole('button', { name: '关闭任务' });
    expect(screen.queryByRole('button', { name: '继续执行' })).toBeNull();
    expect(screen.getByText('挂起等待输入')).toBeDefined();
  });

  it('#116：metadata.blockedBy/ac 非空 → 依赖清单（含各自状态与「找不到这张单」）+ 验收标准', async () => {
    mockWuGet.mockImplementation((id: string) => {
      if (id === 'wu-1') {
        return Promise.resolve({
          data: {
            ...baseWu,
            metadata: JSON.stringify({
              title: '登录功能开发',
              pmoId: 'proj-1',
              blockedBy: ['wu-dep-1', 'wu-gone'],
              ac: ['AC1 单测通过', 'AC2 类型检查零错误'],
            }),
          },
        });
      }
      if (id === 'wu-dep-1') {
        return Promise.resolve({ data: { id, status: 'done', scope: '依赖任务一', metadata: null } });
      }
      return Promise.reject(new Error('404'));
    });
    render(<WorkUnitDetailPage />);

    // 依赖行：标题 + 跳详情页链接；done 依赖状态 chip（Header pill 之外新增一处）
    const depLink = await screen.findByText('依赖任务一');
    expect(depLink.closest('a')?.getAttribute('href')).toBe('/workunits/wu-dep-1');
    expect(screen.getAllByText('已完成').length).toBeGreaterThanOrEqual(2);
    // 缺失 id 保守按未了结展示
    expect(screen.getByText('找不到这张单')).toBeDefined();
    // ac 验收标准逐条展示
    expect(screen.getByText('AC1 单测通过')).toBeDefined();
    expect(screen.getByText('AC2 类型检查零错误')).toBeDefined();
  });

  it('#116：无 blockedBy / ac → 不渲染「依赖与验收」节', async () => {
    render(<WorkUnitDetailPage />);
    await screen.findByText('登录功能开发');
    expect(screen.queryByText('依赖与验收')).toBeNull();
  });

  it('#163 T8-E2：metadata.opportunities 非空 → 左栏「巡检机会」节渲染', async () => {
    mockWuGet.mockResolvedValue({
      data: {
        ...baseWu,
        metadata: JSON.stringify({
          title: '登录功能开发',
          opportunities: [{ id: 'opp-1', problem: '重复拷贝', suggestion: '收口为工具函数', status: 'pending' }],
        }),
      },
    });
    render(<WorkUnitDetailPage />);
    expect(await screen.findByText('巡检机会')).toBeDefined();
  });

  it('闸门动作节按状态条件渲染：done WU 不渲染', async () => {
    render(<WorkUnitDetailPage />);
    await screen.findByText('登录功能开发');
    expect(screen.queryByText('闸门动作')).toBeNull();
  });

  // #284（决策 #250 D1/F7-F9）：详情页（「新页面打开」落点）补齐闸门入口，与列表行/抽屉一致
  it('#284：pending → 闸门动作节出「确认（进待认领）」调 transitionStatus(unassigned) 并重拉详情；人闸 chip 上 stepper 下', async () => {
    mockWuGet.mockResolvedValue({
      data: { ...baseWu, status: 'pending', completedAt: null, metadata: JSON.stringify({ title: '登录功能开发' }) },
    });
    render(<WorkUnitDetailPage />);
    expect(await screen.findByText('闸门动作')).toBeDefined();
    expect(screen.getByText(/待确认人闸/)).toBeDefined();
    fireEvent.click(screen.getByText('确认（进待认领）'));
    await waitFor(() => expect(mockTransitionStatus).toHaveBeenCalledWith('wu-1', 'unassigned'));
    await waitFor(() => expect(mockWuGet.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('#284：in_review task → 通过直调 reviewPassed；拒绝带原因调 reviewRejected（与列表行一致）', async () => {
    mockWuGet.mockResolvedValue({
      data: { ...baseWu, status: 'in_review', completedAt: null, metadata: JSON.stringify({ title: '登录功能开发' }) },
    });
    render(<WorkUnitDetailPage />);

    fireEvent.click(await screen.findByText('通过（审查闸门）'));
    await waitFor(() => expect(mockReviewPassed).toHaveBeenCalledWith('wu-1', undefined, undefined));

    fireEvent.click(screen.getByText('拒绝'));
    fireEvent.change(screen.getByPlaceholderText(/拒绝原因/), { target: { value: '实现不符合预期' } });
    fireEvent.click(screen.getByText('确认拒绝'));
    await waitFor(() => expect(mockReviewRejected).toHaveBeenCalledWith('wu-1', '实现不符合预期'));
  });

  it('#284：in_review analysis → 通过弹确认弹窗（预填逻辑不变），确认后 summary 随 reviewPassed 回传', async () => {
    mockWuGet.mockResolvedValue({
      data: {
        ...baseWu,
        type: 'analysis',
        status: 'in_review',
        completedAt: null,
        metadata: JSON.stringify({ title: '分析单', analysisDestination: '目标', analysisFog: ['问题1'] }),
      },
    });
    render(<WorkUnitDetailPage />);

    fireEvent.click(await screen.findByText('通过（审查闸门）'));
    const textarea = await screen.findByPlaceholderText(/DESTINATION/) as HTMLTextAreaElement;
    expect(textarea.value).toBe('DESTINATION: 目标\nFOG: 问题1');
    expect(mockReviewPassed).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('确认通过'));
    await waitFor(() => expect(mockReviewPassed).toHaveBeenCalledWith('wu-1', 'DESTINATION: 目标\nFOG: 问题1', undefined));
  });
});
