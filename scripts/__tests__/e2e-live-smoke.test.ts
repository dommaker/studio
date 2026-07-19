/**
 * e2e-live-smoke tests — 手动冒烟脚本的 SKIP 契约
 * 真实行为测试：PATH 中没有 claude 时脚本必须打印 SKIP 并以 0 退出，
 * 且不启动 API 子进程（SKIP 发生在任何资源分配之前）。
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const SCRIPT = path.resolve(__dirname, '..', 'e2e-live-smoke.ts');
const TSX_BIN = path.resolve(__dirname, '..', '..', 'node_modules', '.bin', 'tsx');

describe('e2e-live-smoke', () => {
  it('script exists and documents the SKIP contract', () => {
    const content = fs.readFileSync(SCRIPT, 'utf-8');
    expect(content).toContain('SKIP');
    expect(content).toContain('claude');
  });

  it('prints SKIP and exits 0 when claude is not on PATH', () => {
    // PATH 保留 coreutils 与 node，但排除 claude 所在的 /usr/local/bin
    const nodeDir = path.dirname(process.execPath);
    const safePath = [nodeDir, '/usr/bin', '/bin'].join(':');
    const result = spawnSync(TSX_BIN, [SCRIPT], {
      encoding: 'utf-8',
      timeout: 60_000,
      env: { ...process.env, PATH: safePath },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain('SKIP');
    // SKIP 必须先于 API 启动
    expect(`${result.stdout}\n${result.stderr}`).not.toContain('API server ready');
  }, 70_000);
});
