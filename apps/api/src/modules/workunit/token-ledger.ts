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
 * - **watermark 自愈**：freshness = 文件 size + dev/ino 代际 + O(1) 首/末完整行内容锚点；
 *   落后 → 锁内从 watermark.bytes 增量补扫；锚点/代际不符、截短或行边界错位 → 从 0 重建；
 *   账本不存在 = watermark=0 = 懒回填（bootstrap 重放一次，同 daily-token-budget 模式）。
 * - **完整行提交**：只累计并越过换行符终止的行；崩溃半行留在 watermark 之后，补全后再处理。
 * - **写侧 direct-apply**：调用方传入与 append 完全相同的事件对象。锁内仅在文件尾与
 *   该事件的精确字节相匹配时直接累计并提交其末尾 offset；其他进程抢先/随后追加导致
 *   证明不成立时退回增量补扫，绝不把未处理事件纳入 watermark。direct 不推进已有内容锚点，
 *   因而 copytruncate 后即使继续写，下一次同步仍会识别历史重写并全量重建。
 * - **单 writer**：direct-apply 与恢复都使用同一个 mkdir 跨进程锁；账本和 checkpoint
 *   随同一个原子 writeJson 提交，不存在分别落盘的崩溃窗口。
 * - **seam**：账本读走 FileStore.readJson 读穿缓存（mtime 校验），写经 writeJson 精确失效；
 *   锁内重建用裸读（ADR 例外条款：持锁要求此刻最新）。
 *
 * 读方切换：本票仅 checkTreeBudget（delegation-gate）；/overhead、token-usage 等另票。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { FileStore } from '@dommaker/studio-shared';
import { parseStudioEventPayload } from '@dommaker/studio-shared';
import { getStore } from '../../core/store.js';
import { logger } from '@dommaker/studio-shared/node';

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

export interface TokenLedgerAnchor {
  /** 最近验证的完整行位置与内容摘要；direct-apply 保留已有锚点，空账本首行可建立 */
  offset: number;
  bytes: number;
  sha256: string;
}

export interface TokenLedger {
  version: 1;
  /** generation = dev:ino；firstAnchor/anchor 分别是首/末完整行内容锚点 */
  watermark: {
    lines: number;
    bytes: number;
    generation?: string;
    firstAnchor?: TokenLedgerAnchor;
    anchor?: TokenLedgerAnchor;
  };
  byWorkUnit: Record<string, TokenLedgerRow>;
}

interface TokenEventRow {
  type?: unknown;
  payload?: unknown;
}

type CompleteLineScan =
  | { kind: 'missing' }
  | { kind: 'invalid' }
  | {
    kind: 'ok';
    generation: string;
    events: TokenEventRow[];
    lines: number;
    bytes: number;
    firstAnchor?: TokenLedgerAnchor;
    anchor?: TokenLedgerAnchor;
  };

/** 账本文件名（与事件文件同目录，随测试隔离/STUDIO_EVENTS_FILE 自动跟随） */
export const TOKEN_LEDGER_FILE_NAME = 'token-ledger.json';

export function resolveTokenLedgerFile(eventsFile: string): string {
  return path.join(path.dirname(eventsFile), TOKEN_LEDGER_FILE_NAME);
}

export function emptyTokenLedger(): TokenLedger {
  return { version: 1, watermark: { lines: 0, bytes: 0 }, byWorkUnit: {} };
}

function isTokenLedgerAnchor(v: unknown): v is TokenLedgerAnchor {
  const a = v as TokenLedgerAnchor | null;
  return Boolean(a && Number.isSafeInteger(a.offset) && a.offset >= 0
    && Number.isSafeInteger(a.bytes) && a.bytes > 0
    && typeof a.sha256 === 'string' && /^[a-f0-9]{64}$/.test(a.sha256));
}

function isTokenLedger(v: unknown): v is TokenLedger {
  const l = v as TokenLedger | null;
  return Boolean(
    l && l.version === 1
    && Number.isSafeInteger(l.watermark?.lines) && (l.watermark?.lines ?? -1) >= 0
    && Number.isSafeInteger(l.watermark?.bytes) && (l.watermark?.bytes ?? -1) >= 0
    && (l.watermark?.generation === undefined || typeof l.watermark.generation === 'string')
    && (l.watermark?.firstAnchor === undefined || isTokenLedgerAnchor(l.watermark.firstAnchor))
    && (l.watermark?.anchor === undefined || isTokenLedgerAnchor(l.watermark.anchor))
    && l.byWorkUnit && typeof l.byWorkUnit === 'object',
  );
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
}

function generationOf(stat: fs.Stats): string {
  return `${stat.dev}:${stat.ino}`;
}

