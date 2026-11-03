import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const preload = fileURLToPath(new URL('../telemetry.mjs', import.meta.url));
let dir = '';
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

describe('telemetry preload', () => {
  it('记录 event-loop/RSS/readBytes/parsedLines/cacheMisses', () => {
    dir = mkdtempSync(join(tmpdir(), 'perf-telemetry-test-'));
    const out = join(dir, 'telemetry.json');
    const input = join(dir, 'input.jsonl');
    const env = { ...process.env, PERF_TELEMETRY_FILE: out, PERF_TELEMETRY_INTERVAL_MS: '25' };
    delete env.NODE_OPTIONS;
    const child = spawnSync(process.execPath, ['--import', preload, '-e', "const fs=require('fs');fs.writeFileSync(process.argv[1],'{}\\n'.repeat(3));fs.readFileSync(process.argv[1],'utf8').split('\\n').filter(Boolean).forEach(JSON.parse);setTimeout(()=>{},150)", input], {
      env,
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(child.status, child.stderr).toBe(0);
    expect(existsSync(out)).toBe(true);
    const data = JSON.parse(readFileSync(out, 'utf8'));
    expect(data.readBytes).toBeGreaterThan(0);
    expect(data.parsedLines).toBe(3);
    expect(data.rssBytes.peak).toBeGreaterThan(0);
    expect(data.eventLoopDelayMs.max).toBeGreaterThanOrEqual(0);
    expect(data.cacheMisses).toBeGreaterThan(0);
  });

  it('继承 NODE_OPTIONS 的子进程不得覆盖 API 进程 telemetry', () => {
    dir = mkdtempSync(join(tmpdir(), 'perf-telemetry-child-test-'));
    const out = join(dir, 'telemetry.json');
    const env = {
      ...process.env,
      PERF_TELEMETRY_FILE: out,
      PERF_TELEMETRY_INTERVAL_MS: '25',
      NODE_OPTIONS: `--import ${preload}`,
    };
    delete env.PERF_TELEMETRY_OWNER_PID;
    const child = spawnSync(process.execPath, ['-e', `
      const fs = require('fs');
      const cp = require('child_process');
      const nested = cp.spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 80)'], { env: process.env });
      if (nested.status !== 0) throw new Error('nested process failed');
      setTimeout(() => {
        const report = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
        if (report.pid !== process.pid) {
          console.error('telemetry owner mismatch', report.pid, process.pid);
          process.exitCode = 1;
        }
      }, 200);
    `, out], { env, encoding: 'utf8', timeout: 10_000 });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(readFileSync(out, 'utf8')).pid).toBe(child.pid);
  });

  it('主线程与 worker 同时 preload 不发生临时文件 rename 竞态', () => {
    dir = mkdtempSync(join(tmpdir(), 'perf-telemetry-worker-test-'));
    const out = join(dir, 'telemetry.json');
    const env = { ...process.env, PERF_TELEMETRY_FILE: out, PERF_TELEMETRY_INTERVAL_MS: '5' };
    delete env.NODE_OPTIONS;
    const child = spawnSync(process.execPath, ['--import', preload, '-e', "const {Worker}=require('worker_threads');new Worker('setTimeout(()=>{},100)',{eval:true});setTimeout(()=>{},200)"], {
      env,
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(readFileSync(out, 'utf8')).rssBytes.peak).toBeGreaterThan(0);
  });
});
