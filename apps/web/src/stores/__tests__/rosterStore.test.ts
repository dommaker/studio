// rosterStore 单测 — #346 roster 数据面 store 化
// 三端点（profiles / agents summary / channels）TTL 缓存 + single-flight 去重；
// agent.instance.status_changed / workunit.status_changed 就地更新唯一一份（合并 roster 与 ChannelRail 两副本语义）。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockListAllAgents, mockGetAgentSummary, mockListChannels, mockWuGet } = vi.hoisted(() => ({
  mockListAllAgents: vi.fn(),
  mockGetAgentSummary: vi.fn(),
  mockListChannels: vi.fn(),
  mockWuGet: vi.fn(),
}));

vi.mock('../../api/monitoring', () => ({
  monitoringApi: { getAgentSummary: mockGetAgentSummary },
}));

vi.mock('../../api/channel', () => ({
  channelApi: { listAllAgents: mockListAllAgents, list: mockListChannels },
}));

vi.mock('../../api/workunit', async () => {
  const actual = await vi.importActual('../../api/workunit');
  return { ...actual, workunitApi: { get: mockWuGet } };
});

import { useRosterStore, ROSTER_TTL_MS, workUnitToCurrentWorkUnit } from '../rosterStore';
import { useAuthStore } from '../authStore';

const profile = (overrides: Record<string, unknown> = {}) => ({
  id: 'p1', name: 'dev-agent', description: '', status: 'active', provider: 'claude', isOnline: true,
  ...overrides,
});

const instance = (overrides: Record<string, unknown> = {}) => ({
  id: 'i1', roleId: 'p1', name: 'dev-agent', status: 'active', currentWorkUnitId: 'wu-1',
  startedAt: '2026-08-01T00:00:00Z',
  currentWorkUnit: { id: 'wu-1', title: '实现登录接口', type: 'DEV', status: 'active', claimedAt: null },
  ...overrides,
});

function resetStore() {
  useRosterStore.setState({
    profiles: [], agents: [], channels: [],
    loading: false, error: null, forbidden: false,
    loadedAt: null, channelsLoadedOnce: false, agentsLoadedOnce: false, inflight: null,
    lastToken: null,
  });
}

