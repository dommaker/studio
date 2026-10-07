/**
 * perf gate CLI（#673）——ship/CI 前置一把梭：跑 bench（空数据区，与
 * baseline.json 同口径）→ 对比 scripts/perf/baseline.json，回归 >20% exit 1。
 *
 * 用法：pnpm perf:gate -- [--threshold 20] [--min-delta-ms 5] [--cold-start-min-delta-ms 1000]
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBench } from './bench.js';
import { compareReports, type BenchReport, type CompareOptions } from './lib/report.js';
import { formatCompareResult } from './compare.js';

const baselinePath = fileURLToPath(new URL('./baseline.json', import.meta.url));

export function parseGateArgs(argv: string[]): CompareOptions {
  const opts: CompareOptions = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--threshold') opts.thresholdPct = Number(argv[++i]);
    else if (argv[i] === '--min-delta-ms') opts.minDeltaMs = Number(argv[++i]);
    else if (argv[i] === '--cold-start-min-delta-ms') opts.coldStartMinDeltaMs = Number(argv[++i]);
    else throw new Error(`未知参数：${argv[i]}`);
  }
  return opts;
}

export async function runGate(opts: CompareOptions): Promise<number> {
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as BenchReport;
  const { report } = await runBench();
  const result = compareReports(baseline, report, opts);
  for (const line of formatCompareResult(baseline, report, result, opts)) console.error(line);
  return result.ok ? 0 : 1;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let opts: CompareOptions;
  try {
    opts = parseGateArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  }
  runGate(opts)
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`[perf-gate] 失败：${err instanceof Error ? err.message : err}`);
      process.exit(1);
    });
}
