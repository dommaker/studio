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
    // claude 在本机以 npm 全局包形式存在于 node 同级 bin、/usr/bin、/usr/local/bin 三处，
    // 任何包含 node 的 PATH 都必然能找到 claude —— 唯一可靠的隔离是临时目录只软链
    // tsx shim 运行所需的最小工具集（node + sed/dirname/uname），其余一概不含
    const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'live-smoke-path-'));
    fs.symlinkSync(process.execPath, path.join(isolated, 'node'));
    for (const tool of ['sed', 'dirname', 'uname']) {
      fs.symlinkSync(path.join('/usr/bin', tool), path.join(isolated, tool));
    }
    try {
      const result = spawnSync(TSX_BIN, [SCRIPT], {
        encoding: 'utf-8',
        timeout: 60_000,
        env: { ...process.env, PATH: isolated },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain('SKIP');
      // SKIP 必须先于 API 启动
      expect(`${result.stdout}\n${result.stderr}`).not.toContain('API server ready');
    } finally {
      fs.rmSync(isolated, { recursive: true, force: true });
    }
  }, 70_000);
});
