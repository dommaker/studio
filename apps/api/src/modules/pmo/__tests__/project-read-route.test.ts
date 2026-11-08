import { describe, expect, it, vi } from 'vitest';

const { mockGet, mockSyncProjectProgress } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockSyncProjectProgress: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../project.service.js', () => ({
  projectService: { get: mockGet },
  parsePmoNumberFromCommand: vi.fn(),
}));
vi.mock('../progress-rollup.js', () => ({
  syncProjectProgress: mockSyncProjectProgress,
}));

import { pmoOpenRoutes as router } from '../routes.js';

async function invokeGetProject(id: string) {
  const layer = (router as any).stack.find(
    (candidate: any) => candidate.route?.path === '/project/:id' && candidate.route.methods.get,
  );
  const stack = layer.route.stack;
  const handler = stack[stack.length - 1].handle;
  const req = { params: { id }, query: {}, body: {}, headers: {}, get: () => undefined } as any;
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as any;
  await handler(req, res, () => undefined);
  return res;
}

describe('GET /project/:id 只读语义（#702）', () => {
  it('返回项目详情，不触发进度/状态同步或里程碑通知', async () => {
    const project = {
      id: 'proj-1', pmoNumber: 'PMO-1', title: '只读项目',
      description: null, requirement: null, companyId: null, okrId: null,
      status: 'active', priority: 'normal', progress: 25,
      gitBranch: 'PMO-1', gitRepo: null, specFilePath: null, requirementsDocId: null,
      startedAt: null, completedAt: null,
      createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
    };
    mockGet.mockResolvedValue(project);

    const res = await invokeGetProject('proj-1');

    expect(res.json).toHaveBeenCalledWith({ data: project });
    expect(mockGet).toHaveBeenCalledWith('proj-1');
    expect(mockSyncProjectProgress).not.toHaveBeenCalled();
  });
});
