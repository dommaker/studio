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
 *
 * 契约驱动迁移（2026-10 批次 6/7）：走 core/http.ts defineRoute——
 * constraintId/severity/result 必填收进 zod（原手写 400 退役，文案变 zod 格式；
 * result=bypassed 的专属 400 文案保留 handler 显式判）；列表壳内层 data 键
 * 改名词键进 `{ data }` 壳（`{ data, total }` → `{ data: { traces, total } }`，
 * 避免 data.data 双包，无消费方）；错误统一 `{ error: { code, message } }`
 * （503 code SERVICE_UNAVAILABLE；500 message 由固定串变为实际错误消息）。
 */

import { Router } from 'express';
import { logger } from '@dommaker/studio-shared';
import { defineRoute, HttpError } from '../../core/http.js';
import {
  tracesQuerySchema,
  traceRecordBodySchema,
  traceAnalysisQuerySchema,
} from '@dommaker/studio-contract';
import type { ExecutionTrace, TraceFilter } from '@dommaker/harness';
import { getCollector, getAnalyzer } from './runtime.js';

export const tracesRoutes = Router();

const HARNESS_UNAVAILABLE = () => new HttpError(503, 'SERVICE_UNAVAILABLE', 'Harness not available');

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
tracesRoutes.get('/traces', defineRoute(
  { query: tracesQuerySchema },
  async (_req, _res, { query }) => {
    const c = await getCollector();
    if (!c) throw HARNESS_UNAVAILABLE();

    const filter: TraceFilter = {};
    if (query.constraintId) filter.constraintId = query.constraintId;
    if (query.severity) filter.severity = query.severity as ExecutionTrace['severity'];
    if (query.result) filter.result = query.result as ExecutionTrace['result'];
    if (query.hours) {
      const h = Number(query.hours);
      filter.timeRange = { start: Date.now() - h * 3600_000, end: Date.now() };
    }

    const traces = c.read(filter);
    const limited = traces.slice(0, Number(query.limit) || 100);
    return { traces: limited, total: traces.length };
  },
));

/**
 * POST /api/v1/harness/traces
 * Record an execution trace
 */
tracesRoutes.post('/traces', defineRoute(
  { body: traceRecordBodySchema },
  async (_req, _res, { body }) => {
    const c = await getCollector();
    if (!c) throw HARNESS_UNAVAILABLE();

    // bypass 记录 API 已随 harness 1.2.0 删除（专属文案保留，不进 zod 词表拒绝）
    if (body.result === 'bypassed') {
      throw new HttpError(400, 'BAD_REQUEST', 'bypassed traces are no longer supported (harness 1.2.0 removed recordBypass)');
    }

    // severity wire 为 string，ExecutionTrace/collector 词表类型边界收回
    // （userAction 非 ExecutionTrace 字段但历史随 trace 落盘，as 保留运行时形状）
    const severity = body.severity as 'error' | 'warning';
    const trace = {
      constraintId: body.constraintId,
      severity: body.severity as ExecutionTrace['severity'],
      timestamp: Date.now(),
      result: body.result,
      operation: body.operation,
      projectPath: body.projectPath,
      sessionId: body.sessionId,
      userAction: body.userAction,
    } as Partial<ExecutionTrace>;

    if (body.result === 'pass') c.recordPass(body.constraintId, severity, trace);
    else if (body.result === 'fail') c.recordFail(body.constraintId, severity, trace);

    return { recorded: true };
  },
));

/**
 * GET /api/v1/harness/analysis
 * Get trace summaries and anomalies
 */
tracesRoutes.get('/analysis', defineRoute(
  { query: traceAnalysisQuerySchema },
  async (_req, _res, { query }) => {
    const a = await getAnalyzer();
    if (!a) throw HARNESS_UNAVAILABLE();

    const hours = Number(query.hours) || 24;
    // harness#100 报告入口：带坏行计数（兼容签名 analyzeRecent 会丢计数）
    const { summaries, skippedLines } = a.analyzeRecentReport(hours);
    warnSkippedLines(skippedLines, '/analysis');
    const anomalies = a.detectAnomalies(summaries);

    return {
      summaries,
      anomalies,
      totalSummaries: summaries.length,
      totalAnomalies: anomalies.length,
      skippedLines,
    };
  },
));

/**
 * GET /api/v1/harness/analysis/anomalies
 * List detected anomalies
 */
tracesRoutes.get('/analysis/anomalies', defineRoute(
  { query: traceAnalysisQuerySchema },
  async (_req, _res, { query }) => {
    const a = await getAnalyzer();
    if (!a) throw HARNESS_UNAVAILABLE();

    const hours = Number(query.hours) || 24;
    const { summaries, skippedLines } = a.analyzeRecentReport(hours);
    warnSkippedLines(skippedLines, '/analysis/anomalies');
    const anomalies = a.detectAnomalies(summaries);

    return { anomalies, total: anomalies.length, skippedLines };
  },
));
