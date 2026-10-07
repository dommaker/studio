/**
 * bundle 预算门（#674）——vite build 产物 size 断言。
 * 预算正本 scripts/perf/bundle-budget.json（阈值 = 当前产物基线 + ~20-25% 余量）；
 * 本文件 = 纯逻辑（checkBudget / renderBundleReport）+ dist 测量（measureDist）。
 * 口径：原始字节（非 gzip），KB = 1024 B；entry chunk = index-<hash>.js。
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface BundleBudget {
  /** 全部 JS 总量上限（KB） */
  totalJsKb: number;
  /** entry chunk（index-*.js）上限（KB） */
  entryJsKb: number;
  /** 最大单 chunk 上限（KB） */
  maxChunkKb: number;
  /** 全部 CSS 总量上限（KB） */
  totalCssKb: number;
}

export interface BundleMeasurement {
  totalJsBytes: number;
  entryJsBytes: number;
  maxChunkBytes: number;
  maxChunkName: string;
  totalCssBytes: number;
  jsFileCount: number;
}

export interface BudgetViolation {
  metric: 'totalJs' | 'entryJs' | 'maxChunk' | 'totalCss';
  actualKb: number;
  budgetKb: number;
  overPct: number;
  detail?: string;
}

const KB = 1024;

function toKb(bytes: number): number {
  return bytes / KB;
}

export function checkBudget(m: BundleMeasurement, b: BundleBudget): BudgetViolation[] {
  const checks: Array<{
    metric: BudgetViolation['metric'];
    actualKb: number;
    budgetKb: number;
    detail?: string;
  }> = [
    { metric: 'totalJs', actualKb: toKb(m.totalJsBytes), budgetKb: b.totalJsKb },
    { metric: 'entryJs', actualKb: toKb(m.entryJsBytes), budgetKb: b.entryJsKb },
    {
      metric: 'maxChunk',
      actualKb: toKb(m.maxChunkBytes),
      budgetKb: b.maxChunkKb,
      detail: m.maxChunkName,
    },
    { metric: 'totalCss', actualKb: toKb(m.totalCssBytes), budgetKb: b.totalCssKb },
  ];
  const violations: BudgetViolation[] = [];
  for (const c of checks) {
    if (c.actualKb > c.budgetKb) {
      violations.push({
        metric: c.metric,
        actualKb: Math.round(c.actualKb * 10) / 10,
        budgetKb: c.budgetKb,
        overPct: Math.round(((c.actualKb - c.budgetKb) / c.budgetKb) * 1000) / 10,
        ...(c.detail ? { detail: c.detail } : {}),
      });
    }
  }
  return violations;
}

/** 测量 vite build 产物（dist/assets 下的 js/css，原始字节） */
export function measureDist(distDir: string): BundleMeasurement {
  const assetsDir = join(distDir, 'assets');
  const files = readdirSync(assetsDir);
  let totalJsBytes = 0;
  let entryJsBytes = 0;
  let maxChunkBytes = 0;
  let maxChunkName = '';
  let totalCssBytes = 0;
  let jsFileCount = 0;
  for (const name of files) {
    const bytes = statSync(join(assetsDir, name)).size;
    if (name.endsWith('.js')) {
      jsFileCount += 1;
      totalJsBytes += bytes;
      if (/^index-.*\.js$/.test(name)) entryJsBytes += bytes;
      if (bytes > maxChunkBytes) {
        maxChunkBytes = bytes;
        maxChunkName = name;
      }
    } else if (name.endsWith('.css')) {
      totalCssBytes += bytes;
    }
  }
  return { totalJsBytes, entryJsBytes, maxChunkBytes, maxChunkName, totalCssBytes, jsFileCount };
}

export function renderBundleReport(
  m: BundleMeasurement,
  b: BundleBudget,
  violations: BudgetViolation[],
): string {
  const rows: Array<[string, number, number, string]> = [
    ['totalJs（全部 JS）', toKb(m.totalJsBytes), b.totalJsKb, `${m.jsFileCount} 个 chunk`],
    ['entryJs（index entry）', toKb(m.entryJsBytes), b.entryJsKb, ''],
    ['maxChunk（最大单 chunk）', toKb(m.maxChunkBytes), b.maxChunkKb, m.maxChunkName],
    ['totalCss（全部 CSS）', toKb(m.totalCssBytes), b.totalCssKb, ''],
  ];
  const fmt = (kb: number) => `${(Math.round(kb * 10) / 10).toFixed(1)} KB`;
  const lines: string[] = [
    violations.length === 0 ? '## bundle 预算：PASS' : '## bundle 预算：FAIL',
    '',
    '| 指标 | 实测 | 预算 | 余量 | 备注 |',
    '|------|------|------|------|------|',
    ...rows.map(([label, actual, budgetKb, note]) => {
      const headroom = budgetKb - actual;
      const mark = headroom < 0 ? ' ❌' : '';
      return `| ${label} | ${fmt(actual)} | ${fmt(budgetKb)} | ${fmt(headroom)}${mark} | ${note} |`;
    }),
  ];
  if (violations.length > 0) {
    lines.push('', '### 违例');
    for (const v of violations) {
      lines.push(
        `- **${v.metric}**：实测 ${v.actualKb} KB 超预算 ${v.budgetKb} KB（+${v.overPct}%）${v.detail ? `（${v.detail}）` : ''}`,
      );
    }
  }
  return lines.join('\n');
}
