// pmoDataStore 单测 — #456 company/project 数据面 store
// companies 单份 + projects per-companyId map；TTL / single-flight / force 语义走 fetchDiscipline
// 底座（本文件只钉 store 层的落库/口径/错误语义，纪律底座自身语义见 fetchDiscipline.test.ts）。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCompanyList, mockProjectList } = vi.hoisted(() => ({
  mockCompanyList: vi.fn(),
  mockProjectList: vi.fn(),
}));

vi.mock('../../api/company', () => ({
  companyApi: { list: mockCompanyList },
}));

vi.mock('../../api', () => ({
  projectApi: { list: mockProjectList },
}));

import { usePmoDataStore, PMO_DATA_TTL_MS, PMO_PROJECTS_LIMIT } from '../pmoDataStore';

const companies = [{ id: 'co-1', name: '默认公司', size: '1-10' }];
const projectsA = [{ id: 'PMO-1', pmoNumber: 'PMO-1', title: '商城重构', status: 'active', progress: 50, createdAt: '2026-09-01' }];
const projectsB = [{ id: 'PMO-7', pmoNumber: 'PMO-7', title: '数据平台', status: 'pending', progress: 0, createdAt: '2026-09-02' }];

describe('pmoDataStore 拉取与纪律', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePmoDataStore.getState().__resetForTests();
    mockCompanyList.mockResolvedValue({ data: { data: companies } });
    mockProjectList.mockResolvedValue({ data: { data: projectsA } });
  });

  it('companies / projects 各拉一次落库；projects 按 companyId 隔离', async () => {
    await usePmoDataStore.getState().ensureCompanies();
    mockProjectList.mockResolvedValue({ data: { data: projectsB } });
    await usePmoDataStore.getState().ensureProjects('co-2');

    const s = usePmoDataStore.getState();
    expect(s.companies).toEqual(companies);
    expect(s.projects['co-2']).toEqual(projectsB);
    expect(s.projects['co-1']).toBeUndefined();
    expect(s.companiesError).toBeNull();
  });

  it('projects 口径统一 limit=100（原 20/100 漂移收口）', async () => {
    await usePmoDataStore.getState().ensureProjects('co-1');
    expect(mockProjectList).toHaveBeenCalledWith({ companyId: 'co-1', limit: PMO_PROJECTS_LIMIT });
    expect(PMO_PROJECTS_LIMIT).toBe(100);
  });

  it('TTL 内重复调用零重拉；TTL 过期后重拉', async () => {
    vi.useFakeTimers();
    try {
      await usePmoDataStore.getState().ensureCompanies();
      await usePmoDataStore.getState().ensureCompanies();
      expect(mockCompanyList).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(PMO_DATA_TTL_MS + 1);
      await usePmoDataStore.getState().ensureCompanies();
      expect(mockCompanyList).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('并发调用共享单飞：多消费方只发一轮请求', async () => {
    let resolveProjects!: (v: unknown) => void;
    mockProjectList.mockReturnValue(new Promise((r) => { resolveProjects = r; }));
    const p1 = usePmoDataStore.getState().ensureProjects('co-1');
    const p2 = usePmoDataStore.getState().ensureProjects('co-1');
    resolveProjects({ data: { data: projectsA } });
    await Promise.all([p1, p2]);
    expect(mockProjectList).toHaveBeenCalledTimes(1);
    expect(usePmoDataStore.getState().projects['co-1']).toEqual(projectsA);
  });

  it('force（maxAgeMs 0）TTL 内也重拉', async () => {
    await usePmoDataStore.getState().ensureProjects('co-1');
    await usePmoDataStore.getState().ensureProjects('co-1', { maxAgeMs: 0 });
    expect(mockProjectList).toHaveBeenCalledTimes(2);
  });

  it('ensureFresh：companies + 已驻留 projects 键一起刷（重连强刷接线目标）', async () => {
    await usePmoDataStore.getState().ensureProjects('co-1');
    vi.clearAllMocks();
    await usePmoDataStore.getState().ensureFresh({ maxAgeMs: 0 });
    expect(mockCompanyList).toHaveBeenCalledTimes(1);
    expect(mockProjectList).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'co-1' }));
  });
});

describe('pmoDataStore 失败语义', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePmoDataStore.getState().__resetForTests();
  });

  it('companies 失败：错误落状态、不落数据不落锚点（下次重试），ensure 永不 reject', async () => {
    mockCompanyList.mockRejectedValue(new Error('boom'));
    await expect(usePmoDataStore.getState().ensureCompanies()).resolves.toBeUndefined();
    expect(usePmoDataStore.getState().companies).toBeUndefined();
    expect(usePmoDataStore.getState().companiesError).toBe('boom');
    mockCompanyList.mockResolvedValue({ data: { data: companies } });
    await usePmoDataStore.getState().ensureCompanies();
    expect(usePmoDataStore.getState().companies).toEqual(companies);
    expect(usePmoDataStore.getState().companiesError).toBeNull();
  });

  it('projects 失败：错误按 companyId 落状态，不影响其他键', async () => {
    mockProjectList.mockRejectedValue(new Error('boom'));
    await usePmoDataStore.getState().ensureProjects('co-1');
    expect(usePmoDataStore.getState().projects['co-1']).toBeUndefined();
    expect(usePmoDataStore.getState().projectsError['co-1']).toBe('boom');

    mockProjectList.mockResolvedValue({ data: { data: projectsB } });
    await usePmoDataStore.getState().ensureProjects('co-2');
    expect(usePmoDataStore.getState().projects['co-2']).toEqual(projectsB);
    expect(usePmoDataStore.getState().projectsError['co-2']).toBeNull();
  });

  it('非 Error  rejection 落兜底文案（不编造空串）', async () => {
    mockCompanyList.mockRejectedValue('nope');
    await usePmoDataStore.getState().ensureCompanies();
    expect(usePmoDataStore.getState().companiesError).toBeTruthy();
  });
});
