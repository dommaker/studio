/**
 * requirement.tools 单元测试（P2，#566）。
 *
 * 覆盖 getRequirement/listRequirements 只读包装（RequirementService 被 mock），
 * 均 exposure='external'。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGet = vi.fn();
const mockList = vi.fn();

vi.mock('../../requirements/requirement.service.js', () => ({
  RequirementService: vi.fn().mockImplementation(function () {
    return { get: mockGet, list: mockList };
  }),
}));

import { requirementTools } from '../requirement.tools.js';

const getRequirement = requirementTools[0];
const listRequirements = requirementTools[1];

describe('requirement.tools', () => {
  beforeEach(() => vi.clearAllMocks());

  it('导出 getRequirement + listRequirements，均 exposure=external', () => {
    expect(requirementTools.map(t => t.name)).toEqual(['getRequirement', 'listRequirements']);
    expect(getRequirement.exposure).toBe('external');
    expect(listRequirements.exposure).toBe('external');
    expect(getRequirement.inputSchema.required).toEqual(['id']);
  });

  it('getRequirement 命中返回服务层数据', async () => {
    const req = { id: 'REQ-7', title: 'T', status: 'in-progress' };
    mockGet.mockResolvedValue(req);
    expect(await getRequirement.handler({ id: 'REQ-7' })).toEqual(req);
    expect(mockGet).toHaveBeenCalledWith('REQ-7');
  });

  it('getRequirement 未命中抛 not found', async () => {
    mockGet.mockResolvedValue(null);
    await expect(getRequirement.handler({ id: 'REQ-999' })).rejects.toThrow('Requirement not found: REQ-999');
  });

  it('listRequirements 透传过滤并返回 { requirements, total }', async () => {
    mockList.mockResolvedValue([{ id: 'REQ-1' }, { id: 'REQ-2' }]);
    const result = await listRequirements.handler({ status: 'open', channelId: 'ch-1' });
    expect(mockList).toHaveBeenCalledWith({ status: 'open', channelId: 'ch-1' });
    expect(result).toEqual({ requirements: [{ id: 'REQ-1' }, { id: 'REQ-2' }], total: 2 });
  });

  it('listRequirements 无过滤透传 undefined 字段', async () => {
    mockList.mockResolvedValue([]);
    await listRequirements.handler({});
    expect(mockList).toHaveBeenCalledWith({ status: undefined, channelId: undefined });
  });
});
