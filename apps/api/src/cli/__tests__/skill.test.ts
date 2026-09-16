/**
 * studio skill validate/export/install 命令测试（#568）
 *
 * P1：validate CLI 退出码；P2：export/install 语义（tmp 目录 + SKILLS_DIR/STUDIO_HOME 隔离）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { studioSkill } from '../skill.js';

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
