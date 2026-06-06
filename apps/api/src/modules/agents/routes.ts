// Agent API 路由
import { Router, Request, Response } from 'express';
import { AgentRegistry } from '@dommaker/studio-agent';
import { prisma } from '../../core/database.js';
import { postEvalAgent } from './post-eval-agent.service.js';
import { reviewAgent } from './review-agent.service.js';
import { deployAgent } from './deploy-agent.service.js';
import { requireNotGuest, requireRole } from '../../middleware/auth.js';
import { eventStore } from '../../core/event-store.js';
import { logger } from '@dommaker/studio-shared';
import type { MergeToMasterRequest } from './types.js';

const router = Router();

// 延迟初始化：首次请求时创建 AgentRegistry 实例
let registry: InstanceType<typeof AgentRegistry>;

async function initRegistry() {
  if (!registry) {
    registry = new AgentRegistry(prisma, eventStore);
  }
  return registry;
}

// 获取 Agent 列表
router.get('/', async (req: Request, res: Response) => {
  try {
    const reg = await initRegistry();
    const { category, tags, page = 1, limit = 20 } = req.query;

    const result = await reg.list({
      category: category as string,
      tags: tags ? (tags as string).split(',') : undefined,
      page: parseInt(page as string),
      limit: parseInt(limit as string),
    });

    res.json({
      data: result.data,
      pagination: {
        page: parseInt(page as string),
        limit: parseInt(limit as string),
        total: result.total,
        totalPages: Math.ceil(result.total / parseInt(limit as string)),
      },
    });
  } catch (error) {
    logger.error('Failed to list agents', { error: String(error) });
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to list agents' },
    });
  }
});

// 注册新 Agent
router.post('/', async (req: Request, res: Response) => {
  try {
    const reg = await initRegistry();
    const metadata = await reg.register(req.body);

    res.status(201).json(metadata);
  } catch (error: any) {
    logger.error('Failed to register agent', { error: String(error) });
    if (error.message?.includes('already exists')) {
      res.status(409).json({
        error: { code: 'AGENT_EXISTS', message: error.message },
      });
    } else {
      res.status(500).json({
        error: { code: 'INTERNAL_ERROR', message: 'Failed to register agent' },
      });
    }
  }
});

// 获取 Agent 详情
router.get('/:agentId', async (req: Request, res: Response) => {
  try {
    const reg = await initRegistry();
    const { agentId } = req.params;
    const { version } = req.query;

    const agent = await reg.get(agentId, version as string);

    if (!agent) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: `Agent ${agentId} not found` },
      });
    }

    res.json(agent);
  } catch (error) {
    logger.error('Failed to get agent', { error: String(error) });
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get agent' },
    });
  }
});

// 更新 Agent
router.put('/:agentId', async (req: Request, res: Response) => {
  try {
    const reg = await initRegistry();
    const { agentId } = req.params;
    const { version } = req.query;

    if (!version) {
      return res.status(400).json({
        error: { code: 'VERSION_REQUIRED', message: 'Version is required' },
      });
    }

    const agent = await reg.update(agentId, version as string, req.body);
    res.json(agent);
  } catch (error: any) {
    logger.error('Failed to update agent', { error: String(error) });
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to update agent' },
    });
  }
});

// 删除 Agent
// 🆕 SEC-002: Admin only
router.delete('/:agentId', requireRole('Admin'), async (req: Request, res: Response) => {
  try {
    const reg = await initRegistry();
    const { agentId } = req.params;
    const { version } = req.query;

    if (!version) {
      return res.status(400).json({
        error: { code: 'VERSION_REQUIRED', message: 'Version is required' },
      });
    }

    await reg.delete(agentId, version as string);
    res.status(204).send();
  } catch (error) {
    logger.error('Failed to delete agent', { error: String(error) });
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to delete agent' },
    });
  }
});