/** 排空 store 内部 inflight promise（测试里手动驱动 ensureFresh 时用） */
async function drain() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('rosterStore ensureFresh — 三端点拉取与去重', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
    mockListAllAgents.mockResolvedValue({ data: { data: [profile()] } });
    mockGetAgentSummary.mockResolvedValue({
      data: { agents: [instance()], summary: { total: 1, idle: 0, active: 1, error: 0, terminated: 0 } },
    });
    mockListChannels.mockResolvedValue({ data: { data: [{ id: 'ch1', name: 'backend' }] } });
  });

  it('三端点各拉一次，切片落库', async () => {
    await useRosterStore.getState().ensureFresh();
    expect(mockListAllAgents).toHaveBeenCalledTimes(1);
    expect(mockGetAgentSummary).toHaveBeenCalledTimes(1);
    expect(mockListChannels).toHaveBeenCalledTimes(1);
    const s = useRosterStore.getState();
    expect(s.profiles).toHaveLength(1);
    expect(s.agents[0].id).toBe('i1');
    expect(s.channels).toEqual([{ id: 'ch1', name: 'backend' }]);
    expect(s.loadedAt).not.toBeNull();
    expect(s.error).toBeNull();
    expect(s.forbidden).toBe(false);
  });

  it('TTL 内重复调用零重拉；TTL 过期后重拉', async () => {
    vi.useFakeTimers();
    try {
      await useRosterStore.getState().ensureFresh();
      await useRosterStore.getState().ensureFresh();
      expect(mockGetAgentSummary).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(ROSTER_TTL_MS + 1);
      await useRosterStore.getState().ensureFresh();
      expect(mockGetAgentSummary).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('maxAgeMs:0 强制重拉（terminate 后等场景）', async () => {
    await useRosterStore.getState().ensureFresh();
    await useRosterStore.getState().ensureFresh({ maxAgeMs: 0 });
    expect(mockGetAgentSummary).toHaveBeenCalledTimes(2);
  });

  it('并发调用共享单飞（inflight）：同屏多消费方只发一轮请求', async () => {
    let resolveSummary!: (v: unknown) => void;
    mockGetAgentSummary.mockReturnValue(new Promise((r) => { resolveSummary = r; }));
    const p1 = useRosterStore.getState().ensureFresh();
    const p2 = useRosterStore.getState().ensureFresh();
    resolveSummary({ data: { agents: [instance()], summary: { total: 1, idle: 0, active: 1, error: 0, terminated: 0 } } });
    await Promise.all([p1, p2]);
    expect(mockGetAgentSummary).toHaveBeenCalledTimes(1);
    expect(mockListAllAgents).toHaveBeenCalledTimes(1);
  });

  it('force（maxAgeMs 0）不被在途旧 fetch 吞掉：发起新拉取，旧结果不落地', async () => {
    // 模拟 terminate 前已有别的消费方触发的慢 fetch 在途
    let resolveStale!: (v: unknown) => void;
    mockGetAgentSummary.mockReturnValueOnce(new Promise((r) => { resolveStale = r; }));
    const stale = useRosterStore.getState().ensureFresh();
    // terminate 完成 → 强拉（新负载：i2 idle），随后旧 fetch 才落地（旧负载：i1 active）
    mockGetAgentSummary.mockResolvedValue({ data: { agents: [instance({ id: 'i2', status: 'idle' })], summary: { total: 1, idle: 1, active: 0, error: 0, terminated: 0 } } });
    const p2 = useRosterStore.getState().ensureFresh({ maxAgeMs: 0 });
    resolveStale({ data: { agents: [instance({ status: 'active' })], summary: { total: 1, idle: 0, active: 1, error: 0, terminated: 0 } } });
    await Promise.all([stale, p2]);
    const s = useRosterStore.getState();
    // 强拉结果落地，被超越的旧 fetch 不回写
    expect(s.agents[0]?.id).toBe('i2');
    expect(mockGetAgentSummary).toHaveBeenCalledTimes(2);
    // inflight 锚点被清（下一次强拉可正常发起）
    await useRosterStore.getState().ensureFresh({ maxAgeMs: 0 });
    expect(mockGetAgentSummary).toHaveBeenCalledTimes(3);
  });

  it('切片独立：summary 挂了 profiles/channels 照常落库，error 记录', async () => {
    mockGetAgentSummary.mockRejectedValue(new Error('boom'));
    await useRosterStore.getState().ensureFresh();
    const s = useRosterStore.getState();
    expect(s.profiles).toHaveLength(1);
    expect(s.channels).toHaveLength(1);
    expect(s.agents).toEqual([]);
    expect(s.error).toBe('boom');
    expect(s.forbidden).toBe(false);
  });
});

describe('rosterStore ensureFresh — 403 终态与登录态切换', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
    mockListAllAgents.mockResolvedValue({ data: { data: [profile()] } });
    mockListChannels.mockResolvedValue({ data: { data: [] } });
  });

  it('summary 403 → forbidden 终态（不写 error），后续调用短路不再发请求', async () => {
    const err = Object.assign(new Error('Request failed with status code 403'), { response: { status: 403 } });
    mockGetAgentSummary.mockRejectedValue(err);
    await useRosterStore.getState().ensureFresh();
    expect(useRosterStore.getState().forbidden).toBe(true);
    expect(useRosterStore.getState().error).toBeNull();
    await useRosterStore.getState().ensureFresh({ maxAgeMs: 0 });
    expect(mockGetAgentSummary).toHaveBeenCalledTimes(1);
  });

  it('登录 token 变化解除 forbidden 终态（登出/换号后可恢复）', async () => {
    const err = Object.assign(new Error('Request failed with status code 403'), { response: { status: 403 } });
    mockGetAgentSummary.mockRejectedValue(err);
    await useRosterStore.getState().ensureFresh();
    expect(useRosterStore.getState().forbidden).toBe(true);

    mockGetAgentSummary.mockResolvedValue({
      data: { agents: [instance()], summary: { total: 1, idle: 0, active: 1, error: 0, terminated: 0 } },
    });
    useAuthStore.setState({ token: 'new-token' });
    await useRosterStore.getState().ensureFresh();
    const s = useRosterStore.getState();
    expect(s.forbidden).toBe(false);
    expect(s.agents).toHaveLength(1);
    useAuthStore.setState({ token: null });
  });
});

