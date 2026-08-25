/**
 * #180（#60 决策 Q3a）：studio-events.jsonl 尾部倒读 + 游标分页
 *
 * 替代 GET /events 的全文件线性扫 + 200 硬顶：从文件尾按块倒读，
 * 收集到 limit 条匹配事件即停，nextCursor = 已扫区间下界字节偏移，
 * 下一页带 cursor 只扫 [0, cursor)。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  readStudioEventsTail,
  readStudioEventsSince,
  studioEventLevelOf,
  levelAtLeast,
} from '../studio-events-tail.js';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-events-tail-'));
  file = path.join(dir, 'events.jsonl');
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function writeLines(lines: string[], trailingNewline = true): Promise<void> {
  await fs.writeFile(file, lines.join('\n') + (trailingNewline ? '\n' : ''));
}

function line(n: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: 't', payload: '{}', createdAt: `2026-08-01T00:00:${String(n).padStart(2, '0')}.000Z`, n, ...extra });
}

describe('studioEventLevelOf / levelAtLeast', () => {
  it('envelope 无 level 字段 → info（缺省约定）', () => {
    expect(studioEventLevelOf({})).toBe('info');
    expect(studioEventLevelOf({ level: 'warning' })).toBe('warning');
    expect(studioEventLevelOf({ level: 'bogus' })).toBe('info');
  });

  it('级别排序 debug < info < warning < critical', () => {
    expect(levelAtLeast('debug', 'info')).toBe(false);
    expect(levelAtLeast('info', 'info')).toBe(true);
    expect(levelAtLeast('warning', 'info')).toBe(true);
    expect(levelAtLeast('critical', 'warning')).toBe(true);
    expect(levelAtLeast('info', 'warning')).toBe(false);
  });
});

describe('readStudioEventsTail', () => {
  it('文件不存在 → 空结果，nextCursor null，不抛出', async () => {
    const r = await readStudioEventsTail({ file: path.join(dir, 'nope.jsonl'), limit: 10 });
    expect(r).toEqual({ events: [], nextCursor: null });
  });

  it('行数 < limit → 全部返回（文件倒序 = 新→旧），nextCursor null', async () => {
    await writeLines([line(1), line(2), line(3)]);
    const r = await readStudioEventsTail({ file, limit: 10 });
    expect(r.events.map((e) => e.n)).toEqual([3, 2, 1]);
    expect(r.nextCursor).toBeNull();
  });

  it('游标分页：三页扫完无重叠无遗漏', async () => {
    await writeLines(Array.from({ length: 10 }, (_, i) => line(i + 1)));

    const p1 = await readStudioEventsTail({ file, limit: 4 });
    expect(p1.events.map((e) => e.n)).toEqual([10, 9, 8, 7]);
    expect(p1.nextCursor).not.toBeNull();

    const p2 = await readStudioEventsTail({ file, limit: 4, cursor: p1.nextCursor! });
    expect(p2.events.map((e) => e.n)).toEqual([6, 5, 4, 3]);
    expect(p2.nextCursor).not.toBeNull();

    const p3 = await readStudioEventsTail({ file, limit: 4, cursor: p2.nextCursor! });
    expect(p3.events.map((e) => e.n)).toEqual([2, 1]);
    expect(p3.nextCursor).toBeNull();
  });

  it('limit 恰好耗尽时 nextCursor 指向未扫区间，末页 nextCursor null', async () => {
    await writeLines([line(1), line(2)]);
    const p1 = await readStudioEventsTail({ file, limit: 1 });
    expect(p1.events.map((e) => e.n)).toEqual([2]);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await readStudioEventsTail({ file, limit: 1, cursor: p1.nextCursor! });
    expect(p2.events.map((e) => e.n)).toEqual([1]);
    expect(p2.nextCursor).toBeNull();
  });

  it('match 过滤：跳过不匹配行，limit 按匹配数计，游标仍可续扫', async () => {
    await writeLines([line(1), line(2, { kind: 'hit' }), line(3), line(4, { kind: 'hit' }), line(5)]);
    const match = (e: Record<string, unknown>) => e.kind === 'hit';
    const p1 = await readStudioEventsTail({ file, limit: 1, match });
    expect(p1.events.map((e) => e.n)).toEqual([4]);
    const p2 = await readStudioEventsTail({ file, limit: 1, cursor: p1.nextCursor!, match });
    expect(p2.events.map((e) => e.n)).toEqual([2]);
    // n=1 尚未扫到（不匹配但占区间），游标非空；再扫一页才到底
    const p3 = await readStudioEventsTail({ file, limit: 1, cursor: p2.nextCursor!, match });
    expect(p3.events).toEqual([]);
    expect(p3.nextCursor).toBeNull();
  });

  it('损坏行跳过（计入已扫区间，不卡住游标）', async () => {
    await writeLines([line(1), 'broken-json', line(3)]);
    const r = await readStudioEventsTail({ file, limit: 10 });
    expect(r.events.map((e) => e.n)).toEqual([3, 1]);
    expect(r.nextCursor).toBeNull();
  });

  it('文件末尾无换行符也能读到最后一行', async () => {
    await writeLines([line(1), line(2)], false);
    const r = await readStudioEventsTail({ file, limit: 10 });
    expect(r.events.map((e) => e.n)).toEqual([2, 1]);
  });

  it('跨 chunk 边界（极小 chunkSize）分页仍正确', async () => {
    const lines = Array.from({ length: 7 }, (_, i) => line(i + 1));
    await writeLines(lines);
    const p1 = await readStudioEventsTail({ file, limit: 3, chunkSize: 16 });
    expect(p1.events.map((e) => e.n)).toEqual([7, 6, 5]);
    const p2 = await readStudioEventsTail({ file, limit: 10, cursor: p1.nextCursor!, chunkSize: 16 });
    expect(p2.events.map((e) => e.n)).toEqual([4, 3, 2, 1]);
    expect(p2.nextCursor).toBeNull();
  });

  it('无效 cursor（非数字 / 超出文件大小）→ 从文件尾开始扫', async () => {
    await writeLines([line(1), line(2), line(3)]);
    const r1 = await readStudioEventsTail({ file, limit: 2, cursor: 'garbage' });
    expect(r1.events.map((e) => e.n)).toEqual([3, 2]);
    const r2 = await readStudioEventsTail({ file, limit: 2, cursor: '999999999' });
    expect(r2.events.map((e) => e.n)).toEqual([3, 2]);
  });

  it('空文件 → 空结果', async () => {
    await fs.writeFile(file, '');
    const r = await readStudioEventsTail({ file, limit: 10 });
    expect(r).toEqual({ events: [], nextCursor: null });
  });
});

/**
 * #335：时间窗读口（尾部倒读 + 首个窗口外行早停）。
 * 单调前提：文件 append-only 且时间单调（writeStudioEvent 恒追加、#173 轮转保序）。
 */
