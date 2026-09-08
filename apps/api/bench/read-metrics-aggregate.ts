/**
 * #323 阶段一 bench：轮次聚合 + markdown 报告渲染（纯函数，可单测）。
 *
 * 输入 = 各规模档 worker 产出的逐轮事件流；输出：
 *   - 每循环×每规模档：读口调用次数（按存储源分桶）、stat/readParse/clone 各阶段 P50/P95、
 *     轮 wall P50/P95、读口合计 P50、归约残差（wall − 读口合计）占比
 *   - #411 分段归因：exec（子进程，按命令名分列）/ harness（存储栈调用级）段每轮合计 P50，
 *     其他（残差）= wall P50 − 读口/harness/exec 三段 P50 之和
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

/** #411 非读口段事件（exec 子进程 / harness 存储栈调用级 span） */
export interface BenchSegmentEvent {
  kind: 'exec' | 'harness';
  name: string;
  ms: number;
}

export interface BenchRound {
  loop: string;
  round: number;
  wallMs: number;
  events: BenchReadEvent[];
  /** #411 段事件（旧协议结果 JSON 可省略，聚合按空处理） */
  segments?: BenchSegmentEvent[];
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
    /** #411：exec 子进程段每轮合计 P50 */
    execMsP50: number;
    /** #411：harness 存储栈调用级段每轮合计 P50 */
    harnessMsP50: number;
    /** #411：exec 按命令名分列（次/轮 + 单次耗时 P50，flag 参数不进分组键） */
    execByName: Record<string, { countPerRound: number; msP50: number }>;
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

      // #411 段合计：每轮内按 kind 求和 + exec 按命令名求和（一趟分组，避免重复过滤形状）
      const execTotals: number[] = [];
      const harnessTotals: number[] = [];
      const execPerName = new Map<string, { totals: number[]; count: number }>();
      for (const r of warm) {
        let execMs = 0, harnessMs = 0;
        for (const s of r.segments ?? []) {
          if (s.kind === 'exec') {
            execMs += s.ms;
            const agg = execPerName.get(s.name) ?? { totals: [], count: 0 };
            agg.totals.push(s.ms);
            agg.count++;
            execPerName.set(s.name, agg);
          } else {
            harnessMs += s.ms;
          }
        }
        execTotals.push(execMs);
        harnessTotals.push(harnessMs);
      }

      const walls = sortedCopy(warm.map(r => r.wallMs));
      const readCounts = sortedCopy(warm.map(r => r.events.length));
      const readMss = sortedCopy(warm.map(readMsOf));
      const wallP50 = quantile(walls, 0.5);
      const readMsP50 = quantile(readMss, 0.5);

      const execByName: LoopScaleRow['warm']['execByName'] = {};
      for (const [name, agg] of [...execPerName.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        execByName[name] = {
          countPerRound: warm.length > 0 ? agg.count / warm.length : 0,
          msP50: quantile(sortedCopy(agg.totals), 0.5),
        };
      }

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
          execMsP50: quantile(sortedCopy(execTotals), 0.5),
          harnessMsP50: quantile(sortedCopy(harnessTotals), 0.5),
          execByName,
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
  /** 测量代码清单（brief 要求：临时注入的测量代码在报告中显式列出） */
  measurementCode: string[];
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
  lines.push('- 归约残差（总览表「残差占比」列口径）= 轮 wall − 该轮读口耗时合计；完整分段归因见下方「分段归因」节');
  lines.push('- 分段归因口径（#411）：读口 = FileStore 四读口 + knowledgeRead（memo 指纹 stat/clone 与 miss 时穿透 harness 存储栈的磁读）；'
    + 'harness = @dommaker/harness 存储栈调用级打点（FileKnowledgeStore 方法 + lifecycle/ingest/query/injector/linter facade，嵌套只记顶层），'
    + '上报自耗时 = span 全时长 − 嵌套在其中的读口耗时（与读口段按构造不相交）；'
    + 'exec = execAsync/execFileAsync 子进程（按命令身份分列，flag 参数不进分组键）；'
    + '其他（残差）= wall P50 − 读口/harness/exec 三段 P50 之和，含业务纯计算与未打点 I/O（inline 构造的 harness 对象纯 CPU 段也在此列）');
  lines.push('- 并发口径注意：并发读口循环（如 agent-timeout 的 listStates Promise.all）逐事件耗时可远大于 wall，'
    + '此类循环的读口列与「其他（残差）」可为负——以 wall 为准');
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

  // 分段归因（#411）：读口 / harness / exec / 其他（残差），暖轮 P50
  lines.push('## 分段归因（暖轮 P50，ms）', '');
  lines.push('| 循环 | 档位 | 读口 | harness | exec | 其他（残差） | wall P50 |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const row of summary.rows) {
    const other = row.warm.wallP50 - row.warm.readMsP50 - row.warm.harnessMsP50 - row.warm.execMsP50;
    lines.push(`| ${row.loop} | ${row.scale} | ${fmt(row.warm.readMsP50)} | ${fmt(row.warm.harnessMsP50)} | ${fmt(row.warm.execMsP50)} | ${fmt(other)} | ${fmt(row.warm.wallP50)} |`);
  }
  lines.push('');

  // exec 命令明细（#411：至少区分 git worktree prune / npx harness 两类命令）
  const hasExec = summary.rows.some(r => Object.keys(r.warm.execByName).length > 0);
  if (hasExec) {
    lines.push('### exec 命令明细（暖轮）', '');
    lines.push('| 循环 | 档位 | 命令 | 次/轮 | 耗时 P50 |');
    lines.push('|---|---|---|---|---|');
    for (const row of summary.rows) {
      for (const [name, e] of Object.entries(row.warm.execByName)) {
        lines.push(`| ${row.loop} | ${row.scale} | ${name} | ${e.countPerRound.toFixed(1)} | ${fmt(e.msP50)} |`);
      }
    }
    lines.push('');
  }

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

  // 测量代码清单
  lines.push('## 测量代码清单', '');
  for (const item of meta.measurementCode) lines.push(`- ${item}`);
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
