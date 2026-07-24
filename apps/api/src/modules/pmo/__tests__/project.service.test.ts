// AC Group 1: Project 迁移 — FileStore 替代 Prisma
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';

// ── Mock hoisting ──
const {
  mockReadJson,
  mockWriteJson,
  mockReadJsonl,
  mockReadDir,
  mockUnlink,
  mockMkdir,
  mockCreateHumanMessage,
  mockUpdateMessageMeta,
  mockWuCreate,
} = vi.hoisted(() => ({
  mockReadJson: vi.fn().mockResolvedValue(null),
  mockWriteJson: vi.fn().mockResolvedValue(undefined),
  mockReadJsonl: vi.fn().mockResolvedValue([]),
  mockReadDir: vi.fn().mockResolvedValue([]),
  mockUnlink: vi.fn().mockResolvedValue(undefined),
  mockMkdir: vi.fn().mockResolvedValue(undefined),
  mockCreateHumanMessage: vi.fn().mockResolvedValue({
    id: 'msg-1', channelId: 'ch-1', content: 'test',
    authorType: 'human', agentName: null, workUnitId: null,
    replyToId: null, meta: {}, createdAt: new Date(),
  }),
  mockUpdateMessageMeta: vi.fn().mockResolvedValue({ id: 'msg-1', meta: { pmoId: 'proj-1' } }),
  mockWuCreate: vi.fn().mockResolvedValue({
    id: 'wu-1', type: 'analysis', scope: 'test', status: 'unassigned',
  }),
}));

// ── Mock FileStore ──
vi.mock('@dommaker/studio-shared', () => ({
  FileStore: vi.fn().mockImplementation(function () { return {
    readJson: mockReadJson,
    writeJson: mockWriteJson,
    readJsonl: mockReadJsonl,
  }; }),
}));

// ── Mock channel/log/fs ──
vi.mock('../../channels/channel-message.service.js', () => ({
  channelMessageService: {
    createHumanMessage: (...args: unknown[]) => mockCreateHumanMessage(...args),
    updateMessageMeta: (...args: unknown[]) => mockUpdateMessageMeta(...args),
  },
}));

vi.mock('../../workunit/workunit.service.js', () => ({
  WorkUnitService: vi.fn().mockImplementation(function () { return {
    create: (...args: unknown[]) => mockWuCreate(...args),
  }; }),
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...(actual as object),
    promises: {
      readdir: mockReadDir,
      unlink: mockUnlink,
      mkdir: mockMkdir,
    },
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue(''),
  };
});

// ── Setup: dynamically import service ──
const PROJECTS_DIR = path.join(os.homedir(), '.studio', 'projects');

let projectService: typeof import('../project.service.js').projectService;
let generatePmoNumber: typeof import('../project.service.js').generatePmoNumber;

beforeEach(async () => {
  vi.clearAllMocks();
  // Reset mocks to default behavior
  mockReadJson.mockResolvedValue(null);
  mockReadDir.mockResolvedValue([]);
  mockReadJsonl.mockResolvedValue([]);
  // Re-import to pick up fresh mocks
  const mod = await import('../project.service.js');
  projectService = mod.projectService;
  generatePmoNumber = mod.generatePmoNumber;
});

// ── Helper: create Dir-like objects for readdir mock ──
function dirEnt(name: string) {
  return { name, isFile: () => name.endsWith('.json'), isDirectory: () => false } as unknown as fs.Dirent;
}

