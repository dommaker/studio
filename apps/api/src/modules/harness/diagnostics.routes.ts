/**
 * diagnostics.routes — Harness 错误分类子路由（T-016）
 *
 * 从 routes.ts 提取（T3 大文件拆分，零行为变更），处理器逐字迁移：
 * - POST /classify      使用 ErrorClassifier 分类错误（T-016）
 * - POST /failures      记录失败（T-016）
 *
 * /check-spec、/verify、/verify/rules 已随 harness 1.2.0 删除
 * （ADR-0003 孤儿子系统断链，规格检查/规则验证 API 无替代，前端零消费）。
 *
 * 契约驱动迁移（2026-10 批次 6/7）：走 core/http.ts defineRoute——
 * message 必填收进 zod（原手写 400 退役）；错误统一 `{ error: { code, message } }`
 * （503 SERVICE_UNAVAILABLE；500 message 由固定串变为实际错误消息）。
 */

import { Router } from 'express';
import { defineRoute, HttpError } from '../../core/http.js';
import { classifyBodySchema, failureRecordBodySchema } from '@dommaker/studio-contract';
import { loadHarness, harnessModule } from './runtime.js';

export const diagnosticsRoutes = Router();

const HARNESS_UNAVAILABLE = () => new HttpError(503, 'SERVICE_UNAVAILABLE', 'Harness not available');

// ─── Error Classification (T-016) ───

/**
 * POST /api/v1/harness/classify
 * Classify an error using harness ErrorClassifier
 */
diagnosticsRoutes.post('/classify', defineRoute(
  { body: classifyBodySchema },
  async (_req, _res, { body }) => {
    const loaded = await loadHarness();
    if (!loaded) throw HARNESS_UNAVAILABLE();

    const err = new Error(body.message);
    if (body.name) err.name = body.name;
    if (body.stack) err.stack = body.stack;

    const classifier = new (await import('@dommaker/harness')).ErrorClassifier();
    const result = classifier.classify(err);
    const level = classifier.getLevel(result.type);

    return { ...result, level } as Record<string, unknown>;
  },
));

/**
 * POST /api/v1/harness/failures
 * Record a failure
 */
diagnosticsRoutes.post('/failures', defineRoute(
  { body: failureRecordBodySchema },
  async (_req, _res, { body }) => {
    const loaded = await loadHarness();
    if (!loaded) throw HARNESS_UNAVAILABLE();

    // S3 修复：传必需 logFile 参数 + 传 FailureRecord 而非 Error
    // #425：logFile 取 harness 公开常量（口径归一，harness#76）
    const recorder = new harnessModule!.FailureRecorder({
      logFile: harnessModule!.DEFAULT_FAILURE_LOG_FILE,
    });

    // type/level wire 为 string，FailureRecord 词表类型边界收回
    const record = {
      type: body.type || 'unknown',
      level: body.level || 'L1',
      message: String(body.message),
      timestamp: Date.now(),
    } as unknown as import('@dommaker/harness').FailureRecord;
    await recorder.record(record);
    return record as unknown as Record<string, unknown>;
  },
));
