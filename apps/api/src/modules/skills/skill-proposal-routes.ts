/**
 * Skill Proposal API 路由
 *
 * GET  /api/v1/skills/proposals — 获取待审批的 Skill 提案
 * POST /api/v1/skills/proposals/scan — 触发扫描提取
 * POST /api/v1/skills/proposals/extract/:executionId — 从指定执行提取
 * POST /api/v1/skills/proposals/:id/retract — KK 撤回 Skill（见下方注释）
 *
 * #354（ADR 2026-08-25 决策 4）：专有审批端点 /:id/approve|reject 已删除，
 * 审批走 review-proposal 正本通用端点 /api/v1/review-proposals/skill/:id/{approve,reject,status}。
 *
 * 契约驱动迁移（2026-10 批次 3/7）：defineRoute 化 + 统一 envelope——
 * companyId 手写 guard（VALIDATION）收进 zod（BAD_REQUEST）；scan/extract/retract
 * 的平铺响应统一进 `{ data }` 壳；404/400 走 HttpError。
 */

import { Router } from 'express';
import {
  listSkillProposalsQuerySchema,
  scanSkillProposalsBodySchema,
  executionIdParamsSchema,
  skillIdParamsSchema,
  ERROR_CODES,
} from '@dommaker/studio-contract';
import { skillExtractionService } from './skill-extraction.service.js';
import { logger, FileStore } from '@dommaker/studio-shared';
import { channelMessageService } from '../channels/channel-message.service.js';
import { skillStore } from './skill-store.js';
import { requireAuth, requireNotGuest } from '../../middleware/auth.js';
import { defineRoute, HttpError } from '../../core/http.js';

const router = Router();
const fileStore = new FileStore();

/**
 * GET /api/v1/skills/proposals
 * 获取待审批的 Skill 提案
 */
router.get('/', defineRoute({ query: listSkillProposalsQuerySchema }, async (_req, _res, { query }) => {
  return skillExtractionService.getPendingProposals(query.companyId!);
}));

/**
 * POST /api/v1/skills/proposals/scan
 * 触发批量扫描提取
 */
router.post('/scan', requireAuth(), requireNotGuest(), defineRoute(
  { body: scanSkillProposalsBodySchema },
  async (_req, _res, { body }) => {
    const proposals = await skillExtractionService.scanForPatterns(body.companyId!);

    // 保存提案
    const saved: Array<{ skillId: string; proposalId: string; autoPublished: boolean }> = [];
    for (const proposal of proposals) {
      const ids = await skillExtractionService.saveProposal(proposal);
      saved.push(ids);
    }

    return {
      scanned: proposals.length,
      saved: saved.length,
      proposals: saved,
    };
  },
));

/**
 * POST /api/v1/skills/proposals/extract/:executionId
 * 从指定执行提取 Skill
 */
router.post('/extract/:executionId', requireAuth(), requireNotGuest(), defineRoute(
  { params: executionIdParamsSchema },
  async (_req, _res, { params }) => {
    const proposal = await skillExtractionService.extractFromWorkUnit(params.executionId);

    if (!proposal) {
      return { extracted: false, message: 'No reusable pattern found' };
    }

    const ids = await skillExtractionService.saveProposal(proposal);
    return { extracted: true, ...ids, proposal };
  },
));

/**
 * POST /api/v1/skills/proposals/:id/retract — B1-010: KK 撤回 Skill
 *
 * 将 Skill 状态设为 under_review，推确认卡片到 #系统 Channel。
 * 人点击确认→deprecated，点击拒绝→恢复 published。
 */
router.post('/:id/retract', requireAuth(), requireNotGuest(), defineRoute(
  { params: skillIdParamsSchema },
  async (_req, _res, { params }) => {
    const skill = skillStore.get(params.id);
    if (!skill) {
      throw new HttpError(404, ERROR_CODES.NOT_FOUND, 'Skill not found');
    }
    if (skill.status !== 'published') {
      throw new HttpError(400, 'INVALID_STATE', `Cannot retract skill with status: ${skill.status}`);
    }

    // Mark as under_review
    skillStore.update(params.id, { status: 'under_review' });

    // Push confirmation card to #系统
    const sysChannels = await fileStore.listChannels({ name: '#系统' });
    const sysChannel = sysChannels[0] ?? null;
    if (sysChannel) {
      await channelMessageService.createCardMessage(
        sysChannel.id,
        'KK',
        `⚠️ **撤回确认**: Skill \`${skill.name}\` [${skill.category || '未分类'}]\n\n${skill.description || '无描述'}\n\n确认将此 Skill 标记为废弃？`,
        'retract_confirm',
        { skillId: skill.id, skillName: skill.name },
      );
    }

    logger.info('[Skill] Retracted', { skillId: params.id, skillName: skill.name });
    return { success: true, status: 'under_review' as const };
  },
));

export default router;
