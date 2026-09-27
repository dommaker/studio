// projectsStore 单测 — /projects/discover 数据面（2026-09 B3）
// TTL 去重 / single-flight / 失败静默不落锚点（下次重试）；机制同 channelDataStore 三件套
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDiscoverProjects } = vi.hoisted(() => ({
  mockDiscoverProjects: vi.fn(),
}));

vi.mock('../../api/channel', () => ({
  channelApi: { discoverProjects: mockDiscoverProjects },
}));

import { useProjectsStore, PROJECTS_TTL_MS } from '../projectsStore';

const projects = [
  { name: 'studio', path: '/repos/studio', hasClaudeMd: true },
  { name: 'dommaker', path: '/repos/dommaker', hasClaudeMd: false },
];

describe('projectsStore — /projects/discover TTL + single-flight', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useProjectsStore.getState().__resetForTests();
    mockDiscoverProjects.mockResolvedValue({ data: { success: true, data: projects } });
  });

  it('拉取落库；TTL 内重复 ensure 零重拉，过期重拉', async () => {
    vi.useFakeTimers();
    try {
      await useProjectsStore.getState().ensureProjects();
      expect(useProjectsStore.getState().projects).toEqual(projects);
      await useProjectsStore.getState().ensureProjects();
      expect(mockDiscoverProjects).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(PROJECTS_TTL_MS + 1);
      await useProjectsStore.getState().ensureProjects();
      expect(mockDiscoverProjects).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('并发调用共享单飞：多消费方只发一轮请求', async () => {
    let resolveDiscover!: (v: unknown) => void;
    mockDiscoverProjects.mockReturnValue(new Promise((r) => { resolveDiscover = r; }));
    const p1 = useProjectsStore.getState().ensureProjects();
    const p2 = useProjectsStore.getState().ensureProjects();
    resolveDiscover({ data: { success: true, data: projects } });
    await Promise.all([p1, p2]);
    expect(mockDiscoverProjects).toHaveBeenCalledTimes(1);
    expect(useProjectsStore.getState().projects).toEqual(projects);
  });

  it('拉取失败静默：不落数据不落锚点（下次重试），ensure 永不 reject', async () => {
    mockDiscoverProjects.mockRejectedValueOnce(new Error('boom'));
    await expect(useProjectsStore.getState().ensureProjects()).resolves.toBeUndefined();
    expect(useProjectsStore.getState().projects).toBeUndefined();
    await useProjectsStore.getState().ensureProjects();
    expect(mockDiscoverProjects).toHaveBeenCalledTimes(2);
    expect(useProjectsStore.getState().projects).toEqual(projects);
  });

  it('响应非数组 → 形状护栏按 [] 落库', async () => {
    mockDiscoverProjects.mockResolvedValue({ data: { success: true, data: null } });
    await useProjectsStore.getState().ensureProjects();
    expect(useProjectsStore.getState().projects).toEqual([]);
  });
});
