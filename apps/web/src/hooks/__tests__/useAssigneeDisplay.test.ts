// useAssigneeDisplay / resolveAssignee 单测 — #290（清单 #24）负责人 UUID → 角色名
// 解析顺序：运行实例摘要 → 离线实例档案 roleId + profile 名 → legacy profile 直配 → null
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

  it('① 运行实例摘要命中 → {name, roleId}，不再发起回退请求', async () => {
    mockGetAgentSummary.mockReturnValue(summaryWith([{ id: 'inst-1', roleId: 'role-coder', name: 'coder-01' }]));
    await expect(resolveAssignee('inst-1')).resolves.toEqual({ name: 'coder-01', roleId: 'role-coder' });
    // #346：ensureFresh 拉三端点（含 profiles）；回退的点查 getAgentInstance 不应发起
    expect(mockGetAgentInstance).not.toHaveBeenCalled();
  });

  it('② 离线实例：摘要未命中 → 实例档案拿 roleId → profile 拿名字', async () => {
    mockGetAgentInstance.mockResolvedValue({ data: { id: 'inst-off', roleId: 'role-analyst', status: 'terminated' } });
    mockListAllAgents.mockResolvedValue({ data: { data: [{ id: 'role-analyst', name: 'Analyst' }] } });
    await expect(resolveAssignee('inst-off')).resolves.toEqual({ name: 'Analyst', roleId: 'role-analyst' });
  });

  it('② 实例档案 404 → 回退 null（不抛错）', async () => {
    await expect(resolveAssignee('inst-gone')).resolves.toBeNull();
  });

  it('③ 两级都查不到 → null（调用方回退短 UUID）', async () => {
    await expect(resolveAssignee('inst-unknown')).resolves.toBeNull();
  });

  it('摘要接口失败按空列表降级，仍走实例档案回退', async () => {
    mockGetAgentSummary.mockRejectedValue(new Error('network'));
    mockGetAgentInstance.mockResolvedValue({ data: { id: 'inst-off', roleId: 'role-analyst', status: 'terminated' } });
    mockListAllAgents.mockResolvedValue({ data: { data: [{ id: 'role-analyst', name: 'Analyst' }] } });
    await expect(resolveAssignee('inst-off')).resolves.toEqual({ name: 'Analyst', roleId: 'role-analyst' });
  });

  it('并发解析共享在途请求（REQ 链路一屏多节点不放大调用）', async () => {
    mockGetAgentSummary.mockReturnValue(summaryWith([{ id: 'inst-1', roleId: 'r1', name: 'coder-01' }]));
    await Promise.all([resolveAssignee('inst-1'), resolveAssignee('inst-2'), resolveAssignee('inst-3')]);
    expect(mockGetAgentSummary).toHaveBeenCalledTimes(1);
  });
});
