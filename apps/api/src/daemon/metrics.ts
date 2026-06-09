// Pipeline Metrics — 管线 vs 窗口对比
import { prisma } from '@dommaker/studio-prisma';
import { logger } from '@dommaker/studio-shared';

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
  try {
    // Claude Code JSON output: { result, usage: { input_tokens, output_tokens, cache_read_input_tokens } }
    const parsed = JSON.parse(stdout);
    const u = parsed.usage || {};
    return {
      inputTokens: u.input_tokens || 0,
      outputTokens: u.output_tokens || 0,
      cacheHitTokens: u.cache_read_input_tokens || u.cache_creation_input_tokens || 0,
    };
  } catch {
    // Fallback: try to find usage in non-JSON output
    const inputMatch = stdout.match(/input_tokens[:\s]+(\d+)/i);
    const outputMatch = stdout.match(/output_tokens[:\s]+(\d+)/i);
    const cacheMatch = stdout.match(/cache_read_input_tokens[:\s]+(\d+)/i);
    return {
      inputTokens: inputMatch ? parseInt(inputMatch[1]) : 0,
      outputTokens: outputMatch ? parseInt(outputMatch[1]) : 0,
      cacheHitTokens: cacheMatch ? parseInt(cacheMatch[1]) : 0,
    };
  }
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
