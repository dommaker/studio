/**
 * workunit.tools 单元测试（T3 拆分新增，pre-commit TDD 门禁）。
 *
 * 覆盖 createWorkUnit：WorkUnitService 以共享 fileStore 构造、
 * 输入映射与返回字段裁剪；P2（#566）新增 getWorkUnit/listWorkUnits 只读包装。
 * WorkUnitService 被 mock。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCreate = vi.fn().mockResolvedValue({ id: 'wu-1', type: 'task', scope: 'S', status: 'unassigned' });
const mockGetById = vi.fn();
const mockList = vi.fn();

vi.mock('../../workunit/workunit.service.js', () => ({
  WorkUnitService: vi.fn().mockImplementation(function () {
    return { create: mockCreate, getById: mockGetById, list: mockList };
  }),
}));

import { workunitTools } from '../workunit.tools.js';

const createWorkUnit = workunitTools[0];
const getWorkUnit = workunitTools[1];
const listWorkUnits = workunitTools[2];

describe('workunit.tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate.mockResolvedValue({ id: 'wu-1', type: 'task', scope: 'S', status: 'unassigned' });
  });

  it('导出 createWorkUnit + getWorkUnit + listWorkUnits，写 tool internal、读 tool external', () => {
    expect(workunitTools.map(t => t.name)).toEqual(['createWorkUnit', 'getWorkUnit', 'listWorkUnits']);
    expect(createWorkUnit.exposure).toBeUndefined();
    expect(getWorkUnit.exposure).toBe('external');
    expect(listWorkUnits.exposure).toBe('external');
    expect(createWorkUnit.inputSchema.required).toEqual(['type', 'scope']);
    expect(createWorkUnit.inputSchema.properties.type.enum)
      .toEqual(['task', 'plan', 'analysis', 'monitor', 'discussion']);
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

  it('getWorkUnit 命中返回服务层数据', async () => {
    const wu = { id: 'wu-9', scope: 'X', status: 'active' };
    mockGetById.mockResolvedValue(wu);
    expect(await getWorkUnit.handler({ id: 'wu-9' })).toEqual(wu);
    expect(mockGetById).toHaveBeenCalledWith('wu-9');
  });

  it('getWorkUnit 未命中抛 not found', async () => {
    mockGetById.mockResolvedValue(null);
    await expect(getWorkUnit.handler({ id: 'ghost' })).rejects.toThrow('WorkUnit not found: ghost');
  });

  it('listWorkUnits 透传过滤参数并返回服务层分页结果', async () => {
    const page = { data: [{ id: 'wu-1' }], total: 1 };
    mockList.mockResolvedValue(page);
    const input = { status: 'active', channelId: 'ch-1', q: 'abc', page: 2, limit: 5 };
    expect(await listWorkUnits.handler(input)).toEqual(page);
    expect(mockList).toHaveBeenCalledWith(expect.objectContaining({
      status: 'active', channelId: 'ch-1', q: 'abc', page: 2, limit: 5,
    }));
  });
});
