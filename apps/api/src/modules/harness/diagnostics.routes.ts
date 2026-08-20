/**
 * diagnostics.routes — Harness 错误分类子路由（T-016）
 *
 * 从 routes.ts 提取（T3 大文件拆分，零行为变更），处理器逐字迁移：
 * - POST /classify      使用 ErrorClassifier 分类错误（T-016）
 * - POST /failures      记录失败（T-016）
 *
 * /check-spec、/verify、/verify/rules 已随 harness 1.2.0 删除
 * （ADR-0003 孤儿子系统断链，规格检查/规则验证 API 无替代，前端零消费）。
 */

import { Router, Request, Response } from 'express';
import { logger } from '@dommaker/studio-shared';
import { loadHarness, harnessModule } from './runtime.js';

export const diagnosticsRoutes = Router();

// ─── Error Classification (T-016) ───

/**
 * POST /api/v1/harness/classify
 * Classify an error using harness ErrorClassifier
 */
diagnosticsRoutes.post('/classify', async (req: Request, res: Response) => {
  try {
    const loaded = await loadHarness();
    if (!loaded) return res.status(503).json({ error: 'Harness not available' });

    const { message, name, stack, context } = req.body;
    if (!message) return res.status(400).json({ error: 'message is required' });

    const err = new Error(message);
    if (name) err.name = name;
    if (stack) err.stack = stack;

    const classifier = new (await import('@dommaker/harness')).ErrorClassifier();
    const result = classifier.classify(err);
    const level = classifier.getLevel(result.type);

    return res.json({ data: { ...result, level } });
  } catch (error) {
    logger.error('Failed to classify error', { error: String(error) });
    return res.status(500).json({ error: 'Failed to classify error' });
  }
});

/**
 * POST /api/v1/harness/failures
 * Record a failure
 */
diagnosticsRoutes.post('/failures', async (req: Request, res: Response) => {
  try {
    const loaded = await loadHarness();
    if (!loaded) return res.status(503).json({ error: 'Harness not available' });

    const { type, level, message, context } = req.body;
    if (!message) return res.status(400).json({ error: 'message is required' });

    await loadHarness();
    // S3 修复：传必需 logFile 参数 + 传 FailureRecord 而非 Error
    const recorder = new harnessModule!.FailureRecorder({
      logFile: '.harness/logs/failures.log',
    });

    const record: import('@dommaker/harness').FailureRecord = {
      type: type || 'unknown',
      level: level || 'L1',
      message: String(message),
      timestamp: Date.now(),
    };
    await recorder.record(record);
    return res.json({ data: record });
  } catch (error) {
    logger.error('Failed to record failure', { error: String(error) });
    return res.status(500).json({ error: 'Failed to record failure' });
  }
});
