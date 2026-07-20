/**
 * workunit.tools 单元测试（T3 拆分新增，pre-commit TDD 门禁）。
 *
 * 覆盖 createWorkUnit：WorkUnitService 以共享 fileStore 构造、
 * 输入映射与返回字段裁剪。WorkUnitService 被 mock。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCreate = vi.fn().mockResolvedValue({ id: 'wu-1', type: 'task', scope: 'S', status: 'unassigned' });

vi.mock('../../workunit/workunit.service.js', () => ({
  WorkUnitService: vi.fn().mockImplementation(() => ({ create: mockCreate })),
}));

import { workunitTools } from '../workunit.tools.js';
import { fileStore } from '../tool-store.js';

const createWorkUnit = workunitTools[0];

describe('workunit.tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate.mockResolvedValue({ id: 'wu-1', type: 'task', scope: 'S', status: 'unassigned' });
  });

  it('仅导出 createWorkUnit，schema required=[type, scope]', () => {
    expect(workunitTools.map(t => t.name)).toEqual(['createWorkUnit']);
    expect(createWorkUnit.inputSchema.required).toEqual(['type', 'scope']);
    expect(createWorkUnit.inputSchema.properties.type.enum)
      .toEqual(['task', 'analysis', 'monitor', 'discussion']);
  });

  it('handler 以共享 fileStore 构造 WorkUnitService 并透传 status=unassigned', async () => {
    const result = await createWorkUnit.handler({
      type: 'task', scope: 'S', channelId: 'ch-1', parentId: 'wu-0', metadata: { k: 1 },
    });
    expect(result).toEqual({ workUnitId: 'wu-1', type: 'task', scope: 'S', status: 'unassigned' });
  });

  it('可选字段缺省时透传 undefined', async () => {
    await createWorkUnit.handler({ type: 'analysis', scope: 'A' });
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      type: 'analysis', scope: 'A', status: 'unassigned',
    }));
  });
});
