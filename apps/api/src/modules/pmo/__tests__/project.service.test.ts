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
      expect(result.pmoNumber).toMatch(/^PMO-\d+$/);
      expect(mockWriteJson).toHaveBeenCalled();
      const [filePath, data] = mockWriteJson.mock.calls[0];
      expect(filePath).toBe(projectFilePath(data.id));
      expect(data.status).toBe('pending');
      expect(data.pmoNumber).toBe('PMO-1');
    });

    it('PMO 号递增', async () => {
      // Existing project with PM-003 → new should be PMO-4（统一编号）
      mockReadDir.mockResolvedValue([dirEnt('proj-001.json'), dirEnt('proj-002.json')]);
      mockReadJson
        .mockResolvedValueOnce(sampleProject({ id: 'proj-001', pmoNumber: 'PM-001' }))
        .mockResolvedValueOnce(sampleProject({ id: 'proj-002', pmoNumber: 'PM-003' }));

      const result = await projectService.create({
        companyId: 'company-1',
        title: 'Another Project',
      });

      expect(result.pmoNumber).toBe('PMO-4');
    });

    it('PMO-a：reqAlias 同号 / gitBranch 默认=pmoNumber / deliveryPolicy 默认 branch-only', async () => {
      mockReadDir.mockResolvedValue([dirEnt('proj-001.json')]);
      mockReadJson.mockResolvedValue(sampleProject({ id: 'proj-001', pmoNumber: 'PM-010' }));

      const result = await projectService.create({ title: '新项目' });

      expect(result.pmoNumber).toBe('PMO-11');
      expect(result.reqAlias).toBe('REQ-0011');
      expect(result.gitBranch).toBe('PMO-11');
      expect(result.deliveryPolicy).toBe('branch-only');
    });

    it('PMO-a：显式 gitBranch / deliveryPolicy=auto-merge 可覆盖默认', async () => {
      mockReadDir.mockResolvedValue([]);
      mockReadJson.mockResolvedValue(null);

      const result = await projectService.create({
        title: '自定义',
        gitBranch: 'feature/custom',
        deliveryPolicy: 'auto-merge',
      });

      expect(result.gitBranch).toBe('feature/custom');
      expect(result.deliveryPolicy).toBe('auto-merge');
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
describe('generatePmoNumber（决策 4：统一编号，PM/PMO/REQ 两序列 max+1，新格式 PMO-<n>）', () => {
  it('首次创建 → 返回 PMO-1', async () => {
    mockReadDir.mockResolvedValue([]);

    const result = await generatePmoNumber();

    expect(result).toBe('PMO-1');
  });

  it('递增 → max(PM, PMO, REQ)+1', async () => {
    mockReadDir.mockResolvedValue([
      dirEnt('proj-001.json'),
      dirEnt('proj-002.json'),
    ] as unknown as fs.Dirent[]);
    mockReadJson
      .mockResolvedValueOnce(sampleProject({ id: 'proj-001', pmoNumber: 'PM-001' }))
      .mockResolvedValueOnce(sampleProject({ id: 'proj-002', pmoNumber: 'PMO-5' }));

    const result = await generatePmoNumber();

    expect(result).toBe('PMO-6');
  });

  it('REQ 序列纳入 max（决策 4 修正版：两序列重叠，取大者+1）', async () => {
    // 项目目录：只有 PM-003；requirements 目录：有 REQ-0009.json + index.json nextSeq=11
    mockReadDir.mockImplementation(async (dir: string) => {
      if (String(dir).includes('requirements')) {
        return [dirEnt('REQ-0009.json'), dirEnt('index.json')] as unknown as fs.Dirent[];
      }
      return [dirEnt('proj-001.json')] as unknown as fs.Dirent[];
    });
    mockReadJson.mockImplementation(async (p: string) => {
      if (String(p).endsWith('index.json')) return { nextSeq: 11 };
      return sampleProject({ id: 'proj-001', pmoNumber: 'PM-003' });
    });

    const result = await generatePmoNumber();

    expect(result).toBe('PMO-11');
  });
});

// ── PMO-a：别名层与杂务 PMO（决策 2/4）──
describe('PMO-a：getByReqAlias / getByPmoNumber 归一 / ensureChoreProject', () => {
  it('getByReqAlias：命中 reqAlias 的统一编号对象；无别名存量返回 null', async () => {
    mockReadDir.mockResolvedValue([dirEnt('proj-1.json'), dirEnt('proj-2.json')]);
    mockReadJson
      .mockResolvedValueOnce(sampleProject({ id: 'proj-1', pmoNumber: 'PM-001', reqAlias: null }))
      .mockResolvedValueOnce(sampleProject({ id: 'proj-2', pmoNumber: 'PMO-11', reqAlias: 'REQ-0011' }));

    expect((await projectService.getByReqAlias('REQ-0011'))!.id).toBe('proj-2');
    expect(await projectService.getByReqAlias('REQ-0001')).toBeNull();
  });

  it('getByPmoNumber：数字归一（PMO-11 / PM-011 同号），精确匹配优先', async () => {
    mockReadDir.mockResolvedValue([dirEnt('proj-1.json')]);
    mockReadJson.mockResolvedValue(sampleProject({ id: 'proj-1', pmoNumber: 'PMO-11' }));

    expect((await projectService.getByPmoNumber('PMO-11'))!.id).toBe('proj-1');
    expect((await projectService.getByPmoNumber('PM-011'))!.id).toBe('proj-1');
    expect(await projectService.getByPmoNumber('PMO-12')).toBeNull();
    expect(await projectService.getByPmoNumber('garbage')).toBeNull();
  });

  it('ensureChoreProject：find-or-create 幂等；杂务 PMO 直接 active + branch-only', async () => {
    // readJson 返回最近一次 writeJson 写入的对象（模拟 FileStore 读己之写）
    mockReadJson.mockImplementation(async () => mockWriteJson.mock.calls.at(-1)?.[1] ?? null);
    // 第一次：无杂务 → 创建（create 内部 readAllProjects 空 → PMO-1）
    mockReadDir.mockResolvedValue([]);

    const created = await projectService.ensureChoreProject('ch-1', '#测试频道');
    expect(created.isChore).toBe(true);
    expect(created.channelId).toBe('ch-1');
    expect(created.status).toBe('active');
    expect(created.deliveryPolicy).toBe('branch-only');
    expect(created.title).toContain('杂务');
    expect(created.reqAlias).toMatch(/^REQ-\d{4}$/);

    // 第二次：已有杂务 → 直接返回不再创建（mockWriteJson 调用次数不增）
    const callsBefore = mockWriteJson.mock.calls.length;
    mockReadDir.mockResolvedValue([dirEnt(`${created.id}.json`)]);
    const again = await projectService.ensureChoreProject('ch-1', '#测试频道');
    expect(again.id).toBe(created.id);
    expect(mockWriteJson.mock.calls.length).toBe(callsBefore);
  });

  it('findChoreProject：只查不建（未登记返回 null）', async () => {
    mockReadDir.mockResolvedValue([dirEnt('proj-1.json')]);
    mockReadJson.mockResolvedValue(sampleProject({ id: 'proj-1', isChore: true, channelId: 'ch-9' }));

    expect((await projectService.findChoreProject('ch-9'))!.id).toBe('proj-1');
    expect(await projectService.findChoreProject('ch-other')).toBeNull();
    expect(mockWriteJson).not.toHaveBeenCalled();
  });
});
