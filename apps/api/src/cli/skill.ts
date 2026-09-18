/**
 * studio skill validate/export/install — skill 流动三件套（#568）
 *
 * 纯本地文件操作，不依赖 daemon 在线（与走 HTTP API 的 `studio skill list` 本质区别）。
 * 方案正本：docs/plans/2026-09-skill-export-import.md。
 *
 * 与 seed 机制的隔离规则（§3.4）：
 * - install 与内置正本同名 → 硬拒绝（占名会堵死 seed hash 升级通道），提示改名；
 * - install/export/validate 对 <SKILLS_DIR>/.builtin-hashes.json 只字不碰
 *   （台账在 skill 目录的父级，按目录树拷贝天然不含）；
 * - install 不写 skills-index.json（与 seed 对齐：目录即注册）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from '@dommaker/studio-shared';
import { studioDir, studioPath } from '@dommaker/studio-shared/studio-dir';
import { hashSkillDir, builtinSkillsDir } from '@dommaker/studio-skill';
import { validateSkillDir } from './skill-validate.js';

export async function studioSkill(args: string[]): Promise<number> {
  const sub = args[0];
  switch (sub) {
    case 'validate':
      return skillValidateCmd(args.slice(1));
    case 'export':
      return skillExport(args.slice(1));
    case 'install':
      return skillInstall(args.slice(1));
    default:
      console.error('Usage: studio skill <validate <dir> | export <name> [outDir] [--force] | install <dir> [--force]>');
      return 1;
  }
}

/** 数据区 skill 目录，运行期读 SKILLS_DIR 支持测试隔离（与 loader/seed 同口径） */
function skillsDir(): string {
  return process.env.SKILLS_DIR || studioPath('skills');
}

/** 递归整目录拷贝（与 seed copyTree 同语义：先清目标再逐文件复制） */
function copyTree(src: string, dest: string): void {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyTree(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

function splitFlags(args: string[]): { positional: string[]; force: boolean } {
  return { positional: args.filter(a => a !== '--force'), force: args.includes('--force') };
}

/** 从 skills-index.json 取 SkillRecord 的来源信息（取不到 → source: 'unknown'） */
function readProvenance(name: string): { source: string; sourceWorkUnits?: string[] } {
  try {
    const indexFile = path.join(studioDir(), 'skills-index.json');
    const records = JSON.parse(fs.readFileSync(indexFile, 'utf-8')) as Array<{ name?: string; source?: string; metadata?: string | null }>;
    const record = records.find(r => r.name === name);
    if (!record) return { source: 'unknown' };
    let sourceWorkUnits: string[] | undefined;
    if (record.metadata) {
      try {
        const meta = JSON.parse(record.metadata) as { sourceGoalIds?: string[] };
        if (Array.isArray(meta.sourceGoalIds) && meta.sourceGoalIds.length > 0) {
          sourceWorkUnits = meta.sourceGoalIds;
        }
      } catch { /* metadata 非法 JSON 时来源信息从缺 */ }
    }
    return { source: record.source || 'unknown', ...(sourceWorkUnits ? { sourceWorkUnits } : {}) };
  } catch {
    return { source: 'unknown' };
  }
}

function readVersion(skillDir: string): number {
  const parsed = parseFrontmatter(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8'));
  const v = parsed?.meta.version;
  return typeof v === 'number' ? v : 1;
}

function skillValidateCmd(args: string[]): number {
  const dir = args[0];
  if (!dir) {
    console.error('Usage: studio skill validate <dir>');
    return 1;
  }
  const abs = path.resolve(dir);
  const { errors, warnings } = validateSkillDir(abs);
  for (const e of errors) console.error(`error: ${e}`);
  for (const w of warnings) console.log(`warning: ${w}`);
  if (errors.length > 0) {
    console.error(`validate ${abs}: ${errors.length} error(s), ${warnings.length} warning(s)`);
    return 1;
  }
  console.log(`validate ${abs}: ok (${warnings.length} warning(s))`);
  return 0;
}

function skillExport(args: string[]): number {
  const { positional, force } = splitFlags(args);
  const name = positional[0];
  if (!name) {
    console.error('Usage: studio skill export <name> [outDir] [--force]');
    return 1;
  }
  const src = path.join(skillsDir(), name);
  const { errors } = validateSkillDir(src);
  if (errors.length > 0) {
    for (const e of errors) console.error(`error: ${e}`);
    console.error(`export 拒绝：数据区 skill '${name}' 校验未过`);
    return 1;
  }

  const outDir = path.resolve(positional[1] || process.cwd());
  const dest = path.join(outDir, name);
  if (fs.existsSync(dest) && !force) {
    console.error(`export 拒绝：${dest} 已存在，使用 --force 覆盖`);
    return 1;
  }
  copyTree(src, dest);

  // PROVENANCE.json 边车（不进 frontmatter，loader/manifest 天然忽略未知文件）。
  // 脱敏：只含名字/版本/hash/WU id，不写任何绝对路径或机器信息。
  const provenance = {
    name,
    version: readVersion(src),
    exportedAt: new Date().toISOString(),
    ...readProvenance(name),
    contentHash: hashSkillDir(src),
  };
  fs.writeFileSync(path.join(dest, 'PROVENANCE.json'), JSON.stringify(provenance, null, 2) + '\n', 'utf-8');
  console.log(`exported: ${dest}（含 PROVENANCE.json）`);
  return 0;
}

function skillInstall(args: string[]): number {
  const { positional, force } = splitFlags(args);
  const dir = positional[0];
  if (!dir) {
    console.error('Usage: studio skill install <dir> [--force]');
    return 1;
  }
  const src = path.resolve(dir);
  const { errors } = validateSkillDir(src);
  if (errors.length > 0) {
    for (const e of errors) console.error(`error: ${e}`);
    console.error('install 拒绝：来源目录校验未过');
    return 1;
  }
  const name = path.basename(src);

  // 隔离规则 1：与内置正本同名 → 硬拒绝（占名会让 seed 判 skippedLegacy/adopted，
  // 内置同名 skill 从此收不到升级，或用户内容被静默覆盖）
  let builtins: string[] = [];
  try {
    builtins = fs.readdirSync(builtinSkillsDir(), { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
  } catch { /* 内置正本不可读时名单为空，不阻断 install */ }
  if (builtins.includes(name)) {
    const existing = path.join(skillsDir(), name);
    console.error(
      `install 拒绝：'${name}' 与内置 skill 正本同名（会堵死 seed hash 升级通道），请改名后重试`
      + (fs.existsSync(existing) ? `；数据区已存在同名 legacy 目录 ${existing}，请人工决定改名或删除` : ''),
    );
    return 1;
  }

  const dest = path.join(skillsDir(), name);
  if (fs.existsSync(dest)) {
    if (hashSkillDir(src) === hashSkillDir(dest)) {
      console.log(`install：'${name}' 内容相同，no-op`);
      return 0;
    }
    if (!force) {
      console.error(`install 拒绝：数据区已存在 '${name}' 且内容不同，使用 --force 覆盖`);
      return 1;
    }
  }
  copyTree(src, dest);
  console.log(`installed: ${dest}`);
  return 0;
}
