/**
 * SkillHub API — CRUD + 生命周期 + Agent 可发现性 + 使用统计
 *
 * Migrated from Prisma to file-based SkillStore (D-005).
 *
 * 契约驱动迁移（2026-10 批次 3/7）：全部端点走 core/http.ts defineRoute——
 * companyId/name/decision 手写 guard 收进 zod；404 走 HttpError；统一 envelope
 * （GET / 平铺分页 `{ data, total, page, limit }` → `{ data, pagination }`（无消费方）；
 * DELETE 的 `{ success }` 与 GET /stats 平铺对象统一进 `{ data }` 壳）；
 * publish 的 promote 门禁拒绝体保留 reasons 扩展（错误壳扩展，handler 自写 res）。
 * 注册顺序保持原样：GET /stats 在 GET /:id 之后（历史遮蔽 bug，未修，见 CONTEXT.md）。
 */

import { Router } from 'express';
import {
  listSkillsQuerySchema,
  discoverSkillsQuerySchema,
  skillsStatsQuerySchema,
  skillIdParamsSchema,
  createSkillBodySchema,
  updateSkillBodySchema,
  retractDecideBodySchema,
  recordSkillUsageBodySchema,
  ERROR_CODES,
} from '@dommaker/studio-contract';
import { logger } from '../../utils/logger.js';
import { skillStore } from './skill-store.js';
import { loadManifest } from './manifest-loader.js';
import { getSkillReviewAdapter } from './review-adapter.js';
import { promoteSkill } from './skill-promotion.js';
import { channelMessageService } from '../channels/index.js';
import { requireAuth, requireNotGuest } from '../../middleware/auth.js';
import { defineRoute, HttpError, paginated } from '../../core/http.js';

const router = Router();

// ─── CRUD ───

/**
 * GET /api/v1/skills
 * 列表（分页、过滤）
 */
router.get('/', defineRoute({ query: listSkillsQuerySchema }, async (_req, _res, { query }) => {
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

  const pageNum = Number(page);
  const limitNum = Number(limit);
  return paginated(withProposals, {
    page: pageNum,
    limit: limitNum,
    total,
    totalPages: Math.ceil(total / limitNum),
  });
}));

/**
 * GET /api/v1/skills/discover
 * Agent 可发现性 — 查询可用 skills
 */
router.get('/discover', defineRoute({ query: discoverSkillsQuerySchema }, async (_req, _res, { query }) => {
  const { companyId, category, roleId, q, limit = '20' } = query;
  const filter: Record<string, unknown> = { status: 'published' };
  if (companyId) filter.companyId = companyId;
  if (category) filter.category = category;
  if (roleId) filter.roleId = roleId;
  if (q) filter.name = { contains: q, mode: 'insensitive' };

  return skillStore.list(filter, {
    take: Number(limit),
    orderBy: { field: 'usageCount', dir: 'desc' },
  });
}));

/**
 * GET /api/v1/skills/manifest
 * #462: skills MANIFEST 只读清单 —— 角色编辑 UI 的 skill 多选数据源。
 * 源 = loadManifest()（~/.studio/skills/<name>/SKILL.md frontmatter，已过滤非 published）；
 * consumers 含 'loop' 的 hub-service skill 不参与注入，不进候选（与 selectSkillsForInjection 口径一致）。
 * 必须注册在 /:id 之前，否则被参数路由吞掉。
 */
