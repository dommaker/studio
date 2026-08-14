#!/usr/bin/env tsx
/**
 * #142 — maturity 脏数据清洗迁移（蒸馏闭环 1/5）
 *
 * 一次性迁移：把知识库 archive/ 目录下 maturity 字段与归档语义不一致的条目
 * （active / canonical / draft / pending / verified 等）归位为 `maturity: archived`，
 * 使「目录位置 = maturity 字段」语义可信。这是蒸馏生命周期与 GC 打分的数据地基
 * —— 字段脏则一切判据失真（#83 D3 / #141）。
 *
 * 硬约束（AC）：
 * - 幂等：重复执行零副作用（已 archived 的条目跳过）。
 * - 外科手术：只替换 frontmatter 内的 `maturity:` 行，正文与其他 frontmatter 逐字节保留。
 * - 非递归：只处理 archive/ 顶层 .md（对齐 FileKnowledgeStore.listFiles 的非递归语义）。
 *   archive/resolutions/ 等子目录是另一批归档区，不在本次计数（active 36/canonical 54/
 *   draft 7/pending 6 均为顶层），不递归即天然排除。
 *
 * 关于 resolution 记录：archive/ 顶层混有少量 `type: resolution` 记录，其 `maturity`
 * 复用 resolution status 阶梯（pending/verified/canonical）。#83 D3 与 #142 的脏值计数
 * 明确包含 canonical 54 / pending 6（即这些顶层 resolution 记录），且它们已被物理归档、
 * resolution.service 只扫主目录不扫 archive/，故一并归位 archived 无功能影响。
 *
 * 与 KnowledgeStore 兼容（AC3）：只改 frontmatter 里的一行，不重排/重写其他字段，
 * 故 FileKnowledgeStore.rebuildIndex() 前后都能正确解析并同步 index.json（测试覆盖）。
 * 本脚本不维护 archive/ 的 index.json —— 该目录当前无 index.json，主目录 index 亦不含
 * archive/ 条目，无索引需同步。
 *
 * Usage:
 *   npx tsx scripts/normalize-archive-maturity.ts            # dry-run
 *   npx tsx scripts/normalize-archive-maturity.ts --apply    # 实际执行
 *   npx tsx scripts/normalize-archive-maturity.ts --dir /tmp/x/archive
 *
 * 缺省目录：${STUDIO_HOME || ~/.studio}/knowledge/archive
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

/** 目标成熟度：目录位置 = maturity 字段的唯一可信值 */
export const ARCHIVE_MATURITY = 'archived';

/** 单文件归位判定结果 */
export type NormalizeMaturityOutcome =
  | { status: 'normalized'; content: string }   // maturity 非 archived → 已归位
  | { status: 'already-archived' }               // 已是 archived → 幂等不动
  | { status: 'skipped'; reason: string };        // 无 frontmatter / 无 maturity 行

export interface NormalizeArchiveMaturityResult {
  /** 扫描到的顶层 .md 文件数 */
  total: number;
  /** 本次归位为 archived 的文件数（幂等：二次执行为 0） */
  normalized: number;
  /** 已是 archived、无需改动的文件数 */
  unchanged: number;
  /** 无 frontmatter / 无 maturity 行 / 读写出错的文件（含原因） */
  skipped: Array<{ file: string; reason: string }>;
  /** true = 只报告未落盘 */
  dryRun: boolean;
}

export interface NormalizeArchiveMaturityOptions {
  /** true = 只报告不落盘（dry-run） */
  dryRun?: boolean;
}

/**
 * 纯函数：把单文件内容里的 maturity 行归位为 archived。
 *
 * 只替换 frontmatter 区（开头的 `---\n...\n---\n`）内、列 0 的 `maturity:` 行；
 * 正文与其他 frontmatter 字段逐字节保留。带引号的值（`"canonical"`）同样归一。
 */
export function normalizeMaturityLine(raw: string): NormalizeMaturityOutcome {
  // 只认文件开头的 YAML frontmatter 块（与 FileKnowledgeStore.parseFile 同口径）
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fmMatch) return { status: 'skipped', reason: 'no frontmatter' };

  const fm = fmMatch[1];
  const line = fm.match(/^maturity:.*$/m);
  if (!line) return { status: 'skipped', reason: 'no maturity field' };

  const value = line[0].replace(/^maturity:\s*/, '').trim().replace(/^["']|["']$/g, '');
  if (value === ARCHIVE_MATURITY) return { status: 'already-archived' };

  const newFm = fm.replace(/^maturity:.*$/m, `maturity: ${ARCHIVE_MATURITY}`);
  const content = raw.replace(fmMatch[0], fmMatch[0].replace(fm, newFm));
  return { status: 'normalized', content };
}

/**
 * 迁移函数：扫描 archiveDir 顶层 .md，归位 maturity → archived。
 *
 * 幂等；只动 maturity 行；非递归（对齐 FileKnowledgeStore.listFiles 顶层语义）。
 */
export function normalizeArchiveMaturities(
  archiveDir: string,
  options: NormalizeArchiveMaturityOptions = {},
): NormalizeArchiveMaturityResult {
  const dryRun = options.dryRun === true;
  const result: NormalizeArchiveMaturityResult = {
    total: 0, normalized: 0, unchanged: 0, skipped: [], dryRun,
  };

  if (!fs.existsSync(archiveDir)) return result;

  const files = fs.readdirSync(archiveDir).filter(f => f.endsWith('.md'));
  result.total = files.length;

  for (const file of files) {
    const filePath = path.join(archiveDir, file);
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const outcome = normalizeMaturityLine(raw);
      if (outcome.status === 'normalized') {
        if (!dryRun) fs.writeFileSync(filePath, outcome.content, 'utf-8');
        result.normalized++;
      } else if (outcome.status === 'already-archived') {
        result.unchanged++;
      } else {
        result.skipped.push({ file, reason: outcome.reason });
      }
    } catch (err) {
      result.skipped.push({ file, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  return result;
}

/** 缺省归档目录：${STUDIO_HOME || ~/.studio}/knowledge/archive（对齐 studioPath 解析） */
function defaultArchiveDir(): string {
  return path.join(process.env.STUDIO_HOME || path.join(os.homedir(), '.studio'), 'knowledge', 'archive');
}

// ─── CLI ───

function main(): void {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const dirIdx = args.indexOf('--dir');
  const archiveDir = dirIdx >= 0 && args[dirIdx + 1]
    ? path.resolve(args[dirIdx + 1])
    : defaultArchiveDir();

  const result = normalizeArchiveMaturities(archiveDir, { dryRun: !apply });
  console.log(`archive dir: ${archiveDir}`);
  console.log(JSON.stringify(result, null, 2));
  if (!apply) console.log('dry-run：以上未落盘，加 --apply 实际执行。');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
