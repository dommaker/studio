/**
 * Bench 报告模型 + baseline 同口径渲染 + 回归对比（#673）。
 *
 * 回归判定（PERF-07）：p50/p95 相对变化严格大于 thresholdPct 且绝对增量
 * 大于 minDeltaMs，或超过统一绝对预算才算回归；max 只进 observations。
 * 缺失端点与非 2xx 状态码出现也算失败。seed 不同的报告口径默认拒绝对比。
 */

export interface EndpointMetric {
  name: string;
  method: string;
  path: string;
  statusCounts: Record<string, number>;
  p50: number;
  p95: number;
  max: number;
}

export interface SseMetric {
  rounds: number;
  /** POST 应答 → SSE 收到 */
  postToSse: { p50: number; p95: number };
  /** POST 发起 → SSE 收到（端到端，含写处理） */
  endToEnd: { p50: number; p95: number };
}

export interface BenchReport {
  version: 1;
  meta: {
    commit: string;
    node: string;
    date: string;
    /** 预置数据条数（0 = 空数据区） */
    seed: number;
    /** 每轮每端点串行发数 */
    runs: number;
    /** 独立重复轮数；旧 baseline 缺省视为 1。 */
    repeats?: number;
    note?: string;
  };
  /** 各轮端口可服务耗时（/health 首次 200），ms */
  coldStart: { runs: number[]; note?: string };
  endpoints: EndpointMetric[];
  sse?: SseMetric;
}

export interface Regression {
  name: string;
  metric: string;
  baselineMs: number;
  currentMs: number;
  changePct: number;
}

export interface CompareResult {
  ok: boolean;
  regressions: Regression[];
  /** max 尖刺只进诊断，绝不参与 ok。 */
  observations: Regression[];
  /** baseline 有而 current 缺的端点名 */
  missing: string[];
}

export interface CompareOptions {
  thresholdPct?: number;
  /** 端点/SSE 绝对噪声地板（异机毫秒级抖动），默认 5ms */
  minDeltaMs?: number;
  /** 冷启动绝对噪声地板——秒级量级，机器负载方差同量级，默认 1000ms */
  coldStartMinDeltaMs?: number;
  /** 绝对预算依据 performance-baseline.md §5/§7.1。 */
  readP50BudgetMs?: number;
  readP95BudgetMs?: number;
  writeP50BudgetMs?: number;
  writeP95BudgetMs?: number;
  sseP50BudgetMs?: number;
  sseP95BudgetMs?: number;
  coldStartBudgetMs?: number;
  lcpP50BudgetMs?: number;
  lcpP95BudgetMs?: number;
  inpP50BudgetMs?: number;
  inpP95BudgetMs?: number;
  browserHeapGrowthBytes?: number;
  browserRetainedChannelKeys?: number;
  /** gate 默认改测规模区，仍保留旧空区 baseline 的全部回归项。 */
  allowSeedMismatch?: boolean;
}

function isRegression(baselineMs: number, currentMs: number, thresholdPct: number, minDeltaMs: number): boolean {
  const delta = currentMs - baselineMs;
  return delta > minDeltaMs && (delta / baselineMs) * 100 > thresholdPct;
}

function regression(name: string, metric: string, baselineMs: number, currentMs: number): Regression {
  return {
    name,
    metric,
    baselineMs,
    currentMs,
    changePct: Math.round(((currentMs - baselineMs) / baselineMs) * 1000) / 10,
  };
}

