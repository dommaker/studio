/**
 * DataAnalyst Agent — 每日数据分析 (LLM)
 *
 * 消费原始指标 + 各 Agent 产出，产出数据分析报告。
 * 不做事，只分析。
 *
 * 触发: 每 24h (AuditorAgent 之后 30min)
 * 产出: StudioEvent `knowledge:data_analysis`
 */

import { prisma } from '@dommaker/studio-prisma';
import { logger, modelGateway } from '@dommaker/studio-shared';
import { OKRService } from '../pmo/okr.service.js';

const ANALYSIS_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
const INITIAL_DELAY_MS = 35 * 60 * 1000; // 35min (after AuditorAgent)

// ── Types ──

export interface DataAnalysisReport {
  date: string;
  metrics: Record<string, number | null>;
  analysis: {
    trends: TrendItem[];
    rootCauses: RootCause[];
    recommendations: Recommendation[];
    anomalies: Anomaly[];
  };
  metadata: {
    durationMs: number;
    tokensUsed: number;
    model: string;
    dataPoints: number;
  };
}

export interface TrendItem {
  metric: string;
  direction: 'up' | 'down' | 'stable';
  significance: 'high' | 'medium' | 'low';
  description: string;
}

export interface RootCause {
  effect: string;
  cause: string;
  confidence: 'high' | 'medium' | 'low';
  evidence: string[];
}

export interface Recommendation {
  priority: 'P0' | 'P1' | 'P2';
  action: string;
  expectedImpact: string;
  relatedMetrics: string[];
}

export interface Anomaly {
  metric: string;
  expected: number;
  actual: number;
  deviation: number;
  description: string;
}

// ── Agent ──

class DataAnalystAgent {
  private interval: NodeJS.Timeout | null = null;
  /** @internal exposed for testing */
  okrService = new OKRService();

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => this.analyze(), ANALYSIS_INTERVAL_MS);
    setTimeout(() => this.analyze(), INITIAL_DELAY_MS);
    logger.info('[DataAnalyst] Started', { interval: '24h', initialDelay: '35min' });
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    logger.info('[DataAnalyst] Stopped');
  }

  async analyze(): Promise<DataAnalysisReport | null> {
    const start = Date.now();
    try {
      logger.info('[DataAnalyst] Starting daily analysis');

      // 1. Collect data
      const metrics = await this.collectMetrics();
      const events = await this.collectRecentEvents();
      const runs = await this.collectRecentRuns();

      // 2. Build prompt
      const prompt = this.buildPrompt(metrics, events, runs);

      // 3. LLM analysis
      const analysis = await modelGateway.promptJson<DataAnalysisReport['analysis']>(
        prompt,
        '你是 Studio 管线的数据分析师。基于数据找趋势、根因、建议。输出严格 JSON。',
      );

      // 4. Build report
      const report: DataAnalysisReport = {
        date: new Date().toISOString().slice(0, 10),
        metrics,
        analysis: analysis || { trends: [], rootCauses: [], recommendations: [], anomalies: [] },
        metadata: {
          durationMs: Date.now() - start,
          tokensUsed: 0, // modelGateway doesn't expose token count
          model: 'standard',
          dataPoints: events.length + runs.length,
        },
      };

      // 5. Store
      await this.storeReport(report);

      logger.info('[DataAnalyst] Analysis complete', {
        durationMs: report.metadata.durationMs,
        trends: report.analysis.trends.length,
        recommendations: report.analysis.recommendations.length,
      });

      return report;
    } catch (err) {
      logger.warn('[DataAnalyst] Analysis failed (non-blocking)', { error: String(err) });
      return null;
    }
  }

  // ── Data Collection ──

  async collectMetrics(): Promise<Record<string, number | null>> {
    const metrics: Record<string, number | null> = {};
    for (const metricType of Object.keys(OKRService.METRIC_REGISTRY)) {
      try {
        metrics[metricType] = await this.okrService.getMetricBaseline(metricType);
      } catch {
        metrics[metricType] = null;
      }
    }
    return metrics;
  }

  async collectRecentEvents(): Promise<Array<{ type: string; source: string; timestamp: Date; payload: string }>> {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    return prisma.studioEvent.findMany({
      where: { timestamp: { gte: yesterday } },
      orderBy: { timestamp: 'desc' },
      take: 200,
      select: { type: true, source: true, timestamp: true, payload: true },
    });
  }

  async collectRecentRuns(): Promise<Array<{ phase: string; taskName: string; model: string; success: boolean; durationMs: number; inputTokens: number; outputTokens: number }>> {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    return prisma.pipelineRun.findMany({
      where: { createdAt: { gte: yesterday } },
      orderBy: { createdAt: 'desc' },
      select: { phase: true, taskName: true, model: true, success: true, durationMs: true, inputTokens: true, outputTokens: true },
    });
  }

  // ── Prompt ──

  private buildPrompt(
    metrics: Record<string, number | null>,
    events: Array<{ type: string; source: string; timestamp: Date; payload: string }>,
    runs: Array<{ phase: string; taskName: string; model: string; success: boolean; durationMs: number; inputTokens: number; outputTokens: number }>,
  ): string {
    // Summarize events by type
    const eventsByType: Record<string, number> = {};
    for (const e of events) {
      eventsByType[e.type] = (eventsByType[e.type] || 0) + 1;
    }

    // Summarize runs
    const totalRuns = runs.length;
    const succeededRuns = runs.filter(r => r.success).length;
    const totalTokens = runs.reduce((s, r) => s + r.inputTokens + r.outputTokens, 0);
    const avgDuration = totalRuns > 0 ? Math.round(runs.reduce((s, r) => s + r.durationMs, 0) / totalRuns) : 0;

    return [
      '分析以下 Studio 管线 24h 数据，产出结构化报告。',
      '',
      '## 当前指标 (metricType → 值)',
      JSON.stringify(metrics, null, 2),
      '',
      '## 事件统计 (type → count)',
      JSON.stringify(eventsByType, null, 2),
      '',
      '## 管线运行摘要',
      `- 总运行: ${totalRuns}, 成功: ${succeededRuns}, 成功率: ${totalRuns > 0 ? Math.round(succeededRuns / totalRuns * 100) : 0}%`,
      `- 总 token: ${totalTokens}, 平均耗时: ${avgDuration}ms`,
      '',
      '## 分析要求',
      '1. trends: 哪些指标值得关注？方向(up/down/stable)和重要性(high/medium/low)',
      '2. rootCauses: 异常指标的可能原因，附证据',
      '3. recommendations: 优先级(P0/P1/P2)排序的改进行动',
      '4. anomalies: 偏离预期的指标',
      '',
      '返回 JSON: {"trends":[], "rootCauses":[], "recommendations":[], "anomalies":[]}',
    ].join('\n');
  }

  // ── Storage ──

  private async storeReport(report: DataAnalysisReport): Promise<void> {
    try {
      await prisma.studioEvent.create({
        data: {
          type: 'knowledge:data_analysis',
          source: 'data-analyst',
          payload: JSON.stringify(report),
        },
      });
    } catch (err) {
      logger.warn('[DataAnalyst] Failed to store report', { error: String(err) });
    }
  }
}

export const dataAnalystAgent = new DataAnalystAgent();
