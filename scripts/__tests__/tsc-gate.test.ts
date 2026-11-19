/**
 * tsc-gate — 类型门禁核心测试（#694：baseline 比对/自动更新机制删除，任一 tsc 错误即拦截）
 *
 * 用 fixture 包直跑 bin/tsc-gate.js：干净包放行、带错包拦截并报 TS 错误码。
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const GATE = path.join(ROOT, 'bin/tsc-gate.js');

function runGate(packages: string): { code: number; out: string } {
  try {
    const out = execFileSync('node', [GATE, '--check', '--packages', packages], {
      cwd: ROOT,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    return { code: 0, out };
  } catch (e: any) {
    return { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe('tsc-gate --check', () => {
  it('干净包 → 退出 0', () => {
    const r = runGate('scripts/__tests__/fixtures/tsc-gate/clean');
    expect(r.code, r.out).toBe(0);
  }, 60000);

  it('带 tsc 错误的包 → 退出 1 并输出错误（无 baseline 豁免，恒等价于全量拦截）', () => {
    const r = runGate('scripts/__tests__/fixtures/tsc-gate/broken');
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain('TS2322');
  }, 60000);

  it('无 tsconfig 的路径 → 跳过不误报', () => {
    const r = runGate('scripts/__tests__/fixtures/tsc-gate');
    expect(r.code, r.out).toBe(0);
  }, 60000);
});
