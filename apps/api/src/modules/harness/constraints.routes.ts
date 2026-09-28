/**
 * constraints.routes — Harness 约束清单与质量门子路由（T-002 / M2）
 *
 * 从 routes.ts 提取（T3 大文件拆分），harness 0.17.0 适配（ADR-0001 决策 8）：
 * - GET  /constraints                 列出生效约束集（getEffectiveConstraints）
 * - GET  /constraints/stats           生效集统计（注册于 /constraints/:id 之前）
 * - GET  /constraints/retired         已退役约束元数据：config.yml（唯一落点）
 * - GET  /constraints/:id             约束详情（生效集内查找）
 * - POST /constraints/:id/rollback    撤销 retire：config.yml 删 constraints.<id> 段
 * - POST /constraints/propose-upgrade 升级提案发起（ADR-0033 子项 8）：校验应用层约束 →
 *   建 constraint kind 提案卡（action='upgrade'）；approve 后 pack-proposal 打包脱敏材料
 * - POST /check-constraints           M2 质量门：非抛出式约束检查（RequirementsDoc UI）
 *
 * 0.17.0 移除：ConstraintRegistry（layer/deprecationStatus/permanent 概念随之删除）、
 * POST /constraints/:id/degrade、POST /constraints/:id/schedule（deprecationSchedule 删除）。
 * 响应字段说明（harness 1.10.0 / ADR-0029）：原 layer/deprecationStatus/permanent 不存在；
 * 三层 level 命名废弃，条目带显式 severity（error/warning/info）；kind 收窄为单值 'check'。
 * custom-constraints.yml 装载机制已随 harness 1.10.0 退役（studio#606），本仓的
 * custom 落点通道（retired 清单 source:custom / rollback 删 retired 段 / customConstraintsPath）
 * 已随 #617 拆除——retired/rollback 恒为 config.yml 单落点。
 */

