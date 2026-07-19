/**
 * guards.routes — Harness 安全护栏子路由（T-012）
 *
 * 从 routes.ts 提取（T3 大文件拆分，零行为变更），处理器逐字迁移：
 * - POST /check-input   检查输入的提示注入与恶意意图
 * - POST /check-output  检查输出的安全违规
 * - GET  /sandbox       沙箱级别与能力
 */

import { Router, Request, Response } from 'express';
import { logger } from '@dommaker/studio-shared';
import { loadHarness, harnessModule } from './runtime.js';

export const guardsRoutes = Router();

// ─── Safety Guards (T-012) ───

/**
 * POST /api/v1/harness/check-input
 * Check input for prompt injection and malicious intent
 */
guardsRoutes.post('/check-input', async (req: Request, res: Response) => {
  try {
    const loaded = await loadHarness();
    if (!loaded) return res.status(503).json({ error: 'Harness not available' });

    const { input } = req.body;
    if (!input) return res.status(400).json({ error: 'input is required' });

    await loadHarness();
    const guardrail = new harnessModule!.InputGuardrail();
    const result = guardrail.check(input);

    return res.json({ data: result });
  } catch (error) {
    logger.error('Failed to check input', { error: String(error) });
    return res.status(500).json({ error: 'Failed to check input' });
  }
});

/**
 * POST /api/v1/harness/check-output
 * Check output for safety violations
 */
guardsRoutes.post('/check-output', async (req: Request, res: Response) => {
  try {
    const loaded = await loadHarness();
    if (!loaded) return res.status(503).json({ error: 'Harness not available' });

    const { output } = req.body;
    if (!output) return res.status(400).json({ error: 'output is required' });

    await loadHarness();
    const guardrail = new harnessModule!.OutputGuardrail();
    const result = guardrail.check(output);

    return res.json({ data: result });
  } catch (error) {
    logger.error('Failed to check output', { error: String(error) });
    return res.status(500).json({ error: 'Failed to check output' });
  }
});

/**
 * GET /api/v1/harness/sandbox
 * Get sandbox level and capabilities
 */
guardsRoutes.get('/sandbox', async (_req: Request, res: Response) => {
  try {
    const loaded = await loadHarness();
    if (!loaded) return res.status(503).json({ error: 'Harness not available' });

    await loadHarness();
    const sandbox = new harnessModule!.Sandbox();

    return res.json({
      data: {
        level: sandbox.getLevel(),
        description: sandbox.getDescription(),
        needsConfirmation: sandbox.needsConfirmation(),
      },
    });
  } catch (error) {
    logger.error('Failed to get sandbox', { error: String(error) });
    return res.status(500).json({ error: 'Failed to get sandbox' });
  }
});
