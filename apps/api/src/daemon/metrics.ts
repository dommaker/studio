// Pipeline Metrics — 管线 vs 窗口对比
import { prisma } from '@dommaker/studio-prisma';
import { logger } from '@dommaker/studio-shared';
import { formatTable } from '@dommaker/studio-shared/cli';

export interface MetricEntry {
  source: 'pipeline' | 'window';
  phase: 'analyst' | 'executor' | 'review' | 'deploy' | 'full';
  taskName: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
  durationMs: number;
  success: boolean;
  testPassed?: boolean;
  lintPassed?: boolean;
  diffLines?: number;
  error?: string;
  sessionId?: string;
  goalId?: string;
}

/**
 * 从 Claude Code stdout 解析 usage（--output-format json）
 */
export function parseClaudeUsage(stdout: string): {
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
} {
  // Stream-json: scan lines for result event with usage
  for (const line of stdout.split('\n').reverse()) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      const u = parsed.usage || {};
      if (u.input_tokens || u.output_tokens) {
        return {
          inputTokens: u.input_tokens || 0,
          outputTokens: u.output_tokens || 0,
          cacheHitTokens: u.cache_read_input_tokens || u.cache_creation_input_tokens || 0,
        };
      }
    } catch { /* skip */ }
  }
  // Fallback: regex
  const inputMatch = stdout.match(/input_tokens[:\s]+(\d+)/i);
  const outputMatch = stdout.match(/output_tokens[:\s]+(\d+)/i);
  const cacheMatch = stdout.match(/cache_read_input_tokens[:\s]+(\d+)/i);
  return {
    inputTokens: inputMatch ? parseInt(inputMatch[1]) : 0,
    outputTokens: outputMatch ? parseInt(outputMatch[1]) : 0,
    cacheHitTokens: cacheMatch ? parseInt(cacheMatch[1]) : 0,
  };
}

export async function recordWindowRun(entry: Omit<MetricEntry, 'source' | 'sessionId'>): Promise<boolean> {
  return recordPipelineRun({ ...entry, source: 'window' });
}

export async function recordPipelineRun(entry: MetricEntry): Promise<boolean> {
  try {
    await prisma.pipelineRun.create({ data: entry });
    logger.info('[Metrics] Recorded', {
      source: entry.source,
      phase: entry.phase,
      model: entry.model,
      inputTokens: entry.inputTokens,
      cacheHitTokens: entry.cacheHitTokens,
      durationMs: entry.durationMs,
      goalId: entry.goalId || '(none)',
    });
    return true;
  } catch (e) {
    logger.error('[Metrics] FAILED to record PipelineRun', {
      error: String(e),
      phase: entry.phase,
      taskName: entry.taskName,
      goalId: entry.goalId,
      inputTokens: entry.inputTokens,
      durationMs: entry.durationMs,
    });
    // Dead letter: write to StudioEvent so we don't lose the data silently
    try {
      await prisma.studioEvent.create({
        data: {
          type: 'pipeline:metrics_write_failed',
          source: entry.source,
          payload: JSON.stringify({ ...entry, error: String(e) }),
        },
      });
    } catch { /* last resort — log only */ }
    return false;
  }
}

/**
 * 从 worktree 的 .agent.log 读取会话级缓存指标并写入 PipelineRun。
 * 补充 per-turn 的 parseClaudeUsage —— 这个记录 num_turns 和缓存比。
 */
