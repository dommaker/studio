/**
 * §10.6 Skill 降级提案 API 路由
 *
 * GET  /api/v1/skills/demotion-proposals          — 列表（?status=pending 过滤；?scan=true 先跑一次扫描）
 * POST /api/v1/skills/demotion-proposals/:id/approve — 批准（改 SKILL.md frontmatter status: archived）
 * POST /api/v1/skills/demotion-proposals/:id/reject  — 拒绝
 *
 * 只产提案不自动生效；approve 是唯一写 skill 文件的路径。
 */

import { Router, Request, Response } from 'express';
import { logger } from '@dommaker/studio-shared';
import { demotionProposalStore, scanSkillDemotions, approveDemotion, rejectDemotion } from './skill-demotion.js';
import { requireAuth, requireNotGuest } from '../../middleware/auth.js';

const router = Router();

/**
 * GET / — 降级提案列表；?scan=true 先触发一次扫描（无调度器，手动触发口径）
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    let scan: Awaited<ReturnType<typeof scanSkillDemotions>> | null = null;
    if (req.query.scan === 'true') {
      scan = await scanSkillDemotions();
    }
    const status = req.query.status as string | undefined;
    const proposals = demotionProposalStore.list(status ? { status } : {});
    res.json({ data: proposals, ...(scan ? { scan: { scanned: scan.scanned, created: scan.created } } : {}) });
  } catch (error) {
    logger.error('[Skill Demotion] Failed to list', { error: String(error) });
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list demotion proposals' } });
  }
});

/**
 * POST /:id/approve — 批准：frontmatter status → archived（正文不动）
 */
router.post('/:id/approve', requireAuth(), requireNotGuest(), async (req: Request, res: Response) => {
  try {
    const success = await approveDemotion(req.params.id);
    if (!success) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Proposal not found or already reviewed' } });
    }
    res.json({ success: true, status: 'approved' });
  } catch (error) {
    logger.error('[Skill Demotion] Approve failed', { error: String(error) });
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: String(error) } });
  }
});

/**
 * POST /:id/reject — 拒绝：只改提案状态
 */
router.post('/:id/reject', requireAuth(), requireNotGuest(), async (req: Request, res: Response) => {
  try {
    const success = await rejectDemotion(req.params.id);
    if (!success) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Proposal not found or already reviewed' } });
    }
    res.json({ success: true, status: 'rejected' });
  } catch (error) {
    logger.error('[Skill Demotion] Reject failed', { error: String(error) });
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Reject failed' } });
  }
});

export default router;
