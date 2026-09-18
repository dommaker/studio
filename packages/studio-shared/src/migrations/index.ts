/**
 * migrations — 数据区 schema 版本标记 + 启动时迁移框架
 * （#572 实现票；设计冻结正本 = docs/architecture/data-directory-contract.md §5，方案 A）
 *
 * - 版本标记：`data/manifest.json`（`{ schemaVersion, updatedAt }`）；无 manifest = v0。
 *   data 根解析与 FileStore 同口径：`STUDIO_DATA_DIR ?? <rootDir>/data`。
 * - 迁移链：MIGRATIONS 按 version 升序逐条执行；接入点 = apps/api/src/index.ts
 *   启动链 reconcileIndex() 之前；失败抛 MigrationError → 入口外层 catch 拒启。
 * - 四性质（契约 §5，验收即此）：
 *   1. 幂等：每条迁移执行前先跑 isApplied 探针，已应用则跳过；
 *   2. 可重入：每条迁移 apply 成功后立即原子抬 manifest（中断后从断点续跑）；
 *      迁移内部原子 = 写临时文件 + rename，不原地改写；
 *   3. 失败拒启：迁移前备份，任一失败 → MigrationError 携带备份路径 + 回滚指引；
 *   4. 备份范围：只备 data/ 与根级 *.json/*.jsonl；logs/、worktrees/ 等可再生产物不备；
 *      备份命名 `.bak-<YYYYMMDD-HHMMSS>`（沿用数据区既有先例）。
 * - 骨架先行：首个迁移 = 空迁移 v0→v1（只写 manifest）；真实迁移随首次布局变更进，
 *   且按契约 §4 与契约修订同 commit 落地。
 */

import fs from 'node:fs';
import path from 'node:path';
import { studioDir } from '../config/studio-dir';

export interface DataManifest {
  schemaVersion: number;
  updatedAt: string;
}

/** 单条迁移：v(N-1) → vN。apply 内部必须原子（临时文件 + rename），禁止原地改写。 */
export interface Migration {
  /** 本迁移产出的目标版本号 */
  version: number;
  name: string;
  /** 幂等探针：迁移效果已落盘（含中断残留）返回 true，runner 跳过 apply 只抬版本 */
  isApplied(rootDir: string): boolean | Promise<boolean>;
  apply(rootDir: string): Promise<void>;
}

export interface MigrationResult {
  fromVersion: number;
  toVersion: number;
  /** 本次实际执行的迁移名 */
  applied: string[];
  /** 探针判已应用而跳过的迁移名（中断续跑） */
  skipped: string[];
  /** 本次迁移前产生的备份路径；no-op 时为空 */
  backupPaths: string[];
}

/** 迁移失败 = 拒启信号。message 内含备份路径与回滚指引。 */
export class MigrationError extends Error {
  readonly backupPaths: string[];
  constructor(message: string, backupPaths: string[] = []) {
    super(message);
    this.name = 'MigrationError';
    this.backupPaths = backupPaths;
  }
}

/** data 根：与 FileStore baseDir 同口径（file-store-base.ts：STUDIO_DATA_DIR ?? studioPath('data')）。 */
export function dataDir(rootDir: string): string {
  return process.env.STUDIO_DATA_DIR ?? path.join(rootDir, 'data');
}

export function manifestPath(rootDir: string): string {
  return path.join(dataDir(rootDir), 'manifest.json');
}

/** 当前 schema 版本：无 manifest = v0；manifest 损坏/版本字段非法 = 拒启（不静默当 v0 重迁移）。 */
export async function readSchemaVersion(rootDir: string): Promise<number> {
  const p = manifestPath(rootDir);
  if (!fs.existsSync(p)) return 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.promises.readFile(p, 'utf-8'));
  } catch (e) {
    throw new MigrationError(
      `[Migration] 数据区 manifest 损坏（${p}），拒绝启动：${e instanceof Error ? e.message : String(e)}\n`
      + '回滚指引：修复 JSON 后重启；或删除该文件（= 按 v0 重新迁移，迁移前会自动备份）。',
    );
  }
  const v = (parsed as Partial<DataManifest> | null)?.schemaVersion;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw new MigrationError(
      `[Migration] 数据区 manifest 缺少合法 schemaVersion（${p}），拒绝启动。\n`
      + '回滚指引：修复 schemaVersion 为非负整数后重启；或删除该文件（= 按 v0 重新迁移，迁移前会自动备份）。',
    );
  }
  return v;
}