// Plan coverage via PostEval (pre-commit hook)
router.post('/post-eval/plan-coverage', async (req: Request, res: Response) => {
  try {
    const { planPath } = req.body;
    if (!planPath) {
      return res.status(400).json({
        error: { code: 'MISSING_PARAM', message: 'planPath is required' },
      });
    }
    const report = await postEvalAgent.evaluatePlanCoverage(planPath);
    res.json(report);
  } catch (error: any) {
    logger.error('[PostEval] Plan coverage check failed', { error: String(error) });
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Plan coverage check failed' },
    });
  }
});

// ── Review diff between branches ──────────────────────────

router.post('/review/diff', async (req: Request, res: Response) => {
  try {
    const { baseRef, headRef, repoPath, description, acceptanceCriteria, stances } = req.body;
    if (!baseRef || !headRef) {
      return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'baseRef and headRef are required' } });
    }
    const repoDir = repoPath || process.env.REPO_DIR || '/root/projects/studio';
    const result = await reviewAgent.reviewDiff({ baseRef, headRef, repoPath: repoDir, description, acceptanceCriteria, stances });
    res.json(result);
  } catch (error) {
    logger.error('[Agents] Review diff failed', { error: String(error) });
    res.status(500).json({ error: { code: 'REVIEW_FAILED', message: String(error) } });
  }
});

// ── Merge branches (topology-agnostic) ───────────────────

router.post('/deploy/merge', async (req: Request, res: Response) => {
  try {
    const { source, target, repoPath, push } = req.body;
    if (!source || !target) {
      return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'source and target are required' } });
    }
    const result = await deployAgent.mergeBranches({ source, target, repoPath, push });
    res.json(result);
  } catch (error) {
    logger.error('[Agents] Merge branches failed', { error: String(error) });
    res.status(500).json({ error: { code: 'MERGE_FAILED', message: String(error) } });
  }
});

// ── Merge to default branch (convenience composite) ──────

router.post('/deploy/merge-to-master', async (req: Request, res: Response) => {
  try {
    const repoDir = process.env.REPO_DIR || '/root/projects/studio';
    const { getDefaultBranch } = await import('../../utils/git.js');
    const defaultBranch = getDefaultBranch(repoDir);
    const { sourceBranch, skipReview = false, environment = 'vps' } = req.body as MergeToMasterRequest;
    let reviewApproved = true;
    let reviewScore = 100;
    const reviewIssues: any[] = [];

    if (!skipReview) {
      logger.info(`[Agents] merge-to-${defaultBranch}: running review`, { sourceBranch, repoDir });
      const reviewResult = await reviewAgent.reviewDiff({
        baseRef: `origin/${defaultBranch}`,
        headRef: `origin/${sourceBranch}`,
        repoPath: repoDir,
        description: `Merge ${sourceBranch} → ${defaultBranch}: ${sourceBranch} branch commits ahead of ${defaultBranch}`,
      });
      reviewApproved = reviewResult.approved;
      reviewScore = reviewResult.score;
      reviewIssues.push(...reviewResult.issues);

      if (!reviewApproved) {
        return res.status(200).json({ reviewApproved: false, reviewScore, reviewIssues, merged: false, pushed: false, summary: `Review rejected (score: ${reviewScore}). Fix issues before merge.` });
      }
      logger.info(`[Agents] merge-to-${defaultBranch}: review approved`, { sourceBranch, score: reviewScore });
    }

    const mergeResult = await deployAgent.mergeBranches({ source: sourceBranch, target: defaultBranch, repoPath: repoDir, push: true });
    res.status(200).json({ reviewApproved, reviewScore, reviewIssues, merged: mergeResult.merged, pushed: mergeResult.pushed, summary: mergeResult.summary });
  } catch (error) {
    logger.error('[Agents] merge-to-master failed', { error: String(error) });
    res.status(500).json({ error: { code: 'MERGE_TO_MASTER_FAILED', message: String(error) } });
  }
});

export default router;
