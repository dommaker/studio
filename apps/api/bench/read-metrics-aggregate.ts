/**
 * #323 阶段一 bench：轮次聚合 + markdown 报告渲染（纯函数，可单测）。
 *
 * 输入 = 各规模档 worker 产出的逐轮事件流；输出：
 *   - 每循环×每规模档：读口调用次数（按存储源分桶）、stat/readParse/clone 各阶段 P50/P95、
 *     轮 wall P50/P95、读口合计 P50、归约残差（wall − 读口合计，含非读口开销）占比
 *   - 首轮（round 0）冷缓存单列，暖轮（round ≥1）聚合
 */
import fs from 'node:fs';

// ─── 输入类型（worker JSON 协议）───

export interface BenchReadEvent {
  op: string;
  bucket: string;
  hit: boolean;
  statMs: number;
  readParseMs: number;
  cloneMs: number;
}

export interface BenchRound {
  loop: string;
  round: number;
  wallMs: number;
  events: BenchReadEvent[];
}

export interface WorkerResult {
  scale: string;
  meta: { rounds: number; templateWorkUnits: number; eventLines: number; agentDirs: number; stateFiles?: number; profileFiles?: number; channels?: number };
  rounds: BenchRound[];
}

// ─── 输出类型 ───

export interface BucketSummary {
  countPerRound: number;
  hitRatio: number;
  statMsP50: number; statMsP95: number;
  readParseMsP50: number; readParseMsP95: number;
  cloneMsP50: number; cloneMsP95: number;
}

export interface LoopScaleRow {
  loop: string;
  scale: string;
  cold: { wallMs: number; readCount: number; readMs: number };
  warm: {
    rounds: number;
    wallP50: number; wallP95: number;
    readCountP50: number;
    readMsP50: number; readMsP95: number;
    /** 归约残差占比（%）：(wallP50 − readMsP50) / wallP50，含非读口开销 */
    residualPct: number;
    buckets: Record<string, BucketSummary>;
  };
}

export interface Summary {
  scales: string[];
  loops: string[];
  rows: LoopScaleRow[];
  metas: Record<string, WorkerResult['meta']>;
}

/** 最近秩分位数（nearest-rank）：sorted[⌈q·n⌉−1]，n=0 → 0 */
export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx];
}

function sortedCopy(nums: number[]): number[] {
  return [...nums].sort((a, b) => a - b);
}

const SCALE_ORDER = (s: string): number => {
  const m = s.match(/^(\d+(?:\.\d+)?)x$/);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
};

export function summarize(results: WorkerResult[]): Summary {
  const scales = [...new Set(results.map(r => r.scale))].sort((a, b) => SCALE_ORDER(a) - SCALE_ORDER(b));
  const loops = [...new Set(results.flatMap(r => r.rounds.map(rd => rd.loop)))];
  const rows: LoopScaleRow[] = [];
  const metas: Summary['metas'] = {};

  for (const result of results) {
    metas[result.scale] = result.meta;
    for (const loop of loops) {
      const loopRounds = result.rounds.filter(r => r.loop === loop).sort((a, b) => a.round - b.round);
      if (loopRounds.length === 0) continue;
      const [cold, ...warm] = loopRounds;

      const readMsOf = (r: BenchRound) => r.events.reduce((s, e) => s + e.statMs + e.readParseMs + e.cloneMs, 0);
      const coldReadMs = readMsOf(cold);

      const walls = sortedCopy(warm.map(r => r.wallMs));
      const readCounts = sortedCopy(warm.map(r => r.events.length));
      const readMss = sortedCopy(warm.map(readMsOf));
      const wallP50 = quantile(walls, 0.5);
      const readMsP50 = quantile(readMss, 0.5);

      const buckets: Record<string, BucketSummary> = {};
      const bucketNames = [...new Set(warm.flatMap(r => r.events.map(e => e.bucket)))].sort();
      for (const b of bucketNames) {
        const events = warm.flatMap(r => r.events.filter(e => e.bucket === b));
        const stats = sortedCopy(events.map(e => e.statMs));
        const rps = sortedCopy(events.map(e => e.readParseMs));
        const clones = sortedCopy(events.map(e => e.cloneMs));
        buckets[b] = {
          countPerRound: warm.length > 0 ? events.length / warm.length : 0,
          hitRatio: events.length > 0 ? events.filter(e => e.hit).length / events.length : 0,
          statMsP50: quantile(stats, 0.5), statMsP95: quantile(stats, 0.95),
          readParseMsP50: quantile(rps, 0.5), readParseMsP95: quantile(rps, 0.95),
          cloneMsP50: quantile(clones, 0.5), cloneMsP95: quantile(clones, 0.95),
        };
      }

      rows.push({
        loop,
        scale: result.scale,
        cold: { wallMs: cold.wallMs, readCount: cold.events.length, readMs: coldReadMs },
        warm: {
          rounds: warm.length,
          wallP50,
          wallP95: quantile(walls, 0.95),
          readCountP50: quantile(readCounts, 0.5),
          readMsP50,
          readMsP95: quantile(readMss, 0.95),
          residualPct: wallP50 > 0 ? Math.max(0, (wallP50 - readMsP50) / wallP50) * 100 : 0,
          buckets,
        },
      });
    }
  }

  rows.sort((a, b) => a.loop.localeCompare(b.loop) || SCALE_ORDER(a.scale) - SCALE_ORDER(b.scale));
  return { scales, loops: [...loops].sort(), rows, metas };
}