/** manifest 原子写：临时文件 + rename（可重入性质的正身示范）。 */
async function writeManifestAtomic(rootDir: string, version: number): Promise<void> {
  const dir = dataDir(rootDir);
  await fs.promises.mkdir(dir, { recursive: true });
  const target = manifestPath(rootDir);
  const tmp = `${target}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const manifest: DataManifest = { schemaVersion: version, updatedAt: new Date().toISOString() };
  await fs.promises.writeFile(tmp, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  await fs.promises.rename(tmp, target);
}

/** 备份时间戳：.bak-<YYYYMMDD-HHMMSS>（沿用数据区既有备份命名先例，本地时区）。 */
export function backupTimestamp(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
    + `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** 同秒重跑防撞名：目标已存在则追加 -2、-3… */
async function copyWithCollision(src: string, destBase: string): Promise<string> {
  let dest = destBase;
  for (let n = 2; fs.existsSync(dest); n++) dest = `${destBase}-${n}`;
  await fs.promises.cp(src, dest, { recursive: true });
  return dest;
}

const ROOT_BACKUP_RE = /\.(json|jsonl)$/;

/**
 * 迁移前备份（契约 §5）：只备 data/ 整树与根级 *.json/*.jsonl 文件；
 * logs/、worktrees/ 等可再生产物（契约 §2③）不备；既有 .bak-* 天然不匹配后缀，不二次备份。
 */
export async function backupDataArea(rootDir: string, ts: string = backupTimestamp()): Promise<string[]> {
  const backups: string[] = [];
  const data = dataDir(rootDir);
  if (fs.existsSync(data)) {
    backups.push(await copyWithCollision(data, `${data}.bak-${ts}`));
  }
  for (const entry of await fs.promises.readdir(rootDir)) {
    if (!ROOT_BACKUP_RE.test(entry)) continue;
    const src = path.join(rootDir, entry);
    if (!fs.statSync(src).isFile()) continue;
    backups.push(await copyWithCollision(src, `${src}.bak-${ts}`));
  }
  return backups;
}

/** 骨架迁移：v0（无标记）→ v1。无布局变更，manifest 由 runner 在 apply 后统一落盘。 */
const v1EmptyManifest: Migration = {
  version: 1,
  name: 'v1-empty-manifest',
  // 探针：manifest 已在 v1+ 即已应用（正常路径由 version 过滤先行挡住，探针兜中断残留）
  isApplied: async (rootDir) => (await readSchemaVersion(rootDir)) >= 1,
  apply: async () => {},
};

/** 迁移链（升序）。真实迁移随首次布局变更进，与契约修订同 commit（契约 §4）。 */
export const MIGRATIONS: Migration[] = [v1EmptyManifest];

export const CURRENT_SCHEMA_VERSION = 1;

export interface RunMigrationsOptions {
  /** 测试注入用；缺省 = MIGRATIONS */
  migrations?: Migration[];
}

/**
 * 迁移 runner：幂等（探针）/ 可重入（逐条原子抬版）/ 失败拒启（先备份，失败抛 MigrationError）。
 * 接入点 = apps/api 启动链 reconcileIndex() 之前。
 */
export async function runMigrations(
  rootDir: string = studioDir(),
  opts: RunMigrationsOptions = {},
): Promise<MigrationResult> {
  const chain = (opts.migrations ?? MIGRATIONS).slice().sort((a, b) => a.version - b.version);
  const fromVersion = await readSchemaVersion(rootDir);

  const applied: string[] = [];
  const skipped: string[] = [];
  let backupPaths: string[] = [];
  let toVersion = fromVersion;

  const todo: Migration[] = [];
  for (const m of chain) {
    if (m.version <= fromVersion) continue;
    if (await m.isApplied(rootDir)) {
      skipped.push(m.name);
      toVersion = m.version;
    } else {
      todo.push(m);
    }
  }

  if (todo.length === 0) {
    // 纯探针命中（中断续跑）：把 manifest 抬到探针确认的版本，收尾中断现场
    if (toVersion > fromVersion) await writeManifestAtomic(rootDir, toVersion);
    return { fromVersion, toVersion, applied, skipped, backupPaths };
  }

  backupPaths = await backupDataArea(rootDir);

  for (const m of todo) {
    try {
      await m.apply(rootDir);
      await writeManifestAtomic(rootDir, m.version);
    } catch (e) {
      throw new MigrationError(
        `[Migration] 迁移 ${m.name}（v${m.version}）失败，已拒绝启动：${e instanceof Error ? e.message : String(e)}\n`
        + `备份位置：\n${backupPaths.map((p) => `  - ${p}`).join('\n')}\n`
        + '回滚指引：停止服务 → 删除迁移产生的半成品 → 用上述 .bak-* 备份改名还原 data/ 与对应根级文件 → 修复后重启。',
        backupPaths,
      );
    }
    applied.push(m.name);
    toVersion = m.version;
  }

  return { fromVersion, toVersion, applied, skipped, backupPaths };
}
