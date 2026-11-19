/**
 * bundle 预算门（#674）纯逻辑测试：
 * checkBudget（测量 vs 预算 → 违例清单）+ renderBundleReport（报告渲染）。
 * measureDist 为 I/O（读 dist 目录），靠真实 CLI 跑通验证。
 */

import { describe, it, expect } from 'vitest';
import {
  checkBudget,
  renderBundleReport,
  type BundleBudget,
  type BundleMeasurement,
} from '../bundle-budget.js';

const budget: BundleBudget = {
  totalJsKb: 1150,
  entryJsKb: 100,
  maxChunkKb: 240,
  totalCssKb: 120,
};

function measurement(overrides: Partial<BundleMeasurement> = {}): BundleMeasurement {
  return {
    totalJsBytes: 900 * 1024,
    entryJsBytes: 80 * 1024,
    maxChunkBytes: 200 * 1024,
    maxChunkName: 'vendor-utils-abc123.js',
    totalCssBytes: 96 * 1024,
    jsFileCount: 60,
    ...overrides,
  };
}

describe('checkBudget', () => {
  it('全部在预算内 → 零违例', () => {
    expect(checkBudget(measurement(), budget)).toEqual([]);
  });

  it('恰好贴线（等于预算）不算违例', () => {
    const m = measurement({
      totalJsBytes: 1150 * 1024,
      entryJsBytes: 100 * 1024,
      maxChunkBytes: 240 * 1024,
      totalCssBytes: 120 * 1024,
    });
    expect(checkBudget(m, budget)).toEqual([]);
  });

  it('总 JS 超预算 → 一条 totalJs 违例，带超出百分比', () => {
    const m = measurement({ totalJsBytes: 1300 * 1024 });
    const violations = checkBudget(m, budget);
    expect(violations).toHaveLength(1);
    expect(violations[0].metric).toBe('totalJs');
    expect(violations[0].actualKb).toBe(1300);
    expect(violations[0].budgetKb).toBe(1150);
    expect(violations[0].overPct).toBeCloseTo(13.0, 0);
  });

  it('entry chunk 超预算 → entryJs 违例', () => {
    const m = measurement({ entryJsBytes: 110 * 1024 });
    const violations = checkBudget(m, budget);
    expect(violations.map((v) => v.metric)).toEqual(['entryJs']);
  });

  it('最大单 chunk 超预算 → maxChunk 违例，报告带 chunk 名', () => {
    const m = measurement({ maxChunkBytes: 300 * 1024, maxChunkName: 'vendor-react-deadbeef.js' });
    const violations = checkBudget(m, budget);
    expect(violations).toHaveLength(1);
    expect(violations[0].metric).toBe('maxChunk');
    expect(violations[0].detail).toContain('vendor-react-deadbeef.js');
  });

  it('CSS 超预算 → totalCss 违例', () => {
    const m = measurement({ totalCssBytes: 121 * 1024 });
    expect(checkBudget(m, budget).map((v) => v.metric)).toEqual(['totalCss']);
  });

  it('多项同时超 → 全部列出', () => {
    const m = measurement({ totalJsBytes: 2000 * 1024, maxChunkBytes: 500 * 1024 });
    expect(checkBudget(m, budget).map((v) => v.metric).sort()).toEqual(['maxChunk', 'totalJs']);
  });
});

describe('renderBundleReport', () => {
  it('零违例 → 报告含 PASS 与实测值表', () => {
    const report = renderBundleReport(measurement(), budget, []);
    expect(report).toContain('PASS');
    expect(report).toContain('totalJs');
    expect(report).toContain('vendor-utils-abc123.js');
  });

  it('有违例 → 报告含 FAIL 与超出幅度', () => {
    const violations = checkBudget(measurement({ totalJsBytes: 1300 * 1024 }), budget);
    const report = renderBundleReport(measurement({ totalJsBytes: 1300 * 1024 }), budget, violations);
    expect(report).toContain('FAIL');
    expect(report).toContain('totalJs');
  });
});
