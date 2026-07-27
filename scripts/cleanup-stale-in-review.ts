#!/usr/bin/env tsx
/**
 * B2: 滞留 in_review WorkUnit 一次性清理脚本（2026-07-27）
 *
 * 背景：评审回传断链（已修复）导致一批系统触发的 WU（knowledge-quality-skill 审计、
 * session 扫描等，2026-07-18 ~ 07-27）永远停留在 in_review 收不了口。
 * 决策：不删除，状态置 closed 保留历史。数据已备份到 /root/.studio-backup-20260727-p0。
 *
 * 只处理 status === 'in_review' 且 createdAt < 2026-07-28 的 WU；
 * 其他状态（unassigned/active/blocked/done/closed）一律不动。
 *
 * 状态迁移走 FileStore 既有路径（appendEvent + upsertSnapshot，flock 保护），
 * 与 workunit.service.ts transitionStatus 同一写法，与运行中的 API 并发安全；
 * 不直接改 index.json / events.jsonl。
 *
 * Usage:
 *   npx tsx scripts/cleanup-stale-in-review.ts --dry-run   # 只打印将处理的 WU 清单
 *   npx tsx scripts/cleanup-stale-in-review.ts             # 实际执行
 *   npx tsx scripts/cleanup-stale-in-review.ts --dry-run --root /tmp/fixture/.studio
 *
 * 数据根目录解析顺序：--root > STUDIO_CONFIG_DIR > ~/.studio（FileStore 数据目录为其 data/ 子目录）
 */

import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { FileStore, type WorkUnitEvent, type WorkUnitSnapshot } from '../packages/studio-shared/src/index';

// ─── 常量 ───

/** 只清理 createdAt 早于该时刻的 in_review WU（2026-07-18 ~ 07-27 的滞留批次） */
const CREATED_BEFORE = '2026-07-28T00:00:00.000Z';

const CLEANUP_NOTE = 'stale in_review cleanup 2026-07-27 (B2, backup at /root/.studio-backup-20260727-p0)';
const CLEANUP_REASON = 'review-report-chain-broken';

/**
 * 状态机校验表 —— 与 apps/api/src/modules/workunit/workunit.service.ts 的
 * VALID_TRANSITIONS 保持一致（那边是模块私有常量，这里复制一份做迁移合法性守卫）。
 * in_review → closed 是合法迁移。
 */
const VALID_TRANSITIONS: Record<string, string[]> = {
  unassigned: ['active', 'closed'],
  active: ['in_review', 'closed', 'blocked'],
  in_review: ['done', 'active', 'closed'],
  done: ['closed'],
  blocked: ['active', 'closed', 'unassigned'],
  closed: ['unassigned'],
};

// ─── 类型 ───

export interface CleanupOptions {
  /** studio 数据根目录（含 data/ 子目录），默认 ~/.studio */
  studioRoot: string;
  /** true = 只打印清单不写盘 */
  dryRun: boolean;
}

export interface StaleWorkUnit {
  id: string;
  type: string;
  createdAt: string;
  assigneeId: string | null;
  scope: string;
}

export interface CleanupSummary {
  mode: 'dry-run' | 'apply';
  studioRoot: string;
  /** 状态分布（清理前） */
  statusCountsBefore: Record<string, number>;
  /** 命中的待清理 WU 清单 */
  targets: StaleWorkUnit[];
  closed: string[];
  /** apply 期间状态已变化/消失的 WU（并发竞态保护，跳过不处理） */
  skipped: Array<{ id: string; reason: string }>;
  failed: Array<{ id: string; error: string }>;
}

// ─── 主流程 ───

function isTarget(s: WorkUnitSnapshot): boolean {
  return s.status === 'in_review' && new Date(s.createdAt).getTime() < new Date(CREATED_BEFORE).getTime();
}

