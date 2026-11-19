import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGateArgs, loadGateThresholds, resolveGateOptions, gateExitCode, gateBenchOptions, gateStages, writeGateInnerReport } from '../gate.js';

const defaultConfigPath = fileURLToPath(new URL('../gate-thresholds.json', import.meta.url));

describe('parseGateArgs', () => {
  it('缺省：默认配置路径 + 空 opts（落配置文件值）', () => {
    expect(parseGateArgs([])).toEqual({ configPath: defaultConfigPath, opts: {} });
  });

  it('解析阈值与地板', () => {
    expect(parseGateArgs(['--threshold', '25', '--min-delta-ms', '3', '--cold-start-min-delta-ms', '800'])).toEqual({
      configPath: defaultConfigPath,
      opts: { thresholdPct: 25, minDeltaMs: 3, coldStartMinDeltaMs: 800 },
    });
  });

  it('--config 覆盖配置文件路径', () => {
    expect(parseGateArgs(['--config', '/tmp/custom.json']).configPath).toBe('/tmp/custom.json');
  });

  it('未知参数抛错', () => {
    expect(() => parseGateArgs(['--seed', '5'])).toThrow('未知参数');
  });

  it('--config 尾参缺值 → 友好报错（非 TypeError）', () => {
    expect(() => parseGateArgs(['--config'])).toThrow('--config 缺参数值');
  });

  it('数字旗标缺值/非法 → 报错（防 Number(undefined)=NaN 静默全绿，#680）', () => {
    expect(() => parseGateArgs(['--threshold'])).toThrow('--threshold 缺参数值');
    expect(() => parseGateArgs(['--threshold', 'abc'])).toThrow('--threshold 须为正数');
    expect(() => parseGateArgs(['--min-delta-ms', '-1'])).toThrow('--min-delta-ms 须为正数');
    expect(() => parseGateArgs(['--cold-start-min-delta-ms', '0'])).toThrow('--cold-start-min-delta-ms 须为正数');
    expect(() => parseGateArgs(['--threshold', '--config'])).toThrow('--threshold 缺参数值');
  });
});

describe('loadGateThresholds', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'perf-gate-cfg-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeCfg(body: unknown): string {
    const p = join(dir, 'cfg.json');
    writeFileSync(p, JSON.stringify(body));
    return p;
  }

  it('读取 thresholds 三值', () => {
    const p = writeCfg({ comment: 'x', thresholds: { thresholdPct: 30, minDeltaMs: 8, coldStartMinDeltaMs: 1500 } });
    expect(loadGateThresholds(p)).toEqual({ thresholdPct: 30, minDeltaMs: 8, coldStartMinDeltaMs: 1500 });
  });

  it('配置文件不存在 → 空 opts（回落 compareReports 默认值）', () => {
    expect(loadGateThresholds(join(dir, 'missing.json'))).toEqual({});
  });

  it('非正数阈值抛错', () => {
    expect(() => loadGateThresholds(writeCfg({ thresholds: { thresholdPct: -1 } }))).toThrow('gate-thresholds');
    expect(() => loadGateThresholds(writeCfg({ thresholds: { minDeltaMs: 'abc' } }))).toThrow('gate-thresholds');
  });

  it('未知 threshold 键抛错（防笔误静默落默认值）', () => {
    expect(() => loadGateThresholds(writeCfg({ thresholds: { thresholdPc: 20 } }))).toThrow('未知阈值键');
  });

  it('仓内统一阈值含原回归参数与绝对预算', () => {
    expect(loadGateThresholds(defaultConfigPath)).toEqual({
      thresholdPct: 20,
      minDeltaMs: 5,
      coldStartMinDeltaMs: 1000,
      readP50BudgetMs: 50,
      readP95BudgetMs: 100,
      writeP50BudgetMs: 150,
      writeP95BudgetMs: 300,
      sseP50BudgetMs: 50,
      sseP95BudgetMs: 100,
      coldStartBudgetMs: 10000,
      lcpP50BudgetMs: 1000,
      lcpP95BudgetMs: 2000,
      inpP50BudgetMs: 100,
      inpP95BudgetMs: 200,
      browserHeapGrowthBytes: 134217728,
      browserRetainedChannelKeys: 8,
    });
  });
});

describe('resolveGateOptions', () => {
  it('CLI 参数优先于配置文件', () => {
    expect(resolveGateOptions({ configPath: defaultConfigPath, opts: { thresholdPct: 50 } })).toEqual({
      ...loadGateThresholds(defaultConfigPath),
      thresholdPct: 50,
    });
  });

  it('--quick/--skip-browser 只影响运行矩阵，不改阈值', () => {
    expect(parseGateArgs(['--quick', '--skip-browser'])).toEqual({
      configPath: defaultConfigPath, opts: {}, quick: true, skipBrowser: true,
    });
  });

  it('scale 先于 browser 与 legacy，避免浏览器负载污染规模时延', () => {
    expect(gateStages()).toEqual(['scale', 'browser', 'legacy']);
  });

  it('当次内层 scale/browser 报告独立落盘，内容不引用独立运行结果', () => {
    const runId = `test-${process.pid}-${Date.now()}`;
    const scalePath = writeGateInnerReport('scale', { marker: 'gate-scale' }, runId);
    const browserPath = writeGateInnerReport('browser', { marker: 'gate-browser' }, runId);
    try {
      expect(scalePath).not.toBe(browserPath);
      expect(JSON.parse(readFileSync(scalePath, 'utf8'))).toEqual({ marker: 'gate-scale' });
      expect(JSON.parse(readFileSync(browserPath, 'utf8'))).toEqual({ marker: 'gate-browser' });
    } finally {
      rmSync(scalePath, { force: true });
      rmSync(browserPath, { force: true });
    }
  });

  it('quick 只缩规模/浏览器矩阵；legacy 空区与 full 同样本量和冷启/SSE口径', () => {
    expect(gateBenchOptions(true)).toEqual(gateBenchOptions(false));
    expect(gateBenchOptions(false)).toMatchObject({ runs: 20, repeats: 3, sseRounds: 10, coldRuns: 3 });
  });

  it('重锚 baseline 保留完整默认 gate 的60样本、全部端点和 max/SSE 诊断', () => {
    const path = fileURLToPath(new URL('../baseline.json', import.meta.url));
    const baseline = JSON.parse(readFileSync(path, 'utf8'));
    expect(baseline.meta).toMatchObject({ seed: 0, runs: 20, repeats: 3 });
    expect(baseline.endpoints).toHaveLength(9);
    for (const endpoint of baseline.endpoints) {
      expect(Object.values(endpoint.statusCounts)).toEqual([60]);
      expect(Number.isFinite(endpoint.max)).toBe(true);
    }
    expect(baseline.sse.rounds).toBe(10);
    expect(Number.isFinite(baseline.sse.postToSse.p95)).toBe(true);
    expect(Number.isFinite(baseline.sse.endToEnd.p95)).toBe(true);
  });

  it('--skip-browser 是诊断模式，即使其他类别全绿也返回 2', () => {
    expect(gateExitCode({ correctness: [], latency: [], soak: [] }, true)).toBe(2);
    expect(gateExitCode({ correctness: [], latency: [], soak: [] }, false)).toBe(0);
    expect(gateExitCode({ correctness: [], latency: ['LCP'], soak: [] }, true)).toBe(1);
  });
});
