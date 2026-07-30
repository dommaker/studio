// AC-5: PMO Publish API tests — Spec 3 FileStore 版本
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockReadJson,
  mockWriteJson,
  mockCreateHumanMessage,
  mockUpdateMessageMeta,
  mockWuCreate,
} = vi.hoisted(() => ({
  mockReadJson: vi.fn(),
  mockWriteJson: vi.fn().mockResolvedValue(undefined),
  mockCreateHumanMessage: vi.fn().mockResolvedValue({
    id: 'msg-1',
    channelId: 'ch-1',
    content: 'test',
    authorType: 'human',
    agentName: null,
    workUnitId: null,
    replyToId: null,
    meta: {},
    createdAt: new Date(),
  }),
  mockUpdateMessageMeta: vi.fn().mockResolvedValue({
    id: 'msg-1',
    meta: { pmoId: 'proj-1' },
  }),
  mockWuCreate: vi.fn().mockResolvedValue({
    id: 'wu-1',
    type: 'analysis',
    scope: 'test',
    status: 'unassigned',
  }),
}));

// Mock FileStore
vi.mock('@dommaker/studio-shared', () => ({
  FileStore: vi.fn().mockImplementation(function () { return {
    readJson: mockReadJson,
    writeJson: mockWriteJson,
    readJsonl: vi.fn().mockResolvedValue([]),
  }; }),
}));

// Mock fs
vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...(actual as object),
    promises: {
      readdir: vi.fn().mockResolvedValue([]),
      unlink: vi.fn().mockResolvedValue(undefined),
      mkdir: vi.fn().mockResolvedValue(undefined),
    },
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue(''),
  };
});

// Mock channelMessageService
vi.mock('../../channels/channel-message.service.js', () => ({
  channelMessageService: {
    createHumanMessage: (...args: unknown[]) => mockCreateHumanMessage(...args),
    updateMessageMeta: (...args: unknown[]) => mockUpdateMessageMeta(...args),
  },
}));

// Mock WorkUnitService
vi.mock('../../workunit/workunit.service.js', () => ({
  WorkUnitService: vi.fn().mockImplementation(function () { return {
    create: (...args: unknown[]) => mockWuCreate(...args),
  }; }),
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { projectService } from '../project.service.js';

function sampleProject(overrides: Record<string, unknown> = {}) {
  return {
    id: 'proj-1',
    pmoNumber: 'PM-001',
    title: 'Test Project',
    description: null,
    requirement: 'Test requirement',
    companyId: null,
    okrId: null,
    status: 'pending',
    priority: 'normal',
    progress: 0,
    gitBranch: null,
    gitRepo: null,
    specFilePath: null,
    requirementsDocId: null,
    startedAt: null,
    completedAt: null,
    createdAt: '2026-07-15T00:00:00.000Z',
    updatedAt: '2026-07-15T00:00:00.000Z',
    ...overrides,
  };
}

describe('AC-5: PMO Publish API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadJson.mockResolvedValue(sampleProject());
  });

  it('pending PMO publish creates ChannelMessage + WorkUnit + status→active', async () => {
    const result = await projectService.publish({
      projectId: 'proj-1',
      channelId: 'ch-1',
    });

    expect(result.message).toBeDefined();
    expect(result.workUnit).toBeDefined();
    expect(result.project).toBeDefined();
    expect(mockCreateHumanMessage).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('PM-001')
    );
  });

  it('non-pending PMO → error', async () => {
    mockReadJson.mockResolvedValue(sampleProject({ status: 'active' }));

    await expect(
      projectService.publish({ projectId: 'proj-1', channelId: 'ch-1' })
    ).rejects.toThrow();
  });

  it('project not found → error', async () => {
    mockReadJson.mockResolvedValue(null);

    await expect(
      projectService.publish({ projectId: 'nope', channelId: 'ch-1' })
    ).rejects.toThrow();
  });

  it('WorkUnit metadata contains pmoId and pmoNumber', async () => {
    await projectService.publish({ projectId: 'proj-1', channelId: 'ch-1' });

    expect(mockWuCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'analysis',
        metadata: expect.objectContaining({
          pmoId: 'proj-1',
          pmoNumber: 'PM-001',
        }),
      })
    );
  });

  it('B3a 归属链：gitRepo 落 metadata.workspaceRoot；无 gitRepo 不带该字段', async () => {
    mockReadJson.mockResolvedValue(sampleProject({ gitRepo: '/root/projects/demo' }));
    await projectService.publish({ projectId: 'proj-1', channelId: 'ch-1' });
    expect(mockWuCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ workspaceRoot: '/root/projects/demo' }),
      })
    );

    mockWuCreate.mockClear();
    mockReadJson.mockResolvedValue(sampleProject({ gitRepo: null }));
    await projectService.publish({ projectId: 'proj-1', channelId: 'ch-1' });
    const meta = mockWuCreate.mock.calls[0][0].metadata as Record<string, unknown>;
    expect('workspaceRoot' in meta).toBe(false);
  });

  it('analysis scope 含只读约束（2026-07-30：分析阶段禁止改文件）+ TASK 输出约定', async () => {
    await projectService.publish({ projectId: 'proj-1', channelId: 'ch-1' });

    const scope = mockWuCreate.mock.calls[0][0].scope as string;
    expect(scope).toContain('只读分析');
    expect(scope).toContain('禁止创建/修改/删除任何文件');
    expect(scope).toContain('TASK:');
  });

  it('ChannelMessage meta contains pmoId', async () => {
    await projectService.publish({ projectId: 'proj-1', channelId: 'ch-1' });

    expect(mockUpdateMessageMeta).toHaveBeenCalledWith(
      'msg-1',
      expect.objectContaining({ pmoId: 'proj-1' })
    );
  });

  it('PMO status transitions to active', async () => {
    await projectService.publish({ projectId: 'proj-1', channelId: 'ch-1' });

    // publish calls updateStatus which calls writeJson with status='active'
    expect(mockWriteJson).toHaveBeenCalledWith(
      expect.stringContaining('proj-1'),
      expect.objectContaining({ status: 'active' })
    );
  });
});
