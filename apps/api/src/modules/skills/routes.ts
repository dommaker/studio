/**
 * SkillHub API — CRUD + 生命周期 + Agent 可发现性 + 使用统计
 */

import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { logger } from '../../utils/logger.js';

const prisma = new PrismaClient();
const router = Router();

// ─── CRUD ───

/**
 * GET /api/v1/skills
 * 列表（分页、过滤）
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { companyId, status, category, roleId, page = '1', limit = '20' } = req.query;
    const where: any = {};
    if (companyId) where.companyId = companyId;
    if (status) where.status = status;
    if (category) where.category = category;
    if (roleId) where.roleId = roleId;

    const skip = (Number(page) - 1) * Number(limit);
    const [skills, total] = await Promise.all([
      prisma.skill.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip,
        take: Number(limit),
        include: { proposals: { where: { status: 'pending' }, select: { id: true } } },
      }),
      prisma.skill.count({ where }),
    ]);

    res.json({ data: skills, total, page: Number(page), limit: Number(limit) });
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
    const where: any = { status: 'published' };
    if (companyId) where.companyId = companyId;
    if (category) where.category = category;
    if (roleId) where.roleId = roleId;
    if (q) where.name = { contains: String(q), mode: 'insensitive' };

    const skills = await prisma.skill.findMany({
      where,
      orderBy: { usageCount: 'desc' },
      take: Number(limit),
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
    const skill = await prisma.skill.findUnique({
      where: { id: req.params.id },
      include: { proposals: { orderBy: { proposedAt: 'desc' }, take: 10 } },
    });
    if (!skill) return res.status(404).json({ error: 'Skill not found' });
    res.json({ data: skill });
  } catch (error) {
    logger.error({ error }, 'Failed to get skill');
    res.status(500).json({ error: 'Failed to get skill' });
  }
});

/**
 * POST /api/v1/skills
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { companyId, roleId, name, category, description, metadata, source } = req.body;
    if (!companyId || !name) return res.status(400).json({ error: 'companyId and name are required' });

    const skill = await prisma.skill.create({
      data: { companyId, roleId, name, category, description, metadata, source: source || 'manual' },
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
router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const { name, category, description, metadata, roleId } = req.body;
    const skill = await prisma.skill.update({
      where: { id: req.params.id },
      data: { name, category, description, metadata, roleId },
    });
    res.json({ data: skill });
  } catch (error) {
    logger.error({ error }, 'Failed to update skill');
    res.status(500).json({ error: 'Failed to update skill' });
  }
});

/**
 * DELETE /api/v1/skills/:id
 */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    await prisma.skill.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (error) {
    logger.error({ error }, 'Failed to delete skill');
    res.status(500).json({ error: 'Failed to delete skill' });
  }
});

// ─── 生命周期 ───

/**
 * POST /api/v1/skills/:id/publish
 * draft → published
 */
router.post('/:id/publish', async (req: Request, res: Response) => {
  try {
    const skill = await prisma.skill.findUnique({ where: { id: req.params.id } });
    if (!skill) return res.status(404).json({ error: 'Skill not found' });
    if (skill.status !== 'draft' && skill.status !== 'testing') {
      return res.status(400).json({ error: `Cannot publish skill with status '${skill.status}'` });
    }

    const updated = await prisma.skill.update({
      where: { id: req.params.id },
      data: { status: 'published' },
    });

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
router.post('/:id/deprecate', async (req: Request, res: Response) => {
  try {
    const skill = await prisma.skill.findUnique({ where: { id: req.params.id } });
    if (!skill) return res.status(404).json({ error: 'Skill not found' });
    if (skill.status !== 'published') {
      return res.status(400).json({ error: `Cannot deprecate skill with status '${skill.status}'` });
    }

    const updated = await prisma.skill.update({
      where: { id: req.params.id },
      data: { status: 'deprecated' },
    });

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
router.post('/:id/restore', async (req: Request, res: Response) => {
  try {
    const skill = await prisma.skill.findUnique({ where: { id: req.params.id } });
    if (!skill) return res.status(404).json({ error: 'Skill not found' });
    if (skill.status !== 'deprecated') {
      return res.status(400).json({ error: `Cannot restore skill with status '${skill.status}'` });
    }

    const updated = await prisma.skill.update({
      where: { id: req.params.id },
      data: { status: 'draft', version: { increment: 1 } },
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
router.post('/:id/usage', async (req: Request, res: Response) => {
  try {
    const { success, durationMs } = req.body;
    const skill = await prisma.skill.findUnique({ where: { id: req.params.id } });
    if (!skill) return res.status(404).json({ error: 'Skill not found' });

    const newCount = skill.usageCount + 1;
    const newSuccessRate = ((skill.successRate * skill.usageCount) + (success ? 1 : 0)) / newCount;
    const newAvgDuration = durationMs
      ? ((skill.avgDuration * skill.usageCount) + durationMs) / newCount
      : skill.avgDuration;

    const updated = await prisma.skill.update({
      where: { id: req.params.id },
      data: {
        usageCount: newCount,
        successRate: Math.round(newSuccessRate * 100) / 100,
        avgDuration: Math.round(newAvgDuration),
      },
    });

    res.json({ data: updated });
  } catch (error) {
    logger.error({ error }, 'Failed to record usage');
    res.status(500).json({ error: 'Failed to record usage' });
  }
});

/**
 * GET /api/v1/skills/stats
 * 技能统计（从 DB 聚合，替代 runtime proxy）
 */
router.get('/stats', async (req: Request, res: Response) => {
  try {
    const companyId = req.query.company_id as string | undefined;
    const where = companyId ? { companyId } : {};

    const skills = await prisma.skill.findMany({
      where,
      select: { id: true, name: true, status: true, usageCount: true, successRate: true, avgDuration: true, category: true },
    });

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
