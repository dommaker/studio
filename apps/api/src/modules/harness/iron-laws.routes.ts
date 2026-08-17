// Iron Laws API — 从 runtime-proxy 迁移 (2026-05-14)；#150 A5 起直连 harness（ConstraintService facade 退役）
import { Router } from 'express';
import { logger } from '@dommaker/studio-shared';
import { getAllConstraints, getConstraint, checkConstraint, checkConstraints } from '@dommaker/harness';
import type { IronLawContext } from '@dommaker/harness';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    const laws = getAllConstraints();
    res.json({ success: true, data: laws, count: laws.length, source: 'harness' });
  } catch (error) {
    logger.error('[IronLaws] Failed to list', { error: String(error) });
    res.status(500).json({ success: false, error: { code: 'IRON_LAWS_ERROR', message: '获取铁律失败' } });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const law = getConstraint(req.params.id);
    if (!law) return res.status(404).json({ success: false, error: { code: 'IRON_LAW_NOT_FOUND', message: `铁律 ${req.params.id} 不存在` } });
    res.json({ success: true, data: law, source: 'harness' });
  } catch (error) {
    logger.error(`[IronLaws] Failed to get ${req.params.id}`, { error: String(error) });
    res.status(500).json({ success: false, error: { code: 'IRON_LAW_ERROR', message: '获取铁律失败' } });
  }
});

router.post('/check', async (req, res) => {
  try {
    const { lawId, context } = req.body as { lawId: string | string[]; context: IronLawContext };
    if (!lawId) return res.status(400).json({ success: false, error: { code: 'MISSING_LAW_ID', message: '缺少 lawId 参数' } });
    if (!context) return res.status(400).json({ success: false, error: { code: 'MISSING_CONTEXT', message: '缺少 context 参数' } });

    if (Array.isArray(lawId)) {
      const results: Record<string, unknown> = {};
      for (const id of lawId) {
        results[id] = await checkConstraint(id, context);
      }
      res.json({ success: true, data: results, source: 'harness' });
    } else {
      const result = await checkConstraint(lawId, context);
      res.json({ success: true, data: result, source: 'harness' });
    }
  } catch (error) {
    logger.error('[IronLaws] Check failed', { error: String(error) });
    res.status(500).json({ success: false, error: { code: 'IRON_LAW_CHECK_ERROR', message: '铁律检查失败' } });
  }
});

router.post('/check-all', async (req, res) => {
  try {
    const { context } = req.body as { context: IronLawContext };
    if (!context) return res.status(400).json({ success: false, error: { code: 'MISSING_CONTEXT', message: '缺少 context 参数' } });
    const results = await checkConstraints(context);
    res.json({ success: true, data: results, source: 'harness' });
  } catch (error) {
    logger.error('[IronLaws] Check-all failed', { error: String(error) });
    res.status(500).json({ success: false, error: { code: 'IRON_LAW_CHECK_ERROR', message: '铁律检查失败' } });
  }
});

export default router;
