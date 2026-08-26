/**
 * §10.3 显式覆盖 → 决策 11 重构：+skill名 解析从 message-routing/claim 挪到
 * step 时（skill-selector.parseSkillHintsFromScope + selectSkillsWithDomain）。
 * claim 不再消费 metadata.skillHints（workunit.service 的 autoLoadSkillsForAgent 已删除）。
 *
 * 本文件覆盖迁移后的等价行为（磁盘 manifest 版）：
 * - hint 按精确名从 manifest 解析，置于域匹配结果之前（显式 > 域匹配）
 * - 决策 7：排序器全量产出，不再封顶 3（由调用方按预算截断）
 * - 未知 / 非 published / consumers:[loop] 的 hint 跳过并记日志
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Isolated test skills dir（SKILLS_DIR 在模块加载时读取，必须先设再 import）
const testSkillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-hints-test-'));
process.env.SKILLS_DIR = testSkillsDir;
// 显式清理：`import * as fs` 走原生命名空间，mkdtemp-cleanup 补丁登记不到（见其头注）
afterAll(() => { fs.rmSync(testSkillsDir, { recursive: true, force: true }); });

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
writeSkill('loop-skill', 'description: "xyzzy 无交集"\nstatus: published\nagentTypes: [implement]\nconsumers: [loop]');
writeSkill('draft-skill', 'description: "xyzzy 无交集"\nstatus: draft');
writeSkill('domain-a', 'description: "xyzzy 无交集"\nstatus: published\nagentTypes: [implement]');
writeSkill('domain-b', 'description: "xyzzy 无交集"\nstatus: published\nagentTypes: [implement]');
writeSkill('domain-c', 'description: "xyzzy 无交集"\nstatus: published\nagentTypes: [implement]');

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual as object, logger: mockLogger };
});

const { loadManifest, invalidateManifestCache } = await import('../../skills/manifest-loader.js');
const { selectSkillsWithDomain, parseSkillHintsFromScope } = await import('../../skills/skill-selector.js');

describe('§10.3 → 决策 11: +skill 显式点名（step 时从 scope 解析）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateManifestCache();
  });

  it('hint 强制置顶于域匹配之前；排序器全量产出不再封顶 3', () => {
    const hints = parseSkillHintsFromScope('xyzzy 无交集 +hint-skill');
    expect(hints).toEqual(['hint-skill']);

    const matched = selectSkillsWithDomain(
      'xyzzy 无交集', loadManifest(), { acceptedTypes: ['feature'], wuType: 'feature' }, hints,
    );

    // hint-skill 无 agentTypes、无 scope 交集 —— 只能靠显式 hint 进入排序头部
    expect(matched[0].name).toBe('hint-skill');
    // 1 hint + 3 域匹配共 4 个 —— 决策 7：不再封顶 3
    expect(matched).toHaveLength(4);
    expect(matched.slice(1).every(s => ['domain-a', 'domain-b', 'domain-c'].includes(s.name))).toBe(true);
  });

  it('未知 hint 跳过并记日志，域匹配不受影响', () => {
    const matched = selectSkillsWithDomain(
      'xyzzy 无交集', loadManifest(), { acceptedTypes: [], wuType: 'feature' }, ['no-such-skill'],
    );

    // 3 个域匹配在前；hint-skill（无交集但 published）作为「其余」殿后 —— 排序器全量产出
    expect(matched).toHaveLength(4);
    expect(matched.slice(0, 3).every(s => ['domain-a', 'domain-b', 'domain-c'].includes(s.name))).toBe(true);
    expect(matched[3].name).toBe('hint-skill');
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('not found'),
      expect.objectContaining({ hint: 'no-such-skill' }),
    );
  });

  it('consumers:[loop] 的 hint 跳过（hub-only，不进 WU）', () => {
    const matched = selectSkillsWithDomain(
      'xyzzy 无交集', loadManifest(), { acceptedTypes: [], wuType: 'feature' }, ['loop-skill'],
    );

    // loop-skill 声明了 agentTypes:[implement]，域匹配/hint/「其余」三条路都必须排除它
    expect(matched.map(s => s.name)).not.toContain('loop-skill');
    expect(matched).toHaveLength(4);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('not found'),
      expect.objectContaining({ hint: 'loop-skill' }),
    );
  });

  it('非 published 的 hint 跳过（draft 不进 manifest，按未找到处理）', () => {
    const matched = selectSkillsWithDomain(
      'xyzzy 无交集', loadManifest(), { acceptedTypes: [], wuType: 'feature' }, ['draft-skill'],
    );

    expect(matched.map(s => s.name)).not.toContain('draft-skill');
    expect(matched).toHaveLength(4);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('not found'),
      expect.objectContaining({ hint: 'draft-skill' }),
    );
  });

  it('无 hint 时纯域匹配（feature 归一化为 implement 后命中），其余 published 殿后', () => {
    const matched = selectSkillsWithDomain(
      'xyzzy 无交集', loadManifest(), { acceptedTypes: [], wuType: 'feature' },
    );

    expect(matched.map(s => s.name)).toEqual(['domain-a', 'domain-b', 'domain-c', 'hint-skill']);
  });
});
