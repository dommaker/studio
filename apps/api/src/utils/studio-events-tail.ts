/**
 * #180（#60 决策 Q3a）：studio-events.jsonl 尾部倒读 + 游标分页。
 *
 * 替代 GET /events 的全文件线性扫 + 200 硬顶：从文件尾按块（默认 64KB）倒读，
 * 逐行解析并应用 match 过滤，收集到 limit 条匹配事件即停。游标 = 已扫区间
 * 下界的字节偏移（下一次只扫 [0, cursor)，无重叠无遗漏）；扫到文件头仍未
 * 凑满 → nextCursor = null（没有更旧的了）。
 *
 * 实现要点：行切分在字节层做（0x0A 不会出现在多字节 UTF-8 序列内部），
 * 完整行才解码为字符串——跨块的多字节字符不会被截断污染，字节偏移（游标）
 * 也不会因解码替换字符（U+FFFD）漂移。
 *
 * 无效 cursor（非数字 / 越界）→ 忽略，从文件尾重新开始（容错优于报错）。
 * 文件不存在 → 空结果；其他 I/O 错误上抛（调用方决定 500 还是降级）。
 */
import { promises as fs } from 'node:fs';
import type { StudioEventLevel } from './studio-events.js';

const DEFAULT_CHUNK_SIZE = 64 * 1024;
const LF = 0x0a;
const CR = 0x0d;

/** 事件分级（envelope 无 level 字段 = info；非法值回退 info） */
export function studioEventLevelOf(event: { level?: unknown }): StudioEventLevel {
  const l = event?.level;
  return l === 'debug' || l === 'info' || l === 'warning' || l === 'critical' ? l : 'info';
}

const LEVEL_ORDER: Record<StudioEventLevel, number> = { debug: 0, info: 1, warning: 2, critical: 3 };

/** 事件级别是否 ≥ min（读取侧默认 min='info'，#60 决策 Q2） */
export function levelAtLeast(level: StudioEventLevel, min: StudioEventLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[min];
}

export interface ReadStudioEventsTailOptions {
  /** 目标 jsonl 文件 */
  file: string;
  /** 本页最多返回的匹配事件数 */
  limit: number;
  /** 上一页返回的 nextCursor（字节偏移字符串）；缺省/无效 → 从文件尾开始 */
  cursor?: string;
  /** 匹配过滤（type/level/时间窗/关键词等组合）；缺省 = 全部匹配 */
  match?: (event: Record<string, unknown>) => boolean;
  /** 测试用：覆盖读取块大小（默认 64KB） */
  chunkSize?: number;
}

export interface ReadStudioEventsTailResult {
  /** 匹配事件，文件倒序（新 → 旧） */
  events: Array<Record<string, unknown>>;
  /** 续扫游标；null = 没有更旧的事件 */
  nextCursor: string | null;
}

export async function readStudioEventsTail(
  opts: ReadStudioEventsTailOptions,
): Promise<ReadStudioEventsTailResult> {
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const match = opts.match ?? (() => true);

  let handle: fs.FileHandle;
  try {
    handle = await fs.open(opts.file, 'r');
  } catch (e: any) {
    if (e?.code === 'ENOENT') return { events: [], nextCursor: null };
    throw e;
  }

  try {
    const stat = await handle.stat();
    let end = stat.size;
    if (opts.cursor !== undefined) {
      const c = Number(opts.cursor);
      if (Number.isFinite(c) && c >= 0 && c < end) end = Math.floor(c);
    }
    if (end === 0) return { events: [], nextCursor: null };

    const events: Array<Record<string, unknown>> = [];
    let nextCursor: string | null = null;
    let pos = end;
    let tail = Buffer.alloc(0); // 已读但未成行的尾部字节（跨块的不完整行，靠文件尾方向）

    outer: while (pos > 0) {
      const start = Math.max(0, pos - chunkSize);
      const chunk = Buffer.alloc(pos - start);
      await handle.read(chunk, 0, chunk.length, start);
      const buf = tail.length ? Buffer.concat([chunk, tail]) : chunk;

      // 字节层切行：段 = 换行符之间的区间 [segStart, nl)
      const segs: Array<{ start: number; end: number }> = [];
      let segStart = 0;
      for (let i = 0; i < buf.length; i++) {
        if (buf[i] === LF) {
          segs.push({ start: segStart, end: i });
          segStart = i + 1;
        }
      }
      segs.push({ start: segStart, end: buf.length }); // 末段（靠文件尾；拼上 tail 后是完整行）

      // start > 0 时首段可能是不完整行，留给下一块拼接
      const complete = start > 0 ? segs.slice(1) : segs;
      tail = start > 0 ? buf.subarray(segs[0].start, segs[0].end) : Buffer.alloc(0);

      for (let i = complete.length - 1; i >= 0; i--) {
        const seg = complete[i];
        const lineStart = start + seg.start; // 绝对字节偏移（游标语义）
        let lineEnd = seg.end;
        if (lineEnd > seg.start && buf[lineEnd - 1] === CR) lineEnd--; // 兼容 CRLF
        if (lineEnd === seg.start) continue; // 空行
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(buf.toString('utf8', seg.start, lineEnd));
        } catch {
          continue; // 损坏行跳过（已计入已扫区间，不卡住游标）
        }
        if (match(event)) {
          events.push(event);
          if (events.length >= opts.limit) {
            // 本行是已扫区间下界：下一页扫 [0, lineStart)，无重叠无遗漏
            nextCursor = lineStart > 0 ? String(lineStart) : null;
            break outer;
          }
        }
      }
      pos = start;
    }

    return { events, nextCursor };
  } finally {
    await handle.close();
  }
}
