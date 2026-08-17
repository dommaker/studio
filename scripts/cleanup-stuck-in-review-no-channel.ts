#!/usr/bin/env tsx
/**
 * #186（#167 决议 4）：滞留 in_review 的 trigger 巡检单一次性清理（2026-08-16）
 *
 * 背景：analysis-handoff 对 channelId=null 的 WU 早退吞掉确认提示（断链已由 #186 修复），
 * 导致一批 trigger 自动巡检单（knowledge-quality / session-knowledge-extraction 等）
 * 滞留 in_review 12~18 天无人处理，结论已无时效价值。决议：批量关闭，cleanupNote 留痕。
 * 先例：2026-07-27 cleanup-stale-in-review（cleanupReason=review-report-chain-broken）。
 *
 * 命中条件（全部满足）：status='in_review' + type='analysis' + channelId=null
 * + metadata.triggerId 存在（trigger-registry 来源溯源）。其他单一律不动。
 *
 * 状态迁移走 FileStore 锁内复合原语 commitSnapshot（appendEvent + upsertSnapshot 同一把
 * workunits flock 成对，#170 收口），与运行中的 API 并发安全；不直接改 index.json / events.jsonl。
 *
 * Usage:
 *   npx tsx scripts/cleanup-stuck-in-review-no-channel.ts            # dry-run（默认，只打印清单）
 *   npx tsx scripts/cleanup-stuck-in-review-no-channel.ts --apply    # 实际执行
 *   npx tsx scripts/cleanup-stuck-in-review-no-channel.ts --root /tmp/fixture/.studio
 *
 * 数据根目录解析顺序：--root > STUDIO_CONFIG_DIR > ~/.studio（FileStore 数据目录为其 data/ 子目录）
 */

import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { FileStore, type WorkUnitEvent, type WorkUnitSnapshot } from '../packages/studio-shared/src/index';

// ─── 常量 ───

/** 决议指定留痕码 */
export const CLEANUP_NOTE = 'stuck-in-review-no-channel';
const CLEANUP_DETAIL = '#186（#167 决议 4）：trigger 巡检单无频道确认提示断链，滞留 in_review 批量关闭（2026-08-16）';

// ─── 类型 ───

export interface CleanupOptions {
  /** studio 数据根目录（含 data/ 子目录），默认 ~/.studio */
  studioRoot: string;
  /** false = dry-run（只打印清单不写盘） */
  apply: boolean;
}

export interface StuckWorkUnit {
  id: string;
  createdAt: string;
  triggerId: string;
  scope: string;
}

export interface CleanupSummary {
  mode: 'dry-run' | 'apply';
  studioRoot: string;
  /** 状态分布（清理前） */
  statusCountsBefore: Record<string, number>;
  /** 命中的待清理 WU 清单 */
  targets: StuckWorkUnit[];
  closed: string[];
  /** apply 期间状态已变化/消失的 WU（并发竞态保护，跳过不处理） */
  skipped: Array<{ id: string; reason: string }>;
  failed: Array<{ id: string; error: string }>;
}

// ─── 主流程 ───

function parseTriggerId(metadata: string | null): string | null {
  if (!metadata) return null;
  try {
    const meta = JSON.parse(metadata) as { triggerId?: unknown };
    return typeof meta.triggerId === 'string' && meta.triggerId.length > 0 ? meta.triggerId : null;
  } catch {
    return null; // metadata 损坏 → 无法确认 trigger 来源，不命中（需人工处理）
  }
}

function isTarget(s: WorkUnitSnapshot): boolean {
  return s.status === 'in_review'
    && s.type === 'analysis'
    && !s.channelId
    && parseTriggerId(s.metadata) !== null;
}

export async function runCleanup(opts: CleanupOptions): Promise<CleanupSummary> {
  const fileStore = new FileStore(path.join(opts.studioRoot, 'data'));
  const summary: CleanupSummary = {
    mode: opts.apply ? 'apply' : 'dry-run',
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
    createdAt: s.createdAt,
    triggerId: parseTriggerId(s.metadata)!,
    scope: s.scope.length > 80 ? s.scope.slice(0, 80) + '…' : s.scope,
  }));

  if (!opts.apply) return summary;

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
        summary.skipped.push({ id: target.id, reason: `no longer matches (status=${current.status})` });
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
      const isoNow = new Date().toISOString();
      metadata.cleanupNote = CLEANUP_NOTE;
      metadata.cleanupDetail = CLEANUP_DETAIL;
      metadata.cleanupAt = isoNow;

      const updated: WorkUnitSnapshot = {
        ...current,
        status: 'closed',
        metadata: JSON.stringify(metadata),
        completedAt: isoNow,
        updatedAt: isoNow,
      };

      // 锁内成对落盘（appendEvent + upsertSnapshot 同一把 workunits flock）
      const event: WorkUnitEvent = {
        type: 'closed',
        wuId: target.id,
        timestamp: isoNow,
        data: updated as unknown as Record<string, unknown>,
      };
      await fileStore.commitSnapshot(event, updated);

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
  lines.push(`=== stuck-in-review-no-channel cleanup — ${dryRun ? 'DRY-RUN（未做任何修改）' : 'APPLIED'} ===`);
  lines.push(`studio root : ${summary.studioRoot}`);
  lines.push(`cleanupNote : ${CLEANUP_NOTE}`);
  lines.push(`清理前状态分布: ${JSON.stringify(summary.statusCountsBefore)}`);
  lines.push(`命中条件: status='in_review' + type='analysis' + channelId=null + metadata.triggerId → ${summary.targets.length} 个`);
  lines.push('');
  for (const t of summary.targets) {
    lines.push(`  ${t.id}  ${t.createdAt}  trigger=${t.triggerId}  ${t.scope}`);
  }
  lines.push('');
  if (dryRun) {
    lines.push('dry-run：以上 WU 均未改动。加 --apply 实际执行。');
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
  const apply = args.includes('--apply');
  const rootIdx = args.indexOf('--root');
  const studioRoot = rootIdx >= 0 && args[rootIdx + 1]
    ? path.resolve(args[rootIdx + 1])
    : process.env.STUDIO_CONFIG_DIR
      ? path.resolve(process.env.STUDIO_CONFIG_DIR)
      : path.join(os.homedir(), '.studio');

  const summary = await runCleanup({ studioRoot, apply });
  console.log(formatSummary(summary));
  if (summary.failed.length > 0) process.exit(1);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(err => {
    console.error('[cleanup-stuck-in-review-no-channel] failed:', err);
    process.exit(1);
  });
}