function hasNon2xx(statusCounts: Record<string, number>): boolean {
  return Object.entries(statusCounts).some(([code, count]) => count > 0 && !code.startsWith('2'));
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function compareReports(baseline: BenchReport, current: BenchReport, opts: CompareOptions = {}): CompareResult {
  if (!opts.allowSeedMismatch && baseline.meta.seed !== current.meta.seed) {
    throw new Error(`口径不同拒绝对比：baseline seed=${baseline.meta.seed} vs current seed=${current.meta.seed}`);
  }
  const thresholdPct = opts.thresholdPct ?? 20;
  const minDeltaMs = opts.minDeltaMs ?? 5;
  const regressions: Regression[] = [];
  const observations: Regression[] = [];
  const missing: string[] = [];

  const currentByName = new Map(current.endpoints.map((e) => [e.name, e]));
  for (const base of baseline.endpoints) {
    const cur = currentByName.get(base.name);
    if (!cur) {
      missing.push(base.name);
      continue;
    }
    if (hasNon2xx(cur.statusCounts) && !hasNon2xx(base.statusCounts)) {
      regressions.push(regression(base.name, 'status', 0, 1));
    }
    for (const metric of ['p50', 'p95'] as const) {
      if (isRegression(base[metric], cur[metric], thresholdPct, minDeltaMs)) {
        regressions.push(regression(base.name, metric, base[metric], cur[metric]));
      }
    }
    if (isRegression(base.max, cur.max, thresholdPct, minDeltaMs)) {
      observations.push(regression(base.name, 'max', base.max, cur.max));
    }
    const write = base.method !== 'GET';
    const budgets = {
      p50: (write ? opts.writeP50BudgetMs : opts.readP50BudgetMs) ?? (write ? 150 : 50),
      p95: (write ? opts.writeP95BudgetMs : opts.readP95BudgetMs) ?? (write ? 300 : 100),
    };
    for (const metric of ['p50', 'p95'] as const) {
      if (cur[metric] > budgets[metric]) {
        regressions.push(regression(base.name, `${metric}.absolute`, budgets[metric], cur[metric]));
      }
    }
  }

  // 冷启动按中位数对比：run1（全新数据区，含首启 seed/迁移）与其余轮语义不同且
  // 单机负载方差大，逐轮对比会被首轮噪声击穿；真回归（各轮齐慢）中位数必动。
  const coldStartFloor = opts.coldStartMinDeltaMs ?? 1000;
  const bMed = median(baseline.coldStart.runs);
  const cMed = median(current.coldStart.runs);
  if (bMed > 0 && cMed > 0 && isRegression(bMed, cMed, thresholdPct, coldStartFloor)) {
    regressions.push(regression('coldStart.median', 'ms', bMed, cMed));
  }
  const coldBudget = opts.coldStartBudgetMs ?? 10_000;
  if (cMed > coldBudget) regressions.push(regression('coldStart.median', 'absolute', coldBudget, cMed));

  if (baseline.sse && current.sse) {
    for (const key of ['postToSse', 'endToEnd'] as const) {
      for (const metric of ['p50', 'p95'] as const) {
        const b = baseline.sse[key][metric];
        const c = current.sse[key][metric];
        if (isRegression(b, c, thresholdPct, minDeltaMs)) {
          regressions.push(regression(`sse.${key}`, metric, b, c));
        }
        const budget = (metric === 'p50' ? opts.sseP50BudgetMs : opts.sseP95BudgetMs) ?? (metric === 'p50' ? 50 : 100);
        if (c > budget) regressions.push(regression(`sse.${key}`, `${metric}.absolute`, budget, c));
      }
    }
  }

  return { ok: regressions.length === 0 && missing.length === 0, regressions, observations, missing };
}

// ── baseline 同口径渲染 ──

function fmtS(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

function statusSummary(statusCounts: Record<string, number>): string {
  return Object.entries(statusCounts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([code, count]) => `${code}×${count}`)
    .join(' ');
}

export function renderMarkdown(report: BenchReport): string {
  const lines: string[] = [];
  const dataNote = report.meta.seed > 0 ? `预置 ${report.meta.seed} 条记录` : '空数据区';
  lines.push(`# 性能测量报告`);
  lines.push('');
  lines.push(`commit：\`${report.meta.commit}\`　日期：${report.meta.date}　${report.meta.node}`);
  lines.push(`口径：隔离 STUDIO_HOME、${report.meta.runs} 发串行、${dataNote}`);
  if (report.meta.note) lines.push(`备注：${report.meta.note}`);
  lines.push('');
  lines.push(`## 冷启动（端口可服务 = /health 首次 200）`);
  lines.push('');
  lines.push(`| 轮次 | 耗时 |`);
  lines.push(`|------|------|`);
  report.coldStart.runs.forEach((ms, i) => {
    lines.push(`| run${i + 1} | ${fmtS(ms)} |`);
  });
  lines.push('');
  lines.push(`## 端点延迟（${report.meta.runs} 发串行）`);
  lines.push('');
  lines.push(`| 端点 | 路径 | 状态码 | p50 | p95 | max |`);
  lines.push(`|------|------|--------|-----|-----|-----|`);
  for (const e of report.endpoints) {
    lines.push(`| ${e.name} | \`${e.method} ${e.path}\` | ${statusSummary(e.statusCounts)} | ${e.p50.toFixed(1)} ms | ${e.p95.toFixed(1)} ms | ${e.max.toFixed(1)} ms |`);
  }
  if (report.sse) {
    lines.push('');
    lines.push(`## SSE 延迟（${report.sse.rounds} 轮）`);
    lines.push('');
    lines.push(`- POST 应答 → SSE 收到：p50 ${report.sse.postToSse.p50.toFixed(1)} ms / p95 ${report.sse.postToSse.p95.toFixed(1)} ms`);
    lines.push(`- POST 发起 → SSE 收到（端到端）：p50 ${report.sse.endToEnd.p50.toFixed(1)} ms / p95 ${report.sse.endToEnd.p95.toFixed(1)} ms`);
  }
  lines.push('');
  return lines.join('\n');
}
