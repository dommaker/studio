/**
 * seed — 内置 skill 库首启播种与升级（#223）
 *
 * 正本 = 本包 `skills/` 目录（随 npm 包分发，进 git）。
 * `~/.studio/skills/` 降级为实例化副本：运行时可写（skill-store/提案/evolution 不受影响），
 * 启动时由本模块把内置 skill 同步进去。
 *
 * 升级语义（中央 hash 台账 `<SKILLS_DIR>/.builtin-hashes.json`，name → 内容 hash）：
 * - 目标目录不存在 → 拷贝 + 记 hash
 * - 目标存在但无 hash 记录（legacy 存量/用户同名自建）→ 永不动
 * - 磁盘内容 ≠ 记录（用户改过内置 skill）→ 永不动
 * - 磁盘内容 == 记录 ≠ 仓库版本 → 覆盖升级 + 更新记录
 * - 磁盘内容 == 记录 == 仓库版本 → 跳过
 *
 * hash 覆盖整个 skill 目录树（排序后的相对路径 + 文件内容），skill 目录与仓库逐字节一致。
 * 仓库中移除的 skill 不删本地（留置即转为用户自有）。用户删除的内置 skill 下次启动会重建。
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { studioPath } from '@dommaker/studio-shared/studio-dir';

export interface SeedOptions {
  /** 内置 skill 正本目录，默认本包 skills/（src 与 dist 均上溯一级到包根） */
  sourceDir?: string;
  /** 实例化目标目录，默认 SKILLS_DIR 环境变量或 studioPath('skills')，运行期读取支持测试隔离 */
  targetDir?: string;
}

export interface SeedResult {
  /** 新播种的 skill 名 */
  copied: string[];
  /** 覆盖升级的 skill 名 */
  upgraded: string[];
  /** 用户改过、保留不动的 skill 名 */
  skippedUserModified: string[];
  /** 无 hash 记录的存量目录、保留不动的 skill 名 */
  skippedLegacy: string[];
  /** 台账写入或拷贝失败（best-effort，不 throw） */
  errors: string[];
}

const HASHES_FILE = '.builtin-hashes.json';

function defaultSourceDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills');
}

function defaultTargetDir(): string {
  return process.env.SKILLS_DIR || studioPath('skills');
}

/** 递归收集目录下所有文件（相对路径排序），目录不存在返回 null */
function listFiles(dir: string): string[] | null {
  if (!fs.existsSync(dir)) return null;
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) walk(r);
      else if (entry.isFile()) out.push(r);
    }
  };
  walk('');
  return out.sort();
}

/** 目录内容 hash：相对路径 + 逐文件内容 sha256 汇总。目录不存在返回 null */
export function hashSkillDir(dir: string): string | null {
  const files = listFiles(dir);
  if (!files) return null;
  const h = crypto.createHash('sha256');
  for (const rel of files) {
    h.update(rel);
    h.update('\0');
    h.update(fs.readFileSync(path.join(dir, rel)));
    h.update('\0');
  }
  return h.digest('hex');
}

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

function readHashes(targetDir: string): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(path.join(targetDir, HASHES_FILE), 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * 同步内置 skill 到目标目录。best-effort：单个 skill 失败记入 errors 继续，整体不 throw。
 */
export function seedBuiltinSkills(options: SeedOptions = {}): SeedResult {
  const sourceDir = options.sourceDir || defaultSourceDir();
  const targetDir = options.targetDir || defaultTargetDir();
  const result: SeedResult = { copied: [], upgraded: [], skippedUserModified: [], skippedLegacy: [], errors: [] };

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sourceDir, { withFileTypes: true }).filter(e => e.isDirectory());
  } catch (err) {
    result.errors.push(`sourceDir unreadable: ${sourceDir} (${String(err)})`);
    return result;
  }

  try {
    fs.mkdirSync(targetDir, { recursive: true });
  } catch (err) {
    result.errors.push(`targetDir not writable: ${targetDir} (${String(err)})`);
    return result;
  }

  const hashes = readHashes(targetDir);

  for (const entry of entries) {
    const name = entry.name;
    try {
      const src = path.join(sourceDir, name);
      const dest = path.join(targetDir, name);
      const repoHash = hashSkillDir(src);
      if (!repoHash) continue;

      if (!fs.existsSync(dest)) {
        copyTree(src, dest);
        hashes[name] = repoHash;
        result.copied.push(name);
        continue;
      }

      const recorded = hashes[name];
      if (!recorded) {
        result.skippedLegacy.push(name);
        continue;
      }
      const diskHash = hashSkillDir(dest);
      if (diskHash !== recorded) {
        result.skippedUserModified.push(name);
        continue;
      }
      if (recorded !== repoHash) {
        copyTree(src, dest);
        hashes[name] = repoHash;
        result.upgraded.push(name);
      }
    } catch (err) {
      result.errors.push(`${name}: ${String(err)}`);
    }
  }

  try {
    fs.writeFileSync(path.join(targetDir, HASHES_FILE), JSON.stringify(hashes, null, 2) + '\n', 'utf-8');
  } catch (err) {
    result.errors.push(`hashes file not writable: ${String(err)}`);
  }

  return result;
}