describe('rosterStore applyInstanceStatusEvent — 就地更新唯一一份（#346）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
    mockListAllAgents.mockResolvedValue({ data: { data: [profile()] } });
    mockGetAgentSummary.mockResolvedValue({
      data: { agents: [instance()], summary: { total: 1, idle: 0, active: 1, error: 0, terminated: 0 } },
    });
    mockListChannels.mockResolvedValue({ data: { data: [] } });
    mockWuGet.mockResolvedValue({ data: { id: 'wu-9', scope: '补查的任务', type: 'DEV', status: 'active', claimedAt: null } });
  });

  it('instanceId 命中：字段落加法语义（负载缺失键保留原值）', async () => {
    await useRosterStore.getState().ensureFresh();
    useRosterStore.getState().applyInstanceStatusEvent({ profileId: 'p1', instanceId: 'i1', status: 'error', lastError: 'health probe timeout', lastErrorAt: '2026-08-24T02:00:00Z' });
    const a = useRosterStore.getState().agents[0];
    expect(a.status).toBe('error');
    expect(a.lastError).toBe('health probe timeout');
    // 负载未带的键保留
    expect(a.currentWorkUnitId).toBe('wu-1');
    expect(a.currentWorkUnit?.title).toBe('实现登录接口');
  });

  it('roleId 兜底匹配（error 事件携带新 instanceId ≠ 列表 id）：就地更新且 id 切到新实例', async () => {
    await useRosterStore.getState().ensureFresh();
    useRosterStore.getState().applyInstanceStatusEvent({ profileId: 'p1', instanceId: 'i-new', status: 'error', currentWorkUnitId: null });
    const a = useRosterStore.getState().agents[0];
    expect(a.id).toBe('i-new');
    expect(a.status).toBe('error');
    expect(mockWuGet).not.toHaveBeenCalled();
  });

  it('负载带快照（含悬空 null）以负载为准，不发起补查', async () => {
    await useRosterStore.getState().ensureFresh();
    useRosterStore.getState().applyInstanceStatusEvent({
      profileId: 'p1', instanceId: 'i1', status: 'active', currentWorkUnitId: 'wu-9',
      currentWorkUnit: { id: 'wu-9', title: '负载里的任务', type: 'DEV', status: 'active', claimedAt: '2026-08-24T01:00:00Z' },
      channelId: 'ch1', pmo: { id: 'pm-1', pmoNumber: 'PMO-1', title: '登录' },
    });
    const a = useRosterStore.getState().agents[0];
    expect(a.currentWorkUnit?.title).toBe('负载里的任务');
    expect(a.channelId).toBe('ch1');
    expect(a.pmo?.pmoNumber).toBe('PMO-1');
    expect(mockWuGet).not.toHaveBeenCalled();
  });

  it('旧形状事件（无快照字段）任务切换清掉旧快照并发起补查写回', async () => {
    await useRosterStore.getState().ensureFresh();
    useRosterStore.getState().applyInstanceStatusEvent({ profileId: 'p1', instanceId: 'i1', status: 'active', currentWorkUnitId: 'wu-9' });
    const a = useRosterStore.getState().agents[0];
    expect(a.currentWorkUnit).toBeNull();
    expect(mockWuGet).toHaveBeenCalledWith('wu-9');
    await drain();
    expect(useRosterStore.getState().agents[0].currentWorkUnit?.title).toBe('补查的任务');
  });

  it('未匹配任何实例 → 合成条目插头部（ChannelRail #313 语义，轮询不再承担发现）', async () => {
    await useRosterStore.getState().ensureFresh();
    useRosterStore.getState().applyInstanceStatusEvent({ profileId: 'r-unknown', instanceId: 'a-unknown', name: 'ghost', status: 'active', currentWorkUnitId: null });
    const agents = useRosterStore.getState().agents;
    expect(agents).toHaveLength(2);
    expect(agents[0].id).toBe('a-unknown');
    expect(agents[0].name).toBe('ghost');
    expect(agents[0].roleId).toBe('r-unknown');
    expect(agents[0].status).toBe('active');
  });

  it('profileId 与 instanceId 都缺 → 忽略', async () => {
    await useRosterStore.getState().ensureFresh();
    useRosterStore.getState().applyInstanceStatusEvent({ status: 'idle' });
    expect(useRosterStore.getState().agents).toHaveLength(1);
  });
});

