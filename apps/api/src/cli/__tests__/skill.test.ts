/**
 * studio skill validate/export/install 命令测试（#568）
 *
 * P1：validate CLI 退出码；P2：export/install 语义（tmp 目录 + SKILLS_DIR/STUDIO_HOME 隔离）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { studioSkill } from '../skill.js';
import { hashSkillDir, skillLoader } from '@dommaker/studio-skill';

let root: string;
let savedEnv: Record<string, string | undefined>;

function writeSkill(base: string, name: string, files: Record<string, string>): string {
  const dir = path.join(base, name);
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf-8');
  }
  return dir;
}

function validSkillMd(name: string, extra = ''): string {
  return `---\nname: ${name}\ndescription: "测试"\ntriggers: [测试]\nstatus: published\n${extra}---\n\n# body\n`;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'skill-cmd-test-'));
  savedEnv = { SKILLS_DIR: process.env.SKILLS_DIR, STUDIO_HOME: process.env.STUDIO_HOME };
  process.env.STUDIO_HOME = path.join(root, 'home');
  process.env.SKILLS_DIR = path.join(root, 'home', 'skills');
  fs.mkdirSync(process.env.SKILLS_DIR, { recursive: true });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe('studio skill validate（CLI 退出码）', () => {
  it('合法 skill → 0', async () => {
    const dir = writeSkill(root, 'ok-skill', { 'SKILL.md': validSkillMd('ok-skill') });
    expect(await studioSkill(['validate', dir])).toBe(0);
  });

  it('缺 SKILL.md → 1', async () => {
    const dir = path.join(root, 'broken');
    fs.mkdirSync(dir, { recursive: true });
    expect(await studioSkill(['validate', dir])).toBe(1);
  });

  it('name≠目录名 → 1', async () => {
    const dir = writeSkill(root, 'outer', { 'SKILL.md': validSkillMd('inner') });
    expect(await studioSkill(['validate', dir])).toBe(1);
  });

  it('缺参数 → 1', async () => {
    expect(await studioSkill(['validate'])).toBe(1);
  });

  it('未知子命令 → 1', async () => {
    expect(await studioSkill(['frobnicate'])).toBe(1);
  });
});

describe('studio skill export', () => {
  it('产出目录树与数据区逐字节一致，PROVENANCE.json 字段正确（AC2）', async () => {
    const src = writeSkill(process.env.SKILLS_DIR!, 'exp-skill', {
      'SKILL.md': validSkillMd('exp-skill', 'version: 3\n'),
      'refs/x.md': 'ref-content\n',
      'refs/deep/y.md': 'deep\n',
    });
    const out = path.join(root, 'out');
    fs.mkdirSync(out, { recursive: true });
    expect(await studioSkill(['export', 'exp-skill', out])).toBe(0);

    const dest = path.join(out, 'exp-skill');
    for (const rel of ['SKILL.md', 'refs/x.md', 'refs/deep/y.md']) {
      expect(fs.readFileSync(path.join(dest, rel), 'utf-8'))
        .toBe(fs.readFileSync(path.join(src, rel), 'utf-8'));
    }
    const prov = JSON.parse(fs.readFileSync(path.join(dest, 'PROVENANCE.json'), 'utf-8'));
    expect(prov.name).toBe('exp-skill');
    expect(prov.version).toBe(3);
    expect(prov.exportedAt).toBeTruthy();
    expect(prov.source).toBe('unknown'); // 无 skills-index 记录
    expect(prov.contentHash).toBe(hashSkillDir(src));
  });

  it('提取来源 skill 的 source/sourceWorkUnits 来自 skills-index.json（AC2）', async () => {
    writeSkill(process.env.SKILLS_DIR!, 'ext-skill', { 'SKILL.md': validSkillMd('ext-skill') });
    fs.writeFileSync(
      path.join(process.env.STUDIO_HOME!, 'skills-index.json'),
      JSON.stringify([{ name: 'ext-skill', source: 'auto_extracted', metadata: JSON.stringify({ sourceGoalIds: ['WU-1', 'WU-2'] }) }]),
      'utf-8',
    );
    const out = path.join(root, 'out');
    fs.mkdirSync(out, { recursive: true });
    expect(await studioSkill(['export', 'ext-skill', out])).toBe(0);
    const prov = JSON.parse(fs.readFileSync(path.join(out, 'ext-skill', 'PROVENANCE.json'), 'utf-8'));
    expect(prov.source).toBe('auto_extracted');
    expect(prov.sourceWorkUnits).toEqual(['WU-1', 'WU-2']);
  });

  it('frontmatter 无 version → PROVENANCE version 缺省 1', async () => {
    writeSkill(process.env.SKILLS_DIR!, 'noversion', { 'SKILL.md': validSkillMd('noversion') });
    const out = path.join(root, 'out');
    fs.mkdirSync(out, { recursive: true });
    expect(await studioSkill(['export', 'noversion', out])).toBe(0);
    const prov = JSON.parse(fs.readFileSync(path.join(out, 'noversion', 'PROVENANCE.json'), 'utf-8'));
    expect(prov.version).toBe(1);
  });

  it('数据区不存在该 skill → 1', async () => {
    expect(await studioSkill(['export', 'ghost', root])).toBe(1);
  });

  it('数据区 skill 校验有 error → 1 且不产出', async () => {
    writeSkill(process.env.SKILLS_DIR!, 'bad-skill', { 'SKILL.md': '---\nname: other\n---\n' });
    const out = path.join(root, 'out');
    fs.mkdirSync(out, { recursive: true });
    expect(await studioSkill(['export', 'bad-skill', out])).toBe(1);
    expect(fs.existsSync(path.join(out, 'bad-skill'))).toBe(false);
  });

  it('outDir 已存在同名 → 拒绝；--force 覆盖', async () => {
    writeSkill(process.env.SKILLS_DIR!, 'dup-skill', { 'SKILL.md': validSkillMd('dup-skill') });
    const out = path.join(root, 'out');
    writeSkill(out, 'dup-skill', { 'SKILL.md': 'stale\n' });
    expect(await studioSkill(['export', 'dup-skill', out])).toBe(1);
    expect(fs.readFileSync(path.join(out, 'dup-skill', 'SKILL.md'), 'utf-8')).toBe('stale\n');
    expect(await studioSkill(['export', 'dup-skill', out, '--force'])).toBe(0);
    expect(fs.readFileSync(path.join(out, 'dup-skill', 'SKILL.md'), 'utf-8')).toBe(validSkillMd('dup-skill'));
  });
});

describe('studio skill install', () => {
  it('装进数据区后可被 skillLoader.loadSingle 加载（AC3）', async () => {
    const src = writeSkill(root, 'new-skill', { 'SKILL.md': validSkillMd('new-skill'), 'refs/a.md': 'a\n' });
    expect(await studioSkill(['install', src])).toBe(0);
    const def = skillLoader.loadSingle('new-skill');
    expect(def).not.toBeNull();
    expect(def!.name).toBe('new-skill');
    expect(fs.existsSync(path.join(process.env.SKILLS_DIR!, 'new-skill', 'refs', 'a.md'))).toBe(true);
  });

  it('与内置正本同名 → 硬拒绝且不写任何文件（AC4/Q3）', async () => {
    const src = writeSkill(root, 'research', { 'SKILL.md': validSkillMd('research') });
    expect(await studioSkill(['install', src])).toBe(1);
    expect(fs.existsSync(path.join(process.env.SKILLS_DIR!, 'research'))).toBe(false);
  });

  it('数据区同名同 hash → no-op（0）', async () => {
    const files = { 'SKILL.md': validSkillMd('same-skill'), 'refs/a.md': 'a\n' };
    writeSkill(process.env.SKILLS_DIR!, 'same-skill', files);
    const src = writeSkill(root, 'same-skill', files);
    expect(await studioSkill(['install', src])).toBe(0);
  });

  it('数据区同名不同 hash → 无 --force 拒绝，有 --force 覆盖（AC4）', async () => {
    writeSkill(process.env.SKILLS_DIR!, 'conflict-skill', { 'SKILL.md': validSkillMd('conflict-skill') + 'old\n' });
    const src = writeSkill(root, 'conflict-skill', { 'SKILL.md': validSkillMd('conflict-skill') + 'new\n' });
    expect(await studioSkill(['install', src])).toBe(1);
    expect(fs.readFileSync(path.join(process.env.SKILLS_DIR!, 'conflict-skill', 'SKILL.md'), 'utf-8')).toContain('old');
    expect(await studioSkill(['install', src, '--force'])).toBe(0);
    expect(fs.readFileSync(path.join(process.env.SKILLS_DIR!, 'conflict-skill', 'SKILL.md'), 'utf-8')).toContain('new');
  });

  it('install 后 .builtin-hashes.json 与 skills-index.json 内容不变（AC5）', async () => {
    const hashesFile = path.join(process.env.SKILLS_DIR!, '.builtin-hashes.json');
    const indexFile = path.join(process.env.STUDIO_HOME!, 'skills-index.json');
    fs.writeFileSync(hashesFile, '{"a":"b"}\n', 'utf-8');
    fs.writeFileSync(indexFile, '[]', 'utf-8');
    const src = writeSkill(root, 'clean-skill', { 'SKILL.md': validSkillMd('clean-skill') });
    expect(await studioSkill(['install', src])).toBe(0);
    expect(fs.readFileSync(hashesFile, 'utf-8')).toBe('{"a":"b"}\n');
    expect(fs.readFileSync(indexFile, 'utf-8')).toBe('[]');
  });

  it('来源目录校验有 error → 1', async () => {
    const src = writeSkill(root, 'bad-install', { 'SKILL.md': '# no frontmatter\n' });
    expect(await studioSkill(['install', src])).toBe(1);
    expect(fs.existsSync(path.join(process.env.SKILLS_DIR!, 'bad-install'))).toBe(false);
  });
});