function contentAnchor(offset: number, line: Buffer): TokenLedgerAnchor {
  return { offset, bytes: line.length, sha256: createHash('sha256').update(line).digest('hex') };
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

async function readExact(handle: fs.promises.FileHandle, position: number, length: number): Promise<Buffer | null> {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    // Buffer 运行时是 Uint8Array；类型转换对齐仓内其他增量读口的 @types/node 20 适配。
    const { bytesRead } = await handle.read(buffer as Uint8Array, filled, length - filled, position + filled);
    if (bytesRead === 0) return null;
    filled += bytesRead;
  }
  return buffer;
}

/** O(1) 首尾锚点校验：正常 append 不动历史首尾；任一锚点被改写则必须重建。 */
async function ledgerAnchorMatches(eventsFile: string, ledger: TokenLedger): Promise<boolean> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(eventsFile, 'r');
    const stat = await handle.stat();
    if (ledger.watermark.generation !== generationOf(stat)) return false;
    const first = ledger.watermark.firstAnchor;
    const last = ledger.watermark.anchor;
    if (!first || !last) return ledger.watermark.bytes === 0 && stat.size === 0 && !first && !last;

    const checked = new Set<string>();
    for (const anchor of [first, last]) {
      const key = `${anchor.offset}:${anchor.bytes}`;
      if (checked.has(key)) continue; // 单行文件首尾相同，只读一次
      checked.add(key);
      if (anchor.offset + anchor.bytes > stat.size) return false;
      const actual = await readExact(handle, anchor.offset, anchor.bytes);
      if (!actual || contentAnchor(anchor.offset, actual).sha256 !== anchor.sha256) return false;
    }
    return true;
  } catch (err: unknown) {
    if (isEnoent(err)) return false;
    throw err;
  } finally {
    await handle?.close();
  }
}

/** 从 byte offset 读取到打开句柄时的 size，只返回换行符终止的完整行。 */
async function scanCompleteLines(eventsFile: string, fromOffset: number): Promise<CompleteLineScan> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(eventsFile, 'r');
    const stat = await handle.stat();
    if (fromOffset > stat.size) return { kind: 'invalid' };
    if (fromOffset > 0) {
      const boundary = await readExact(handle, fromOffset - 1, 1);
      if (!boundary || boundary[0] !== 0x0a) return { kind: 'invalid' };
    }

    const length = stat.size - fromOffset;
    const buffer = await readExact(handle, fromOffset, length);
    if (!buffer) return { kind: 'invalid' }; // 读取期间截短：当前 checkpoint 不再可信
    let completeLength = 0;
    for (let i = length - 1; i >= 0; i -= 1) {
      if (buffer[i] === 0x0a) {
        completeLength = i + 1;
        break;
      }
    }

    const events: TokenEventRow[] = [];
    let lines = 0;
    let lineStart = 0;
    let firstCompleteLineEnd = 0;
    let lastCompleteLineStart = 0;
    for (let i = 0; i < completeLength; i += 1) {
      if (buffer[i] !== 0x0a) continue;
      if (lines === 0) firstCompleteLineEnd = i + 1;
      lines += 1;
      lastCompleteLineStart = lineStart;
      if (i > lineStart) {
        try {
          events.push(JSON.parse(buffer.toString('utf8', lineStart, i)) as TokenEventRow);
        } catch {
          // 损坏 JSONL 行跳过，但物理行仍进入 checkpoint（与原容错口径一致）。
        }
      }
      lineStart = i + 1;
    }
    return {
      kind: 'ok',
      generation: generationOf(stat),
      events,
      lines,
      bytes: fromOffset + completeLength,
      ...(completeLength > 0 ? {
        firstAnchor: contentAnchor(fromOffset, buffer.subarray(0, firstCompleteLineEnd)),
        anchor: contentAnchor(
          fromOffset + lastCompleteLineStart,
          buffer.subarray(lastCompleteLineStart, completeLength),
        ),
      } : {}),
    };
  } catch (err: unknown) {
    if (isEnoent(err)) return { kind: 'missing' };
    throw err;
  } finally {
    await handle?.close();
  }
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** 把一条事件累计进账本（非 token 事件 / 损坏 payload / 缺 workUnitId 跳过） */
function accumulate(ledger: TokenLedger, event: TokenEventRow): void {
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

/** 调用方持有 ledger lock；事件文件消失时不覆盖旧账本。 */
async function syncTokenLedgerLocked(eventsFile: string, ledgerFile: string): Promise<TokenLedger> {
  let ledger = readLedgerBare(ledgerFile) ?? emptyTokenLedger();
  if (!await ledgerAnchorMatches(eventsFile, ledger)) ledger = emptyTokenLedger();
  let scan = await scanCompleteLines(eventsFile, ledger.watermark.bytes);
  if (scan.kind === 'missing') return emptyTokenLedger();

  if (scan.kind === 'invalid' || ledger.watermark.generation !== scan.generation) {
    ledger = emptyTokenLedger();
    scan = await scanCompleteLines(eventsFile, 0);
    if (scan.kind === 'missing') return emptyTokenLedger();
    if (scan.kind === 'invalid') throw new Error('token ledger rebuild failed: invalid zero offset');
  }

  // 只有半行或没有新增字节：保留原 checkpoint，不把未完整事件提交进账本。
  if (scan.bytes === ledger.watermark.bytes && scan.lines === 0
    && ledger.watermark.generation === scan.generation) return ledger;

  for (const event of scan.events) accumulate(ledger, event);
  ledger.watermark = {
    lines: ledger.watermark.lines + scan.lines,
    bytes: scan.bytes,
    generation: scan.generation,
    firstAnchor: ledger.watermark.firstAnchor ?? scan.firstAnchor,
    anchor: scan.anchor ?? ledger.watermark.anchor,
  };
  await getStore().writeJson(ledgerFile, ledger);
  return ledger;
}

/**
 * 同步账本项目前（读方主入口）：size + 代际匹配后还需 O(1) 内容锚点匹配才直返；
 * 落后 → 锁内按 byte offset 增量补扫；历史重写/轮转/截断/损坏/缺失 → 重建。
 * 事件文件不存在 → 空账本（不落盘）。可能抛 IO 错（锁超时等）——读方按各自语义兜底
 * （checkTreeBudget：catch → 0 → pass，与原全扫实现一致）；写侧走 noteTokenLedgerWritten。
 */
export async function syncTokenLedger(eventsFile: string): Promise<TokenLedger> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(eventsFile);
  } catch (err: unknown) {
    if (isEnoent(err)) return emptyTokenLedger();
    throw err;
  }

  const ledgerFile = resolveTokenLedgerFile(eventsFile);
  const cached = await getStore().readJson<TokenLedger>(ledgerFile).catch(() => null);
  if (isTokenLedger(cached) && cached.watermark.bytes === stat.size
    && cached.watermark.generation === generationOf(stat)
    && await ledgerAnchorMatches(eventsFile, cached)) return cached;

  const lockDir = path.join(path.dirname(ledgerFile), '.token-ledger.lock');
  return getStore().withLock(lockDir, () => syncTokenLedgerLocked(eventsFile, ledgerFile));
}

