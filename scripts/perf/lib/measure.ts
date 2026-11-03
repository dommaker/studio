import { monitorEventLoopDelay } from 'node:perf_hooks';
import { summarize, type Summary } from './stats.js';

export interface Distribution {
  p50: number;
  p95: number;
  /** 仅诊断，不参与硬门。 */
  max: number;
}

export interface MeasurementDiagnostics {
  lockWaitMs: Distribution;
  eventLoopDelayMs: Distribution;
  rssBytes: { start: number; peak: number; end: number };
  readBytes: number;
  parsedLines: number;
  cacheMisses: number;
}

/** 交替顺序 B,C / C,B，降低机器状态单向漂移对 A/B 归因的影响。 */
export async function measureAlternating(opts: {
  repeats: number;
  baseline: () => Promise<number[]>;
  current: () => Promise<number[]>;
}): Promise<{ baseline: Summary; current: Summary; order: Array<'baseline' | 'current'> }> {
  if (!Number.isInteger(opts.repeats) || opts.repeats < 2) throw new Error('交替测量 repeats 须 ≥2');
  const baseline: number[] = [];
  const current: number[] = [];
  const order: Array<'baseline' | 'current'> = [];
  for (let round = 0; round < opts.repeats; round++) {
    const pair = round % 2 === 0 ? ['baseline', 'current'] as const : ['current', 'baseline'] as const;
    for (const side of pair) {
      order.push(side);
      const samples = side === 'baseline' ? await opts.baseline() : await opts.current();
      if (samples.length === 0 || samples.some(v => !Number.isFinite(v) || v < 0)) throw new Error(`${side} 返回非法时延样本`);
      (side === 'baseline' ? baseline : current).push(...samples);
    }
  }
  return { baseline: summarize(baseline), current: summarize(current), order };
}

/** 同端点、同冻结数据快照的 B/C 交替；scenario/snapshot 不允许在 B/C 间改变。 */
export async function measureScenarioAlternating<T>(opts: {
  scenario: T;
  snapshot: string;
  repeats: number;
  measure: (scenario: T, snapshot: string) => Promise<number[]>;
}): Promise<{ baseline: Summary; current: Summary; order: Array<'baseline' | 'current'> }> {
  if (!opts.snapshot) throw new Error('交替测量必须显式冻结数据快照');
  return measureAlternating({
    repeats: opts.repeats,
    baseline: () => opts.measure(opts.scenario, opts.snapshot),
    current: () => opts.measure(opts.scenario, opts.snapshot),
  });
}

function distribution(samples: number[]): Distribution {
  const summary = summarize(samples);
  return { p50: summary.p50, p95: summary.p95, max: summary.max };
}

export function summarizeDiagnostics(input: {
  lockWaitMs: number[];
  eventLoopDelayMs: number[];
  rssBytes: number[];
  readBytes: number;
  parsedLines: number;
  cacheMisses: number;
}): MeasurementDiagnostics {
  const rss = input.rssBytes;
  return {
    lockWaitMs: distribution(input.lockWaitMs),
    eventLoopDelayMs: distribution(input.eventLoopDelayMs),
    rssBytes: { start: rss[0] ?? 0, peak: rss.length ? Math.max(...rss) : 0, end: rss.at(-1) ?? 0 },
    readBytes: input.readBytes,
    parsedLines: input.parsedLines,
    cacheMisses: input.cacheMisses,
  };
}

/** 同进程场景的统一资源采样器；max 只用于诊断报告。 */
export class ResourceSampler {
  private readonly histogram = monitorEventLoopDelay({ resolution: 1 });
  private readonly rss: number[] = [];
  private readonly started = performance.now();

  constructor() {
    this.histogram.enable();
    this.rss.push(process.memoryUsage().rss);
  }

  sample(): void {
    this.rss.push(process.memoryUsage().rss);
  }

  finish(): { eventLoopDelayMs: number[]; rssBytes: number[]; wallMs: number } {
    this.sample();
    this.histogram.disable();
    // 直方图不提供原始样本；p50/p95/max 都作为区间诊断值传入统一汇总。
    return {
      eventLoopDelayMs: [this.histogram.percentile(50) / 1e6, this.histogram.percentile(95) / 1e6, this.histogram.max / 1e6],
      rssBytes: [...this.rss],
      wallMs: performance.now() - this.started,
    };
  }
}
