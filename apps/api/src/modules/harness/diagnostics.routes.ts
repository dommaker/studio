/**
 * diagnostics.routes — Harness 错误分类/规格检查/验证循环子路由（T-016 / T-018 / T-013）
 *
 * 从 routes.ts 提取（T3 大文件拆分，零行为变更），处理器逐字迁移：
 * - POST /classify      使用 ErrorClassifier 分类错误（T-016）
 * - POST /failures      记录失败（T-016）
 * - POST /check-spec    检查文件/目录的 @spec 标注（T-018）
 * - POST /verify        对变更文件运行验证规则（T-013）
 * - GET  /verify/rules  可用验证规则列表（T-013）
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

// ─── Spec Checking (T-018) ───

/**
 * POST /api/v1/harness/check-spec
 * Check file or directory for @spec annotations
 */
diagnosticsRoutes.post('/check-spec', async (req: Request, res: Response) => {
  try {
    const loaded = await loadHarness();
    if (!loaded) return res.status(503).json({ error: 'Harness not available' });

    const { filePath, dirPath } = req.body;
    if (!filePath && !dirPath) {
      return res.status(400).json({ error: 'filePath or dirPath is required' });
    }

    await loadHarness();

    if (filePath) {
      const result = harnessModule!.checkFile(filePath);
      return res.json({ data: result });
    }

    const results = harnessModule!.checkDirectory(dirPath || process.cwd());
    const report = harnessModule!.generateReport(results);
    const totalErrors = results.reduce((sum: number, r: { errors: unknown[]; warnings: unknown[] }) => sum + r.errors.length, 0);
    const totalWarnings = results.reduce((sum: number, r: { errors: unknown[]; warnings: unknown[] }) => sum + r.warnings.length, 0);

    return res.json({
      data: results,
      report,
      totalFiles: results.length,
      totalErrors,
      totalWarnings,
    });
  } catch (error) {
    logger.error('Failed to check spec annotations', { error: String(error) });
    return res.status(500).json({ error: 'Failed to check spec annotations' });
  }
});

// ─── Verification Loop (T-013) ───

/**
 * POST /api/v1/harness/verify
 * Run verification rules on changed files
 */
diagnosticsRoutes.post('/verify', async (req: Request, res: Response) => {
  try {
    const loaded = await loadHarness();
    if (!loaded) return res.status(503).json({ error: 'Harness not available' });

    const { rules, projectRoot, changedFiles } = req.body;
    if (!rules || !Array.isArray(rules)) {
      return res.status(400).json({ error: 'rules array is required' });
    }

    await loadHarness();
    const verifier = new harnessModule!.RulesBasedVerification(rules);

    const context = {
      projectRoot: projectRoot || process.cwd(),
      changedFiles: changedFiles || [],
    };

    const results = await verifier.verifyAll(context);
    const allPassed = results.every((r: { passed: boolean }) => r.passed);

    return res.json({ data: results, passed: allPassed, total: results.length });
  } catch (error) {
    logger.error('Failed to run verification', { error: String(error) });
    return res.status(500).json({ error: 'Failed to run verification' });
  }
});

/**
 * GET /api/v1/harness/verify/rules
 * List available verification rules
 */
diagnosticsRoutes.get('/verify/rules', async (_req: Request, res: Response) => {
  try {
    const loaded = await loadHarness();
    if (!loaded) return res.status(503).json({ error: 'Harness not available' });

    // Return default rule types
    return res.json({
      data: [
        { type: 'test', description: 'Run test suite', command: 'pnpm test' },
        { type: 'lint', description: 'Run linter', command: 'pnpm lint' },
        { type: 'typecheck', description: 'TypeScript check', command: 'npx tsc --noEmit' },
        { type: 'custom', description: 'Custom verification function' },
      ],
    });
  } catch (error) {
    logger.error('Failed to list rules', { error: String(error) });
    return res.status(500).json({ error: 'Failed to list rules' });
  }
});
