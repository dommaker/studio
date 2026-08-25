/**
 * setup-isolated-data 清理机制测试（/tmp 9.5 万 studio-test-data-* 残留事故，2026-08-25）
 *
 * 复现路径：每个测试文件进程 mkdtempSync 一个隔离根，原实现无任何清理——
 * 进程退出后目录永留 /tmp。这里用真实子进程 import setup 文件验证：
 * 1. 子进程正常退出后，其隔离根必须被自清（exit 钩子）；
 * 2. import 时必须顺带扫掉 /tmp 下超过 24h 的历史隔离根（崩溃/kill -9 兜底），
 *    且不得误删 24h 内的新目录（并发测试进程保护）。
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SETUP = path.resolve(__dirname, 'setup-isolated-data.setup.ts');
const TMP = process.env.TMPDIR || '/tmp';

/** 子进程 import setup 并打印隔离根路径；返回隔离根路径 */
function runSetupInChild(): string {
  const out = execFileSync(
    process.execPath,
    ['-e', `import(${JSON.stringify(SETUP)}).then(() => console.log(process.env.STUDIO_HOME))`],
    { encoding: 'utf8', env: { ...process.env } },
  );
  const line = out.split('\n').find(l => l.startsWith(path.join(TMP, 'studio-test-data-')));
  if (!line) throw new Error(`子进程未输出隔离根: ${out.slice(0, 200)}`);
  return line.trim();
}

describe('setup-isolated-data 清理机制', () => {
  it('进程退出后隔离根被自清（exit 钩子）', () => {
    const root = runSetupInChild();
    expect(root.startsWith(path.join(TMP, 'studio-test-data-'))).toBe(true);
    expect(fs.existsSync(root)).toBe(false);
  });

  it('import 时扫掉 >24h 的历史隔离根，保留 24h 内的', () => {
    const stale = fs.mkdtempSync(path.join(TMP, 'studio-test-data-'));
    const fresh = fs.mkdtempSync(path.join(TMP, 'studio-test-data-'));
    try {
      // 把 stale 的 mtime 拨到 25 小时前
      const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
      fs.utimesSync(stale, old, old);

      runSetupInChild(); // import 即触发清扫

      expect(fs.existsSync(stale)).toBe(false);
      expect(fs.existsSync(fresh)).toBe(true);
    } finally {
      fs.rmSync(stale, { recursive: true, force: true });
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });
});
