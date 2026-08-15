// AC-10: PMO-SDD association query tests（#155 新口径）
//
// getLinkedSDDs 新口径：spec 唯一落点 = specsDir(project.gitRepo) = <gitRepo>/.studio/specs/*.md
// - project 无 gitRepo 或 specs 目录不存在 → { sddEntries: [] } 不报错
// - 每个 .md 尽量解析 frontmatter 取 title/status，取不到用文件名/空串兜底
// 测试 mock FileStore（readJson）与 node:fs（readdirSync/readFileSync）。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockFileReadJson,
  mockReaddirSync,
  mockReadFileSync,
} = vi.hoisted(() => ({
  mockFileReadJson: vi.fn(),
  mockReaddirSync: vi.fn(),
  mockReadFileSync: vi.fn(),
}));

// Mock FileStore — project.service 模块级 `new FileStore()`，get() 走 readJson
vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared')>();
  return {
    ...actual,
    FileStore: vi.fn().mockImplementation(function () { return {
      readJson: mockFileReadJson,
    }; }),
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
  WorkUnitService: vi.fn().mockImplementation(function () { return {
    create: vi.fn(),
  }; }),
}));

// Partial mock of node:fs（project.service 以 'node:fs' 导入）— keep other fs functions intact
vi.mock('node:fs', async (importOriginal) => {
  const orig = await importOriginal() as Record<string, unknown>;
  return {
    ...orig,
    readdirSync: mockReaddirSync,
    readFileSync: mockReadFileSync,
  };
});

import { projectService } from '../project.service.js';

const PROJECT_WITH_REPO = {
  id: 'proj-1',
  pmoNumber: 'PM-001',
  title: 'Test',
  status: 'active',
  gitRepo: '/repo/biz',
};

describe('AC-10: PMO-SDD association query（specs 目录口径）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFileReadJson.mockResolvedValue(PROJECT_WITH_REPO);
  });

  it('specs 目录下 .md 文件全部列出，frontmatter 提供 title/status', async () => {
    mockReaddirSync.mockReturnValue(['alpha-spec.md', 'beta-spec.md', 'notes.txt']);
    mockReadFileSync.mockImplementation((p: string) =>
      p.endsWith('alpha-spec.md')
        ? '---\ntitle: "Alpha Spec"\nstatus: "confirmed"\n---\n\nbody'
        : '---\ntitle: "Beta Spec"\nstatus: "draft"\n---\n\nbody');

    const result = await projectService.getLinkedSDDs('proj-1');

    expect(result.sddEntries).toHaveLength(2);
    expect(result.sddEntries[0]).toEqual({
      slug: 'alpha-spec', pmoNumber: 'PM-001', status: 'confirmed', title: 'Alpha Spec', tags: '',
    });
    expect(result.sddEntries[1]).toMatchObject({ slug: 'beta-spec', status: 'draft', title: 'Beta Spec' });
    // readdir 落在 <gitRepo>/.studio/specs
    expect(mockReaddirSync).toHaveBeenCalledWith(expect.stringMatching(/\/repo\/biz\/\.studio\/specs$/));
  });

  it('无 frontmatter 的 .md → 文件名/空串兜底', async () => {
    mockReaddirSync.mockReturnValue(['bare.md']);
    mockReadFileSync.mockReturnValue('no frontmatter here');

    const result = await projectService.getLinkedSDDs('proj-1');

    expect(result.sddEntries).toEqual([
      { slug: 'bare', pmoNumber: 'PM-001', status: '', title: 'bare', tags: '' },
    ]);
  });

  it('project 无 gitRepo → 空列表（不读目录）', async () => {
    mockFileReadJson.mockResolvedValue({ ...PROJECT_WITH_REPO, gitRepo: undefined });

    const result = await projectService.getLinkedSDDs('proj-1');

    expect(result.sddEntries).toEqual([]);
    expect(mockReaddirSync).not.toHaveBeenCalled();
  });

  it('specs 目录不存在 → 空列表（不报错）', async () => {
    mockReaddirSync.mockImplementation(() => { throw new Error('ENOENT'); });

    const result = await projectService.getLinkedSDDs('proj-1');

    expect(result.sddEntries).toEqual([]);
  });

  it('project not found → throws', async () => {
    // FileStore readJson 返回 null（文件不存在）
    mockFileReadJson.mockResolvedValue(null);

    await expect(projectService.getLinkedSDDs('nope')).rejects.toThrow();
  });
});