export function recordAgentSessionFromLog(
  worktree: string,
  sessionId: string,
  phase: MetricEntry['phase'],
  taskName: string,
): void {
  try {
    const fs = require('fs');
    const path = require('path');
    const logPath = path.join(worktree, '.agent.log');
    if (!fs.existsSync(logPath)) return;

    const raw = fs.readFileSync(logPath, 'utf-8');
    const log = JSON.parse(raw);
    const u = log.usage || {};
    const mu = log.modelUsage || {};
    const model = Object.keys(mu)[0] || 'unknown';
    const m = mu[model] || {};

    const inputTokens = m.inputTokens || u.input_tokens || 0;
    const outputTokens = m.outputTokens || u.output_tokens || 0;
    const cacheHitTokens = m.cacheReadInputTokens || u.cache_read_input_tokens || 0;
    const turns = log.num_turns || 0;
    const cost = log.total_cost_usd || 0;

    // 同步写 Prisma（fire-and-forget，不阻塞）
    prisma.pipelineRun.create({
      data: {
        source: 'pipeline',
        phase,
        taskName,
        model,
        inputTokens,
        outputTokens,
        cacheHitTokens,
        durationMs: log.duration_ms || 0,
        success: log.is_error !== true,
        sessionId,
        // 复用 diffLines 存 turns（语义复用，避免 schema 变更）
        diffLines: turns,
      },
    }).then(() => {
      const ratio = inputTokens > 0 ? (cacheHitTokens / inputTokens).toFixed(1) : '0';
      logger.info('[Metrics] Agent session cache', {
        sessionId: sessionId.slice(0, 12),
        phase,
        model,
        turns,
        cacheRatio: `${ratio}x`,
        costUSD: cost.toFixed(3),
      });
    }).catch(e => {
      logger.error('[Metrics] Session log record FAILED', {
        error: String(e), sessionId, phase, taskName, model,
      });
      // Dead letter
      prisma.studioEvent.create({
        data: {
          type: 'pipeline:metrics_write_failed',
          source: 'pipeline',
          payload: JSON.stringify({ sessionId, phase, taskName, model, inputTokens, outputTokens, cacheHitTokens, error: String(e) }),
        },
      }).catch(() => {});
    });
  } catch {
    // non-blocking
  }
}
export async function getComparison(taskName: string): Promise<{
  pipeline?: MetricEntry;
  window?: MetricEntry;
} | null> {
  const runs = await prisma.pipelineRun.findMany({
    where: { taskName },
    orderBy: { createdAt: 'desc' },
  });
  if (runs.length === 0) return null;

  const pipeline = runs.find(r => r.source === 'pipeline');
  const window = runs.find(r => r.source === 'window');

  return {
    pipeline: pipeline ? mapRun(pipeline) : undefined,
    window: window ? mapRun(window) : undefined,
  };
}

export function printComparison(pipeline?: MetricEntry, window?: MetricEntry): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('═══════════════════════════════════════');
  lines.push('  管线 vs 窗口 对比');
  lines.push('═══════════════════════════════════════');
  lines.push('');

  const header = '│ 指标          │ 管线          │ 窗口          │';
  const sep =    '├───────────────┼───────────────┼───────────────┤';
  lines.push(header);
  lines.push(sep);

  const compare = (label: string, pVal: any, wVal: any, fmt?: (v: any) => string) => {
    const f = fmt || ((v: any) => String(v ?? '-'));
    lines.push(`│ ${label.padEnd(13)} │ ${f(pVal).padEnd(13)} │ ${f(wVal).padEnd(13)} │`);
  };

  const formatMs = (ms?: number) => ms ? `${(ms / 1000).toFixed(1)}s` : '-';
  const formatTokens = (t?: number) => t ? `${(t / 1000).toFixed(1)}K` : '-';
  const formatPct = (hit?: number, total?: number) => {
    if (!total || !hit) return '-';
    return `${((hit / total) * 100).toFixed(1)}%`;
  };
  const formatBool = (b?: boolean) => b === true ? '✅' : b === false ? '❌' : '-';

  compare('模型', pipeline?.model, window?.model);
  compare('耗时', pipeline?.durationMs, window?.durationMs, formatMs);
  compare('输入 token', pipeline?.inputTokens, window?.inputTokens, formatTokens);
  compare('输出 token', pipeline?.outputTokens, window?.outputTokens, formatTokens);
  compare('缓存命中', pipeline?.cacheHitTokens, window?.cacheHitTokens, formatTokens);
  compare('缓存命中率',
    pipeline?.inputTokens ? ((pipeline.cacheHitTokens / pipeline.inputTokens) * 100).toFixed(1) + '%' : '-',
    window?.inputTokens ? ((window.cacheHitTokens / window.inputTokens) * 100).toFixed(1) + '%' : '-');
  compare('成功', pipeline?.success, window?.success, formatBool);
  compare('测试通过', pipeline?.testPassed, window?.testPassed, formatBool);
  compare('Lint 通过', pipeline?.lintPassed, window?.lintPassed, formatBool);
  compare('改动行数', pipeline?.diffLines, window?.diffLines);

  lines.push('═══════════════════════════════════════');
  return lines.join('\n');
}

/**
 * 将毫秒转为人类可读格式
 * <60s → Xs, >=60s → XmYs, >=3600s → XhYm
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  if (ms === 0) return '0s';
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
  }
  return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`;
}

/** 单 phase 汇总行 */
export interface PhaseSummaryRow {
  phase: string;
  count: number;
  successRate: number;
  avgDurationMs: number;
  totalTokens: number;
  cacheHitRate: number;
}