/**
 * 锁内证明 checkpoint 正好位于本事件之前，且本事件完整字节已在当前代际文件尾。
 * 证明失败不改变账本，调用方回退增量补扫；追加与账本锁无需被错误假设为原子。
 * 已有内容锚点必须原样保留：若 direct 前发生 copytruncate，下一次同步仍能识别并重建。
 */
async function tryDirectApply(
  eventsFile: string,
  ledger: TokenLedger,
  event: TokenEventRow,
): Promise<TokenLedger | null> {
  const expected = Buffer.from(JSON.stringify(event) + '\n');
  const start = ledger.watermark.bytes;
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(eventsFile, 'r');
    const stat = await handle.stat();
    const generation = generationOf(stat);
    if (stat.size !== start + expected.length) return null;
    if (start === 0) {
      if (ledger.watermark.lines !== 0 || Object.keys(ledger.byWorkUnit).length !== 0) return null;
    } else if (ledger.watermark.generation !== generation
      || !ledger.watermark.firstAnchor || !ledger.watermark.anchor) return null;

    const actual = await readExact(handle, start, expected.length);
    if (!actual?.equals(expected)) return null;
    accumulate(ledger, event);
    ledger.watermark = {
      lines: ledger.watermark.lines + 1,
      bytes: start + expected.length,
      generation,
      firstAnchor: ledger.watermark.firstAnchor ?? contentAnchor(start, expected),
      anchor: ledger.watermark.anchor ?? contentAnchor(start, expected),
    };
    return ledger;
  } catch (err: unknown) {
    if (isEnoent(err)) return null;
    throw err;
  } finally {
    await handle?.close();
  }
}

/**
 * 写侧记账钩子：token 事件落盘成功后由 writeWorkunitTokenEvent 调用（#320/PERF-01）。
 * event 必须是传给 appendJsonl 的同一个对象；缺省保留旧调用方式，走增量补扫。
 * 永不抛出——账本落后由读方 watermark 补扫自愈。
 */
export async function noteTokenLedgerWritten(eventsFile: string, event?: TokenEventRow): Promise<void> {
  try {
    const ledgerFile = resolveTokenLedgerFile(eventsFile);
    const lockDir = path.join(path.dirname(ledgerFile), '.token-ledger.lock');
    await getStore().withLock(lockDir, async () => {
      if (event) {
        const ledger = readLedgerBare(ledgerFile) ?? emptyTokenLedger();
        const direct = await tryDirectApply(eventsFile, ledger, event);
        if (direct) {
          await getStore().writeJson(ledgerFile, direct);
          return;
        }
      }
      await syncTokenLedgerLocked(eventsFile, ledgerFile);
    });
  } catch (err) {
    logger.warn('[TokenLedger] sync failed (non-blocking)', { error: String(err) });
  }
}
