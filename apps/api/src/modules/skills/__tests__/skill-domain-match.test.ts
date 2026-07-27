/**
 * §10 P0 域匹配测试（决策 7/8/11 重构后）
 *
 * - manifest-loader：解析 agentTypes/status；status 显式非 published 跳过，缺省 = active
 * - selectSkillsWithDomain：相关度排序器——显式 hints > 域匹配（normalizeToStage 归一化）
 *   > scope 匹配 > 其余 published（热度/名称序）；全量产出不封顶（调用方按预算截断）
 * - parseSkillHintsFromScope：从 scope 解析 +skill名（决策 11，自 message-routing 迁入）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Isolated test skills dir（SKILLS_DIR 在模块加载时读取，必须先设再 import）
const testSkillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'domain-match-test-'));
process.env.SKILLS_DIR = testSkillsDir;

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// importOriginal：skill-selector 还依赖 normalizeToStage，不能整包替换
vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const orig = await importOriginal() as Record<string, unknown>;
  return { ...orig, logger: mockLogger };
});

const { loadManifest, invalidateManifestCache } = await import('../manifest-loader.js');
const { selectSkillsWithDomain, parseSkillHintsFromScope } = await import('../skill-selector.js');
type SkillEntry = import('../manifest-loader.js').SkillEntry;

function writeSkill(dirName: string, frontmatterLines: string[], body?: string) {
  const dir = path.join(testSkillsDir, dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\n${frontmatterLines.join('\n')}\n---\n\n${body ?? `# ${dirName}\n\nSkill body of ${dirName}.`}\n`,
    'utf-8',
  );
}

function cleanupSkills() {
  for (const dir of fs.readdirSync(testSkillsDir)) {
    fs.rmSync(path.join(testSkillsDir, dir), { recursive: true, force: true });
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  invalidateManifestCache();
  cleanupSkills();
});

afterEach(() => {
  cleanupSkills();
});

describe('manifest-loader: agentTypes/status 解析（§10 P0）', () => {
  it('parses agentTypes array and status from frontmatter', () => {
    writeSkill('feature-dev', [
      'name: feature-dev',
      'description: "功能开发流程"',
      'agentTypes: [feature, refactor]',
      'status: published',
    ]);

    const skills = loadManifest();
    expect(skills.length).toBe(1);
    expect(skills[0].agentTypes).toEqual(['feature', 'refactor']);
    expect(skills[0].status).toBe('published');
  });

  it('skips skill with status explicitly set and != published', () => {
    writeSkill('draft-skill', ['name: draft-skill', 'description: "草稿"', 'status: draft']);
    writeSkill('published-skill', ['name: published-skill', 'description: "正式"', 'status: published']);

    const skills = loadManifest();
    expect(skills.map(s => s.name)).toEqual(['published-skill']);
  });

  it('includes skill without status (absence = active)', () => {
    writeSkill('no-status-skill', ['name: no-status-skill', 'description: "无 status 字段"']);

    const skills = loadManifest();
    expect(skills.length).toBe(1);
    expect(skills[0].status).toBeUndefined();
    expect(skills[0].agentTypes).toBeUndefined();
  });

  it('still skips _-prefixed directories', () => {
    fs.mkdirSync(path.join(testSkillsDir, '_deprecated'), { recursive: true });
    fs.writeFileSync(
      path.join(testSkillsDir, '_deprecated', 'SKILL.md'),
      '---\nname: old-skill\ndescription: "已废弃"\n---\n\nbody\n',
      'utf-8',
    );
    writeSkill('live-skill', ['name: live-skill', 'description: "在用"']);

    const skills = loadManifest();
    expect(skills.map(s => s.name)).toEqual(['live-skill']);
  });
});

describe('parseSkillHintsFromScope（决策 11：+skill 从 scope 解析，自 message-routing 迁入）', () => {
  it('解析全部 +skill名 token（按序）', () => {
    expect(parseSkillHintsFromScope('实现登录 +tdd +review 谢谢')).toEqual(['tdd', 'review']);
  });

  it('去重且保持首次出现顺序', () => {
    expect(parseSkillHintsFromScope('+a +b +a')).toEqual(['a', 'b']);
  });

  it('无 token → 空数组', () => {
    expect(parseSkillHintsFromScope('随便聊聊，没有 hint')).toEqual([]);
  });

  it('支持连字符与下划线 skill 名', () => {
    expect(parseSkillHintsFromScope('+skill-design-skill +my_skill')).toEqual(['skill-design-skill', 'my_skill']);
  });
});

describe('selectSkillsWithDomain（决策 7/8：排序器 + 阶段词表归一化）', () => {
  const entry = (name: string, extra?: Partial<SkillEntry>): SkillEntry => ({
    name,
    path: `${name}/SKILL.md`,
    description: `desc-of-${name}`,
    ...extra,
  });

  it('domain match: agentTypes [feature, refactor] 归一化后命中 WU type feature，域匹配排最前', () => {
    const skills = [
      entry('feature-dev', { agentTypes: ['feature', 'refactor'] }),
      entry('review-only', { agentTypes: ['review'] }),
    ];
    const matched = selectSkillsWithDomain('xyzzy 无交集文本', skills, { acceptedTypes: [], wuType: 'feature' });
    // feature→implement 归一化后命中 feature-dev；未命中的 review-only 作为「其余 published」殿后
    expect(matched.map(s => s.name)).toEqual(['feature-dev', 'review-only']);
  });

  it('归一化（决策 8）：wuType feature → implement 命中 agentTypes [implement]', () => {
    const skills = [entry('impl-skill', { agentTypes: ['implement'] })];
    const matched = selectSkillsWithDomain('', skills, { acceptedTypes: [], wuType: 'feature' });
    expect(matched[0].name).toBe('impl-skill');
  });

  it('归一化（决策 8）：角色 acceptedTypes [feature] → implement；wuType task → general', () => {
    const skills = [
      entry('impl-skill', { agentTypes: ['implement'] }),
      entry('general-skill', { agentTypes: ['general'] }),
    ];
    const matched = selectSkillsWithDomain('', skills, { acceptedTypes: ['feature'], wuType: 'task' });
    expect(matched.map(s => s.name)).toEqual(['impl-skill', 'general-skill']);
  });

  it('domain match: 角色 acceptedTypes 与 WU type 取并集', () => {
    const skills = [entry('review-skill', { agentTypes: ['review'] })];
    const matched = selectSkillsWithDomain('', skills, { acceptedTypes: ['review'], wuType: 'task' });
    expect(matched.map(s => s.name)).toEqual(['review-skill']);
  });

  it('excludes skill with status draft even when domain matches', () => {
    const skills = [entry('draft-skill', { agentTypes: ['feature'], status: 'draft' })];
    const matched = selectSkillsWithDomain('', skills, { acceptedTypes: [], wuType: 'feature' });
    expect(matched).toEqual([]);
  });

  it('includes skill without status when domain matches', () => {
    const skills = [entry('active-skill', { agentTypes: ['feature'] })];
    const matched = selectSkillsWithDomain('', skills, { acceptedTypes: [], wuType: 'feature' });
    expect(matched.map(s => s.name)).toEqual(['active-skill']);
  });

  it('skill without agentTypes falls back to scope matching', () => {
    const skills = [entry('session-analyst', { description: '分析需求、产出 spec/SDD、AC 形式化' })];
    const matched = selectSkillsWithDomain('分析需求：用户认证', skills, { acceptedTypes: [], wuType: 'task' });
    expect(matched.map(s => s.name)).toContain('session-analyst');
  });

  it('domain matches first, then scope matches, dedup by name', () => {
    const skills = [
      // 同时命中域与 scope —— 只应出现一次，且排在最前
      entry('both', { agentTypes: ['feature'], description: '分析需求、产出 spec' }),
      entry('scope-only', { description: '分析需求、AC 形式化' }),
    ];
    const matched = selectSkillsWithDomain('分析需求', skills, { acceptedTypes: [], wuType: 'feature' });
    const names = matched.map(s => s.name);
    expect(names[0]).toBe('both');
    expect(names.filter(n => n === 'both').length).toBe(1);
    expect(names).toContain('scope-only');
  });

  it('决策 7：不再封顶 3 —— 返回相关度排序全量列表（由调用方按预算截断）', () => {
    const skills = [
      entry('s1', { agentTypes: ['feature'] }),
      entry('s2', { agentTypes: ['feature'] }),
      entry('s3', { agentTypes: ['feature'] }),
      entry('s4', { agentTypes: ['feature'] }),
    ];
    const matched = selectSkillsWithDomain('', skills, { acceptedTypes: [], wuType: 'feature' });
    expect(matched.length).toBe(4);
  });

  it('其余 published 殿后：有引用数按引用数降序', () => {
    const skills = [
      entry('low', { referenceCount: 1 }),
      entry('high', { referenceCount: 9 }),
      entry('mid', { referenceCount: 5 }),
    ];
    const matched = selectSkillsWithDomain('', skills, { acceptedTypes: [], wuType: 'zzz-无交集' });
    expect(matched.map(s => s.name)).toEqual(['high', 'mid', 'low']);
  });

  it('其余 published 殿后：无引用数/更新时间字段按名称序兜底', () => {
    const skills = [entry('delta'), entry('bravo'), entry('alpha')];
    const matched = selectSkillsWithDomain('', skills, { acceptedTypes: [], wuType: 'zzz-无交集' });
    expect(matched.map(s => s.name)).toEqual(['alpha', 'bravo', 'delta']);
  });

  it('决策 11：显式 hint 强制置顶于域匹配之前', () => {
    const skills = [
      entry('hint-skill', { description: 'xyzzy 无交集' }),
      entry('domain-a', { agentTypes: ['implement'] }),
    ];
    const matched = selectSkillsWithDomain('', skills, { acceptedTypes: [], wuType: 'implement' }, ['hint-skill']);
    expect(matched[0].name).toBe('hint-skill');
    expect(matched.map(s => s.name)).toContain('domain-a');
  });

  it('未知 hint 跳过并记日志，其余排序不受影响', () => {
    const skills = [entry('domain-a', { agentTypes: ['implement'] })];
    const matched = selectSkillsWithDomain('', skills, { acceptedTypes: [], wuType: 'implement' }, ['no-such-skill']);
    expect(matched.map(s => s.name)).toEqual(['domain-a']);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('not found'),
      expect.objectContaining({ hint: 'no-such-skill' }),
    );
  });

  it('consumers:[loop] 的 hint 跳过（hub-only，不进 WU）', () => {
    const skills = [
      entry('loop-skill', { agentTypes: ['implement'], consumers: ['loop'] }),
      entry('domain-a', { agentTypes: ['implement'] }),
    ];
    const matched = selectSkillsWithDomain('', skills, { acceptedTypes: [], wuType: 'implement' }, ['loop-skill']);
    expect(matched.map(s => s.name)).toEqual(['domain-a']);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('not found'),
      expect.objectContaining({ hint: 'loop-skill' }),
    );
  });
});
