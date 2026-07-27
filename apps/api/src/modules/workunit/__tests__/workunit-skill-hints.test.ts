/**
 * §10.3 显式覆盖：metadata.skillHints（+skill名）在 claim 时强制置顶匹配集
 *
 * - hint 按精确名从 manifest 解析，置于域匹配结果之前（显式 > 域匹配）
 * - 未知 / 非 published / consumers:[loop] 的 hint 跳过并记日志
 * - 总数封顶 3（hint 优先占位）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Isolated test skills dir（SKILLS_DIR 在模块加载时读取，必须先设再 import）
const testSkillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-hints-test-'));
process.env.SKILLS_DIR = testSkillsDir;

function writeSkill(name: string, frontmatter: string) {
  fs.mkdirSync(path.join(testSkillsDir, name), { recursive: true });
  fs.writeFileSync(
    path.join(testSkillsDir, name, 'SKILL.md'),
    `---\nname: ${name}\n${frontmatter}\n---\n\n# ${name}\n`,
    'utf-8',
  );
}

// description 均为零文本交集词 —— scope 匹配不命中，只剩域匹配/hint 两条路
writeSkill('hint-skill', 'description: "xyzzy 无交集"\nstatus: published');
writeSkill('loop-skill', 'description: "xyzzy 无交集"\nstatus: published\nagentTypes: [feature]\nconsumers: [loop]');
writeSkill('draft-skill', 'description: "xyzzy 无交集"\nstatus: draft');
writeSkill('domain-a', 'description: "xyzzy 无交集"\nstatus: published\nagentTypes: [feature]');
writeSkill('domain-b', 'description: "xyzzy 无交集"\nstatus: published\nagentTypes: [feature]');
writeSkill('domain-c', 'description: "xyzzy 无交集"\nstatus: published\nagentTypes: [feature]');

const { mockFileStore, mockLogger } = vi.hoisted(() => ({
  mockFileStore: {
    getIndex: vi.fn(),
    claimWorkUnit: vi.fn(),
    upsertSnapshot: vi.fn(),
    appendEvent: vi.fn(),
    getState: vi.fn(),
    getProfile: vi.fn(),
  },
  mockLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, logger: mockLogger };
});

const { WorkUnitService } = await import('../../workunit/workunit.service.js');
const { invalidateManifestCache } = await import('../../skills/manifest-loader.js');

describe('§10.3: claim 时 skillHints 显式覆盖', () => {
  let service: InstanceType<typeof WorkUnitService>;

  /** scope 与所有 skill 零文本交集；域 = WU type feature + profile feature → 命中 domain-a/b/c */
  function setupClaim(metadata: string | null) {
    const base = {
      id: 'wu-1', status: 'unassigned', scope: 'xyzzy 无交集', type: 'feature',
      parentId: null, assigneeId: null, failureType: null,
      retryCount: 0, timeoutAt: null, channelId: null, projectPath: null,
      metadata, claimedAt: null, completedAt: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    let getIndexCalls = 0;
    mockFileStore.getIndex.mockImplementation(() => {
      getIndexCalls++;
      return getIndexCalls === 1
        ? [base]
        : [{ ...base, assigneeId: 'inst-1', status: 'active' }];
    });
    mockFileStore.claimWorkUnit.mockResolvedValue(true);
    mockFileStore.upsertSnapshot.mockResolvedValue(undefined);
    mockFileStore.appendEvent.mockResolvedValue(undefined);
    mockFileStore.getState.mockResolvedValue({ id: 'inst-1', roleId: 'role-1' });
    mockFileStore.getProfile.mockResolvedValue({ id: 'role-1', description: '负责 feature 开发' });
  }

  /** 等待 fire-and-forget 的 autoLoad 落盘，返回持久化的 matchedSkills */
  async function persistedMatchedSkills(): Promise<string[]> {
    // P0 修复后 claim 会先写一次 timeoutAt（upsertSnapshot 调用顺序不再固定）——
    // 按内容定位含 matchedSkills 的那次写入
    const withMatchedSkills = (c: unknown[]) => {
      try {
        const meta = (c[0] as { metadata?: string | null })?.metadata;
        return meta ? JSON.parse(meta).matchedSkills : undefined;
      } catch {
        return undefined;
      }
    };
    await vi.waitFor(() => {
      expect(mockFileStore.upsertSnapshot.mock.calls.some(c => withMatchedSkills(c))).toBe(true);
    });
    const call = mockFileStore.upsertSnapshot.mock.calls.find(c => withMatchedSkills(c));
    return JSON.parse((call![0] as { metadata: string }).metadata).matchedSkills;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    invalidateManifestCache();
    service = new WorkUnitService(mockFileStore as never);
  });

  it('hint 强制置顶于域匹配之前，总数封顶 3', async () => {
    setupClaim(JSON.stringify({ skillHints: ['hint-skill'] }));

    await service.claim('wu-1', 'inst-1');
    const matched = await persistedMatchedSkills();

    // hint-skill 无 agentTypes、无 scope 交集 —— 只能靠显式 hint 进入匹配集
    expect(matched[0]).toBe('hint-skill');
    // 1 hint + 3 域匹配共 4 个候选 → 封顶 3
    expect(matched).toHaveLength(3);
    expect(matched.slice(1).every(n => ['domain-a', 'domain-b', 'domain-c'].includes(n))).toBe(true);
  });

  it('未知 hint 跳过并记日志，域匹配不受影响', async () => {
    setupClaim(JSON.stringify({ skillHints: ['no-such-skill'] }));

    await service.claim('wu-1', 'inst-1');
    const matched = await persistedMatchedSkills();

    expect(matched).toHaveLength(3);
    expect(matched.every(n => ['domain-a', 'domain-b', 'domain-c'].includes(n))).toBe(true);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('not found'),
      expect.objectContaining({ hint: 'no-such-skill' }),
    );
  });

  it('consumers:[loop] 的 hint 跳过（hub-only，不进 WU）', async () => {
    setupClaim(JSON.stringify({ skillHints: ['loop-skill'] }));

    await service.claim('wu-1', 'inst-1');
    const matched = await persistedMatchedSkills();

    // loop-skill 声明了 agentTypes:[feature]，域匹配与 hint 两条路都必须排除它
    expect(matched).not.toContain('loop-skill');
    expect(matched).toHaveLength(3);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('loop-only'),
      expect.objectContaining({ hint: 'loop-skill' }),
    );
  });

  it('非 published 的 hint 跳过（draft 不进 manifest，按未找到处理）', async () => {
    setupClaim(JSON.stringify({ skillHints: ['draft-skill'] }));

    await service.claim('wu-1', 'inst-1');
    const matched = await persistedMatchedSkills();

    expect(matched).not.toContain('draft-skill');
    expect(matched).toHaveLength(3);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('not found'),
      expect.objectContaining({ hint: 'draft-skill' }),
    );
  });

  it('无 hint 时行为不变（纯域匹配）', async () => {
    setupClaim(null);

    await service.claim('wu-1', 'inst-1');
    const matched = await persistedMatchedSkills();

    expect(matched).toHaveLength(3);
    expect(matched.every(n => ['domain-a', 'domain-b', 'domain-c'].includes(n))).toBe(true);
  });
});