describe('rosterStore applyWorkunitStatusEvent / patchAgentCurrentWorkUnit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
    mockListAllAgents.mockResolvedValue({ data: { data: [profile()] } });
    mockGetAgentSummary.mockResolvedValue({
      data: { agents: [instance()], summary: { total: 1, idle: 0, active: 1, error: 0, terminated: 0 } },
    });
    mockListChannels.mockResolvedValue({ data: { data: [] } });
  });

  it('currentWorkUnitId 命中：快照 title/type/status 落加法更新', async () => {
    await useRosterStore.getState().ensureFresh();
    useRosterStore.getState().applyWorkunitStatusEvent({ id: 'wu-1', scope: '实现登录接口 v2', status: 'in_review' });
    const cw = useRosterStore.getState().agents[0].currentWorkUnit!;
    expect(cw.title).toBe('实现登录接口 v2');
    expect(cw.status).toBe('in_review');
    expect(cw.type).toBe('DEV');
  });

  it('currentWorkUnit.id 命中（currentWorkUnitId 尚未跟上）也更新', async () => {
    await useRosterStore.getState().ensureFresh();
    useRosterStore.setState({ agents: [instance({ currentWorkUnitId: null })] });
    useRosterStore.getState().applyWorkunitStatusEvent({ id: 'wu-1', status: 'done' });
    expect(useRosterStore.getState().agents[0].currentWorkUnit?.status).toBe('done');
  });

  it('不归属任何实例的 WU → 不动名册', async () => {
    await useRosterStore.getState().ensureFresh();
    useRosterStore.getState().applyWorkunitStatusEvent({ id: 'wu-elsewhere', status: 'done' });
    expect(useRosterStore.getState().agents[0].currentWorkUnit?.id).toBe('wu-1');
  });

  it('patchAgentCurrentWorkUnit：instanceId 且 currentWorkUnitId 双匹配才写回', async () => {
    await useRosterStore.getState().ensureFresh();
    useRosterStore.getState().patchAgentCurrentWorkUnit('i1', { id: 'wu-1', title: '补查', type: 'DEV', status: 'active', claimedAt: null });
    expect(useRosterStore.getState().agents[0].currentWorkUnit?.title).toBe('补查');

    useRosterStore.getState().patchAgentCurrentWorkUnit('i1', { id: 'wu-别的', title: 'x', type: '', status: '', claimedAt: null });
    expect(useRosterStore.getState().agents[0].currentWorkUnit?.title).toBe('补查');
  });

  it('appendChannel：创建频道后追加进切片', async () => {
    useRosterStore.getState().appendChannel({ id: 'ch-9', name: 'ops', type: 'system' } as never);
    expect(useRosterStore.getState().channels).toHaveLength(1);
    expect(useRosterStore.getState().channelsLoadedOnce).toBe(true);
  });
});

describe('workUnitToCurrentWorkUnit', () => {
  it('WU 详情 → 卡片快照映射（scope→title）', () => {
    expect(workUnitToCurrentWorkUnit({ id: 'wu-1', scope: '任务', type: 'DEV', status: 'active', claimedAt: 't' } as never)).toEqual({
      id: 'wu-1', title: '任务', type: 'DEV', status: 'active', claimedAt: 't',
    });
  });
});
