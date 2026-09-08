/**
 * 通用 JSONL 尾部倒读原语（架构评审候选 2 下沉，泛化自 apps/api studio-events-tail #180/#335）。
 *
 * 定位：FileStore seam 内的增量读口——「取尾部 N 行 / 按游标翻旧页」这类 O(增量) 语义
 * 不再摊成 O(全量) 的 readJsonl（全量读 + 全量克隆）。消费方：getChannelVersion /
 * getMessagesSince（file-store.ts）、studio-events-tail（apps/api 薄封装）、未来冷链分页。
 *
 * 与读穿缓存的关系（grilling Q4）：尾读每次直读磁盘尾部字节，结果不进 jsonlCache、
 * 不新立缓存层（真源唯一）；现有 appendJsonl 精确失效链不受影响。
 *
 * 行切分在字节层做（0x0A 不会出现在多字节 UTF-8 序列内部），完整行才解码为字符串——
 * 跨块的多字节字符不会被截断污染，字节偏移（游标）也不会因解码替换字符（U+FFFD）漂移。
 */
import { promises as fs } from 'node:fs';

const DEFAULT_CHUNK_SIZE = 64 * 1024;
const LF = 0x0a;
const CR = 0x0d;

/**
 * 从 [0, end) 区间尾部按块倒读，逐行（新→旧）产出完整行。空行不产出。
 * 每行附带 lineStart（该行首字节的文件偏移），供游标分页取已扫区间下界。
 */
export async function* iterateJsonlLinesBackward(
  handle: fs.FileHandle,
  end: number,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
): AsyncGenerator<{ text: string; lineStart: number }> {
  let pos = end;
  let tail = Buffer.alloc(0); // 已读但未成行的尾部字节（跨块的不完整行，靠文件尾方向）

  while (pos > 0) {
    const start = Math.max(0, pos - chunkSize);
    const chunk = Buffer.alloc(pos - start);
    // 本包 @types/node 钉在 20.0.0（泛型前的 Buffer 类型）与 TS 5.7+ lib 的
    // ArrayBufferView 泛型不兼容——Buffer 运行时是 Uint8Array 子类，此处仅做类型层适配
    await handle.read(chunk as Uint8Array, 0, chunk.length, start);
    const buf = tail.length ? Buffer.concat([chunk as Uint8Array, tail as Uint8Array]) : chunk;

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
      let lineEnd = seg.end;
      if (lineEnd > seg.start && buf[lineEnd - 1] === CR) lineEnd--; // 兼容 CRLF
      if (lineEnd === seg.start) continue; // 空行
      yield { text: buf.toString('utf8', seg.start, lineEnd), lineStart: start + seg.start };
    }
    pos = start;
  }
}

export interface ReadJsonlTailOptions {
  /** 目标 jsonl 文件 */
  file: string;
  /** 本页最多返回的匹配行数 */
  limit: number;
  /** 上一页返回的 nextCursor（字节偏移字符串）；缺省/无效 → 从文件尾开始 */
  cursor?: string;
  /** 匹配过滤；缺省 = 全部匹配 */
  match?: (row: Record<string, unknown>) => boolean;
  /** 测试用：覆盖读取块大小（默认 64KB） */
  chunkSize?: number;
}

export interface ReadJsonlTailResult {
  /** 匹配行，文件倒序（新 → 旧） */
  rows: Array<Record<string, unknown>>;
  /** 续扫游标；null = 没有更旧的行 */
  nextCursor: string | null;
}

/**
 * 尾页读：从文件尾（或 cursor 处）倒读，收集 limit 条匹配行即停。
 * 无效 cursor（非数字 / 越界）→ 忽略，从文件尾重新开始（容错优于报错）。
 * 文件不存在 → 空结果；损坏行跳过（已计入已扫区间，不卡住游标）；
 * 其他 I/O 错误上抛（调用方决定 500 还是降级）。
 */
export async function readJsonlTail(
  opts: ReadJsonlTailOptions,
): Promise<ReadJsonlTailResult> {
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const match = opts.match ?? (() => true);

  let handle: fs.FileHandle;
  try {
    handle = await fs.open(opts.file, 'r');
  } catch (e: any) {
    if (e?.code === 'ENOENT') return { rows: [], nextCursor: null };
    throw e;
  }

  try {
    const stat = await handle.stat();
    let end = stat.size;
    if (opts.cursor !== undefined) {
      const c = Number(opts.cursor);
      if (Number.isFinite(c) && c >= 0 && c < end) end = Math.floor(c);
    }
    if (end === 0) return { rows: [], nextCursor: null };

    const rows: Array<Record<string, unknown>> = [];
    let nextCursor: string | null = null;

    for await (const { text, lineStart } of iterateJsonlLinesBackward(handle, end, chunkSize)) {
      let row: Record<string, unknown>;
      try {
        row = JSON.parse(text);
      } catch {
        continue; // 损坏行跳过（已计入已扫区间，不卡住游标）
      }
      if (match(row)) {
        rows.push(row);
        if (rows.length >= opts.limit) {
          // 本行是已扫区间下界：下一页扫 [0, lineStart)，无重叠无遗漏
          nextCursor = lineStart > 0 ? String(lineStart) : null;
          break;
        }
      }
    }

    return { rows, nextCursor };
  } finally {
    await handle.close();
  }
}
