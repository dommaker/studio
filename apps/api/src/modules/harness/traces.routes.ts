/**
 * traces.routes — Harness 执行轨迹采集/分析子路由（T-015）
 *
 * 从 routes.ts 提取（T3 大文件拆分，零行为变更），处理器逐字迁移：
 * - GET  /traces              查询执行轨迹
 * - POST /traces              记录执行轨迹
 * - GET  /analysis            轨迹汇总 + 异常
 * - GET  /analysis/anomalies  检测到的异常列表
 *
 * POST /diagnose 已随 harness 1.2.0 删除（ADR-0003 孤儿子系统断链，
 * 诊断器无替代，前端零消费）；result=bypassed 随 bypass 记录 API
 * 删除改为 400。
 */

import { Router, Request, Response } from 'express';
import { logger } from '@dommaker/studio-shared';
import type { ExecutionTrace, TraceFilter } from '@dommaker/harness';
import { getCollector, getAnalyzer } from './runtime.js';

export const tracesRoutes = Router();

/**
 * traces.log 坏行计数 > 0 时打 warn（harness#82 后读入口不再抛错，
 * 坏行信号只剩 harness#100 透传的 skippedLines，端点日志是唯一保底可见面）。
 * 计数是文件级口径（坏行无 timestamp 可归窗），不要按响应条数反推。
 */
function warnSkippedLines(skippedLines: number, endpoint: string): void {
  if (skippedLines > 0) {
    logger.warn('Trace log has skipped corrupted lines', { skippedLines, endpoint });
  }
}

/**
 * GET /api/v1/harness/traces
 * Query execution traces
 */
tracesRoutes.get('/traces', async (req: Request, res: Response) => {
  try {
    const c = await getCollector();
    if (!c) return res.status(503).json({ error: 'Harness not available' });

    const { constraintId, severity, result, hours, limit } = req.query;
    const filter: TraceFilter = {};
    if (constraintId) filter.constraintId = constraintId as string;
    if (severity) filter.severity = severity as ExecutionTrace['severity'];
    if (result) filter.result = result as ExecutionTrace['result'];
    if (hours) {
      const h = Number(hours);
      filter.timeRange = { start: Date.now() - h * 3600_000, end: Date.now() };
    }

    const traces = c.read(filter);
    const limited = traces.slice(0, Number(limit) || 100);
    return res.json({ data: limited, total: traces.length });
  } catch (error) {
    logger.error('Failed to query traces', { error: String(error) });
    return res.status(500).json({ error: 'Failed to query traces' });
  }
});

/**
 * POST /api/v1/harness/traces
 * Record an execution trace
 */
tracesRoutes.post('/traces', async (req: Request, res: Response) => {
  try {
    const c = await getCollector();
    if (!c) return res.status(503).json({ error: 'Harness not available' });

    const { constraintId, severity, result, operation, projectPath, sessionId, userAction } = req.body;
    if (!constraintId || !severity || !result) {
      return res.status(400).json({ error: 'constraintId, severity, and result are required' });
    }

    const trace = {
      constraintId,
      severity,
      timestamp: Date.now(),
      result,
      operation,
      projectPath,
      sessionId,
      userAction,
    };

    if (result === 'pass') c.recordPass(constraintId, severity, trace);
    else if (result === 'fail') c.recordFail(constraintId, severity, trace);
    else if (result === 'bypassed') {
      return res.status(400).json({ error: 'bypassed traces are no longer supported (harness 1.2.0 removed recordBypass)' });
    }

    return res.json({ recorded: true });
  } catch (error) {
    logger.error('Failed to record trace', { error: String(error) });
    return res.status(500).json({ error: 'Failed to record trace' });
  }
});

/**
 * GET /api/v1/harness/analysis
 * Get trace summaries and anomalies
 */
tracesRoutes.get('/analysis', async (req: Request, res: Response) => {
  try {
    const a = await getAnalyzer();
    if (!a) return res.status(503).json({ error: 'Harness not available' });

    const hours = Number(req.query.hours) || 24;
    // harness#100 报告入口：带坏行计数（兼容签名 analyzeRecent 会丢计数）
    const { summaries, skippedLines } = a.analyzeRecentReport(hours);
    warnSkippedLines(skippedLines, '/analysis');
    const anomalies = a.detectAnomalies(summaries);

    return res.json({
      summaries,
      anomalies,
      totalSummaries: summaries.length,
      totalAnomalies: anomalies.length,
      skippedLines,
    });
  } catch (error) {
    logger.error('Failed to analyze traces', { error: String(error) });
    return res.status(500).json({ error: 'Failed to analyze traces' });
  }
});

/**
 * GET /api/v1/harness/analysis/anomalies
 * List detected anomalies
 */
tracesRoutes.get('/analysis/anomalies', async (req: Request, res: Response) => {
  try {
    const a = await getAnalyzer();
    if (!a) return res.status(503).json({ error: 'Harness not available' });

    const hours = Number(req.query.hours) || 24;
    const { summaries, skippedLines } = a.analyzeRecentReport(hours);
    warnSkippedLines(skippedLines, '/analysis/anomalies');
    const anomalies = a.detectAnomalies(summaries);

    return res.json({ data: anomalies, total: anomalies.length, skippedLines });
  } catch (error) {
    logger.error('Failed to get anomalies', { error: String(error) });
    return res.status(500).json({ error: 'Failed to get anomalies' });
  }
});
