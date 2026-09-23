// utils/wuPmo — WU→PMO 归属解析共享正本（#630 自 WorkUnitDetailPage.resolvePmo 提取 +
// resolveWuPmoBatch 批量去重）。契约：① metadata.pmoId（‖ legacy ownershipProjectId）戳优先直查；
// ② 否则 reqId → requirement.projectId；全部 best-effort（解析不到 → null），batch 按
// reqId/projectId promise 去重防 N+1。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkUnit } from '../../api/workunit';

const { mockProjectGet, mockRequirementGet } = vi.hoisted(() => ({
  mockProjectGet: vi.fn(),
  mockRequirementGet: vi.fn(),
}));

vi.mock('../../api/index', async () => {
  const actual = await vi.importActual('../../api/index');
  return { ...actual, projectApi: { get: mockProjectGet } };
});

vi.mock('../../api/requirements', async () => {
  const actual = await vi.importActual('../../api/requirements');
  return { ...actual, requirementApi: { get: mockRequirementGet } };
});

import { resolveWuPmo, resolveWuPmoBatch } from '../wuPmo';

const PMO = { id: 'proj-1', pmoNumber: 'PMO-3', title: '交付守卫' };

const wu = (over: Partial<WorkUnit> = {}): WorkUnit =>
  ({ id: 'wu-1', metadata: null, reqId: null, ...over }) as WorkUnit;

describe('resolveWuPmo（单 WU 归属解析）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProjectGet.mockResolvedValue({ data: PMO });
  });

  it('metadata.pmoId 归因戳优先直查（有 reqId 也不查 requirement）', async () => {
    const result = await resolveWuPmo(wu({ metadata: JSON.stringify({ pmoId: 'proj-1' }), reqId: 'req-9' }));

    expect(result).toEqual(PMO);
    expect(mockProjectGet).toHaveBeenCalledWith('proj-1');
    expect(mockRequirementGet).not.toHaveBeenCalled();
  });

  it('legacy ownershipProjectId 戳同级命中', async () => {
    const result = await resolveWuPmo(wu({ metadata: JSON.stringify({ ownershipProjectId: 'proj-1' }) }));

    expect(result).toEqual(PMO);
  });

  it('无戳走 reqId → requirement.projectId 二跳', async () => {
    mockRequirementGet.mockResolvedValue({ data: { data: { projectId: 'proj-1' } } });

    const result = await resolveWuPmo(wu({ reqId: 'req-9' }));

    expect(mockRequirementGet).toHaveBeenCalledWith('req-9');
    expect(result).toEqual(PMO);
  });

  it('无戳无 reqId → null 且零请求（调用方按「未归属」降级）', async () => {
    expect(await resolveWuPmo(wu())).toBeNull();
    expect(mockProjectGet).not.toHaveBeenCalled();
    expect(mockRequirementGet).not.toHaveBeenCalled();
  });

  it('best-effort：项目/需求查询失败 → null，不上抛', async () => {
    mockProjectGet.mockRejectedValue(new Error('boom'));
    expect(await resolveWuPmo(wu({ metadata: JSON.stringify({ pmoId: 'proj-1' }) }))).toBeNull();

    mockRequirementGet.mockRejectedValue(new Error('boom'));
    expect(await resolveWuPmo(wu({ reqId: 'req-9' }))).toBeNull();
  });

  it('项目响应缺 pmoNumber（非 PMO 形状）→ null', async () => {
    mockProjectGet.mockResolvedValue({ data: { id: 'proj-1' } });
    expect(await resolveWuPmo(wu({ metadata: JSON.stringify({ pmoId: 'proj-1' }) }))).toBeNull();
  });
});

describe('resolveWuPmoBatch（批量去重）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProjectGet.mockResolvedValue({ data: PMO });
    mockRequirementGet.mockResolvedValue({ data: { data: { projectId: 'proj-1' } } });
  });

  it('同 reqId 多 WU 只查一次 requirement，同 projectId 只查一次 project（防 N+1）', async () => {
    const map = await resolveWuPmoBatch([
      wu({ id: 'wu-a', reqId: 'req-9' }),
      wu({ id: 'wu-b', reqId: 'req-9' }),
      wu({ id: 'wu-c', metadata: JSON.stringify({ pmoId: 'proj-1' }) }),
      wu({ id: 'wu-d' }),
    ]);

    expect(mockRequirementGet).toHaveBeenCalledTimes(1);
    expect(mockProjectGet).toHaveBeenCalledTimes(1);
    expect(map.get('wu-a')).toEqual(PMO);
    expect(map.get('wu-b')).toEqual(PMO);
    expect(map.get('wu-c')).toEqual(PMO);
    expect(map.get('wu-d')).toBeNull();
  });
});