router.get('/manifest', defineRoute({}, async () => {
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
 * GET /api/v1/skills/:id
 */
router.get('/:id', defineRoute({ params: skillIdParamsSchema }, async (_req, _res, { params }) => {
  const skill = skillStore.get(params.id);
  if (!skill) throw new HttpError(404, ERROR_CODES.NOT_FOUND, 'Skill not found');

  // #354：提案存取归 review-proposal 正本（append-only 词表 pending|executed|rejected|failed|card-failed）；
  // 响应形状沿用旧 ProposalRecord 字段名（proposedAt←createdAt，reviewedAt←statusAt）
  const proposals = (await getSkillReviewAdapter().store.listProposals())
    .filter(p => p.skillId === skill.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 10)
    .map(p => ({
      id: p.id,
      skillId: p.skillId,
      status: p.status,
      proposedBy: p.proposedBy,
      summary: p.summary ?? null,
      proposedAt: p.createdAt,
      reviewedAt: p.status === 'pending' ? null : p.statusAt,
    }));

  return { ...skill, proposals };
}));

/**
 * POST /api/v1/skills
 */
router.post('/', requireAuth(), requireNotGuest(), defineRoute(
  { body: createSkillBodySchema },
  { status: 201 },
  async (_req, _res, { body }) => {
    const { companyId, roleId, name, category, description, metadata, source } = body;
    return skillStore.create({
      companyId: companyId!, roleId, name: name!, category, description,
      metadata: metadata ? JSON.stringify(metadata) : undefined,
      source: source || 'manual',
    });
  },
));

/**
 * PATCH /api/v1/skills/:id
 */
router.patch('/:id', requireAuth(), requireNotGuest(), defineRoute(
  { params: skillIdParamsSchema, body: updateSkillBodySchema },
  async (_req, _res, { params, body }) => {
    const { name, category, description, metadata, roleId } = body;
    const skill = skillStore.update(params.id, {
      name, category, description, roleId,
      metadata: metadata ? JSON.stringify(metadata) : undefined,
    });
    if (!skill) throw new HttpError(404, ERROR_CODES.NOT_FOUND, 'Skill not found');
    return skill;
  },
));

/**
 * DELETE /api/v1/skills/:id
 */
router.delete('/:id', requireAuth(), requireNotGuest(), defineRoute(
  { params: skillIdParamsSchema },
  async (_req, _res, { params }) => {
    const deleted = skillStore.delete(params.id);
    if (!deleted) throw new HttpError(404, ERROR_CODES.NOT_FOUND, 'Skill not found');
    return { success: true };
  },
));

// ─── 生命周期 ───

/**
 * POST /api/v1/skills/:id/publish
 * draft → published（D11 promote 门禁：SKILL.md 存在 + frontmatter 三要素 + 引用路径真实，
 * 任一不满足拒绝并说明原因；通过后磁盘 frontmatter 同步 published 进匹配池）
 */
router.post('/:id/publish', requireAuth(), requireNotGuest(), defineRoute(
  { params: skillIdParamsSchema },
  async (_req, res, { params }) => {
    const skill = skillStore.get(params.id);
    if (!skill) throw new HttpError(404, ERROR_CODES.NOT_FOUND, 'Skill not found');
    if (skill.status !== 'draft' && skill.status !== 'testing') {
      throw new HttpError(400, ERROR_CODES.BAD_REQUEST, `Cannot publish skill with status '${skill.status}'`);
    }

    const result = promoteSkill(skill.name);
    if (!result.ok) {
      // 错误壳扩展（reasons 数组 HttpError 承载不了，handler 自写 res——同 pmo deliver 409 先例）
      res.status(400).json({ error: { code: ERROR_CODES.BAD_REQUEST, message: 'Promote gate rejected', reasons: result.errors } });
      return undefined;
    }

    return skillStore.get(params.id);
  },
));

/**
 * POST /api/v1/skills/:id/deprecate
 * published → deprecated
 */
router.post('/:id/deprecate', requireAuth(), requireNotGuest(), defineRoute(
  { params: skillIdParamsSchema },
  async (_req, _res, { params }) => {
    const skill = skillStore.get(params.id);
    if (!skill) throw new HttpError(404, ERROR_CODES.NOT_FOUND, 'Skill not found');
    if (skill.status !== 'published') {
      throw new HttpError(400, ERROR_CODES.BAD_REQUEST, `Cannot deprecate skill with status '${skill.status}'`);
    }

    return skillStore.update(params.id, { status: 'deprecated' });
  },
));

/**
 * POST /api/v1/skills/:id/retract/decide — #278（决策 #250 D2）：retract_confirm 卡的退役决策端点
 * retract（skill-proposal-routes）已把 skill 置 under_review 并推卡，本端点补下半截：
 * confirm → deprecated、reject → 恢复 published；body.messageId 提供时同步回写卡片 meta.status
 * （经 updateMessageMeta → SSE channel.message_updated，非阻断——卡片找不到不拖垮状态迁移）。
 * #524 P1-1：body.channelId 可选透传 → 回写按频道直查免全频道扇出（缺省保留扇出兼容）。
 */
router.post('/:id/retract/decide', requireAuth(), requireNotGuest(), defineRoute(
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
        await channelMessageService.updateMessageMeta(
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

/**
 * POST /api/v1/skills/:id/restore
 * deprecated → draft
 */
router.post('/:id/restore', requireAuth(), requireNotGuest(), defineRoute(
  { params: skillIdParamsSchema },
  async (_req, _res, { params }) => {
    const skill = skillStore.get(params.id);
    if (!skill) throw new HttpError(404, ERROR_CODES.NOT_FOUND, 'Skill not found');
    if (skill.status !== 'deprecated') {
      throw new HttpError(400, ERROR_CODES.BAD_REQUEST, `Cannot restore skill with status '${skill.status}'`);
    }

    return skillStore.update(params.id, {
      status: 'draft',
      version: { increment: 1 },
    });
  },
));

// ─── 使用统计 ───

/**
 * POST /api/v1/skills/:id/usage
 * 记录一次使用，自动更新统计
 */
router.post('/:id/usage', requireAuth(), requireNotGuest(), defineRoute(
  { params: skillIdParamsSchema, body: recordSkillUsageBodySchema },
  async (_req, _res, { params, body }) => {
    const { success, durationMs } = body;
    const skill = skillStore.get(params.id);
    if (!skill) throw new HttpError(404, ERROR_CODES.NOT_FOUND, 'Skill not found');

    const newCount = skill.usageCount + 1;
    // EMA with alpha=0.3 (recent samples weighted 30%, history 70%)
    const alpha = 0.3;
    const newSuccessRate = alpha * (success ? 1 : 0) + (1 - alpha) * skill.successRate;
    const newAvgDuration = durationMs
      ? ((skill.avgDuration * skill.usageCount) + durationMs) / newCount
      : skill.avgDuration;

    return skillStore.update(params.id, {
      usageCount: newCount,
      successRate: Math.round(newSuccessRate * 100) / 100,
      avgDuration: Math.round(newAvgDuration),
    });
  },
));

/**
 * GET /api/v1/skills/stats
 * 技能统计（从 SkillStore 聚合）
 * 注意：注册在 GET /:id 之后是历史遮蔽 bug（实际请求被 /:id 以 id='stats' 吞掉），
 * 迁移保持原注册顺序，行为不变（见 CONTEXT.md 遗留）。
 */
router.get('/stats', defineRoute({ query: skillsStatsQuerySchema }, async (_req, _res, { query }) => {
  const filter = query.company_id ? { companyId: query.company_id } : {};

  const skills = skillStore.list(filter);

  const totalSkills = skills.length;
  const publishedSkills = skills.filter(s => s.status === 'published').length;
  const totalUsage = skills.reduce((sum, s) => sum + s.usageCount, 0);
  const avgSuccessRate = totalSkills > 0
    ? Math.round((skills.reduce((sum, s) => sum + s.successRate, 0) / totalSkills) * 100) / 100
    : 0;
  const avgDuration = totalSkills > 0
    ? Math.round(skills.reduce((sum, s) => sum + s.avgDuration, 0) / totalSkills)
    : 0;

  const byCategory: Record<string, { count: number; usage: number }> = {};
  for (const s of skills) {
    const cat = s.category || 'uncategorized';
    if (!byCategory[cat]) byCategory[cat] = { count: 0, usage: 0 };
    byCategory[cat].count++;
    byCategory[cat].usage += s.usageCount;
  }

  const topSkills = skills
    .filter(s => s.usageCount > 0)
    .sort((a, b) => b.usageCount - a.usageCount)
    .slice(0, 10)
    .map(s => ({ id: s.id, name: s.name, usageCount: s.usageCount, successRate: s.successRate, avgDuration: s.avgDuration }));

  return {
    totalSkills,
    publishedSkills,
    totalUsage,
    avgSuccessRate,
    avgDuration,
    byCategory,
    topSkills,
  };
}));

export default router;
