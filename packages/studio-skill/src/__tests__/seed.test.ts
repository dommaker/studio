/**
 * seed 单元测试（#223）——用真实 tmp 目录（源/目标各自隔离），不 mock fs。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { seedBuiltinSkills, hashSkillDir } from '../seed.js';

let root: string;
let sourceDir: string;
let targetDir: string;

function writeSkill(base: string, name: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(base, name, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf-8');
  }
}

function readHashes(): Record<string, string> {
  return JSON.parse(fs.readFileSync(path.join(targetDir, '.builtin-hashes.json'), 'utf-8'));
}

const SKILL_A_V1 = { 'SKILL.md': '---\nname: skill-a\n---\nv1\n' };
const SKILL_B = { 'SKILL.md': '---\nname: skill-b\n---\n', 'refs/x.md': 'ref\n', 'refs/deep/y.md': 'deep\n' };

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-test-'));
  sourceDir = path.join(root, 'source');
  targetDir = path.join(root, 'target');
  fs.mkdirSync(sourceDir, { recursive: true });
  writeSkill(sourceDir, 'skill-a', SKILL_A_V1);
  writeSkill(sourceDir, 'skill-b', SKILL_B);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('seedBuiltinSkills', () => {
  it('首启：目标为空 → 全部拷贝（含多级文件），台账落 hash', () => {
    const r = seedBuiltinSkills({ sourceDir, targetDir });
    expect(r.copied.sort()).toEqual(['skill-a', 'skill-b']);
    expect(r.upgraded).toEqual([]);
    expect(r.errors).toEqual([]);
    expect(fs.readFileSync(path.join(targetDir, 'skill-a/SKILL.md'), 'utf-8')).toBe(SKILL_A_V1['SKILL.md']);
    expect(fs.readFileSync(path.join(targetDir, 'skill-b/refs/deep/y.md'), 'utf-8')).toBe('deep\n');
    const hashes = readHashes();
    expect(hashes['skill-a']).toBe(hashSkillDir(path.join(sourceDir, 'skill-a')));
    expect(hashes['skill-b']).toBe(hashSkillDir(path.join(sourceDir, 'skill-b')));
  });

  it('幂等：二次 seed 无任何变更', () => {
    seedBuiltinSkills({ sourceDir, targetDir });
    const r = seedBuiltinSkills({ sourceDir, targetDir });
    expect(r.copied).toEqual([]);
    expect(r.upgraded).toEqual([]);
    expect(r.skippedUserModified).toEqual([]);
    expect(r.skippedLegacy).toEqual([]);
  });

  it('升级：仓库新版 + 本地未改 → 覆盖升级并更新台账', () => {
    seedBuiltinSkills({ sourceDir, targetDir });
    writeSkill(sourceDir, 'skill-a', { 'SKILL.md': '---\nname: skill-a\n---\nv2\n' });
    const r = seedBuiltinSkills({ sourceDir, targetDir });
    expect(r.upgraded).toEqual(['skill-a']);
    expect(fs.readFileSync(path.join(targetDir, 'skill-a/SKILL.md'), 'utf-8')).toContain('v2');
    expect(readHashes()['skill-a']).toBe(hashSkillDir(path.join(sourceDir, 'skill-a')));
  });

  it('升级：仓库新版 + 本地新增文件也算未改追踪范围 → 整树覆盖（新增文件被清掉）', () => {
    seedBuiltinSkills({ sourceDir, targetDir });
    // 用户新增文件 = 磁盘内容偏离台账 → 用户改过，不动
    writeSkill(targetDir, 'skill-a', { 'notes.md': 'my notes\n' });
    writeSkill(sourceDir, 'skill-a', { 'SKILL.md': '---\nname: skill-a\n---\nv2\n' });
    const r = seedBuiltinSkills({ sourceDir, targetDir });
    expect(r.upgraded).toEqual([]);
    expect(r.skippedUserModified).toEqual(['skill-a']);
    expect(fs.readFileSync(path.join(targetDir, 'skill-a/SKILL.md'), 'utf-8')).toContain('v1');
    expect(fs.existsSync(path.join(targetDir, 'skill-a/notes.md'))).toBe(true);
  });

  it('用户改过（编辑 SKILL.md）→ 永不动，即使仓库有新版', () => {
    seedBuiltinSkills({ sourceDir, targetDir });
    writeSkill(targetDir, 'skill-a', { 'SKILL.md': 'user edited\n' });
    writeSkill(sourceDir, 'skill-a', { 'SKILL.md': '---\nname: skill-a\n---\nv2\n' });
    const r = seedBuiltinSkills({ sourceDir, targetDir });
    expect(r.skippedUserModified).toEqual(['skill-a']);
    expect(fs.readFileSync(path.join(targetDir, 'skill-a/SKILL.md'), 'utf-8')).toBe('user edited\n');
  });

  it('存量无 hash 记录（legacy/用户同名自建）且与正本不一致 → 永不动', () => {
    // 目标里预先存在 skill-a，但无台账（模拟 seed 机制前的老安装）
    writeSkill(targetDir, 'skill-a', { 'SKILL.md': 'legacy content\n' });
    const r = seedBuiltinSkills({ sourceDir, targetDir });
    expect(r.skippedLegacy).toEqual(['skill-a']);
    expect(r.copied).toEqual(['skill-b']);
    expect(fs.readFileSync(path.join(targetDir, 'skill-a/SKILL.md'), 'utf-8')).toBe('legacy content\n');
  });

  it('收养：无台账记录但磁盘与正本字节一致 → 写台账收养，内容不动（#225）', () => {
    // 目标里预先存在与正本逐字节一致的 skill-a，但无台账（#223 落地前的存量环境）
    writeSkill(targetDir, 'skill-a', SKILL_A_V1);
    const r = seedBuiltinSkills({ sourceDir, targetDir });
    expect(r.adopted).toEqual(['skill-a']);
    expect(r.skippedLegacy).toEqual([]);
    expect(readHashes()['skill-a']).toBe(hashSkillDir(path.join(sourceDir, 'skill-a')));
    expect(fs.readFileSync(path.join(targetDir, 'skill-a/SKILL.md'), 'utf-8')).toBe(SKILL_A_V1['SKILL.md']);
    // 收养后正本升级走正常覆盖升级，不再卡 legacy
    writeSkill(sourceDir, 'skill-a', { 'SKILL.md': '---\nname: skill-a\n---\nv2\n' });
    const r2 = seedBuiltinSkills({ sourceDir, targetDir });
    expect(r2.upgraded).toEqual(['skill-a']);
    expect(r2.skippedLegacy).toEqual([]);
    expect(fs.readFileSync(path.join(targetDir, 'skill-a/SKILL.md'), 'utf-8')).toContain('v2');
  });

  it('收养不适用：无台账记录且磁盘与正本不一致 → 仍 skippedLegacy，不写台账（#225）', () => {
    writeSkill(targetDir, 'skill-a', { 'SKILL.md': 'user custom\n' });
    const r = seedBuiltinSkills({ sourceDir, targetDir });
    expect(r.adopted).toEqual([]);
    expect(r.skippedLegacy).toEqual(['skill-a']);
    expect(readHashes()['skill-a']).toBeUndefined();
  });

  it('非内置目录（用户自建 skill）→ 不进台账、永不动', () => {
    writeSkill(targetDir, 'my-custom', { 'SKILL.md': 'mine\n' });
    const r = seedBuiltinSkills({ sourceDir, targetDir });
    expect(r.copied.sort()).toEqual(['skill-a', 'skill-b']);
    expect(readHashes()['my-custom']).toBeUndefined();
    // 二次 seed 也不碰
    const r2 = seedBuiltinSkills({ sourceDir, targetDir });
    expect(r2.skippedLegacy).toEqual([]);
    expect(fs.readFileSync(path.join(targetDir, 'my-custom/SKILL.md'), 'utf-8')).toBe('mine\n');
  });

  it('seeded 目录与仓库逐字节一致（hash 不含台账文件，台账在目录外维度）', () => {
    seedBuiltinSkills({ sourceDir, targetDir });
    expect(hashSkillDir(path.join(targetDir, 'skill-b'))).toBe(hashSkillDir(path.join(sourceDir, 'skill-b')));
  });

  it('best-effort：源目录不可读 → errors 记录，不 throw', () => {
    const r = seedBuiltinSkills({ sourceDir: path.join(root, 'nonexistent'), targetDir });
    expect(r.errors.length).toBe(1);
    expect(r.copied).toEqual([]);
  });
});
