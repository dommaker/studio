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

export type ReadOp = 'readJson' | 'readJsonl' | 'readIndexForQuery' | 'readdir';

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

/** 记录一次读口事件（读口仅在 timer 非 null 时调用；此处仍防御性判空一次）。 */
export function emitReadMetric(event: Omit<ReadMetricEvent, 'loop'>): void {
  const current = sink;
  if (current === null) return;
  current({ loop: loopLabelStorage.getStore() ?? 'unlabeled', ...event });
}