/** 总览 */
export interface SummaryOverview {
  totalExecutions: number;
  totalTokens: number;
  avgGoalDurationMs: number;
}

/**
 * 按 phase 聚合最近 24h 的 PipelineRun 数据
 */
export async function getPhaseSummary(): Promise<{ phases: PhaseSummaryRow[]; overview: SummaryOverview }> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const grouped = await prisma.pipelineRun.groupBy({
    by: ['phase'],
    where: { createdAt: { gte: since } },
    _count: { _all: true },
    _avg: { durationMs: true },
    _sum: { inputTokens: true, outputTokens: true, cacheHitTokens: true },
  });

  if (grouped.length === 0) {
    return { phases: [], overview: { totalExecutions: 0, totalTokens: 0, avgGoalDurationMs: 0 } };
  }

  // 成功率 — 额外 groupBy success=true
  const successCounts = await prisma.pipelineRun.groupBy({
    by: ['phase'],
    where: { createdAt: { gte: since }, success: true },
    _count: { _all: true },
  });
  const successMap = new Map(successCounts.map(s => [s.phase, s._count._all]));

  const phases: PhaseSummaryRow[] = grouped.map(g => {
    const inputTokens = g._sum.inputTokens ?? 0;
    const cacheHitTokens = g._sum.cacheHitTokens ?? 0;
    const totalTokensForPhase = inputTokens + (g._sum.outputTokens ?? 0);
    const hitDenom = inputTokens + cacheHitTokens;
    return {
      phase: g.phase,
      count: g._count._all,
      successRate: g._count._all > 0 ? (successMap.get(g.phase) ?? 0) / g._count._all : 0,
      avgDurationMs: g._avg.durationMs ?? 0,
      totalTokens: totalTokensForPhase,
      cacheHitRate: hitDenom > 0 ? cacheHitTokens / hitDenom : 0,
    };
  });

  const totalExecutions = phases.reduce((s, p) => s + p.count, 0);
  const totalTokens = phases.reduce((s, p) => s + p.totalTokens, 0);

  // 平均 goal 耗时: findMany → JS Map group by goalId → 求平均
  const runsWithGoal = await prisma.pipelineRun.findMany({
    where: { createdAt: { gte: since }, goalId: { not: null } },
    select: { goalId: true, durationMs: true },
  });
  const goalDurations = new Map<string, number[]>();
  for (const r of runsWithGoal) {
    if (!r.goalId) continue;
    const arr = goalDurations.get(r.goalId) ?? [];
    arr.push(r.durationMs);
    goalDurations.set(r.goalId, arr);
  }
  const avgGoalDurationMs = goalDurations.size > 0
    ? [...goalDurations.values()].reduce((s, durs) => s + durs.reduce((a, b) => a + b, 0) / durs.length, 0) / goalDurations.size
    : 0;

  return {
    phases,
    overview: { totalExecutions, totalTokens, avgGoalDurationMs },
  };
}

/**
 * 格式化 phase 汇总为表格字符串
 */
export function printSummary(phases: PhaseSummaryRow[], overview: SummaryOverview): string {
  if (phases.length === 0) return 'No pipeline runs in the last 24h';

  const rows = phases.map(p => ({
    'Phase': p.phase,
    'Executions': p.count,
    'Success Rate': `${(p.successRate * 100).toFixed(1)}%`,
    'Avg Duration': formatDuration(p.avgDurationMs),
    'Total Tokens': `${(p.totalTokens / 1000).toFixed(1)}K`,
    'Cache Hit Rate': `${(p.cacheHitRate * 100).toFixed(1)}%`,
  }));

  const table = formatTable(rows);
  const lines = [table, ''];
  lines.push(`Total: ${overview.totalExecutions} executions, ${(overview.totalTokens / 1000).toFixed(1)}K tokens, avg goal ${formatDuration(overview.avgGoalDurationMs)}`);

  return lines.join('\n');
}

function mapRun(r: any): MetricEntry {
  return {
    source: r.source,
    phase: r.phase,
    taskName: r.taskName,
    model: r.model,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cacheHitTokens: r.cacheHitTokens,
    durationMs: r.durationMs,
    success: r.success,
    testPassed: r.testPassed,
    lintPassed: r.lintPassed,
    diffLines: r.diffLines,
    error: r.error,
    sessionId: r.sessionId,
  };
}
