/**
 * bundle 预算门 CLI（#674）端到端测试：临时 fixture dist + 临时预算配置喂 run()，
 * 验证退出码三态（0 过 / 1 超预算 / 2 dist 缺失）。判定逻辑本身的用例在
 * lib/__tests__/bundle-budget.test.ts。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../bundle-budget.js';

let fixture: string;
let config: string;

beforeAll(() => {
  fixture = mkdtempSync(join(tmpdir(), 'bundle-budget-test-'));
  mkdirSync(join(fixture, 'dist', 'assets'), { recursive: true });
  // entry 10 KB + 一个 chunk 20 KB + css 5 KB
  writeFileSync(join(fixture, 'dist', 'assets', 'index-abc123.js'), 'x'.repeat(10 * 1024));
  writeFileSync(join(fixture, 'dist', 'assets', 'vendor-utils-def456.js'), 'x'.repeat(20 * 1024));
  writeFileSync(join(fixture, 'dist', 'assets', 'index-abc123.css'), 'x'.repeat(5 * 1024));
  config = join(fixture, 'budget.json');
  writeFileSync(config, JSON.stringify({
    budget: { totalJsKb: 100, entryJsKb: 50, maxChunkKb: 50, totalCssKb: 50 },
  }));
});

afterAll(() => {
  rmSync(fixture, { recursive: true, force: true });
});

describe('run（fixture dist）', () => {
  it('全部在预算内 → exit 0', () => {
    expect(run(['--config', config], join(fixture, 'dist'))).toBe(0);
  });

  it('超预算 → exit 1', () => {
    writeFileSync(config, JSON.stringify({
      budget: { totalJsKb: 25, entryJsKb: 50, maxChunkKb: 50, totalCssKb: 50 },
    }));
    expect(run(['--config', config], join(fixture, 'dist'))).toBe(1);
  });

  it('dist 缺失 → exit 2', () => {
    expect(run(['--config', config], join(fixture, 'no-such-dist'))).toBe(2);
  });
});
