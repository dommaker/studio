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

export async function recordWindowRun(entry: Omit<MetricEntry, 'source' | 'sessionId'>): Promise<void> {
  return recordPipelineRun({ ...entry, source: 'window' });
}

export async function recordPipelineRun(entry: MetricEntry): Promise<void> {
  try {
    await prisma.pipelineRun.create({ data: entry });
    logger.info('[Metrics] Recorded', {
      source: entry.source,
      phase: entry.phase,
      model: entry.model,
      inputTokens: entry.inputTokens,
      cacheHitTokens: entry.cacheHitTokens,
      durationMs: entry.durationMs,
    });
  } catch (e) {
    logger.warn('[Metrics] Failed to record', { error: String(e) });
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
