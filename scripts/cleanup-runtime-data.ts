#!/usr/bin/env tsx
/**
 * F3: 运行时数据一次性清洗脚本
 *
 * 默认 dry-run（只打印将发生的动作）；--apply 才真正执行。
 * 所有归档都以 rename 到 <studioRoot>/backup-<ISOts>/ 的方式完成，可恢复。
 *
 * Usage:
 *   npx tsx scripts/cleanup-runtime-data.ts            # dry-run
 *   npx tsx scripts/cleanup-runtime-data.ts --apply    # 实际执行
 *   npx tsx scripts/cleanup-runtime-data.ts --root /tmp/fixture/.studio
 *
 * 数据根目录解析顺序：--root > STUDIO_CONFIG_DIR > ~/.studio
 *
 * 动作：
 *   a. 归档 ~/.studio/data/agents/ 下 profile 缺失/损坏或 status != 'active' 的目录
 *   b. 归档引用了已不存在 profile 的孤儿 state.json
 *   c. 归档旧 DB 残留文件（data.db / data/data.db / data/data.db.bak* / data/studio.db）
 *   d. 合并 ~/events/studio.jsonl → ~/.studio/events/studio.jsonl（按行去重），归档源文件
 *   e. 删除仓库 .harness/knowledge/ 下 guideline-test-lq-* 测试污染文件（含 index.json 条目）
 *   f. 归一化存活 profile 的 channels 字段为单层 JSON 编码（见 file-store.ts）
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { FileStore } from '@dommaker/studio-shared';

// ─── 类型 ───

export interface CleanupOptions {
  /** studio 数据根目录（含 data/ 子目录），默认 ~/.studio */
  studioRoot: string;
  /** 仓库根目录（用于 .harness/knowledge 测试污染清理） */
  repoRoot: string;
  /** false = dry-run（只报告不动手） */
  apply: boolean;
  /** 默认 <studioRoot>/backup-<ISOts> */
  backupDir?: string;
}

export interface CleanupSummary {
  mode: 'dry-run' | 'apply';
  studioRoot: string;
  backupDir: string;
  agentDirsArchived: Array<{ id: string; reason: string }>;
  agentDirsKept: string[];
  orphanStatesArchived: Array<{ dir: string; reason: string }>;
  dbFilesArchived: string[];
  events: {
    sourcePath: string;
    sourceExists: boolean;
    sourceLines: number;
    mergedLines: number;
    duplicateLines: number;
    sourceArchived: boolean;
    othersLeftInPlace: string[];
  };
  knowledge: { testFilesRemoved: number; indexEntriesRemoved: number };
  channelsMigration: { scanned: number; rewritten: number };
}