import { Router, Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { buildConstraintsUsageReport } from '@dommaker/harness';
import { logger } from '@dommaker/studio-shared';
import { loadHarness, harnessModule } from './runtime.js';
import { sanitizeConstraintContext, downgradeAnnotation } from './sanitize-context.js';
import {
  getConstraintReviewAdapter,
  submitConstraintUpgradeProposal,
} from '../evolution/constraint-adapter.js';
import { formatConstraintStats } from '../evolution/format-constraint-stats.js';

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
 * 列出当前生效约束集（内置 → preset → config.yml 禁用，带 kind/severity）
 */
constraintsRoutes.get('/constraints', async (_req: Request, res: Response) => {
  try {
    const loaded = await loadHarness();
    if (!loaded || !harnessModule) return res.status(503).json({ error: 'Harness not available' });

    const constraints = harnessModule.getEffectiveConstraints(projectRoot()).map(c => ({
      id: c.id,
      kind: c.kind,
      severity: c.severity,
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
 * 生效集统计。0.17.0 语义变化：原按 layer（safety/quality）聚合 → 现按 kind/severity 聚合
 */
constraintsRoutes.get('/constraints/stats', async (_req: Request, res: Response) => {
  try {
    const loaded = await loadHarness();
    if (!loaded || !harnessModule) return res.status(503).json({ error: 'Harness not available' });

    const constraints = harnessModule.getEffectiveConstraints(projectRoot());
    const byKind: Record<string, number> = {};
    const bySeverity: Record<string, number> = {};
    for (const c of constraints) {
      byKind[c.kind] = (byKind[c.kind] ?? 0) + 1;
      bySeverity[c.severity] = (bySeverity[c.severity] ?? 0) + 1;
    }
    return res.json({ data: { total: constraints.length, byKind, bySeverity } });
  } catch (error) {
    logger.error('Failed to get constraint stats', { error: String(error) });
    return res.status(500).json({ error: 'Failed to get constraint stats' });
  }
});

/**
 * GET /api/v1/harness/constraints/retired
 * 已退役约束元数据：config.yml constraints.<id>.retired（唯一落点）。
 */
constraintsRoutes.get('/constraints/retired', async (_req: Request, res: Response) => {
  try {
    const retired: Array<{ id: string; enabled: boolean; source: 'config'; retired: unknown }> = [];

    const file = configPath();
    if (fs.existsSync(file)) {
      const raw = (yaml.load(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>) ?? {};
      const constraints = (raw.constraints ?? {}) as Record<string, Record<string, unknown>>;
      for (const [id, v] of Object.entries(constraints)) {
        if (v && typeof v === 'object' && v.retired) {
          retired.push({ id, enabled: v.enabled === true, source: 'config', retired: v.retired });
        }
      }
    }

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
 * POST /api/v1/harness/constraints/propose-upgrade
 * 子项 8（ADR-0033 决策 4）：应用层约束 → 通用层升级提案发起。
 * body: { constraintId, repoRoot? }（repoRoot 缺省 process.cwd()）。
 * 校验该 id 是应用层约束（<repoRoot>/.harness/constraints.yml 里有定义）→ 建 constraint
 * kind 提案卡（action='upgrade'，卡面带条文 + checker 配置 + traces 统计白话）发 #系统。
 * approve 后的 pack-proposal 落点归 constraint-adapter；本端点只发起。不自动开 issue。
 */
constraintsRoutes.post('/constraints/propose-upgrade', async (req: Request, res: Response) => {
  try {
    const { constraintId, repoRoot: rawRoot } = (req.body ?? {}) as { constraintId?: unknown; repoRoot?: unknown };
    if (typeof constraintId !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/i.test(constraintId)) {
      return res.status(400).json({ error: 'constraintId is required (合法约束 id 字符集)' });
    }
    const repoRoot = typeof rawRoot === 'string' && rawRoot ? rawRoot : projectRoot();
    if (!path.isAbsolute(repoRoot) || !fs.existsSync(repoRoot) || !fs.statSync(repoRoot).isDirectory()) {
      return res.status(400).json({ error: `invalid repoRoot: ${repoRoot}（必须是存在的绝对路径目录）` });
    }

    // 校验是应用层约束（constraints.yml 定义正本，id 强制 app_ 前缀由 harness 加载期保证）
    const file = path.join(repoRoot, '.harness', 'constraints.yml');
    const raw = fs.existsSync(file)
      ? ((yaml.load(fs.readFileSync(file, 'utf-8')) as { constraints?: Array<Record<string, unknown>> } | null) ?? {})
      : {};
    const entry = (raw.constraints ?? []).find(e => e?.id === constraintId);
    if (!entry || typeof entry.rule !== 'string') {
      return res.status(404).json({ error: `not-an-app-constraint: ${constraintId}（.harness/constraints.yml 无此条目；内置约束升级请直接联系 harness 仓）` });
    }

    // traces 统计白话（report 读不到 = 零记录口径，不阻断发起；子项 9：统一过 formatConstraintStats）
    let statsText = '暂无使用统计（traces 缺失或零记录）';
    if (typeof buildConstraintsUsageReport === 'function') {
      try {
        const s = buildConstraintsUsageReport(repoRoot).stats.find(x => x.id === constraintId);
        if (s) statsText = formatConstraintStats(s);
      } catch (err) {
        logger.warn('[Harness] propose-upgrade usage report failed', { error: String(err) });
      }
    }

    let adapter;
    try {
      adapter = getConstraintReviewAdapter();
    } catch {
      return res.status(503).json({ error: 'constraint review adapter not registered（EvolutionService 未装配）' });
    }
    const { proposalId, posted } = await submitConstraintUpgradeProposal(adapter, {
      repoRoot,
      entry: {
        id: constraintId,
        rule: entry.rule,
        ...(typeof entry.checker === 'string' ? { checker: entry.checker } : {}),
        ...(entry.params && typeof entry.params === 'object' ? { params: entry.params as Record<string, unknown> } : {}),
        ...(typeof entry.severity === 'string' ? { severity: entry.severity } : {}),
        ...(typeof entry.message === 'string' ? { message: entry.message } : {}),
      },
      statsText,
    });
    return res.json({ success: true, data: { proposalId, posted } });
  } catch (error) {
    logger.error('Failed to propose constraint upgrade', { error: String(error) });
    return res.status(500).json({ error: 'Failed to propose constraint upgrade' });
  }
});

/**
 * POST /api/v1/harness/constraints/:id/rollback
 * 撤销 retire/disable：config.yml 删 constraints.<id> 段；无该 id → 404。
 * js-yaml 重写不保留原文件注释（与 harness CLI 一致）。
 */
constraintsRoutes.post('/constraints/:id/rollback', async (req: Request, res: Response) => {
  try {
    let removed = false;

    const file = configPath();
    if (fs.existsSync(file)) {
      const raw = (yaml.load(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>) ?? {};
      const constraints = (raw.constraints ?? {}) as Record<string, unknown>;
      if (req.params.id in constraints) {
        delete constraints[req.params.id];
        if (Object.keys(constraints).length === 0) delete raw.constraints;
        else raw.constraints = constraints;
        fs.writeFileSync(file, yaml.dump(raw, { lineWidth: 120 }), 'utf-8');
        removed = true;
      }
    }

    if (!removed) {
      return res.status(404).json({ error: `No retire/disable entry for constraint: ${req.params.id}` });
    }

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

    const { operation, taskDescription, projectPath, hasRequirement } = req.body;
    if (!operation) return res.status(400).json({ error: 'operation is required' });

    // Use checkConstraints (checkConstraintsSafe removed in harness 0.13.0)
    // #641：证据标志不可由调用方自报——hasRequirement 剥离，依赖项降级 skip
    const sanitized = sanitizeConstraintContext({ operation: operation as string, taskDescription, projectPath, hasRequirement });
    const result = await harnessModule!.checkConstraints(sanitized.context);

    return res.json({ data: result, ...downgradeAnnotation(sanitized.strippedFlags) });
  } catch (error) {
    logger.error('Failed to check constraints', { error: String(error) });
    return res.status(500).json({ error: 'Failed to check constraints' });
  }
});
