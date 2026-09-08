/**
 * #323 阶段一：FileStore 读口量化测量 sink（周期循环读口测量的唯一新增模块）。
 *
 * 设计（docs/plans/2026-08-loop-read-measurement.md §1）：
 *  - 模块级 sink（默认 null）：关闭时读口除一次 if（readMetricsBegin 返回 null）外零开销、
 *    零行为变化；开启后每个读口事件记录 stat / readParse / clone 三段耗时与 cacheHit。
 *  - 循环归因：runWithLoopLabel(label, fn) 基于 node:async_hooks AsyncLocalStorage，
 *    嵌套覆盖/恢复、跨 await 传播、并发轮次互不串扰；无 label → 'unlabeled'。
 *  - 事件由调用方内存收集（基准场景量级可控，本模块不聚合格式、不落盘）。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

export type ReadOp = 'readJson' | 'readJsonl' | 'readIndexForQuery' | 'readdir' | 'knowledgeRead';

export interface ReadMetricEvent {
  /** 循环归因标签（runWithLoopLabel 设置；无 → 'unlabeled'） */
  loop: string;
  /** 读口目标（文件绝对路径；readdir 为目录绝对路径） */
  file: string;
  op: ReadOp;
  cacheHit: boolean;
  /** mtime 校验（statMtimeMs）耗时 */
  statMs: number;
  /** miss 时 readFile+parse（readdir 时为目录读取）耗时；hit 恒 0 */
  readParseMs: number;
  /** cloneCached 结构克隆耗时（readdir 不克隆，恒 0） */
  cloneMs: number;
}

export type ReadMetricsSink = (event: ReadMetricEvent) => void;

let sink: ReadMetricsSink | null = null;

/** 设置/关闭测量 sink（null = 关闭，默认）。 */
export function setReadMetricsSink(next: ReadMetricsSink | null): void {
  sink = next;
}

// ── #411 段事件（非读口段：exec 子进程 / harness 存储栈调用级 span）───
//
// 与读口事件平行的兄弟事件类型（brief 允许二选一；选兄弟类型——exec/harness 只有一段
// 耗时，硬套 stat/readParse/clone 三段会污染「读口合计」口径）。归因机制与读口共用
// loopLabelStorage（ALS），bench 报告据此给每个循环出分段归因。

export type SegmentKind = 'exec' | 'harness';

export interface SegmentMetricEvent {
  /** 循环归因标签（runWithLoopLabel 设置；无 → 'unlabeled'） */
  loop: string;
  kind: SegmentKind;
  /**
   * 段名。exec = 到首个 flag 前的命令 token（'git worktree prune' /
   * 'npx harness update-user-model'）；harness = 调用级入口
   * （'FileKnowledgeStore.readEntriesFromDisk' / 'KnowledgeLifecycle.runDecayCycle'）。
   */
  name: string;
  ms: number;
}

export type SegmentMetricsSink = (event: SegmentMetricEvent) => void;

let segmentSink: SegmentMetricsSink | null = null;

/** 设置/关闭段测量 sink（null = 关闭，默认）。 */
export function setSegmentMetricsSink(next: SegmentMetricsSink | null): void {
  segmentSink = next;
}

// 段嵌套（与 loop label 各自独立的 ALS，互不干扰）：facade 内嵌 store 调用只记顶层；
// ctx.nestedReadMs 由 emitReadMetric 累加嵌套读口耗时，span 关闭时扣除 → 上报自耗时，
// 与读口段按构造不相交（否则 auditor/decay 等读密集 facade 的段与读口双重计入，残差为负）。
interface SegmentSpanCtx { nestedReadMs: number }
const segmentSpanStorage = new AsyncLocalStorage<{ depth: number; ctx: SegmentSpanCtx }>();

/** 测量绝不影响业务：sink 抛异常一律吞掉。 */
function safeEmitSegment(event: SegmentMetricEvent): void {
  try {
    segmentSink?.(event);
  } catch { /* 测量路径永不外泄 */ }
}

