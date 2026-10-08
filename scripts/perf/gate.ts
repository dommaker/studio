/**
 * perf gate CLI（#673，阈值配置文件化 #678）——ship/CI 前置一把梭：跑 bench（空数据区，与
 * baseline.json 同口径）→ 对比 scripts/perf/baseline.json，回归超阈值 exit 1。
 * 阈值正本 scripts/perf/gate-thresholds.json（bundle-budget.json 同风格，调阈值不改代码），
 * CLI 参数优先于配置文件；配置文件缺失/键缺省时回落 compareReports 内置默认值。
 *
 * 用法：pnpm perf:gate -- [--config scripts/perf/gate-thresholds.json] [--threshold 20] [--min-delta-ms 5] [--cold-start-min-delta-ms 1000]
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBench } from './bench.js';
import { compareReports, type BenchReport, type CompareOptions } from './lib/report.js';
import { formatCompareResult } from './compare.js';

const baselinePath = fileURLToPath(new URL('./baseline.json', import.meta.url));
const defaultConfigPath = fileURLToPath(new URL('./gate-thresholds.json', import.meta.url));

export interface GateArgs {
  configPath: string;
  opts: CompareOptions;
}

export function parseGateArgs(argv: string[]): GateArgs {
  const args: GateArgs = { configPath: defaultConfigPath, opts: {} };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config') args.configPath = argv[++i];
    else if (argv[i] === '--threshold') args.opts.thresholdPct = Number(argv[++i]);
    else if (argv[i] === '--min-delta-ms') args.opts.minDeltaMs = Number(argv[++i]);
    else if (argv[i] === '--cold-start-min-delta-ms') args.opts.coldStartMinDeltaMs = Number(argv[++i]);
    else throw new Error(`未知参数：${argv[i]}`);
  }
  return args;
}

const THRESHOLD_KEYS = ['thresholdPct', 'minDeltaMs', 'coldStartMinDeltaMs'] as const;

/** 读阈值配置文件；文件不存在回落空 opts（compareReports 默认值，#673 既有行为） */
export function loadGateThresholds(configPath: string): CompareOptions {
  if (!existsSync(configPath)) return {};
  const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as { thresholds?: Record<string, unknown> };
  const opts: CompareOptions = {};
  for (const [key, value] of Object.entries(parsed.thresholds ?? {})) {
    if (!THRESHOLD_KEYS.includes(key as (typeof THRESHOLD_KEYS)[number])) {
      throw new Error(`gate-thresholds 配置含未知阈值键：${key}`);
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new Error(`gate-thresholds 配置非法：${key} 须为正数，实际 ${JSON.stringify(value)}`);
    }
    opts[key as (typeof THRESHOLD_KEYS)[number]] = value;
  }
  return opts;
}

/** 配置合并：CLI 参数优先于配置文件 */
export function resolveGateOptions(args: GateArgs): CompareOptions {
  return { ...loadGateThresholds(args.configPath), ...args.opts };
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
    opts = resolveGateOptions(parseGateArgs(process.argv.slice(2)));
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
