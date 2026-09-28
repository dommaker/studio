// Iron Laws API — 从 runtime-proxy 迁移 (2026-05-14)；#150 A5 起直连 harness（ConstraintService facade 退役）
import { Router } from 'express';
import { logger } from '@dommaker/studio-shared';
import { getAllConstraints, getConstraint, checkConstraint, checkConstraints, ConstraintViolationError } from '@dommaker/harness';
import type { ConstraintContext } from '@dommaker/harness';
import { sanitizeConstraintContext, downgradeAnnotation, degradedChecksOf, violationAsPartialView, VIOLATION_PARTIAL_VIEW } from './sanitize-context.js';

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
  // 单约束面：checkConstraint(id) 返回 ConstraintResult 不抛（即抛即停只属于
  // checkConstraints 的 block 编排），违规天然走数据面——下方 catch 仅收真实故障
  try {
    const { lawId, context } = req.body as { lawId: string | string[]; context: ConstraintContext };
    if (!lawId) return res.status(400).json({ success: false, error: { code: 'MISSING_LAW_ID', message: '缺少 lawId 参数' } });
    if (!context) return res.status(400).json({ success: false, error: { code: 'MISSING_CONTEXT', message: '缺少 context 参数' } });
    // #641：剥离请求体自报的证据标志（has*），依赖项降级 skip（见 sanitize-context.ts）
    const sanitized = sanitizeConstraintContext(context);
    const downgrade = downgradeAnnotation(sanitized.strippedFlags);

    if (Array.isArray(lawId)) {
      const results: Record<string, unknown> = {};
      for (const id of lawId) {
        results[id] = await checkConstraint(id, sanitized.context);
      }
      res.json({ success: true, data: results, source: 'harness', ...downgrade });
    } else {
      const result = await checkConstraint(lawId, sanitized.context);
      res.json({ success: true, data: result, source: 'harness', ...downgrade });
    }
  } catch (error) {
    logger.error('[IronLaws] Check failed', { error: String(error) });
    res.status(500).json({ success: false, error: { code: 'IRON_LAW_CHECK_ERROR', message: '铁律检查失败' } });
  }
});

router.post('/check-all', async (req, res) => {
  const { context } = req.body as { context: ConstraintContext };
  if (!context) return res.status(400).json({ success: false, error: { code: 'MISSING_CONTEXT', message: '缺少 context 参数' } });
  // #641：剥离请求体自报的证据标志（has*），依赖项降级 skip（见 sanitize-context.ts）
  const sanitized = sanitizeConstraintContext(context);
  try {
    const results = await checkConstraints(sanitized.context);
    const degraded = degradedChecksOf(results);
    res.json({
      success: true,
      data: results,
      source: 'harness',
      ...downgradeAnnotation(sanitized.strippedFlags),
      ...(degraded.length > 0 ? { degradedChecks: degraded } : {}),
    });
  } catch (error) {
    // block 模式首个 error 级违规即抛（ConstraintViolationError 只带该条结果）：
    // 违规是判定数据不是服务故障——转部分视图数据返回，500 只留给真实调不通 harness
    if (error instanceof ConstraintViolationError) {
      logger.warn('[IronLaws] Check-all violation (partial view)', { id: error.result.id });
      return res.json({
        success: true,
        data: violationAsPartialView(error),
        source: 'harness',
        ...downgradeAnnotation(sanitized.strippedFlags),
        violationPartialView: VIOLATION_PARTIAL_VIEW,
      });
    }
    logger.error('[IronLaws] Check-all failed', { error: String(error) });
    res.status(500).json({ success: false, error: { code: 'IRON_LAW_CHECK_ERROR', message: '铁律检查失败' } });
  }
});

export default router;
