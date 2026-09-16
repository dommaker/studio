/**
 * skill-validate 规则矩阵测试（#568 P1）
 *
 * 每个 error/warning 规则一例 + 合法用例（含真实内置正本，对应 AC1）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { validateSkillDir } from '../skill-validate.js';

let root: string;

function writeSkill(name: string, content: string, dirName = name): string {
  const dir = path.join(root, dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf-8');
  return dir;
}

const VALID = [
  '---',
  'name: my-skill',
  'description: "测试 skill"',
  'triggers: [测试]',
  'status: published',
  '---',
  '',
  '# body',
].join('\n');

beforeEach(() => {
  root = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'skill-validate-test-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('validateSkillDir — error 规则', () => {
  it('目录不存在 → error', () => {
    const r = validateSkillDir(path.join(root, 'nope'));
    expect(r.errors.some(e => e.includes('不存在'))).toBe(true);
  });

  it('缺 SKILL.md → error', () => {
    const dir = path.join(root, 'empty-skill');
    fs.mkdirSync(dir, { recursive: true });
    const r = validateSkillDir(dir);
    expect(r.errors.some(e => e.includes('SKILL.md'))).toBe(true);
  });

  it('frontmatter 不可解析 → error', () => {
    const dir = writeSkill('bad-fm', '# 没有 frontmatter 的 markdown\n');
    const r = validateSkillDir(dir);
    expect(r.errors.some(e => e.includes('frontmatter'))).toBe(true);
  });

  it('name 缺失 → error', () => {
    const dir = writeSkill('no-name', '---\ndescription: "x"\n---\nbody\n');
    const r = validateSkillDir(dir);
    expect(r.errors.some(e => e.includes('name'))).toBe(true);
  });

  it('name 为空 → error', () => {
    const dir = writeSkill('empty-name', '---\nname: ""\n---\nbody\n');
    const r = validateSkillDir(dir);
    expect(r.errors.some(e => e.includes('name'))).toBe(true);
  });

  it('name 与目录名不一致 → error', () => {
    const dir = writeSkill('inner-name', VALID.replace('name: my-skill', 'name: inner-name'), 'outer-dir');
    const r = validateSkillDir(dir);
    expect(r.errors.some(e => e.includes('inner-name') && e.includes('outer-dir'))).toBe(true);
  });

  it('status 越界（不在词表） → error', () => {
    const dir = writeSkill('bad-status', VALID.replace('status: published', 'status: archived'));
    const r = validateSkillDir(dir);
    expect(r.errors.some(e => e.includes('status') && e.includes('archived'))).toBe(true);
  });
});

describe('validateSkillDir — warning 规则', () => {
  it('description 缺失 → warning 而非 error', () => {
    const dir = writeSkill('no-desc', VALID.replace('name: my-skill', 'name: no-desc').replace('description: "测试 skill"\n', ''));
    const r = validateSkillDir(dir);
    expect(r.errors).toEqual([]);
    expect(r.warnings.some(w => w.includes('description'))).toBe(true);
  });

  it('status 非 published → warning 而非 error', () => {
    const dir = writeSkill('draft-skill', VALID.replace('name: my-skill', 'name: draft-skill').replace('status: published', 'status: draft'));
    const r = validateSkillDir(dir);
    expect(r.errors).toEqual([]);
    expect(r.warnings.some(w => w.includes('draft'))).toBe(true);
  });

  it('无 triggers → warning 而非 error', () => {
    const dir = writeSkill('no-triggers', VALID.replace('name: my-skill', 'name: no-triggers').replace('triggers: [测试]\n', ''));
    const r = validateSkillDir(dir);
    expect(r.errors).toEqual([]);
    expect(r.warnings.some(w => w.includes('triggers'))).toBe(true);
  });
});

describe('validateSkillDir — 合法用例（AC1 正面）', () => {
  it('完整 frontmatter 的 skill → 零 error 零 warning', () => {
    const dir = writeSkill('my-skill', VALID);
    const r = validateSkillDir(dir);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('真实内置正本 research → 零 error', () => {
    const builtin = path.resolve(__dirname, '../../../../../packages/studio-skill/skills/research');
    const r = validateSkillDir(builtin);
    expect(r.errors).toEqual([]);
  });
});
