/**
 * SkillHub API — CRUD + 生命周期 + Agent 可发现性 + 使用统计
 *
 * Migrated from Prisma to file-based SkillStore (D-005).
 */

import { Router, Request, Response } from 'express';
import { logger } from '../../utils/logger.js';
import { skillStore } from './skill-store.js';
import { proposalStore } from './proposal-store.js';
import { promoteSkill } from './skill-promotion.js';
import { requireAuth, requireNotGuest } from '../../middleware/auth.js';

const router = Router();

// ─── CRUD ───

/**
 * GET /api/v1/skills
 * 列表（分页、过滤）
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { companyId, status, category, roleId, page = '1', limit = '20' } = req.query;
    const filter: Record<string, string> = {};
    if (companyId) filter.companyId = companyId as string;
    if (status) filter.status = status as string;
    if (category) filter.category = category as string;
    if (roleId) filter.roleId = roleId as string;

    const skip = (Number(page) - 1) * Number(limit);
    const total = skillStore.count(filter);
    const skills = skillStore.list(filter, {
      skip,
      take: Number(limit),
      orderBy: { field: 'updatedAt', dir: 'desc' },
    });

    // Attach pending proposals
    const withProposals = skills.map(s => ({
      ...s,
      proposals: proposalStore.list({ skillId: s.id, status: 'pending' }, { take: 1 }).map(p => ({ id: p.id })),
    }));

    res.json({ data: withProposals, total, page: Number(page), limit: Number(limit) });
  } catch (error) {
    logger.error({ error }, 'Failed to list skills');
    res.status(500).json({ error: 'Failed to list skills' });
  }
});

/**
 * GET /api/v1/skills/discover
 * Agent 可发现性 — 查询可用 skills
 */
router.get('/discover', async (req: Request, res: Response) => {
  try {
    const { companyId, category, roleId, q, limit = '20' } = req.query;
    const filter: Record<string, unknown> = { status: 'published' };
    if (companyId) filter.companyId = companyId;
    if (category) filter.category = category;
    if (roleId) filter.roleId = roleId;
    if (q) filter.name = { contains: String(q), mode: 'insensitive' };

    const skills = skillStore.list(filter, {
      take: Number(limit),
      orderBy: { field: 'usageCount', dir: 'desc' },
    });

    res.json({ data: skills });
  } catch (error) {
    logger.error({ error }, 'Failed to discover skills');
    res.status(500).json({ error: 'Failed to discover skills' });
  }
});

/**
 * GET /api/v1/skills/:id
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const skill = skillStore.get(req.params.id);
    if (!skill) return res.status(404).json({ error: 'Skill not found' });

    const proposals = proposalStore.list(
      { skillId: skill.id },
      { orderBy: { field: 'proposedAt', dir: 'desc' }, take: 10 },
    );

    res.json({ data: { ...skill, proposals } });
  } catch (error) {
    logger.error({ error }, 'Failed to get skill');
    res.status(500).json({ error: 'Failed to get skill' });
  }
});

/**
 * POST /api/v1/skills
 */
router.post('/', requireAuth(), requireNotGuest(), async (req: Request, res: Response) => {
  try {
    const { companyId, roleId, name, category, description, metadata, source } = req.body;
    if (!companyId || !name) return res.status(400).json({ error: 'companyId and name are required' });

    const skill = skillStore.create({
      companyId, roleId, name, category, description,
      metadata: metadata ? JSON.stringify(metadata) : undefined,
      source: source || 'manual',
    });

    res.status(201).json({ data: skill });
  } catch (error) {
    logger.error({ error }, 'Failed to create skill');
    res.status(500).json({ error: 'Failed to create skill' });
  }
});

/**
 * PATCH /api/v1/skills/:id
 */
router.patch('/:id', requireAuth(), requireNotGuest(), async (req: Request, res: Response) => {
  try {
    const { name, category, description, metadata, roleId } = req.body;
    const skill = skillStore.update(req.params.id, {
      name, category, description, roleId,
      metadata: metadata ? JSON.stringify(metadata) : undefined,
    });
    if (!skill) return res.status(404).json({ error: 'Skill not found' });
    res.json({ data: skill });
  } catch (error) {
    logger.error({ error }, 'Failed to update skill');
    res.status(500).json({ error: 'Failed to update skill' });
  }
});

/**
 * DELETE /api/v1/skills/:id
 */