/**
 * 调用级段 span。sink 关闭 → fn() 原样直调（零开销、返回值/异常/promise 身份不变）；
 * 开启 → 计时到同步返回 / promise settle / throw 为止，emit 一个段事件，耗时为
 * 自耗时（span 全时长 − 嵌套在其中的读口事件耗时，见 emitReadMetric）。
 * 嵌套调用（如 facade 内的 store 方法）只记最外层一个事件（深度延传，内层静默）。
 */
export function runSegmentSpan<T>(kind: SegmentKind, name: string, fn: () => T): T {
  if (segmentSink === null) return fn();
  const outer = segmentSpanStorage.getStore();
  if (outer) return segmentSpanStorage.run({ depth: outer.depth + 1, ctx: outer.ctx }, fn);
  const ctx: SegmentSpanCtx = { nestedReadMs: 0 };
  const t0 = performance.now();
  const emit = () => safeEmitSegment({
    loop: loopLabelStorage.getStore() ?? 'unlabeled', kind, name,
    ms: Math.max(0, performance.now() - t0 - ctx.nestedReadMs),
  });
  return segmentSpanStorage.run({ depth: 1, ctx }, () => {
    try {
      const result = fn();
      if (typeof (result as PromiseLike<unknown>)?.then === 'function') {
        // 挂 then 只为计时，不包不换 promise——原 promise 的消费方行为完全不变
        (result as PromiseLike<unknown>).then(emit, emit);
      } else {
        emit();
      }
      return result;
    } catch (e) {
      emit();
      throw e;
    }
  });
}

/**
 * 对象方法调用级 span 包装（#411 harness 段装配入口）：列内自有方法逐个包 span，
 * 未列方法与自有字段原样保留（lifecycle.store 等实例字段不丢）；方法缺席即跳过
 * （harness npm 版本容忍，同 onReference 特征检测先例）。
 */
export function wrapWithSegmentSpan<T extends object>(
  obj: T,
  label: string,
  methods: readonly string[],
  kind: SegmentKind = 'harness',
): T {
  for (const m of methods) {
    const orig = (obj as Record<string, unknown>)[m];
    if (typeof orig !== 'function') continue;
    (obj as Record<string, unknown>)[m] = function (this: unknown, ...args: unknown[]) {
      return runSegmentSpan(kind, `${label}.${m}`, () => (orig as (...a: unknown[]) => unknown).apply(this, args));
    };
  }
  return obj;
}

const loopLabelStorage = new AsyncLocalStorage<string>();

/** 在 label 归因上下文内执行 fn（返回值原样透传，含 Promise）。 */
export function runWithLoopLabel<T>(label: string, fn: () => T): T {
  return loopLabelStorage.run(label, fn);
}

/** 读口计时器（sink 开启时由 readMetricsBegin 发放）：调用即取当前毫秒时间戳。 */
export type ReadMetricsNow = () => number;

/**
 * 读口埋点起点。sink 关闭 → null（读口本次不再触碰测量路径，零开销）；
 * 开启 → 返回取时函数，读口据此取各阶段时间戳后调 emitReadMetric。
 */
export function readMetricsBegin(): ReadMetricsNow | null {
  if (sink === null) return null;
  return () => performance.now();
}

/** 记录一次读口事件（读口仅在 timer 非 null 时调用；此处仍防御性判空一次）。
 *  #411：若当前处于顶层段 span 内，读口耗时同步累加进 span 的嵌套扣减账
 *  （runSegmentSpan 关闭时扣除）——harness 段上报自耗时，与读口段不相交。
 *  不变量：读口事件与扣减账联动——读 sink 关闭时事件本身不存在，扣减也不发生，
 *  两口径恒一致（单独开 segment sink 不会产生「扣了但读口看不见」的负差）。 */
export function emitReadMetric(event: Omit<ReadMetricEvent, 'loop'>): void {
  const current = sink;
  if (current === null) return;
  current({ loop: loopLabelStorage.getStore() ?? 'unlabeled', ...event });
  const span = segmentSpanStorage.getStore();
  if (span) span.ctx.nestedReadMs += event.statMs + event.readParseMs + event.cloneMs;
}
