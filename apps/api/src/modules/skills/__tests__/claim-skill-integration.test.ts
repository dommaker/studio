/**
 * WorkUnit claim + skill auto-load integration test (AS-025 §3.28c-5)
 * → 决策 7 重构：claim 不再自动加载 skill（匹配挪到 agent-loop step 时）。
 * 本文件保留为 claim 基础行为冒烟：claim 成功/无匹配不抛错/乐观锁失败抛错。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Isolated test skills dir
const testSkillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-skill-test-'));
process.env.SKILLS_DIR = testSkillsDir;

// Create test SKILL.md files with description in frontmatter
const SKILL_DESCRIPTIONS: Record<string, string> = {
  'session-analyst': '需求分析、产出 spec/SDD、AC 形式化',
  'code-review': '代码审查、多维度质量检查、AC 覆盖',
};
for (const [name, description] of Object.entries(SKILL_DESCRIPTIONS)) {
  const dir = path.join(testSkillsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: "${description}"\nstatus: published\n---\n\n# ${name}\nSkill content for ${name}\n`,
    'utf-8'
  );
}

const { mockFileStore } = vi.hoisted(() => ({
  mockFileStore: {
    getIndex: vi.fn(),
    claimWorkUnit: vi.fn(),
    upsertSnapshot: vi.fn(),
    appendEvent: vi.fn(),
    removeSnapshot: vi.fn(),
    // #170：update 改走锁内成对原语（claim 的 timeoutAt 回写经过）
    commitSnapshot: vi.fn(),
  },
}));

// Mock @dommaker/studio-skill (used by SkillLoaderService internally)
vi.mock('@dommaker/studio-skill', () => ({
  skillLoader: {
    loadSingle: vi.fn((name: string) => ({
      prompt: `Mock prompt for ${name}`,
      tools: [],
      requires: [],
    })),
    get: vi.fn(),
  },
}));

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
});

const { WorkUnitService } = await import('../../workunit/workunit.service.js');
const { invalidateManifestCache } = await import('../manifest-loader.js');

describe('AC4 → 决策 7: claim 基础行为（skill 匹配已挪到 step 时）', () => {
  let service: WorkUnitService;

  beforeEach(() => {
    vi.clearAllMocks();
    invalidateManifestCache();

    service = new WorkUnitService(mockFileStore as never);
  });

  it('claim 成功返回 claimed WU（不再触发 skill 自动加载）', async () => {
    const baseSnapshot = {
      id: 'wu-1', status: 'unassigned', scope: '分析需求：用户认证',
      parentId: null, type: 'task', assigneeId: null, failureType: null,
      retryCount: 0, timeoutAt: null, channelId: null, projectPath: null,
      metadata: null, claimedAt: null, completedAt: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    const claimedSnapshot = {
      ...baseSnapshot,
      assigneeId: 'agent-1',
      status: 'active',
    };
    let getIndexCalls = 0;
    mockFileStore.getIndex.mockImplementation(() => {
      getIndexCalls++;
      return getIndexCalls === 1 ? [baseSnapshot] : [claimedSnapshot];
    });
    mockFileStore.claimWorkUnit.mockResolvedValue(true);

    const result = await service.claim('wu-1', 'agent-1');
    expect(result).toBeDefined();
    expect(result.assigneeId).toBe('agent-1');
    expect(result.status).toBe('active');
    // Skill loading happens internally — no error thrown means success
  });

  it('does not throw when no skills match', async () => {
    const baseSnapshot = {
      id: 'wu-2', status: 'unassigned', scope: '完全无关的 scope 内容',
      parentId: null, type: 'task', assigneeId: null, failureType: null,
      retryCount: 0, timeoutAt: null, channelId: null, projectPath: null,
      metadata: null, claimedAt: null, completedAt: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    let getIndexCalls = 0;
    mockFileStore.getIndex.mockImplementation(() => {
      getIndexCalls++;
      return getIndexCalls === 1
        ? [baseSnapshot]
        : [{ ...baseSnapshot, assigneeId: 'agent-1', status: 'active' }];
    });
    mockFileStore.claimWorkUnit.mockResolvedValue(true);

    const result = await service.claim('wu-2', 'agent-1');
    expect(result).toBeDefined();
  });

  it('throws when claim fails (optimistic lock)', async () => {
    mockFileStore.getIndex.mockResolvedValue([
      {
        id: 'wu-3', status: 'unassigned', scope: 'test',
        parentId: null, type: 'task', assigneeId: null, failureType: null,
        retryCount: 0, timeoutAt: null, channelId: null, projectPath: null,
        metadata: null, claimedAt: null, completedAt: null,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      },
    ]);
    mockFileStore.claimWorkUnit.mockResolvedValue(false);

    await expect(service.claim('wu-3', 'agent-1')).rejects.toThrow('Claim failed');
  });
});