router.delete('/:id', requireAuth(), requireNotGuest(), async (req: Request, res: Response) => {
  try {
    const deleted = skillStore.delete(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Skill not found' });
    res.json({ success: true });
  } catch (error) {
    logger.error({ error }, 'Failed to delete skill');
    res.status(500).json({ error: 'Failed to delete skill' });
  }
});

// ─── 生命周期 ───

/**
 * POST /api/v1/skills/:id/publish
 * draft → published（D11 promote 门禁：SKILL.md 存在 + frontmatter 三要素 + 引用路径真实，
 * 任一不满足拒绝并说明原因；通过后磁盘 frontmatter 同步 published 进匹配池）
 */
router.post('/:id/publish', requireAuth(), requireNotGuest(), async (req: Request, res: Response) => {
  try {
    const skill = skillStore.get(req.params.id);
    if (!skill) return res.status(404).json({ error: 'Skill not found' });
    if (skill.status !== 'draft' && skill.status !== 'testing') {
      return res.status(400).json({ error: `Cannot publish skill with status '${skill.status}'` });
    }

    const result = promoteSkill(skill.name);
    if (!result.ok) {
      return res.status(400).json({ error: 'Promote gate rejected', reasons: result.errors });
    }

    const updated = skillStore.get(req.params.id);
    res.json({ data: updated });
  } catch (error) {
    logger.error({ error }, 'Failed to publish skill');
    res.status(500).json({ error: 'Failed to publish skill' });
  }
});

/**
 * POST /api/v1/skills/:id/deprecate
 * published → deprecated
 */
router.post('/:id/deprecate', requireAuth(), requireNotGuest(), async (req: Request, res: Response) => {
  try {
    const skill = skillStore.get(req.params.id);
    if (!skill) return res.status(404).json({ error: 'Skill not found' });
    if (skill.status !== 'published') {
      return res.status(400).json({ error: `Cannot deprecate skill with status '${skill.status}'` });
    }

    const updated = skillStore.update(req.params.id, { status: 'deprecated' });
    res.json({ data: updated });
  } catch (error) {
    logger.error({ error }, 'Failed to deprecate skill');
    res.status(500).json({ error: 'Failed to deprecate skill' });
  }
});

/**
 * POST /api/v1/skills/:id/restore
 * deprecated → draft
 */
router.post('/:id/restore', requireAuth(), requireNotGuest(), async (req: Request, res: Response) => {
  try {
    const skill = skillStore.get(req.params.id);
    if (!skill) return res.status(404).json({ error: 'Skill not found' });
    if (skill.status !== 'deprecated') {
      return res.status(400).json({ error: `Cannot restore skill with status '${skill.status}'` });
    }

    const updated = skillStore.update(req.params.id, {
      status: 'draft',
      version: { increment: 1 },
    });
    res.json({ data: updated });
  } catch (error) {
    logger.error({ error }, 'Failed to restore skill');
    res.status(500).json({ error: 'Failed to restore skill' });
  }
});

// ─── 使用统计 ───

/**
 * POST /api/v1/skills/:id/usage
 * 记录一次使用，自动更新统计
 */
router.post('/:id/usage', requireAuth(), requireNotGuest(), async (req: Request, res: Response) => {
  try {
    const { success, durationMs } = req.body;
    const skill = skillStore.get(req.params.id);
    if (!skill) return res.status(404).json({ error: 'Skill not found' });

    const newCount = skill.usageCount + 1;
    // EMA with alpha=0.3 (recent samples weighted 30%, history 70%)
    const alpha = 0.3;
    const newSuccessRate = alpha * (success ? 1 : 0) + (1 - alpha) * skill.successRate;
    const newAvgDuration = durationMs
      ? ((skill.avgDuration * skill.usageCount) + durationMs) / newCount
      : skill.avgDuration;

    const updated = skillStore.update(req.params.id, {
      usageCount: newCount,
      successRate: Math.round(newSuccessRate * 100) / 100,
      avgDuration: Math.round(newAvgDuration),
    });

    res.json({ data: updated });
  } catch (error) {
    logger.error({ error }, 'Failed to record usage');
    res.status(500).json({ error: 'Failed to record usage' });
  }
});

/**
 * GET /api/v1/skills/stats
 * 技能统计（从 SkillStore 聚合）
 */
router.get('/stats', async (req: Request, res: Response) => {
  try {
    const companyId = req.query.company_id as string | undefined;
    const filter = companyId ? { companyId } : {};

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

    res.json({
      totalSkills,
      publishedSkills,
      totalUsage,
      avgSuccessRate,
      avgDuration,
      byCategory,
      topSkills,
    });
  } catch (error) {
    logger.error({ error }, 'Failed to get skills stats');
    res.status(500).json({ error: 'Failed to get skills stats' });
  }
});

export default router;
