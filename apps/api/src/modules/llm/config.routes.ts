/**
 * LLM Config API 路由
 *
 * GET    /api/v1/llm/config — 获取所有配置（脱敏）
 * GET    /api/v1/llm/config/:scope — 获取指定 scope 的配置
 * POST   /api/v1/llm/config — 保存/更新配置
 * DELETE /api/v1/llm/config/:id — 删除配置
 * POST   /api/v1/llm/config/:scope/test — 测试连通性
 */

import { Router, Request, Response } from 'express';
import { llmConfigService } from './config.service.js';
import { logger } from '@dommaker/studio-shared';

const router = Router();

/**
 * GET /api/v1/llm/config
 * 获取所有配置（脱敏）
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const scope = req.query.scope as string | undefined;
    const configs = await llmConfigService.getConfigs(scope);
    return res.json({ data: configs });
  } catch (error) {
    logger.error('[LLM Config API] List failed', { error: String(error) });
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list configs' } });
  }
});

/**
 * POST /api/v1/llm/config
 * 保存/更新配置
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { scope, provider, baseUrl, apiKey, model, options } = req.body;

    if (!scope || !provider || !apiKey || !model) {
      return res.status(400).json({
        error: { code: 'VALIDATION', message: 'scope, provider, apiKey, model are required' },
      });
    }

    const validScopes = ['orchestrator', 'agent_codex', 'agent_claude', 'agent_opencode', 'agent_default', 'studio'];
    if (!validScopes.includes(scope)) {
      return res.status(400).json({
        error: { code: 'VALIDATION', message: `scope must be one of: ${validScopes.join(', ')}` },
      });
    }

    const config = await llmConfigService.saveConfig({ scope, provider, baseUrl, apiKey, model, options });
    return res.json(config);
  } catch (error) {
    logger.error('[LLM Config API] Save failed', { error: String(error) });
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to save config' } });
  }
});

/**
 * POST /api/v1/llm/config/:scope/test
 * 测试连通性
 */
router.post('/:scope/test', async (req: Request, res: Response) => {
  try {
    const { scope } = req.params;
    const result = await llmConfigService.testConfig(scope as any);
    return res.json(result);
  } catch (error) {
    logger.error('[LLM Config API] Test failed', { error: String(error) });
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Test failed' } });
  }
});

/**
 * DELETE /api/v1/llm/config/:id
 */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    await llmConfigService.deleteConfig(req.params.id);
    return res.json({ success: true });
  } catch (error) {
    logger.error('[LLM Config API] Delete failed', { error: String(error) });
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to delete config' } });
  }
});

export default router;
