/**
 * SkillHub API — 列表 + MANIFEST 清单 + retract 裁决
 *
 * Migrated from Prisma to file-based SkillStore (D-005)。
 *
 * 重构批次 P4.3（2026-10-17）：无消费方的 10 条孤儿端点随批删除
 * （/discover、/stats、GET/POST/PATCH/DELETE CRUD、publish、deprecate、restore、usage）；
 * 保留 3 条有消费方的端点：
 * - GET /（scripts/perf/bench.ts perf 基线脚本）
 * - GET /manifest（前端 RoleSkillsModal skill 多选数据源）
 * - POST /:id/retract/decide（前端 useChannelCardActions）
 * 被删端点的 service 入口全部保留（submitSkillProposal / usage 直写 / promoteSkill / scanSkillDemotions）。
 *
 * 契约驱动迁移（2026-10 批次 3/7）：全部端点走 core/http.ts defineRoute；
 * GET / 平铺分页 `{ data, total, page, limit }` → `{ data, pagination }`（无消费方）。
 */

import { Router } from 'express';
import {
  listSkillsQuerySchema,
  skillIdParamsSchema,
  retractDecideBodySchema,
  ERROR_CODES,
} from '@dommaker/studio-contract';
import { logger } from '../../utils/logger.js';
import { skillStore } from './skill-store.js';
import { loadManifest } from './manifest-loader.js';
import { getSkillReviewAdapter } from './review-adapter.js';
import { getChannelMessageService } from '../channels/index.js';
import { defineRoute, HttpError, paginated, makePagination } from '../../core/http.js';

// P2-e 鉴权声明式统一：open（GET 读）/ write（retract/decide，registry 挂 authNotGuest）拆 router，
// 路由内不再挂鉴权。
const openRoutes = Router();
const writeRoutes = Router();

/**
 * GET /api/v1/skills
 * 列表（分页、过滤）——scripts/perf/bench.ts perf 基线脚本的消费端点，保留
 */
openRoutes.get('/', defineRoute({ query: listSkillsQuerySchema }, async (_req, _res, { query }) => {
  const { companyId, status, category, roleId, page = '1', limit = '20' } = query;
  const filter: Record<string, string> = {};
  if (companyId) filter.companyId = companyId;
  if (status) filter.status = status;
  if (category) filter.category = category;
  if (roleId) filter.roleId = roleId;

  const skip = (Number(page) - 1) * Number(limit);
  const total = skillStore.count(filter);
  const skills = skillStore.list(filter, {
    skip,
    take: Number(limit),
    orderBy: { field: 'updatedAt', dir: 'desc' },
  });

  // Attach pending proposals（#354：提案存取归 review-proposal 正本，kind='skill'）
  const allProposals = await getSkillReviewAdapter().store.listProposals();
  const pendingBySkill = new Map<string, string[]>();
  for (const p of allProposals) {
    if (p.status !== 'pending') continue;
    const ids = pendingBySkill.get(p.skillId) ?? [];
    ids.push(p.id);
    pendingBySkill.set(p.skillId, ids);
  }
  const withProposals = skills.map(s => ({
    ...s,
    proposals: (pendingBySkill.get(s.id) ?? []).slice(0, 1).map(id => ({ id })),
  }));

  return paginated(withProposals, makePagination(Number(page), Number(limit), total));
}));

/**
 * GET /api/v1/skills/manifest
 * #462: skills MANIFEST 只读清单 —— 角色编辑 UI 的 skill 多选数据源。
 * 源 = loadManifest()（~/.studio/skills/<name>/SKILL.md frontmatter，已过滤非 published）；
 * consumers 含 'loop' 的 hub-service skill 不参与注入，不进候选（与 selectSkillsForInjection 口径一致）。
 */
openRoutes.get('/manifest', defineRoute({}, async () => {
  return loadManifest()
    .filter(s => !(Array.isArray(s.consumers) && s.consumers.some(c => c.toLowerCase() === 'loop')))
    .map(s => ({
      name: s.name,
      description: s.description,
      agentTypes: s.agentTypes ?? [],
      triggers: s.triggers ?? [],
    }));
}));

/**
 * POST /api/v1/skills/:id/retract/decide — #278（决策 #250 D2）：retract_confirm 卡的退役决策端点
 * retract 已把 skill 置 under_review 并推卡，本端点补下半截：
 * confirm → deprecated、reject → 恢复 published；body.messageId 提供时同步回写卡片 meta.status
 * （经 updateMessageMeta → SSE channel.message_updated，非阻断——卡片找不到不拖垮状态迁移）。
 * #524 P1-1：body.channelId 可选透传 → 回写按频道直查免全频道扇出（缺省保留扇出兼容）。
 * 前端消费方：useChannelCardActions。
 */
writeRoutes.post('/:id/retract/decide', defineRoute(
  { params: skillIdParamsSchema, body: retractDecideBodySchema },
  async (_req, _res, { params, body }) => {
    const { decision, messageId, channelId } = body;
    const skill = skillStore.get(params.id);
    if (!skill) throw new HttpError(404, ERROR_CODES.NOT_FOUND, 'Skill not found');
    if (skill.status !== 'under_review') {
      throw new HttpError(400, ERROR_CODES.BAD_REQUEST, `Cannot decide retract for skill with status '${skill.status}'`);
    }

    const nextStatus = decision === 'confirm' ? 'deprecated' : 'published';
    const updated = skillStore.update(params.id, { status: nextStatus });

    if (typeof messageId === 'string' && messageId) {
      try {
        await getChannelMessageService().updateMessageMeta(
          messageId,
          { status: nextStatus },
          typeof channelId === 'string' && channelId ? channelId : undefined,
        );
      } catch (e: unknown) {
        logger.warn({ messageId, error: String(e) }, '[Skill] retract decide 卡片回写失败（非阻断）');
      }
    }

    logger.info({ skillId: params.id, decision, status: nextStatus }, '[Skill] Retract decided');
    return updated;
  },
));

export { openRoutes as skillsOpenRoutes, writeRoutes as skillsWriteRoutes };
