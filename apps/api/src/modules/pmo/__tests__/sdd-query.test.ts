// AC-10: PMO-SDD association query tests
//
// 迁移说明（studio-prisma 移除后）：
// - projectService.get 通过 FileStore.readJson 读取 ~/.studio/projects/<id>.json
// - getLinkedSDDs 仍用 fs.existsSync/readFileSync 读 docs/sdd/_index.md
// 测试 mock FileStore（readJson）与 fs（existsSync/readFileSync）。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockFileReadJson,
  mockExistsSync,
  mockReadFileSync,
} = vi.hoisted(() => ({
  mockFileReadJson: vi.fn(),
  mockExistsSync: vi.fn(),
  mockReadFileSync: vi.fn(),
}));

// Mock FileStore — project.service 模块级 `new FileStore()`，get() 走 readJson
vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared')>();
  return {
    ...actual,
    FileStore: vi.fn().mockImplementation(() => ({
      readJson: mockFileReadJson,
    })),
  };
});

// Mock channelMessageService and WorkUnitService (needed by project.service imports)
vi.mock('../../channels/channel-message.service.js', () => ({
  channelMessageService: {
    createHumanMessage: vi.fn(),
    updateMessageMeta: vi.fn(),
  },
}));

vi.mock('../../workunit/workunit.service.js', () => ({
  WorkUnitService: vi.fn().mockImplementation(() => ({
    create: vi.fn(),
  })),
}));

// Partial mock of node:fs（project.service 以 'node:fs' 导入）— keep other fs functions intact
vi.mock('node:fs', async (importOriginal) => {
  const orig = await importOriginal() as Record<string, unknown>;
  return {
    ...orig,
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
  };
});

import { projectService } from '../project.service.js';

describe('AC-10: PMO-SDD association query', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // FileStore readJson：~/.studio/projects/proj-1.json 存在
    mockFileReadJson.mockResolvedValue({
      id: 'proj-1',
      pmoNumber: 'PM-001',
      title: 'Test',
      status: 'active',
    });
  });

  it('matching SDD entries returned', async () => {
    const indexContent = [
      'other-slug | PM-999 | done | Other | []',
      'my-slug | PM-001 | confirmed | My SDD | ["a"]',
    ].join('\n');

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(indexContent);

    const result = await projectService.getLinkedSDDs('proj-1');

    expect(result.sddEntries).toHaveLength(1);
    expect(result.sddEntries[0]).toMatchObject({ slug: 'my-slug', pmoNumber: 'PM-001' });
  });

  it('no match → empty array', async () => {
    const indexContent = 'other-slug | PM-999 | done | Other | []';

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(indexContent);

    const result = await projectService.getLinkedSDDs('proj-1');

    expect(result.sddEntries).toEqual([]);
  });

  it('index file not found → empty array', async () => {
    mockExistsSync.mockReturnValue(false);

    const result = await projectService.getLinkedSDDs('proj-1');

    expect(result.sddEntries).toEqual([]);
  });

  it('project not found → throws', async () => {
    // FileStore readJson 返回 null（文件不存在）
    mockFileReadJson.mockResolvedValue(null);

    await expect(projectService.getLinkedSDDs('nope')).rejects.toThrow();
  });
});
