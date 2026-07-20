/**
 * pmo.tools 单元测试（T3 拆分新增，pre-commit TDD 门禁）。
 *
 * 覆盖 createProject / listProjects / getProjectStatus 三个 tool 的
 * schema 与 handler（projectService 动态 import 被 mock）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCreate = vi.fn();
const mockList = vi.fn();
const mockGet = vi.fn();

vi.mock('../../pmo/project.service.js', () => ({
  projectService: { create: mockCreate, list: mockList, get: mockGet },
}));

import { pmoTools } from '../pmo.tools.js';

function tool(name: string) {
  const t = pmoTools.find(t => t.name === name);
  expect(t).toBeDefined();
  return t!;
}

describe('pmo.tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('导出 3 个 tool，注册顺序不变', () => {
    expect(pmoTools.map(t => t.name)).toEqual(['createProject', 'listProjects', 'getProjectStatus']);
  });

  it('createProject 调用 projectService.create 并返回 { projectId, pmoNumber }', async () => {
    mockCreate.mockResolvedValue({ id: 'p1', pmoNumber: 'PMO-001' });
    const result = await tool('createProject').handler({
      title: 'T', description: 'D', requirement: 'R',
    });
    expect(mockCreate).toHaveBeenCalledWith({ title: 'T', description: 'D', requirement: 'R' });
    expect(result).toEqual({ projectId: 'p1', pmoNumber: 'PMO-001' });
    expect(tool('createProject').inputSchema.required).toEqual(['title']);
  });

  it('listProjects 默认 limit=50 并返回 total', async () => {
    mockList.mockResolvedValue([{ id: 'p1' }, { id: 'p2' }]);
    const result = await tool('listProjects').handler({});
    expect(mockList).toHaveBeenCalledWith({ status: undefined, limit: 50 });
    expect(result).toEqual({ projects: [{ id: 'p1' }, { id: 'p2' }], total: 2 });
  });

  it('listProjects 透传 status/limit', async () => {
    mockList.mockResolvedValue([]);
    await tool('listProjects').handler({ status: 'active', limit: 5 });
    expect(mockList).toHaveBeenCalledWith({ status: 'active', limit: 5 });
  });

  it('getProjectStatus 返回项目；不存在时抛 Project not found', async () => {
    mockGet.mockResolvedValue({ id: 'p1', status: 'active' });
    expect(await tool('getProjectStatus').handler({ projectId: 'p1' })).toEqual({ id: 'p1', status: 'active' });

    mockGet.mockResolvedValue(null);
    await expect(tool('getProjectStatus').handler({ projectId: 'x' })).rejects.toThrow('Project not found');
    expect(tool('getProjectStatus').inputSchema.required).toEqual(['projectId']);
  });
});