// ─── markdown 渲染 ───

export interface ReportMeta {
  generatedAt: string;
  roundsPerLoop: number;
  /** 驱动不了的循环缺口（含理由），报告显式列出 */
  gaps: string[];
  /** 末节：建/不建快照层建议（含拐点规模判断） */
  recommendation: string;
}

function fmt(ms: number): string {
  return ms >= 100 ? ms.toFixed(0) : ms >= 1 ? ms.toFixed(1) : ms.toFixed(2);
}

export function renderMarkdown(summary: Summary, meta: ReportMeta): string {
  const lines: string[] = [];
  lines.push('# 周期循环读口量化测量报告（#323 阶段一）', '');
  lines.push(`- 生成时间：${meta.generatedAt}`);
  lines.push(`- 口径：每循环每档 ${meta.roundsPerLoop} 轮，首轮冷缓存单列，暖轮（≥2）聚合；耗时单位 ms`);
  lines.push('- 归约残差 = 轮 wall − 该轮读口耗时合计（含非读口开销：业务计算、写路径、execSync 探测等）');
  lines.push('');

  // 数据集画像
  lines.push('## 数据集画像', '');
  lines.push('| 档位 | WU 条数 | events 行数 | agents 目录 | state 文件 |');
  lines.push('|---|---|---|---|---|');
  for (const scale of summary.scales) {
    const m = summary.metas[scale];
    lines.push(`| ${scale} | ${m.templateWorkUnits} | ${m.eventLines} | ${m.agentDirs} | ${m.stateFiles ?? '-'} |`);
  }
  lines.push('');

  // 总览：每循环×每规模档
  lines.push('## 总览（暖轮 P50；wall 含 P95）', '');
  lines.push('| 循环 | 档位 | 读次数/轮 | 读口合计 P50 | 读口合计 P95 | wall P50 | wall P95 | 残差占比 |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const row of summary.rows) {
    lines.push(`| ${row.loop} | ${row.scale} | ${row.warm.readCountP50} | ${fmt(row.warm.readMsP50)} | ${fmt(row.warm.readMsP95)} | ${fmt(row.warm.wallP50)} | ${fmt(row.warm.wallP95)} | ${row.warm.residualPct.toFixed(0)}% |`);
  }
  lines.push('');

  // 冷轮
  lines.push('## 冷轮（首轮，缓存全冷）', '');
  lines.push('| 循环 | 档位 | 读次数 | 读口合计 | wall |');
  lines.push('|---|---|---|---|---|');
  for (const row of summary.rows) {
    lines.push(`| ${row.loop} | ${row.scale} | ${row.cold.readCount} | ${fmt(row.cold.readMs)} | ${fmt(row.cold.wallMs)} |`);
  }
  lines.push('');

  // 分桶明细
  lines.push('## 分桶明细（暖轮，按存储源）', '');
  for (const loop of summary.loops) {
    lines.push(`### ${loop}`, '');
    lines.push('| 档位 | 存储源 | 次数/轮 | 命中率 | stat P50/P95 | readParse P50/P95 | clone P50/P95 |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const row of summary.rows.filter(r => r.loop === loop)) {
      for (const [bucket, b] of Object.entries(row.warm.buckets)) {
        lines.push(`| ${row.scale} | ${bucket} | ${b.countPerRound.toFixed(1)} | ${(b.hitRatio * 100).toFixed(0)}% | ${fmt(b.statMsP50)}/${fmt(b.statMsP95)} | ${fmt(b.readParseMsP50)}/${fmt(b.readParseMsP95)} | ${fmt(b.cloneMsP50)}/${fmt(b.cloneMsP95)} |`);
      }
    }
    lines.push('');
  }

  // 缺口
  lines.push('## 驱动缺口', '');
  for (const gap of meta.gaps) lines.push(`- ${gap}`);
  lines.push('');

  // 建议
  lines.push('## 建/不建快照层建议', '');
  lines.push(meta.recommendation);
  lines.push('');

  return lines.join('\n');
}

/** 便捷：从磁盘读 worker JSON 列表 */
export function loadWorkerResults(files: string[]): WorkerResult[] {
  return files.map(f => JSON.parse(fs.readFileSync(f, 'utf-8')) as WorkerResult);
}
