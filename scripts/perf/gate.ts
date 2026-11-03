/**
 * perf gate CLI（PERF-07）——legacy 空区 bench + 非空规模 + 浏览器，
 * 输出 correctness/latency/soak；p50/p95 多轮相对回归与绝对预算判红，max 仅诊断。
 * 阈值正本 scripts/perf/gate-thresholds.json，CLI 参数优先。
 *
 * 用法：pnpm perf:gate [--quick] [--skip-browser] [--config scripts/perf/gate-thresholds.json]
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runBench } from './bench.js';
import { compareReports, type BenchReport, type CompareOptions } from './lib/report.js';
import { formatCompareResult } from './compare.js';
import { runScale, evaluateScaleReport, DEFAULT_SCALE, type ScaleOptions } from './scale.js';
import { runBrowser, evaluateBrowserReport, DEFAULT_BROWSER_MATRIX, type BrowserOptions } from './browser.js';

const baselinePath = fileURLToPath(new URL('./baseline.json', import.meta.url));
const defaultConfigPath = fileURLToPath(new URL('./gate-thresholds.json', import.meta.url));

export interface GateArgs {
  configPath: string;
  opts: CompareOptions;
  /** 本地小矩阵验证；默认完整矩阵。 */
  quick?: boolean;
  /** 仅显式诊断时允许跳过；默认 gate 必跑浏览器场景。 */
  skipBrowser?: boolean;
}

/** 取旗标值；缺值（尾参或紧跟另一旗标）直接抛友好报错，不放行 undefined */
function takeFlagValue(argv: string[], i: number, flag: string): string {
  const value = argv[i];
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} 缺参数值`);
  return value;
}

/** 取正数旗标值；缺值/非正数抛错——对齐 loadGateThresholds 配置面校验，防 Number(undefined)=NaN 静默全绿（#680） */
function takePositiveNumber(argv: string[], i: number, flag: string): number {
  const raw = takeFlagValue(argv, i, flag);
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${flag} 须为正数，实际 ${JSON.stringify(raw)}`);
  }
  return value;
}

export function parseGateArgs(argv: string[]): GateArgs {
  const args: GateArgs = { configPath: defaultConfigPath, opts: {} };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--config') args.configPath = takeFlagValue(argv, ++i, flag);
    else if (flag === '--threshold') args.opts.thresholdPct = takePositiveNumber(argv, ++i, flag);
    else if (flag === '--min-delta-ms') args.opts.minDeltaMs = takePositiveNumber(argv, ++i, flag);
    else if (flag === '--cold-start-min-delta-ms') args.opts.coldStartMinDeltaMs = takePositiveNumber(argv, ++i, flag);
    else if (flag === '--quick') args.quick = true;
    else if (flag === '--skip-browser') args.skipBrowser = true;
    else throw new Error(`未知参数：${flag}`);
  }
  return args;
}

const THRESHOLD_KEYS = [
  'thresholdPct', 'minDeltaMs', 'coldStartMinDeltaMs',
  'readP50BudgetMs', 'readP95BudgetMs', 'writeP50BudgetMs', 'writeP95BudgetMs',
  'sseP50BudgetMs', 'sseP95BudgetMs', 'coldStartBudgetMs',
  'lcpP50BudgetMs', 'lcpP95BudgetMs', 'inpP50BudgetMs', 'inpP95BudgetMs',
  'browserHeapGrowthBytes', 'browserRetainedChannelKeys',
] as const;

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

export function gateExitCode(categories: { correctness: string[]; latency: string[]; soak: string[] }, skipBrowser: boolean): number {
  if (Object.values(categories).some(failures => failures.length > 0)) return 1;
  return skipBrowser ? 2 : 0;
}

export function gateBenchOptions(quick: boolean): { runs: number; repeats: number; sseRounds: number; coldRuns: number } {
  // quick 只缩 scale/browser 矩阵；legacy 必须与 baseline 保持同样本和冷启/SSE口径。
  void quick;
  return { runs: 20, repeats: 3, sseRounds: 10, coldRuns: 3 };
}

