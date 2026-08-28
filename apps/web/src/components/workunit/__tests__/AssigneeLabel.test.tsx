// AssigneeLabel 组件测试 — #290（清单 #24）负责人标签：解析到角色名 → 链接；查无 → 短 UUID span
// 解析口径三分支在 hooks/__tests__/useAssigneeDisplay.test.ts 覆盖，本文件测渲染契约
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { mockGetAgentSummary, mockGetAgentInstance, mockListAllAgents } = vi.hoisted(() => ({
  mockGetAgentSummary: vi.fn(),
  mockGetAgentInstance: vi.fn(),
  mockListAllAgents: vi.fn(),
}));

vi.mock('../../../api/monitoring', () => ({
  monitoringApi: { getAgentSummary: mockGetAgentSummary, getAgentInstance: mockGetAgentInstance },
}));
vi.mock('../../../api/channel', () => ({
  channelApi: { listAllAgents: mockListAllAgents, list: vi.fn().mockRejectedValue(new Error('not mocked here')) },
}));

import { AssigneeLabel } from '../AssigneeLabel';
import { useRosterStore } from '../../../stores/rosterStore';

const renderLabel = (assigneeId: string) =>
  render(
    <MemoryRouter>
      <AssigneeLabel assigneeId={assigneeId} />
    </MemoryRouter>,
  );

describe('AssigneeLabel — #290 负责人标签渲染', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // #346：解析面读 rosterStore（模块级单例），每测重置避免 TTL 缓存跨测串味
    useRosterStore.setState({
      profiles: [], agents: [], channels: [],
      loading: false, error: null, forbidden: false,
      loadedAt: null, channelsLoadedOnce: false, agentsLoadedOnce: false,
      inflight: null, lastToken: null,
    });
    mockGetAgentSummary.mockResolvedValue({
      data: { agents: [], summary: { total: 0, idle: 0, active: 0, error: 0, terminated: 0 } },
    });
    mockGetAgentInstance.mockRejectedValue(new Error('404'));
    mockListAllAgents.mockResolvedValue({ data: { data: [] } });
  });

  it('解析到角色名 → 渲染 @名字 并链到 /agents/:roleId', async () => {
    mockGetAgentSummary.mockResolvedValue({
      data: {
        agents: [{ id: 'inst-1', roleId: 'role-1', name: 'Analyst', status: 'idle', currentWorkUnitId: null, startedAt: '2026-08-24T00:00:00Z' }],
        summary: { total: 1, idle: 1, active: 0, error: 0, terminated: 0 },
      },
    });
    renderLabel('inst-1');
    const link = await screen.findByText('@Analyst');
    expect(link.closest('a')?.getAttribute('href')).toBe('/agents/role-1');
  });

  it('查无对应角色 → 回退短 UUID（span，不可点）', async () => {
    renderLabel('abcdefgh-1234-5678');
    const chip = await screen.findByText('@abcdefgh');
    expect(chip.closest('a')).toBeNull();
  });
});
