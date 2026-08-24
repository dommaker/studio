/**
 * #320 token 账本（token ledger）— workunit:tokens 事件流的写侧累计派生索引。
 *
 * 设计（2026-08-24 #320 grilling 定稿，计划 docs/plans/2026-08-24-token-ledger.md）：
 *
 * - **真源不变**：studio-events.jsonl 事件流仍是唯一真源，账本是可重建派生索引；
 *   丢失/损坏/轮转随时从事件流重放重建（ADR 2026-08-24-cache-seam-decision-rules「真源唯一」）。
 * - **粒度**：per-WU 一行，全口径 token 字段照抄累计（读方各取所需，口径分叉不进账本）。
 *   维度只落事件 payload 自带的 triggerId/provider（last-wins）；rootId/profileId
 *   不在 payload 中，由读方对活 WU index join（checkTreeBudget 本来就经 getIndex 拿
 *   treeWuIds；token-usage 经 assignee 解析），冗余落账只会陈旧——有意的简报偏差。
 * - **watermark 自愈**：freshness = stat(eventsFile).size === watermark.bytes（O(1) 判定）；
 *   落后 → 锁内增量补扫 rows[watermark.lines..]；行数倒退 → 判定轮转，清空重建；
 *   账本不存在 = watermark=0 = 懒回填（bootstrap 重放一次，同 daily-token-budget 模式）。
 * - **竞态约定**：watermark.bytes 恒取 readJsonl 之前的 stat（下界）——append 撞进读窗口
 *   只会 bytes 偏小导致下次再同步，不会漏记/重记。
 * - **seam**：账本读走 FileStore.readJson 读穿缓存（mtime 校验），写经 writeJson 精确失效；
 *   锁内重建用裸读（ADR 例外条款：持锁要求此刻最新）。
 *
 * 读方切换：本票仅 checkTreeBudget（delegation-gate）；/overhead、token-usage 等另票。
 */
import fs from 'node:fs';
import path from 'node:path';
import { FileStore, logger } from '@dommaker/studio-shared';
import { parseStudioEventPayload } from './studio-events.js';

/** per-WU 累计行：全部数值字段为「该 WU 所有 token 事件的 Σ（仅计有限数字）」 */
export interface TokenLedgerRow {
  workUnitId: string;
  /** 该 WU 的 workunit:tokens 事件条数 */
  events: number;
  /** 带数字 executionTokens 的事件条数（诚实口径：CLI 未回报的不计入分母） */
  executionCount: number;
  injectedTokens: number;
  executionTokens: number;
  totalTokens: number;
  billedTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** 事件 payload 自带的维度（last-wins；rootId 不落账本，读方 join 活 index） */
  triggerId?: string;
  provider?: string;
}

export interface TokenLedger {
  version: 1;
  /** 已入账进度：lines = readJsonl 行数；bytes = 读取前 stat.size（下界，见头注释竞态约定） */
  watermark: { lines: number; bytes: number };
  byWorkUnit: Record<string, TokenLedgerRow>;
}

/** 账本文件名（与事件文件同目录，随测试隔离/STUDIO_EVENTS_FILE 自动跟随） */
export const TOKEN_LEDGER_FILE_NAME = 'token-ledger.json';

const fileStore = new FileStore();

export function resolveTokenLedgerFile(eventsFile: string): string {
  return path.join(path.dirname(eventsFile), TOKEN_LEDGER_FILE_NAME);
}

export function emptyTokenLedger(): TokenLedger {
  return { version: 1, watermark: { lines: 0, bytes: 0 }, byWorkUnit: {} };
}

function isTokenLedger(v: unknown): v is TokenLedger {
  const l = v as TokenLedger | null;
  return Boolean(
    l && l.version === 1
    && typeof l.watermark?.lines === 'number' && typeof l.watermark?.bytes === 'number'
    && l.byWorkUnit && typeof l.byWorkUnit === 'object',
  );
}