export function gateStages(): Array<'browser' | 'scale' | 'legacy'> {
  return ['scale', 'browser', 'legacy'];
}

export function writeGateInnerReport(kind: 'scale' | 'browser', report: unknown, runId: string): string {
  const out = join(tmpdir(), `studio-perf-gate-${kind}-${runId}.json`);
  writeFileSync(out, JSON.stringify(report, null, 2));
  return out;
}

export async function runGate(opts: CompareOptions, runtime: { quick?: boolean; skipBrowser?: boolean } = {}): Promise<number> {
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as BenchReport;
  const quick = runtime.quick ?? false;
  const runId = `${Date.now()}-${process.pid}`;
  const scaleOptions: ScaleOptions = quick ? {
    scale: { workUnits: 20, events: 50, messages: 100, notifications: 20, knowledge: 10, roles: 4, httpConcurrency: 2, sseClients: 2 },
    repeats: 2, runs: 5,
  } : { scale: { ...DEFAULT_SCALE }, repeats: 3, runs: 10 };
  const scale = await runScale(scaleOptions);
  console.error(`[perf-gate] scale JSON 报告：${writeGateInnerReport('scale', scale, runId)}`);
  const scaleFailures = evaluateScaleReport(scale);

  const browserOptions: BrowserOptions = quick
    ? { matrix: { channels: 4, messages: 100, sseEvents: 3, detailVisits: 10 }, repeats: 2, runs: 3 }
    : { matrix: { ...DEFAULT_BROWSER_MATRIX }, repeats: 3, runs: 3 };
  const browser = runtime.skipBrowser ? null : await runBrowser(browserOptions);
  if (browser) console.error(`[perf-gate] browser JSON 报告：${writeGateInnerReport('browser', browser, runId)}`);
  const browserFailures = browser ? evaluateBrowserReport(browser) : { correctness: [], latency: [], soak: [] };

  const { report } = await runBench(gateBenchOptions(quick));
  // legacy bench 与空区 baseline 同口径；默认 gate 的非空规模证据由 runScale/runBrowser 提供。
  const result = compareReports(baseline, report, { ...opts, allowSeedMismatch: true });
  for (const line of formatCompareResult(baseline, report, result, opts)) console.error(line);

  const categories = {
    correctness: [
      ...result.missing.map(name => `missing:${name}`),
      ...result.regressions.filter(row => row.metric === 'status').map(row => `status:${row.name}`),
      ...scaleFailures.correctness,
      ...browserFailures.correctness,
    ],
    latency: [
      ...result.regressions.filter(row => row.metric !== 'status').map(row => `${row.name}.${row.metric}`),
      ...scaleFailures.latency,
      ...browserFailures.latency,
    ],
    soak: [...scaleFailures.soak, ...browserFailures.soak],
  };
  for (const [category, failures] of Object.entries(categories)) {
    console.error(`[perf-gate] ${category}: ${failures.length ? `红 ${failures.join(', ')}` : '绿'}`);
  }
  for (const observation of result.observations) console.error(`[perf-gate] 诊断 max ${observation.name}: ${observation.baselineMs} → ${observation.currentMs}ms（不判红）`);
  if (runtime.skipBrowser) console.error('[perf-gate] 诊断：显式 --skip-browser，本次未形成浏览器门禁证据');
  return gateExitCode(categories, runtime.skipBrowser ?? false);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let opts: CompareOptions;
  let runtime: { quick?: boolean; skipBrowser?: boolean };
  try {
    const args = parseGateArgs(process.argv.slice(2));
    opts = resolveGateOptions(args);
    runtime = { quick: args.quick, skipBrowser: args.skipBrowser };
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  }
  runGate(opts, runtime)
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`[perf-gate] 失败：${err instanceof Error ? err.message : err}`);
      process.exit(1);
    });
}
