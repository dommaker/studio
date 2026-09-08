/**
 * jsonl-tail：通用 JSONL 尾部倒读原语（候选 2 下沉，泛化自 apps/api studio-events-tail）。
 * 字节级行切分（0x0A 不出现在多字节 UTF-8 序列内部），跨块多字节安全；
 * 游标 = 已扫区间下界字节偏移，续扫 [0, cursor) 无重叠无遗漏。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readJsonlTail } from '../jsonl-tail';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsonl-tail-'));
  file = path.join(dir, 'rows.jsonl');
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function writeLines(lines: string[], trailingNewline = true): Promise<void> {
  await fs.writeFile(file, lines.join('\n') + (trailingNewline ? '\n' : ''));
}

function row(n: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ id: `r${n}`, n, ...extra });
}

describe('readJsonlTail', () => {
  it('文件不存在 → 空结果，nextCursor null，不抛出', async () => {
    const r = await readJsonlTail({ file: path.join(dir, 'nope.jsonl'), limit: 10 });
    expect(r).toEqual({ rows: [], nextCursor: null });
  });

  it('空文件 → 空结果', async () => {
    await writeLines([]);
    const r = await readJsonlTail({ file, limit: 10 });
    expect(r).toEqual({ rows: [], nextCursor: null });
  });

  it('行数 < limit → 全部返回（文件倒序 = 新→旧），nextCursor null', async () => {
    await writeLines([row(1), row(2), row(3)]);
    const r = await readJsonlTail({ file, limit: 10 });
    expect(r.rows.map((x) => x.n)).toEqual([3, 2, 1]);
    expect(r.nextCursor).toBeNull();
  });

  it('游标分页：三页扫完无重叠无遗漏', async () => {
    await writeLines(Array.from({ length: 10 }, (_, i) => row(i + 1)));

    const p1 = await readJsonlTail({ file, limit: 4 });
    expect(p1.rows.map((x) => x.n)).toEqual([10, 9, 8, 7]);
    expect(p1.nextCursor).not.toBeNull();

    const p2 = await readJsonlTail({ file, limit: 4, cursor: p1.nextCursor! });
    expect(p2.rows.map((x) => x.n)).toEqual([6, 5, 4, 3]);
    expect(p2.nextCursor).not.toBeNull();

    const p3 = await readJsonlTail({ file, limit: 4, cursor: p2.nextCursor! });
    expect(p3.rows.map((x) => x.n)).toEqual([2, 1]);
    expect(p3.nextCursor).toBeNull();
  });

  it('无效 cursor（非数字 / 越界）→ 忽略，从文件尾重新开始', async () => {
    await writeLines([row(1), row(2), row(3)]);
    const r1 = await readJsonlTail({ file, limit: 2, cursor: 'abc' });
    expect(r1.rows.map((x) => x.n)).toEqual([3, 2]);
    const r2 = await readJsonlTail({ file, limit: 2, cursor: '999999999' });
    expect(r2.rows.map((x) => x.n)).toEqual([3, 2]);
  });

  it('match 过滤只收集匹配行，凑满 limit 即停', async () => {
    await writeLines([row(1, { keep: true }), row(2), row(3, { keep: true }), row(4)]);
    const r = await readJsonlTail({ file, limit: 5, match: (x) => x.keep === true });
    expect(r.rows.map((x) => x.n)).toEqual([3, 1]);
    expect(r.nextCursor).toBeNull();
  });

  it('损坏行跳过且游标不卡住', async () => {
    await writeLines([row(1), '{"broken":', row(2), row(3)]);
    const r = await readJsonlTail({ file, limit: 10 });
    expect(r.rows.map((x) => x.n)).toEqual([3, 2, 1]);
    expect(r.nextCursor).toBeNull();
  });

  it('跨块多字节字符（CJK/emoji）不被截断污染', async () => {
    const lines = [
      JSON.stringify({ id: 'a', text: '频道消息：中文内容🚀' }),
      JSON.stringify({ id: 'b', text: '第二行也是中文🎉🎉' }),
      JSON.stringify({ id: 'c', text: 'x' }),
    ];
    await writeLines(lines);
    // 极小 chunk 强制行被切在多字节序列中间
    const r = await readJsonlTail({ file, limit: 10, chunkSize: 7 });
    expect(r.rows.map((x) => x.id)).toEqual(['c', 'b', 'a']);
    expect(r.rows[1].text).toBe('第二行也是中文🎉🎉');
    expect(r.rows[2].text).toBe('频道消息：中文内容🚀');
  });

  it('CRLF 行尾兼容', async () => {
    await fs.writeFile(file, row(1) + '\r\n' + row(2) + '\r\n');
    const r = await readJsonlTail({ file, limit: 10 });
    expect(r.rows.map((x) => x.n)).toEqual([2, 1]);
  });

  it('文件尾无换行符时最后一行仍读出', async () => {
    await writeLines([row(1), row(2)], false);
    const r = await readJsonlTail({ file, limit: 10 });
    expect(r.rows.map((x) => x.n)).toEqual([2, 1]);
  });

  it('空行不产出', async () => {
    await fs.writeFile(file, row(1) + '\n\n\n' + row(2) + '\n\n');
    const r = await readJsonlTail({ file, limit: 10 });
    expect(r.rows.map((x) => x.n)).toEqual([2, 1]);
  });
});
