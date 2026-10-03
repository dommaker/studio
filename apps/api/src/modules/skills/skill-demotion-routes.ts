/**
 * §10.6 Skill 降级提案 API 路由
 *
 * GET  /api/v1/skills/demotion-proposals          — 列表（?status=pending 过滤；?scan=true 先跑一次扫描）
 * POST /api/v1/skills/demotion-proposals/:id/approve — 批准（改 SKILL.md frontmatter status: archived）
 * POST /api/v1/skills/demotion-proposals/:id/reject  — 拒绝
 *
 * 只产提案不自动生效；approve 是唯一写 skill 文件的路径。
 *
 * 契约驱动迁移（2026-10 批次 3/7）：defineRoute 化 + 统一 envelope——
 * 列表的 scan 摘要兄弟键退役（无消费方），approve/reject 平铺 `{ success, status }`
 * 统一进 `{ data }` 壳；404 走 HttpError。
 */

import { Router } from 'express';
import {
  listDemotionProposalsQuerySchema,
  demotionProposalIdParamsSchema,
  ERROR_CODES,
} from '@dommaker/studio-contract';
import { demotionProposalStore, scanSkillDemotions, approveDemotion, rejectDemotion } from './skill-demotion.js';
import { defineRoute, HttpError } from '../../core/http.js';

// P2-e 鉴权声明式统一：open（GET 列表）/ write（approve/reject，registry 挂 authNotGuest）拆 router。
const openRoutes = Router();
const writeRoutes = Router();

/**
 * GET / — 降级提案列表；?scan=true 先触发一次扫描（无调度器，手动触发口径）
 */
openRoutes.get('/', defineRoute({ query: listDemotionProposalsQuerySchema }, async (_req, _res, { query }) => {
  if (query.scan === 'true') {
    await scanSkillDemotions();
  }
  return demotionProposalStore.list(query.status ? { status: query.status } : {});
}));

/**
 * POST /:id/approve — 批准：frontmatter status → archived（正文不动）
 */
writeRoutes.post('/:id/approve', defineRoute(
  { params: demotionProposalIdParamsSchema },
  async (_req, _res, { params }) => {
    const success = await approveDemotion(params.id);
    if (!success) {
      throw new HttpError(404, ERROR_CODES.NOT_FOUND, 'Proposal not found or already reviewed');
    }
    return { success: true, status: 'approved' as const };
  },
));

/**
 * POST /:id/reject — 拒绝：只改提案状态
 */
writeRoutes.post('/:id/reject', defineRoute(
  { params: demotionProposalIdParamsSchema },
  async (_req, _res, { params }) => {
    const success = await rejectDemotion(params.id);
    if (!success) {
      throw new HttpError(404, ERROR_CODES.NOT_FOUND, 'Proposal not found or already reviewed');
    }
    return { success: true, status: 'rejected' as const };
  },
));

export { openRoutes as skillDemotionOpenRoutes, writeRoutes as skillDemotionWriteRoutes };
