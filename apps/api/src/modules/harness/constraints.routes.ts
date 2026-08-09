/**
 * constraints.routes — Harness 约束清单与质量门子路由（T-002 / M2）
 *
 * 从 routes.ts 提取（T3 大文件拆分），harness 0.17.0 适配（ADR-0001 决策 8）：
 * - GET  /constraints                 列出生效约束集（getEffectiveConstraints）
 * - GET  /constraints/stats           生效集统计（注册于 /constraints/:id 之前）
 * - GET  /constraints/retired         config.yml 中已退役约束的元数据（注册于 /:id 之前）
 * - GET  /constraints/:id             约束详情（生效集内查找）
 * - POST /constraints/:id/rollback    撤销 retire：删除 config.yml constraints.<id> 段
 * - POST /check-constraints           M2 质量门：非抛出式约束检查（RequirementsDoc UI）
 *
 * 0.17.0 移除：ConstraintRegistry（layer/deprecationStatus/permanent 概念随之删除）、
 * POST /constraints/:id/degrade、POST /constraints/:id/schedule（deprecationSchedule 删除）。
 * 响应字段说明：原 layer/deprecationStatus/permanent 不再存在；kind（check/prompt）为新增。
 */

import { Router, Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { logger } from '@dommaker/studio-shared';
import { loadHarness, harnessModule } from './runtime.js';

export const constraintsRoutes = Router();

/** 项目根（harness 配置 .harness/ 所在目录）：与 harness CLI 一致，缺省 process.cwd() */
function projectRoot(): string {
  return process.cwd();
}

function configPath(): string {
  return path.join(projectRoot(), '.harness', 'config.yml');
}

// ─── Constraint Lifecycle (T-002) ───

/**
 * GET /api/v1/harness/constraints
 * 列出当前生效约束集（内置 → config.yml 合并 → custom 追加，带 kind）
 */
constraintsRoutes.get('/constraints', async (_req: Request, res: Response) => {
  try {
    const loaded = await loadHarness();
    if (!loaded || !harnessModule) return res.status(503).json({ error: 'Harness not available' });

    const constraints = harnessModule.getEffectiveConstraints(projectRoot()).map(c => ({
      id: c.id,
      kind: c.kind,
      level: c.level,
      trigger: c.trigger,
      rule: c.rule,
      message: c.message,
      enforcement: c.enforcement,
    }));
    return res.json({ data: constraints, total: constraints.length });
  } catch (error) {
    logger.error('Failed to list constraints', { error: String(error) });
    return res.status(500).json({ error: 'Failed to list constraints' });
  }
});

/**
 * GET /api/v1/harness/constraints/stats
 * 生效集统计。0.17.0 语义变化：原按 layer（safety/quality）聚合 → 现按 kind/level 聚合
 */
constraintsRoutes.get('/constraints/stats', async (_req: Request, res: Response) => {
  try {
    const loaded = await loadHarness();
    if (!loaded || !harnessModule) return res.status(503).json({ error: 'Harness not available' });

    const constraints = harnessModule.getEffectiveConstraints(projectRoot());
    const byKind: Record<string, number> = {};
    const byLevel: Record<string, number> = {};
    for (const c of constraints) {
      byKind[c.kind] = (byKind[c.kind] ?? 0) + 1;
      byLevel[c.level] = (byLevel[c.level] ?? 0) + 1;
    }
    return res.json({ data: { total: constraints.length, byKind, byLevel } });
  } catch (error) {
    logger.error('Failed to get constraint stats', { error: String(error) });
    return res.status(500).json({ error: 'Failed to get constraint stats' });
  }
});

/**
 * GET /api/v1/harness/constraints/retired
 * 已退役约束元数据（config.yml constraints.<id>.retired：at/reason/stats）
 */
constraintsRoutes.get('/constraints/retired', async (_req: Request, res: Response) => {
  try {
    const file = configPath();
    if (!fs.existsSync(file)) return res.json({ data: [], total: 0 });

    const raw = (yaml.load(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>) ?? {};
    const constraints = (raw.constraints ?? {}) as Record<string, Record<string, unknown>>;
    const retired = Object.entries(constraints)
      .filter(([, v]) => v && typeof v === 'object' && v.retired)
      .map(([id, v]) => ({ id, enabled: v.enabled ?? false, retired: v.retired }));
    return res.json({ data: retired, total: retired.length });
  } catch (error) {
    logger.error('Failed to list retired constraints', { error: String(error) });
    return res.status(500).json({ error: 'Failed to list retired constraints' });
  }
});

/**
 * GET /api/v1/harness/constraints/:id
 * 约束详情（生效集内查找）
 */
constraintsRoutes.get('/constraints/:id', async (req: Request, res: Response) => {
  try {
    const loaded = await loadHarness();
    if (!loaded || !harnessModule) return res.status(503).json({ error: 'Harness not available' });

    const constraint = harnessModule.getEffectiveConstraints(projectRoot())
      .find(c => c.id === req.params.id);
    if (!constraint) return res.status(404).json({ error: 'Constraint not found' });
    return res.json({ data: constraint });
  } catch (error) {
    logger.error('Failed to get constraint', { error: String(error) });
    return res.status(500).json({ error: 'Failed to get constraint' });
  }
});

/**
 * POST /api/v1/harness/constraints/:id/rollback
 * 撤销 retire/disable：删除 .harness/config.yml 中 constraints.<id> 段（0.17.0 语义）。
 * config.yml 不存在或无该段 → 404。js-yaml 重写不保留原文件注释（与 harness CLI 一致）。
 */
constraintsRoutes.post('/constraints/:id/rollback', async (req: Request, res: Response) => {
  try {
    const file = configPath();
    if (!fs.existsSync(file)) {
      return res.status(404).json({ error: 'No config.yml: constraint has no retire/disable entry to roll back' });
    }

    const raw = (yaml.load(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>) ?? {};
    const constraints = (raw.constraints ?? {}) as Record<string, unknown>;
    if (!(req.params.id in constraints)) {
      return res.status(404).json({ error: `No config entry for constraint: ${req.params.id}` });
    }

    delete constraints[req.params.id];
    if (Object.keys(constraints).length === 0) delete raw.constraints;
    else raw.constraints = constraints;
    fs.writeFileSync(file, yaml.dump(raw, { lineWidth: 120 }), 'utf-8');

    // 回滚后若重新进入生效集，返回其定义
    let restored = null;
    const loaded = await loadHarness();
    if (loaded && harnessModule) {
      restored = harnessModule.getEffectiveConstraints(projectRoot())
        .find(c => c.id === req.params.id) ?? null;
    }
    return res.json({ data: restored, rolledBack: true });
  } catch (error) {
    logger.error('Failed to rollback constraint', { error: String(error) });
    return res.status(500).json({ error: 'Failed to rollback constraint' });
  }
});

// ─── Quality Gate (M2) ───

/**
 * POST /api/v1/harness/check-constraints
 * M2: RequirementsDoc quality gate — run non-throwing constraint check for UI
 */
constraintsRoutes.post('/check-constraints', async (req: Request, res: Response) => {
  try {
    const loaded = await loadHarness();
    if (!loaded) return res.status(503).json({ error: 'Harness not available' });

    const { operation, taskDescription, projectPath, hasRequirement, hasRequirementReview } = req.body;
    if (!operation) return res.status(400).json({ error: 'operation is required' });

    // Use checkConstraints (checkConstraintsSafe removed in harness 0.13.0)
    const result = await harnessModule!.checkConstraints({
      operation: operation as string,
      taskDescription,
      projectPath,
      hasRequirement: hasRequirement !== false,
      hasRequirementReview: hasRequirementReview !== false,
    });

    return res.json({ data: result });
  } catch (error) {
    logger.error('Failed to check constraints', { error: String(error) });
    return res.status(500).json({ error: 'Failed to check constraints' });
  }
});