// ── Helper: create a sample project ──
function sampleProject(overrides: Record<string, unknown> = {}) {
  return {
    id: 'proj-001',
    pmoNumber: 'PM-001',
    title: 'Test Project',
    description: 'Test desc',
    requirement: 'Build X',
    companyId: 'company-1',
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

function projectFilePath(id: string) {
  return path.join(PROJECTS_DIR, `${id}.json`);
}

// ============================================================
describe('ProjectService — FileStore 迁移', () => {
  // ── AC-1.1: create ──
  describe('create', () => {
    it('生成 PMO 号 + 写 ~/.studio/projects/{id}.json', async () => {
      // No existing projects → PM-001
      const proj = sampleProject();
      mockWriteJson.mockResolvedValue(undefined);
      mockReadJson.mockResolvedValue(proj); // get() after create uses readJson

      const result = await projectService.create({
        companyId: 'company-1',
        title: 'Test Project',
      });

      expect(result).toBeDefined();
      expect(result.pmoNumber).toMatch(/^PM-\d{3}$/);
      expect(mockWriteJson).toHaveBeenCalled();
      const [filePath, data] = mockWriteJson.mock.calls[0];
      expect(filePath).toBe(projectFilePath(data.id));
      expect(data.status).toBe('pending');
      expect(data.pmoNumber).toBe('PM-001');
    });

    it('PMO 号递增', async () => {
      // Existing project with PM-003 → new should be PM-004
      mockReadDir.mockResolvedValue([dirEnt('proj-001.json'), dirEnt('proj-002.json')]);
      mockReadJson
        .mockResolvedValueOnce(sampleProject({ id: 'proj-001', pmoNumber: 'PM-001' }))
        .mockResolvedValueOnce(sampleProject({ id: 'proj-002', pmoNumber: 'PM-003' }));

      const result = await projectService.create({
        companyId: 'company-1',
        title: 'Another Project',
      });

      expect(result.pmoNumber).toBe('PM-004');
    });
  });

  // ── AC-1.1/1.2: get ──
  describe('get', () => {
    it('读取存在项目 → 返回 ProjectData', async () => {
      const proj = sampleProject();
      mockReadJson.mockResolvedValue(proj);

      const result = await projectService.get('proj-001');

      expect(result).toBeDefined();
      expect(result!.id).toBe('proj-001');
      expect(result!.pmoNumber).toBe('PM-001');
    });

    it('文件不存在 → 返回 null', async () => {
      mockReadJson.mockResolvedValue(null);

      const result = await projectService.get('nonexistent');

      expect(result).toBeNull();
    });
  });

  // ── AC-1.2: getByPmoNumber ──
  describe('getByPmoNumber', () => {
    it('按 PMO 号查找 → 找到匹配项目', async () => {
      mockReadDir.mockResolvedValue([dirEnt('proj-001.json')]);
      mockReadJson.mockResolvedValue(sampleProject());

      const result = await projectService.getByPmoNumber('PM-001');

      expect(result).toBeDefined();
      expect(result!.pmoNumber).toBe('PM-001');
    });

    it('PMO 号不存在 → 返回 null', async () => {
      mockReadDir.mockResolvedValue([
        dirEnt('proj-001.json'),
      ] as unknown as fs.Dirent[]);
      mockReadJson.mockResolvedValue(sampleProject({ pmoNumber: 'PM-002' }));

      const result = await projectService.getByPmoNumber('PM-999');

      expect(result).toBeNull();
    });
  });

  // ── AC-1.2: list ──
  describe('list', () => {
    it('无过滤条件 → 返回所有项目', async () => {
      mockReadDir.mockResolvedValue([
        dirEnt('proj-001.json'),
        dirEnt('proj-002.json'),
      ] as unknown as fs.Dirent[]);
      mockReadJson
        .mockResolvedValueOnce(sampleProject({ id: 'proj-001' }))
        .mockResolvedValueOnce(sampleProject({ id: 'proj-002', status: 'active' }));

      const result = await projectService.list();

      expect(result).toHaveLength(2);
    });

    it('按 status 过滤 → 只返回匹配项目', async () => {
      mockReadDir.mockResolvedValue([
        dirEnt('proj-001.json'),
        dirEnt('proj-002.json'),
      ] as unknown as fs.Dirent[]);
      mockReadJson
        .mockResolvedValueOnce(sampleProject({ id: 'proj-001' }))
        .mockResolvedValueOnce(sampleProject({ id: 'proj-002', status: 'active' }));

      const result = await projectService.list({ status: 'active' });

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('proj-002');
    });

    it('空目录 → 返回空数组', async () => {
      mockReadDir.mockResolvedValue([]);

      const result = await projectService.list();

      expect(result).toEqual([]);
    });

    it('目录不存在 → 返回空数组', async () => {
      mockReadDir.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      const result = await projectService.list();

      expect(result).toEqual([]);
    });
  });

  // ── AC-1.1: update ──
  describe('update', () => {
    it('更新字段 → 文件内容更新', async () => {
      const proj = sampleProject();
      mockReadJson.mockResolvedValue(proj);
      mockWriteJson.mockResolvedValue(undefined);

      const result = await projectService.update('proj-001', { title: 'Updated Title' });

      expect(result.title).toBe('Updated Title');
      expect(mockWriteJson).toHaveBeenCalled();
    });

    it('项目不存在 → throw Error', async () => {
      mockReadJson.mockResolvedValue(null);

      await expect(projectService.update('nonexistent', { title: 'X' }))
        .rejects.toThrow('Project not found');
    });
  });

  // ── AC-1.1: updateStatus ──
  describe('updateStatus', () => {
    it('合法转换 → 状态更新', async () => {
      const proj = sampleProject({ status: 'pending' });
      mockReadJson.mockResolvedValue(proj);

      const result = await projectService.updateStatus('proj-001', 'active');

      expect(result.status).toBe('active');
    });

    it('非法转换 → throw Error', async () => {
      const proj = sampleProject({ status: 'completed' });
      mockReadJson.mockResolvedValue(proj);

      await expect(projectService.updateStatus('proj-001', 'active'))
        .rejects.toThrow('Invalid status transition');
    });

    it('completed → 设置 completedAt + progress=100', async () => {
      const proj = sampleProject({ status: 'in_review' });
      mockReadJson.mockResolvedValue(proj);

      const result = await projectService.updateStatus('proj-001', 'completed');

      expect(result.status).toBe('completed');
      expect(result.progress).toBe(100);
      expect(result.completedAt).toBeDefined();
    });
  });

  // ── AC-1.1: delete ──
  describe('delete', () => {
    it('删除 pending 项目 → 文件被删除', async () => {
      mockReadJson.mockResolvedValue(sampleProject({ status: 'pending' }));

      const result = await projectService.delete('proj-001');

      expect(result).toEqual({ success: true });
      expect(mockUnlink).toHaveBeenCalledWith(projectFilePath('proj-001'));
    });

    it('删除 active 项目 → throw Error', async () => {
      mockReadJson.mockResolvedValue(sampleProject({ status: 'active' }));

      await expect(projectService.delete('proj-001'))
        .rejects.toThrow('Can only delete pending or cancelled projects');
    });
  });

  // ── AC-1.3: calculateProgress ──
  describe('calculateProgress', () => {
    it('tasks.jsonl 不存在 → 返回 project.progress', async () => {
      mockReadJson.mockResolvedValue(sampleProject({ progress: 30 }));
      mockReadJsonl.mockResolvedValue([]);

      const result = await projectService.calculateProgress('proj-001');

      expect(result).toBe(30);
    });

    it('有 tasks → 按 completed/total 计算', async () => {
      mockReadJson.mockResolvedValue(sampleProject());
      mockReadJsonl.mockResolvedValue([
        { id: 'task-1', status: 'completed' },
        { id: 'task-2', status: 'completed' },
        { id: 'task-3', status: 'pending' },
      ]);

      const result = await projectService.calculateProgress('proj-001');

      expect(result).toBe(67); // 2/3 ≈ 67%
    });

    it('所有 task 完成 → 返回 100', async () => {
      mockReadJson.mockResolvedValue(sampleProject());
      mockReadJsonl.mockResolvedValue([
        { id: 'task-1', status: 'completed' },
        { id: 'task-2', status: 'completed' },
      ]);

      const result = await projectService.calculateProgress('proj-001');

      expect(result).toBe(100);
    });

    it('project 不存在 → 返回 0', async () => {
      mockReadJson.mockResolvedValue(null);

      const result = await projectService.calculateProgress('nonexistent');

      expect(result).toBe(0);
    });
  });

  // ── AC-1.4: publish ──
  describe('publish', () => {
    it('pending 项目发布 → 状态变为 active', async () => {
      const proj = sampleProject();
      mockReadJson.mockResolvedValue(proj);

      const result = await projectService.publish({ projectId: 'proj-001', channelId: 'ch-1' });

      expect(result.project.status).toBe('active');
      expect(mockCreateHumanMessage).toHaveBeenCalled();
      expect(mockWuCreate).toHaveBeenCalled();
    });

    it('非 pending 项目发布 → throw Error', async () => {
      mockReadJson.mockResolvedValue(sampleProject({ status: 'active' }));

      await expect(projectService.publish({ projectId: 'proj-001', channelId: 'ch-1' }))
        .rejects.toThrow('Project must be pending to publish');
    });
  });
});

// ── generatePmoNumber ──
describe('generatePmoNumber', () => {
  it('首次创建 → 返回 PM-001', async () => {
    mockReadDir.mockResolvedValue([]);

    const result = await generatePmoNumber();

    expect(result).toBe('PM-001');
  });

  it('递增 → 返回 PM-00X', async () => {
    mockReadDir.mockResolvedValue([
      dirEnt('proj-001.json'),
      dirEnt('proj-002.json'),
    ] as unknown as fs.Dirent[]);
    mockReadJson
      .mockResolvedValueOnce(sampleProject({ id: 'proj-001', pmoNumber: 'PM-001' }))
      .mockResolvedValueOnce(sampleProject({ id: 'proj-002', pmoNumber: 'PM-005' }));

    const result = await generatePmoNumber();

    expect(result).toBe('PM-006');
  });
});