/** 锁内裸读（ADR 例外条款：不经读穿缓存）；缺失/损坏 → null（调用方重建） */
function readLedgerBare(ledgerFile: string): TokenLedger | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(ledgerFile, 'utf-8'));
    return isTokenLedger(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** 把一条事件累计进账本（非 token 事件 / 损坏 payload / 缺 workUnitId 跳过） */
function accumulate(ledger: TokenLedger, event: { type?: unknown; payload?: unknown }): void {
  if (event?.type !== 'workunit:tokens') return;
  const payload = parseStudioEventPayload(event);
  if (!payload) return;
  const workUnitId = payload.workUnitId;
  if (typeof workUnitId !== 'string' || !workUnitId) return;

  const row = ledger.byWorkUnit[workUnitId] ??= {
    workUnitId,
    events: 0,
    executionCount: 0,
    injectedTokens: 0,
    executionTokens: 0,
    totalTokens: 0,
    billedTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
  row.events += 1;
  const execution = num(payload.executionTokens);
  if (execution !== null) {
    row.executionTokens += execution;
    row.executionCount += 1;
  }
  row.injectedTokens += num(payload.injectedTokens) ?? 0;
  row.totalTokens += num(payload.totalTokens) ?? 0;
  row.billedTokens += num(payload.billedTokens) ?? 0;
  row.inputTokens += num(payload.inputTokens) ?? 0;
  row.outputTokens += num(payload.outputTokens) ?? 0;
  row.cacheReadTokens += num(payload.cacheReadTokens) ?? 0;
  row.cacheCreationTokens += num(payload.cacheCreationTokens) ?? 0;
  if (typeof payload.triggerId === 'string' && payload.triggerId) row.triggerId = payload.triggerId;
  if (typeof payload.provider === 'string' && payload.provider) row.provider = payload.provider;
}

/**
 * 同步账本项目前（读方主入口）：新鲜（size 未变）→ 读穿缓存直返；
 * 落后 → 锁内增量补扫；轮转/损坏/缺失 → 重建。事件文件不存在 → 空账本（不落盘）。
 * 可能抛 IO 错（锁超时等）——读方按各自语义兜底（checkTreeBudget：catch → 0 → pass，
 * 与原全扫实现一致）；写侧请走 noteTokenLedgerWritten（失败隔离）。
 */
export async function syncTokenLedger(eventsFile: string): Promise<TokenLedger> {
  let size: number;
  try {
    size = (await fs.promises.stat(eventsFile)).size;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return emptyTokenLedger();
    throw err;
  }

  const ledgerFile = resolveTokenLedgerFile(eventsFile);
  const cached = await fileStore.readJson<TokenLedger>(ledgerFile).catch(() => null);
  if (isTokenLedger(cached) && cached.watermark.bytes === size) return cached;

  const lockDir = path.join(path.dirname(ledgerFile), '.token-ledger.lock');
  return fileStore.withLock(lockDir, async () => {
    const ledger = readLedgerBare(ledgerFile) ?? emptyTokenLedger();
    // 锁内复核：另一进程可能刚同步完
    if (ledger.watermark.bytes === size) return ledger;
    const rows = await fileStore.readJsonl<{ type?: unknown; payload?: unknown }>(eventsFile);
    const base = rows.length < ledger.watermark.lines ? emptyTokenLedger() : ledger; // 行数倒退 = 轮转重建
    for (const row of rows.slice(base.watermark.lines)) accumulate(base, row);
    base.watermark = { lines: rows.length, bytes: size };
    await fileStore.writeJson(ledgerFile, base);
    return base;
  });
}

/**
 * 写侧记账钩子：token 事件落盘成功后由 writeWorkunitTokenEvent 调用（#320，
 * 同 noteTokensWritten 先例）。永不抛出——账本落后由读方 watermark 补扫自愈。
 */
export async function noteTokenLedgerWritten(eventsFile: string): Promise<void> {
  try {
    await syncTokenLedger(eventsFile);
  } catch (err) {
    logger.warn('[TokenLedger] sync failed (non-blocking)', { error: String(err) });
  }
}
