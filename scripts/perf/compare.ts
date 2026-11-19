/**
 * perf compare CLI（#673）——回归门判定：两份 bench JSON 对比，
 * 回归 >阈值（默认 20%，另带 5ms 绝对噪声地板、冷启动 1s 地板按中位数）
 * 返回退出码 1 并打印明细。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/perf/compare.ts <baseline.json> <current.json>
 *        [--threshold 20] [--min-delta-ms 5] [--cold-start-min-delta-ms 1000]
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareReports, type BenchReport, type CompareOptions, type CompareResult } from './lib/report.js';

export function parseCompareArgs(argv: string[]): { baseline: string; current: string; opts: CompareOptions } {
  const positional: string[] = [];
  const opts: CompareOptions = {};
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--threshold': opts.thresholdPct = Number(argv[++i]); break;
      case '--min-delta-ms': opts.minDeltaMs = Number(argv[++i]); break;
      case '--cold-start-min-delta-ms': opts.coldStartMinDeltaMs = Number(argv[++i]); break;
      default: positional.push(argv[i]);
    }
  }
  if (positional.length !== 2) {
    throw new Error('用法：compare.ts <baseline.json> <current.json> [--threshold 20] [--min-delta-ms 5] [--cold-start-min-delta-ms 1000]');
  }
  return { baseline: positional[0], current: positional[1], opts };
}

export function formatCompareResult(base: BenchReport, cur: BenchReport, result: CompareResult, opts: CompareOptions): string[] {
  const lines: string[] = [];
  lines.push(`[perf-gate] baseline commit=${base.meta.commit} vs current commit=${cur.meta.commit}（threshold=${opts.thresholdPct ?? 20}%, min-delta=${opts.minDeltaMs ?? 5}ms, cold-start-min-delta=${opts.coldStartMinDeltaMs ?? 1000}ms）`);
  for (const name of result.missing) {
    lines.push(`[perf-gate] 缺失端点：${name}（baseline 有而本次未测）`);
  }
  for (const r of result.regressions) {
    const detail = r.metric === 'status' ? '出现非 2xx 状态码' : `${r.baselineMs} → ${r.currentMs} ms（+${r.changePct}%）`;
    lines.push(`[perf-gate] 回归 ${r.name} ${r.metric}: ${detail}`);
  }
  lines.push(result.ok ? '[perf-gate] 绿：无 >20% 回归' : `[perf-gate] 红：${result.regressions.length} 项回归 / ${result.missing.length} 项缺失`);
  return lines;
}

/** 返回进程退出码（0 绿 / 1 红 / 2 用法错误），供 CLI 与测试共用 */
export function runCompare(argv: string[]): number {
  let args: ReturnType<typeof parseCompareArgs>;
  try {
    args = parseCompareArgs(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    return 2;
  }
  const base = JSON.parse(readFileSync(args.baseline, 'utf8')) as BenchReport;
  const cur = JSON.parse(readFileSync(args.current, 'utf8')) as BenchReport;
  const result = compareReports(base, cur, args.opts);
  for (const line of formatCompareResult(base, cur, result, args.opts)) console.error(line);
  return result.ok ? 0 : 1;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  process.exit(runCompare(process.argv.slice(2)));
}
