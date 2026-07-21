/**
 * §10 P0 域匹配测试
 *
 * - manifest-loader：解析 agentTypes/status；status 显式非 published 跳过，缺省 = active
 * - selectSkillsWithDomain：域交集主信号 + scope 次级信号、去重、封顶 3
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Isolated test skills dir（SKILLS_DIR 在模块加载时读取，必须先设再 import）
const testSkillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'domain-match-test-'));
process.env.SKILLS_DIR = testSkillsDir;

vi.mock('@dommaker/studio-shared', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { loadManifest, invalidateManifestCache, loadSkillBody } = await import('../manifest-loader.js');
const { selectSkillsWithDomain, parseAcceptedTypesFromDescription } = await import('../skill-selector.js');
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

  it('loadSkillBody returns body without frontmatter', () => {
    writeSkill('body-skill', ['name: body-skill', 'description: "正文测试"'], '## 步骤\n\n1. 先做\n2. 后做');

    const entry = loadManifest().find(s => s.name === 'body-skill')!;
    const body = loadSkillBody(entry);
    expect(body).toContain('## 步骤');
    expect(body).not.toContain('---');
    expect(body).not.toContain('description');
  });
});

describe('parseAcceptedTypesFromDescription（与 agent-loop 同一关键词集）', () => {
  it('extracts type keywords from description', () => {
    expect(parseAcceptedTypesFromDescription('负责 feature 开发与 code review 工作'))
      .toEqual(['feature', 'review']);
  });

  it('returns [] for null/empty description', () => {
    expect(parseAcceptedTypesFromDescription(null)).toEqual([]);
    expect(parseAcceptedTypesFromDescription('')).toEqual([]);
  });
});

describe('selectSkillsWithDomain（§10.3 域匹配动态解析）', () => {
  const entry = (name: string, extra?: Partial<SkillEntry>): SkillEntry => ({
    name,
    path: `${name}/SKILL.md`,
    description: `desc-of-${name}`,
    ...extra,
  });

  it('domain match: agentTypes [feature, refactor] 命中 WU type feature', () => {
    const skills = [
      entry('feature-dev', { agentTypes: ['feature', 'refactor'] }),
      entry('review-only', { agentTypes: ['review'] }),
    ];
    const matched = selectSkillsWithDomain('xyzzy 无交集文本', skills, { acceptedTypes: [], wuType: 'feature' });
    expect(matched.map(s => s.name)).toEqual(['feature-dev']);
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

  it('caps result at 3 skills', () => {
    const skills = [
      entry('s1', { agentTypes: ['feature'] }),
      entry('s2', { agentTypes: ['feature'] }),
      entry('s3', { agentTypes: ['feature'] }),
      entry('s4', { agentTypes: ['feature'] }),
    ];
    const matched = selectSkillsWithDomain('', skills, { acceptedTypes: [], wuType: 'feature' });
    expect(matched.length).toBe(3);
  });
});