// ─── 内部工具 ───

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readDirSafe(dir: string): Promise<fs.Dirent[]> {
  try {
    return await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** 归档 = rename 到 backupDir 下的相对路径（apply 时才真正移动） */
async function archivePath(target: string, relDest: string, opts: CleanupOptions): Promise<void> {
  if (!opts.apply) return;
  const dest = path.join(opts.backupDir!, relDest);
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  await fs.promises.rename(target, dest);
}

function defaultBackupDir(studioRoot: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(studioRoot, `backup-${ts}`);
}

// ─── 各清洗动作 ───

/** a. 归档 profile 缺失/损坏或 status != 'active' 的 agent 目录；返回存活 profile 的 id 集合 */
async function cleanAgentDirs(summary: CleanupSummary, opts: CleanupOptions): Promise<Set<string>> {
  const agentsDir = path.join(opts.studioRoot, 'data', 'agents');
  const survivingIds = new Set<string>();

  for (const entry of await readDirSafe(agentsDir)) {
    // 非目录等歧义项保留不动
    if (!entry.isDirectory()) continue;
    const dir = path.join(agentsDir, entry.name);
    const profileFile = path.join(dir, 'profile.json');

    let reason: string | null = null;
    let profile: { id?: string; status?: string } | null = null;
    let raw: string | null = null;
    try {
      raw = await fs.promises.readFile(profileFile, 'utf-8');
    } catch {
      reason = 'profile.json missing';
    }
    if (raw !== null) {
      try {
        profile = JSON.parse(raw);
      } catch {
        reason = 'profile.json malformed';
      }
    }
    if (!reason && profile && profile.status !== 'active') {
      reason = `status=${profile.status ?? 'missing'}`;
    }

    if (reason) {
      summary.agentDirsArchived.push({ id: entry.name, reason });
      await archivePath(dir, path.join('data', 'agents', entry.name), opts);
    } else {
      summary.agentDirsKept.push(entry.name);
      if (profile?.id) survivingIds.add(profile.id);
    }
  }
  return survivingIds;
}

/** b. 归档存活目录下引用了已不存在 profile 的孤儿 state.json */
async function cleanOrphanStates(summary: CleanupSummary, opts: CleanupOptions, survivingIds: Set<string>): Promise<void> {
  const agentsDir = path.join(opts.studioRoot, 'data', 'agents');
  for (const dirName of summary.agentDirsKept) {
    const stateFile = path.join(agentsDir, dirName, 'state.json');
    if (!(await pathExists(stateFile))) continue;

    let reason: string | null = null;
    try {
      const state = JSON.parse(await fs.promises.readFile(stateFile, 'utf-8')) as { roleId?: string };
      // roleId 缺失视为歧义，保留不动
      if (state.roleId && !survivingIds.has(state.roleId)) {
        reason = `roleId ${state.roleId} has no surviving profile`;
      }
    } catch {
      reason = 'state.json malformed';
    }

    if (reason) {
      summary.orphanStatesArchived.push({ dir: dirName, reason });
      await archivePath(stateFile, path.join('data', 'agents', dirName, 'state.json'), opts);
    }
  }
}

/** c. 归档旧 DB 残留文件 */
async function cleanDbResidue(summary: CleanupSummary, opts: CleanupOptions): Promise<void> {
  const candidates = [
    path.join(opts.studioRoot, 'data.db'),
    path.join(opts.studioRoot, 'data', 'data.db'),
    path.join(opts.studioRoot, 'data', 'studio.db'),
  ];
  // data/data.db.bak*（实际文件名带时间戳后缀）
  for (const entry of await readDirSafe(path.join(opts.studioRoot, 'data'))) {
    if (entry.isFile() && entry.name.startsWith('data.db.bak')) {
      candidates.push(path.join(opts.studioRoot, 'data', entry.name));
    }
  }

  for (const file of candidates) {
    if (!(await pathExists(file))) continue;
    const rel = path.relative(opts.studioRoot, file);
    summary.dbFilesArchived.push(rel);
    await archivePath(file, rel, opts);
  }
}

/** d. 合并 ~/events/studio.jsonl → <studioRoot>/events/studio.jsonl（按行去重），归档源文件 */
async function mergeEvents(summary: CleanupSummary, opts: CleanupOptions): Promise<void> {
  // 源目录与 studioRoot 同级：~/.studio → ~/events；tmp/.studio → tmp/events
  const sourceDir = path.join(path.dirname(opts.studioRoot), 'events');
  const source = path.join(sourceDir, 'studio.jsonl');
  summary.events.sourcePath = source;

  for (const entry of await readDirSafe(sourceDir)) {
    if (entry.name !== 'studio.jsonl') summary.events.othersLeftInPlace.push(entry.name);
  }

  if (!(await pathExists(source))) return;
  summary.events.sourceExists = true;

  const sourceLines = (await fs.promises.readFile(source, 'utf-8'))
    .split('\n')
    .filter(l => l.trim().length > 0);
  summary.events.sourceLines = sourceLines.length;

  const target = path.join(opts.studioRoot, 'events', 'studio.jsonl');
  const existing = new Set<string>();
  if (await pathExists(target)) {
    for (const l of (await fs.promises.readFile(target, 'utf-8')).split('\n')) {
      if (l.trim().length > 0) existing.add(l);
    }
  }

  const newLines: string[] = [];
  for (const line of sourceLines) {
    if (existing.has(line)) continue;
    existing.add(line); // 源文件内部也去重
    newLines.push(line);
  }
  summary.events.mergedLines = newLines.length;
  summary.events.duplicateLines = sourceLines.length - newLines.length;

  if (opts.apply && newLines.length > 0) {
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.appendFile(target, newLines.join('\n') + '\n', 'utf-8');
  }

  summary.events.sourceArchived = true;
  await archivePath(source, path.join('home-events', 'studio.jsonl'), opts);
}

/** e. 删除仓库 .harness/knowledge/ 下 guideline-test-lq-* 测试污染文件（含 index.json 条目） */
async function cleanKnowledgeTestFiles(summary: CleanupSummary, opts: CleanupOptions): Promise<void> {
  const knowledgeDir = path.join(opts.repoRoot, '.harness', 'knowledge');

  for (const entry of await readDirSafe(knowledgeDir)) {
    if (!entry.isFile() || !entry.name.startsWith('guideline-test-lq-')) continue;
    summary.knowledge.testFilesRemoved++;
    await archivePath(
      path.join(knowledgeDir, entry.name),
      path.join('repo', '.harness', 'knowledge', entry.name),
      opts,
    );
  }

  const indexFile = path.join(knowledgeDir, 'index.json');
  if (!(await pathExists(indexFile))) return;
  try {
    const index = JSON.parse(await fs.promises.readFile(indexFile, 'utf-8')) as Array<{ id?: string; path?: string }>;
    if (!Array.isArray(index)) return;
    const kept = index.filter(e => {
      const hit = (typeof e.id === 'string' && e.id.includes('guideline-test-lq-'))
        || (typeof e.path === 'string' && e.path.includes('guideline-test-lq-'));
      return !hit;
    });
    summary.knowledge.indexEntriesRemoved = index.length - kept.length;
    if (opts.apply && kept.length !== index.length) {
      await fs.promises.writeFile(indexFile, JSON.stringify(kept, null, 2) + '\n', 'utf-8');
    }
  } catch {
    // index.json 损坏 → 歧义，保留不动
  }
}

// ─── 主流程 ───

export async function runCleanup(opts: CleanupOptions): Promise<CleanupSummary> {
  const summary: CleanupSummary = {
    mode: opts.apply ? 'apply' : 'dry-run',
    studioRoot: opts.studioRoot,
    backupDir: opts.backupDir ?? defaultBackupDir(opts.studioRoot),
    agentDirsArchived: [],
    agentDirsKept: [],
    orphanStatesArchived: [],
    dbFilesArchived: [],
    events: {
      sourcePath: '',
      sourceExists: false,
      sourceLines: 0,
      mergedLines: 0,
      duplicateLines: 0,
      sourceArchived: false,
      othersLeftInPlace: [],
    },
    knowledge: { testFilesRemoved: 0, indexEntriesRemoved: 0 },
    channelsMigration: { scanned: 0, rewritten: 0 },
  };
  const resolved = { ...opts, backupDir: summary.backupDir };

  const survivingIds = await cleanAgentDirs(summary, resolved);
  await cleanOrphanStates(summary, resolved, survivingIds);
  await cleanDbResidue(summary, resolved);
  await mergeEvents(summary, resolved);
  await cleanKnowledgeTestFiles(summary, resolved);

  // f. channels 字段迁移（放最后：只对清洗后存活的 profile 做）
  const fileStore = new FileStore(path.join(opts.studioRoot, 'data'));
  summary.channelsMigration = await fileStore.migrateChannelsEncoding({ dryRun: !opts.apply });

  return summary;
}

// ─── 输出 ───

export function formatSummary(summary: CleanupSummary): string {
  const lines: string[] = [];
  const dryRun = summary.mode === 'dry-run';
  lines.push(`=== F3 runtime data cleanup — ${dryRun ? 'DRY-RUN（未做任何修改）' : 'APPLIED'} ===`);
  lines.push(`studio root : ${summary.studioRoot}`);
  lines.push(`backup dir  : ${summary.backupDir}${dryRun ? '（apply 时创建）' : ''}`);
  lines.push('');

  const byReason = new Map<string, number>();
  for (const a of summary.agentDirsArchived) byReason.set(a.reason, (byReason.get(a.reason) ?? 0) + 1);
  const reasonText = [...byReason.entries()].map(([r, n]) => `${r}: ${n}`).join(', ');
  lines.push(`[a] agent 目录清洗   : 归档 ${summary.agentDirsArchived.length} 个（${reasonText || '无'}）；保留 ${summary.agentDirsKept.length} 个 active`);
  for (const a of summary.agentDirsArchived.slice(0, 3)) lines.push(`    例: ${a.id} — ${a.reason}`);
  lines.push(`[b] 孤儿 state.json  : 归档 ${summary.orphanStatesArchived.length} 个`);
  for (const s of summary.orphanStatesArchived.slice(0, 3)) lines.push(`    例: ${s.dir}/state.json — ${s.reason}`);
  lines.push(`[c] DB 残留          : 归档 ${summary.dbFilesArchived.length} 个文件${summary.dbFilesArchived.length > 0 ? `（${summary.dbFilesArchived.join(', ')}）` : ''}`);

  const ev = summary.events;
  if (!ev.sourceExists) {
    lines.push(`[d] events 合并      : 源文件不存在（${ev.sourcePath}），跳过`);
  } else {
    lines.push(`[d] events 合并      : ${ev.sourceLines} 行 → 新增 ${ev.mergedLines} 行，重复跳过 ${ev.duplicateLines} 行；源文件归档`);
    if (ev.othersLeftInPlace.length > 0) {
      lines.push(`    （events 源目录含非 studio 文件，保留不动: ${ev.othersLeftInPlace.join(', ')}）`);
    }
  }

  lines.push(`[e] knowledge 测试污染: 删除 guideline-test-lq-* 文件 ${summary.knowledge.testFilesRemoved} 个；index.json 移除 ${summary.knowledge.indexEntriesRemoved} 条`);
  lines.push(`[f] channels 迁移    : 扫描 profile ${summary.channelsMigration.scanned} 个，重写 ${summary.channelsMigration.rewritten} 个`);
  lines.push('');
  lines.push(dryRun ? 'dry-run：以上动作均未执行。加 --apply 实际执行。' : `完成。归档内容位于 ${summary.backupDir}`);
  return lines.join('\n');
}

// ─── CLI ───

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const rootIdx = args.indexOf('--root');
  const studioRoot = rootIdx >= 0 && args[rootIdx + 1]
    ? path.resolve(args[rootIdx + 1])
    : process.env.STUDIO_CONFIG_DIR
      ? path.resolve(process.env.STUDIO_CONFIG_DIR)
      : path.join(os.homedir(), '.studio');
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

  const summary = await runCleanup({ studioRoot, repoRoot, apply });
  console.log(formatSummary(summary));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(err => {
    console.error('[cleanup-runtime-data] failed:', err);
    process.exit(1);
  });
}
