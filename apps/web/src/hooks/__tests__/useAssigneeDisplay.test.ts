// useAssigneeDisplay / resolveAssignee 单测 — #290（清单 #24）负责人 UUID → 角色名
// 解析顺序：认领快照 roleId → 运行实例摘要 → profile 直配 → null
// 2026-09-10：离线实例档案点查（原②）已删除——实例 terminated 后被物理回收，
// 点查是 100% doomed 404；认领时 roleId 已冗余快照到 WU（assigneeRoleId），无需点查。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetAgentSummary, mockGetAgentInstance, mockListAllAgents, mockListChannels } = vi.hoisted(() => ({
  mockGetAgentSummary: vi.fn(),
  mockGetAgentInstance: vi.fn(),
  mockListAllAgents: vi.fn(),
  mockListChannels: vi.fn(),
}));

vi.mock('../../api/monitoring', () => ({
  monitoringApi: { getAgentSummary: mockGetAgentSummary, getAgentInstance: mockGetAgentInstance },
}));
vi.mock('../../api/channel', () => ({
  channelApi: { listAllAgents: mockListAllAgents, list: mockListChannels },
}));

import { resolveAssignee } from '../useAssigneeDisplay';
import { useRosterStore } from '../../stores/rosterStore';

const summaryWith = (agents: Array<{ id: string; roleId: string; name: string }>) =>
  Promise.resolve({
    data: {
      agents: agents.map(a => ({ ...a, status: 'idle', currentWorkUnitId: null, startedAt: '2026-08-24T00:00:00Z' })),
      summary: { total: agents.length, idle: agents.length, active: 0, error: 0, terminated: 0 },
    },
  });
const EMPTY_SUMMARY = summaryWith([]);

describe('resolveAssignee — #290 负责人解析顺序', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // #346：summary/profiles 面读 rosterStore，每测重置（避免 TTL 缓存跨测串味）
    useRosterStore.setState({
      profiles: [], agents: [], channels: [],
      loading: false, error: null, forbidden: false,
      loadedAt: null, channelsLoadedOnce: false, agentsLoadedOnce: false,
      inflight: null, lastToken: null,
    });
    mockGetAgentSummary.mockReturnValue(EMPTY_SUMMARY);
    mockGetAgentInstance.mockRejectedValue(new Error('404'));
    mockListAllAgents.mockResolvedValue({ data: { data: [] } });
    mockListChannels.mockResolvedValue({ data: { data: [] } });
  });

  it('⓪ assigneeRoleId 认领快照命中 profile → 直接返回角色名，不发任何实例点查', async () => {
    // 认领时 roleId 已冗余到 WU：实例被回收后仍能解析（snapshot 分支的存在意义）
    mockListAllAgents.mockResolvedValue({ data: { data: [{ id: 'role-coder', name: 'Coder' }] } });
    await expect(resolveAssignee('inst-dead', 'role-coder')).resolves.toEqual({ name: 'Coder', roleId: 'role-coder' });
    expect(mockGetAgentInstance).not.toHaveBeenCalled();
  });

  it('⓪ 快照优先于运行实例摘要之外的回退：快照 roleId 与 assigneeId 无关联时也按快照解析', async () => {
    mockListAllAgents.mockResolvedValue({ data: { data: [{ id: 'role-analyst', name: 'Analyst' }] } });
    await expect(resolveAssignee('inst-old', 'role-analyst')).resolves.toEqual({ name: 'Analyst', roleId: 'role-analyst' });
    expect(mockGetAgentInstance).not.toHaveBeenCalled();
  });

  it('⓪ 快照 roleId 查无此 profile → 继续走 ①/①.5，查不到落 null', async () => {
    await expect(resolveAssignee('inst-x', 'role-gone')).resolves.toBeNull();
  });

  it('① 运行实例摘要命中 → {name, roleId}，不再发起回退请求', async () => {
    mockGetAgentSummary.mockReturnValue(summaryWith([{ id: 'inst-1', roleId: 'role-coder', name: 'coder-01' }]));
    await expect(resolveAssignee('inst-1')).resolves.toEqual({ name: 'coder-01', roleId: 'role-coder' });
    // #346：ensureFresh 拉三端点（含 profiles）；实例档案点查已从解析器删除，任何分支都不应发起
    expect(mockGetAgentInstance).not.toHaveBeenCalled();
  });

  it('无快照的死实例 id → resolve null，且不发起实例档案点查（404 防回归）', async () => {
    // 实例 terminated 后档案被物理回收，旧版②段点查必 404；删除后此路径零请求
    await expect(resolveAssignee('inst-gone')).resolves.toBeNull();
    expect(mockGetAgentInstance).not.toHaveBeenCalled();
  });

  it('①.5 assigneeId 双语义：未认领指名 WU 的 assigneeId=profile id → 直配 profile 名，不发实例档案点查（消除必死 404）', async () => {
    // 2026-09-10：workunit assigneeId 双语义（workunit/CONTEXT.md）——unassigned 时=被指名 profile.id，
    // 认领后才改写为 instance.id。旧解析器只认 instance id，指名 WU 每行必刷一次 404 且退化为 UUID。
    mockListAllAgents.mockResolvedValue({ data: { data: [{ id: 'role-studio', name: 'studio' }] } });
    await expect(resolveAssignee('role-studio')).resolves.toEqual({ name: 'studio', roleId: 'role-studio' });
    expect(mockGetAgentInstance).not.toHaveBeenCalled();
  });

  it('①.5 profile 直配不抢占运行实例：①仍优先（实例名精度高于角色名）', async () => {
    mockGetAgentSummary.mockReturnValue(summaryWith([{ id: 'inst-1', roleId: 'role-coder', name: 'coder-01' }]));
    mockListAllAgents.mockResolvedValue({ data: { data: [{ id: 'role-coder', name: 'Coder' }] } });
    // 传 instance id：①命中（实例名 coder-01），不走 profile 直配
    await expect(resolveAssignee('inst-1')).resolves.toEqual({ name: 'coder-01', roleId: 'role-coder' });
  });

  it('③ 各段都查不到 → null（调用方回退短 UUID）', async () => {
    await expect(resolveAssignee('inst-unknown')).resolves.toBeNull();
  });

  it('摘要接口失败按空列表降级，仍不发起实例档案点查', async () => {
    mockGetAgentSummary.mockRejectedValue(new Error('network'));
    await expect(resolveAssignee('inst-off')).resolves.toBeNull();
    expect(mockGetAgentInstance).not.toHaveBeenCalled();
  });

  it('并发解析共享在途请求（REQ 链路一屏多节点不放大调用）', async () => {
    mockGetAgentSummary.mockReturnValue(summaryWith([{ id: 'inst-1', roleId: 'r1', name: 'coder-01' }]));
    await Promise.all([resolveAssignee('inst-1'), resolveAssignee('inst-2'), resolveAssignee('inst-3')]);
    expect(mockGetAgentSummary).toHaveBeenCalledTimes(1);
  });
});