describe('readStudioEventsSince', () => {
  // line(n) 的 createdAt = 2026-08-01T00:00:<n>.000Z；sinceMs 取 n=4 的秒界
  const SINCE = new Date('2026-08-01T00:00:04.000Z').getTime();

  it('只返回 t >= sinceMs 的事件，按文件序（旧→新）', async () => {
    await writeLines([line(1), line(2), line(3), line(4), line(5), line(6)]);
    const rows = await readStudioEventsSince({ file, sinceMs: SINCE });
    expect(rows.map((e) => e.n)).toEqual([4, 5, 6]);
  });

  it('边界含端点：t 恰好等于 sinceMs 的事件被返回', async () => {
    await writeLines([line(3), line(4)]);
    const rows = await readStudioEventsSince({ file, sinceMs: SINCE });
    expect(rows.map((e) => e.n)).toEqual([4]);
  });

  it('时间非法（无 createdAt/timestamp）的行跳过且不触发停扫', async () => {
    const noTime = JSON.stringify({ type: 't', payload: '{}', n: 99 });
    await writeLines([line(1), line(5), noTime, line(6)]);
    const rows = await readStudioEventsSince({ file, sinceMs: SINCE });
    expect(rows.map((e) => e.n)).toEqual([5, 6]);
  });

  it('早停前提文档化：窗口外行更前面的窗口内行不返回（假设时间单调）', async () => {
    // n=5 在窗口内但位于 n=2（窗口外）之前 —— 倒扫在 n=2 处停扫，n=5 不可见
    await writeLines([line(5), line(2), line(6)]);
    const rows = await readStudioEventsSince({ file, sinceMs: SINCE });
    expect(rows.map((e) => e.n)).toEqual([6]);
  });

  it('兼容历史扁平事件：timestamp 为 epoch number', async () => {
    const flat = (sec: number) =>
      JSON.stringify({ type: 't', timestamp: new Date(`2026-08-01T00:00:${String(sec).padStart(2, '0')}.000Z`).getTime(), n: sec });
    await writeLines([flat(1), flat(5), flat(6)]);
    const rows = await readStudioEventsSince({ file, sinceMs: SINCE });
    expect(rows.map((e) => e.n)).toEqual([5, 6]);
  });

  it('损坏行跳过；空行跳过', async () => {
    await writeLines([line(1), 'broken-json', line(5), '', line(6)]);
    const rows = await readStudioEventsSince({ file, sinceMs: SINCE });
    expect(rows.map((e) => e.n)).toEqual([5, 6]);
  });

  it('文件不存在 → []，不抛出', async () => {
    await expect(readStudioEventsSince({ file: path.join(dir, 'nope.jsonl'), sinceMs: SINCE }))
      .resolves.toEqual([]);
  });

  it('空文件 → []', async () => {
    await fs.writeFile(file, '');
    await expect(readStudioEventsSince({ file, sinceMs: SINCE })).resolves.toEqual([]);
  });

  it('全部行都在窗口外 → []', async () => {
    await writeLines([line(1), line(2), line(3)]);
    await expect(readStudioEventsSince({ file, sinceMs: SINCE })).resolves.toEqual([]);
  });

  it('跨 chunk 边界（极小 chunkSize）仍正确', async () => {
    await writeLines(Array.from({ length: 8 }, (_, i) => line(i + 1)));
    const rows = await readStudioEventsSince({ file, sinceMs: SINCE, chunkSize: 16 });
    expect(rows.map((e) => e.n)).toEqual([4, 5, 6, 7, 8]);
  });

  it('多字节字符跨块不污染（payload 含中文，极小 chunkSize）', async () => {
    const cn = JSON.stringify({ type: 't', payload: '{"msg":"窗口化读口"}', createdAt: '2026-08-01T00:00:07.000Z', n: 7 });
    await writeLines([line(1), cn, line(8)]);
    const rows = await readStudioEventsSince({ file, sinceMs: SINCE, chunkSize: 16 });
    expect(rows.map((e) => e.n)).toEqual([7, 8]);
  });
});