export async function runCleanup(opts: CleanupOptions): Promise<CleanupSummary> {
  if (!VALID_TRANSITIONS['in_review']?.includes('closed')) {
    throw new Error('VALID_TRANSITIONS 不允许 in_review → closed，终止（需改走合法迁移路径）');
  }

  const fileStore = new FileStore(path.join(opts.studioRoot, 'data'));
  const summary: CleanupSummary = {
    mode: opts.dryRun ? 'dry-run' : 'apply',
    studioRoot: opts.studioRoot,
    statusCountsBefore: {},
    targets: [],
    closed: [],
    skipped: [],
    failed: [],
  };

  const index = await fileStore.getIndex();
  for (const s of index) summary.statusCountsBefore[s.status] = (summary.statusCountsBefore[s.status] ?? 0) + 1;

  summary.targets = index.filter(isTarget).map(s => ({
    id: s.id,
    type: s.type,
    createdAt: s.createdAt,
    assigneeId: s.assigneeId,
    scope: s.scope.length > 80 ? s.scope.slice(0, 80) + '…' : s.scope,
  }));

  if (opts.dryRun) return summary;

  for (const target of summary.targets) {
    try {
      // 逐个重读 index 再判定（与 service 层 update/transitionStatus 同一模式），
      // 防止 dry-run 之后评审回传等并发写已改变状态时被误覆盖
      const current = (await fileStore.getIndex()).find(s => s.id === target.id);
      if (!current) {
        summary.skipped.push({ id: target.id, reason: 'snapshot disappeared' });
        continue;
      }
      if (!isTarget(current)) {
        summary.skipped.push({ id: target.id, reason: `status/createdAt changed (status=${current.status})` });
        continue;
      }

      let metadata: Record<string, unknown> = {};
      if (current.metadata) {
        try {
          metadata = JSON.parse(current.metadata) as Record<string, unknown>;
        } catch {
          summary.failed.push({ id: target.id, error: 'metadata JSON parse failed (未改动，需人工处理)' });
          continue;
        }
      }
      metadata.cleanupNote = CLEANUP_NOTE;
      metadata.cleanupReason = CLEANUP_REASON;

      const isoNow = new Date().toISOString();
      const updated: WorkUnitSnapshot = {
        ...current,
        status: 'closed',
        metadata: JSON.stringify(metadata),
        completedAt: isoNow,
        updatedAt: isoNow,
      };

      // 既有路径：append 事件 + upsertSnapshot（内部持 workunits flock）
      const event: WorkUnitEvent = {
        type: 'closed',
        wuId: target.id,
        timestamp: isoNow,
        data: updated as unknown as Record<string, unknown>,
      };
      await fileStore.appendEvent(event);
      await fileStore.upsertSnapshot(updated);

      summary.closed.push(target.id);
    } catch (err) {
      summary.failed.push({ id: target.id, error: String(err) });
    }
  }

  return summary;
}

// ─── 输出 ───

export function formatSummary(summary: CleanupSummary): string {
  const lines: string[] = [];
  const dryRun = summary.mode === 'dry-run';
  lines.push(`=== stale in_review cleanup — ${dryRun ? 'DRY-RUN（未做任何修改）' : 'APPLIED'} ===`);
  lines.push(`studio root : ${summary.studioRoot}`);
  lines.push(`清理前状态分布: ${JSON.stringify(summary.statusCountsBefore)}`);
  lines.push(`命中条件: status='in_review' 且 createdAt < ${CREATED_BEFORE} → ${summary.targets.length} 个`);
  lines.push('');
  for (const t of summary.targets) {
    lines.push(`  ${t.id}  ${t.createdAt}  type=${t.type}  assignee=${t.assigneeId ?? '-'}  ${t.scope}`);
  }
  lines.push('');
  if (dryRun) {
    lines.push('dry-run：以上 WU 均未改动。去掉 --dry-run 实际执行。');
  } else {
    lines.push(`已关闭 ${summary.closed.length} 个；跳过 ${summary.skipped.length} 个；失败 ${summary.failed.length} 个`);
    for (const s of summary.skipped) lines.push(`  跳过: ${s.id} — ${s.reason}`);
    for (const f of summary.failed) lines.push(`  失败: ${f.id} — ${f.error}`);
  }
  return lines.join('\n');
}

// ─── CLI ───

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const rootIdx = args.indexOf('--root');
  const studioRoot = rootIdx >= 0 && args[rootIdx + 1]
    ? path.resolve(args[rootIdx + 1])
    : process.env.STUDIO_CONFIG_DIR
      ? path.resolve(process.env.STUDIO_CONFIG_DIR)
      : path.join(os.homedir(), '.studio');

  const summary = await runCleanup({ studioRoot, dryRun });
  console.log(formatSummary(summary));
  if (summary.failed.length > 0) process.exit(1);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(err => {
    console.error('[cleanup-stale-in-review] failed:', err);
    process.exit(1);
  });
}
