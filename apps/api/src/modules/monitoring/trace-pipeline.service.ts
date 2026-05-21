/**
 * TracePipelineService — ⑨ 修复
 *
 * 将 TraceCollector/TraceAnalyzer 从 REST-only 变为执行流自动分析。
 * Goal/Execution 完成后自动运行分析，异常推送 MonitorAgent 告警。
 */

import { logger } from '@dommaker/studio-shared';
import type {
  ExecutionTrace,
  TraceAnalyzer,
  TraceCollector,
  TraceAnomaly,
} from '@dommaker/harness';

export interface TracePipelineResult {
  goalId: string;
  analyzedAt: number;
  totalTraces: number;
  anomalies: TraceAnomaly[];
  summary: {
    passCount: number;
    failCount: number;
    bypassCount: number;
    constraintsChecked: number;
  };
}

export class TracePipelineService {
  private collector: TraceCollector | null = null;
  private analyzer: TraceAnalyzer | null = null;

  setCollector(collector: TraceCollector): void {
    this.collector = collector;
  }

  setAnalyzer(analyzer: TraceAnalyzer): void {
    this.analyzer = analyzer;
  }

  /**
   * Goal 完成后的全量 trace 分析
   */
  async analyzeAfterGoalComplete(goalId: string): Promise<TracePipelineResult | null> {
    if (!this.collector || !this.analyzer) {
      logger.warn('[TracePipeline] Collector or Analyzer not initialized, skipping');
      return null;
    }

    try {
      // 查询最近 24h 的 trace
      const traces = this.collector.read({
        start: Date.now() - 24 * 3600_000,
        end: Date.now(),
      });

      if (traces.length === 0) {
        return {
          goalId,
          analyzedAt: Date.now(),
          totalTraces: 0,
          anomalies: [],
          summary: { passCount: 0, failCount: 0, bypassCount: 0, constraintsChecked: 0 },
        };
      }

      // 运行分析
      const summaries = this.analyzer.analyzeRecent(24);
      const anomalies = this.analyzer.detectAnomalies(summaries);

      // 统计
      const passCount = traces.filter(t => t.result === 'pass').length;
      const failCount = traces.filter(t => t.result === 'fail').length;
      const bypassCount = traces.filter(t => t.result === 'bypass' || t.result === 'bypassed').length;
      const constraintsChecked = new Set(traces.map(t => t.constraintId)).size;

      const result: TracePipelineResult = {
        goalId,
        analyzedAt: Date.now(),
        totalTraces: traces.length,
        anomalies,
        summary: { passCount, failCount, bypassCount, constraintsChecked },
      };

      logger.info('[TracePipeline] Analysis complete', {
        goalId,
        traces: traces.length,
        anomalies: anomalies.length,
        constraintsChecked,
      });

      return result;
    } catch (err) {
      logger.error('[TracePipeline] Analysis failed', { goalId, error: String(err) });
      return null;
    }
  }

  /**
   * 检查是否有需要告警的异常
   */
  async getAlerts(result: TracePipelineResult): Promise<Array<{ level: 'warning' | 'critical'; message: string }>> {
    const alerts: Array<{ level: 'warning' | 'critical'; message: string }> = [];

    if (result.anomalies.length > 0) {
      for (const anomaly of result.anomalies) {
        alerts.push({
          level: anomaly.severity === 'high' ? 'critical' : 'warning',
          message: `Trace anomaly: ${anomaly.constraintId} — ${anomaly.description || 'unexpected pattern'}`,
        });
      }
    }

    // 高失败率告警
    if (result.totalTraces > 0) {
      const failRate = result.summary.failCount / result.totalTraces;
      if (failRate > 0.5) {
        alerts.push({
          level: 'critical',
          message: `High constraint failure rate: ${(failRate * 100).toFixed(0)}% (${result.summary.failCount}/${result.totalTraces})`,
        });
      }
    }

    // ⑱: Cross-executor error detection
    try {
      const crossErrors = await this.detectCrossExecutorErrors(result.goalId);
      for (const err of crossErrors) {
        alerts.push({
          level: 'warning',
          message: `Cross-executor: ${err.constraintId} failed in ${err.executionCount} executions — ${err.pattern}`,
        });
      }
    } catch {
      // non-blocking
    }

    return alerts;
  }

  /**
   * ⑱: 检测同 Goal 内跨并行 Executor 的同类错误模式
   */
  async detectCrossExecutorErrors(goalId: string): Promise<
    Array<{ constraintId: string; executionCount: number; pattern: string }>
  > {
    if (!this.collector) return [];

    try {
      const traces = this.collector.read({
        start: Date.now() - 24 * 3600_000, end: Date.now(),
      });

      // 筛选 fail traces，按 constraintId 分组
      const byConstraint = new Map<string, ExecutionTrace[]>();
      for (const t of traces) {
        if (t.result !== 'fail') continue;
        const id = t.constraintId;
        if (!byConstraint.has(id)) byConstraint.set(id, []);
        byConstraint.get(id)!.push(t);
      }

      const results: Array<{ constraintId: string; executionCount: number; pattern: string }> = [];
      for (const [constraintId, group] of byConstraint) {
        // 同一约束在 ≥2 个 execution 中失败 → 跨 executor 模式
        const executionIds = new Set(group.map(t => (t as any).executionId || (t as any).sessionId).filter(Boolean));
        if (executionIds.size >= 2) {
          results.push({
            constraintId,
            executionCount: executionIds.size,
            pattern: `Same constraint failed across ${executionIds.size} parallel executors`,
          });
        }
      }

      if (results.length > 0) {
        logger.warn('[TracePipeline] Cross-executor errors detected', { goalId, patterns: results.length });
      }

      return results;
    } catch {
      return [];
    }
  }
}

export const tracePipeline = new TracePipelineService();
