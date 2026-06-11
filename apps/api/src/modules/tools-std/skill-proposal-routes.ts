/**
 * Skill Proposal API 路由
 *
 * GET  /api/v1/skills/proposals — 获取待审批的 Skill 提案
 * POST /api/v1/skills/proposals/scan — 触发扫描提取
 * POST /api/v1/skills/proposals/:id/approve — 审批通过
 * POST /api/v1/skills/proposals/:id/reject — 审批拒绝
 * POST /api/v1/skills/proposals/extract/:executionId — 从指定执行提取
 */

import { Router, Request, Response } from 'express';
import { skillExtractionService } from './skill-extraction.service.js';
import { logger } from '@dommaker/studio-shared';
import { prisma } from '../../core/database.js';
import { channelMessageService } from '../channels/channel-message.service.js';
import { skillStore } from '../skills/skill-store.js';

const router = Router();

/**
 * GET /api/v1/skills/proposals
 * 获取待审批的 Skill 提案
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const companyId = req.query.companyId as string;
    if (!companyId) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'companyId is required' } });
    }

    const proposals = await skillExtractionService.getPendingProposals(companyId);
    return res.json({ data: proposals });
  } catch (error) {
    logger.error('[Skill Proposals] Failed to list', { error: String(error) });
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list proposals' } });
  }
});

/**
 * POST /api/v1/skills/proposals/scan
 * 触发批量扫描提取
 */
router.post('/scan', async (req: Request, res: Response) => {
  try {
    const { companyId } = req.body;
    if (!companyId) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'companyId is required' } });
    }

    const proposals = await skillExtractionService.scanForPatterns(companyId);

    // 保存提案
    const saved: Array<{ skillId: string; proposalId: string }> = [];
    for (const proposal of proposals) {
      const ids = await skillExtractionService.saveProposal(proposal);
      saved.push(ids);
    }

    return res.json({
      scanned: proposals.length,
      saved: saved.length,
      proposals: saved,
    });
  } catch (error) {
    logger.error('[Skill Proposals] Scan failed', { error: String(error) });
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Scan failed' } });
  }
});

/**
 * POST /api/v1/skills/proposals/extract/:executionId
 * 从指定执行提取 Skill
 */
router.post('/extract/:executionId', async (req: Request, res: Response) => {
  try {
    const { executionId } = req.params;
    const proposal = await skillExtractionService.extractFromGoalExecution(executionId);

    if (!proposal) {
      return res.json({ extracted: false, message: 'No reusable pattern found' });
    }

    const ids = await skillExtractionService.saveProposal(proposal);
    return res.json({ extracted: true, ...ids, proposal });
  } catch (error) {
    logger.error('[Skill Proposals] Extraction failed', { error: String(error) });
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Extraction failed' } });
  }
});

/**
 * POST /api/v1/skills/proposals/:id/approve
 */
router.post('/:id/approve', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const success = await skillExtractionService.reviewProposal(id, true);
    if (!success) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Proposal not found or already reviewed' } });
    }
    return res.json({ success: true, status: 'approved' });
  } catch (error) {
    logger.error('[Skill Proposals] Approve failed', { error: String(error) });
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Approve failed' } });
  }
});

/**
 * POST /api/v1/skills/proposals/:id/reject
 */
router.post('/:id/reject', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const success = await skillExtractionService.reviewProposal(id, false);
    if (!success) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Proposal not found or already reviewed' } });
    }
    return res.json({ success: true, status: 'rejected' });
  } catch (error) {
    logger.error('[Skill Proposals] Reject failed', { error: String(error) });
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Reject failed' } });
  }
});

/**
 * POST /api/v1/skills/:id/retract — B1-010: KK 撤回 Skill
 *
 * 将 Skill 状态设为 under_review，推确认卡片到 #系统 Channel。
 * 人点击确认→deprecated，点击拒绝→恢复 published。
 */
router.post('/:id/retract', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const skill = skillStore.get(id);
    if (!skill) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Skill not found' } });
    }
    if (skill.status !== 'published') {
      return res.status(400).json({ error: { code: 'INVALID_STATE', message: `Cannot retract skill with status: ${skill.status}` } });
    }

    // Mark as under_review
    skillStore.update(id, { status: 'under_review' });

    // Push confirmation card to #系统
    const sysChannel = await prisma.channel.findUnique({ where: { name: '#系统' } });
    if (sysChannel) {
      await channelMessageService.createCardMessage(
        sysChannel.id,
        'KK',
        `⚠️ **撤回确认**: Skill \`${skill.name}\` [${skill.category || '未分类'}]\n\n${skill.description || '无描述'}\n\n确认将此 Skill 标记为废弃？`,
        'retract_confirm',
        { skillId: skill.id, skillName: skill.name },
      );
    }

    logger.info('[Skill] Retracted', { skillId: id, skillName: skill.name });
    return res.json({ success: true, status: 'under_review' });
  } catch (error) {
    logger.error('[Skill] Retract failed', { error: String(error) });
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Retract failed' } });
  }
});

export default router;
