import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGateArgs, loadGateThresholds, resolveGateOptions } from '../gate.js';

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
});

describe('resolveGateOptions', () => {
  it('CLI 参数优先于配置文件', () => {
    expect(resolveGateOptions({ configPath: defaultConfigPath, opts: { thresholdPct: 50 } })).toEqual({
      thresholdPct: 50,
      minDeltaMs: 5,
      coldStartMinDeltaMs: 1000,
    });
  });

  it('仓内 gate-thresholds.json 默认值不变（20% / 5ms / 1000ms）', () => {
    expect(loadGateThresholds(defaultConfigPath)).toEqual({
      thresholdPct: 20,
      minDeltaMs: 5,
      coldStartMinDeltaMs: 1000,
    });
  });
});
