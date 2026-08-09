/**
 * proposals.routes — Harness 约束提案子路由（T-002）
 *
 * 从 routes.ts 提取（T3 大文件拆分），harness 0.17.0 适配（ADR-0001 决策 8）：
 * - GET  /proposals               列出约束变更提案
 * - POST /proposals/:id/review    审核（接受/拒绝）提案，仅更新状态落盘
 * - POST /proposals/:id/execute   410 Gone（自动执行已移除）
 *
 * POST /evolve 已随 harness 0.17.0 移除（autoEvolve 删除）。
 * ConstraintLifecycleRunner 已删除：提案只是"人看的建议记录"，
 * accepted 后由人工实施，再经 harness constraints retire/report 闭环。
 *
 * 提案持久化于 process.cwd()/.harness/proposals/ 目录（与原实现一致）。
 */

import { Router, Request, Response } from 'express';
import { logger } from '@dommaker/studio-shared';

export const proposalsRoutes = Router();

/**
 * GET /api/v1/harness/proposals
 * List constraint change proposals
 */
proposalsRoutes.get('/proposals', async (_req: Request, res: Response) => {
  try {
    // Proposals are stored in .harness/proposals/ directory
    const { readdir, readFile } = await import('fs/promises');
    const { join } = await import('path');

    const proposalsDir = join(process.cwd(), '.harness', 'proposals');
    try {
      const files = await readdir(proposalsDir);
      const proposals = [];
      for (const file of files.filter(f => f.endsWith('.json'))) {
        try {
          const content = await readFile(join(proposalsDir, file), 'utf-8');
          proposals.push(JSON.parse(content));
        } catch {
          // skip invalid files
        }
      }
      return res.json({ data: proposals, total: proposals.length });
    } catch {
      return res.json({ data: [], total: 0 });
    }
  } catch (error) {
    logger.error('Failed to list proposals', { error: String(error) });
    return res.status(500).json({ error: 'Failed to list proposals' });
  }
});

/**
 * POST /api/v1/harness/proposals/:id/review
 * Accept or reject a proposal
 */
proposalsRoutes.post('/proposals/:id/review', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { approved, comment } = req.body;

    if (typeof approved !== 'boolean') {
      return res.status(400).json({ error: 'approved (boolean) is required' });
    }

    const { readFile, writeFile } = await import('fs/promises');
    const { join } = await import('path');

    const proposalsDir = join(process.cwd(), '.harness', 'proposals');
    const proposalFile = join(proposalsDir, `${id}.json`);

    try {
      const content = await readFile(proposalFile, 'utf-8');
      const proposal = JSON.parse(content);
      proposal.status = approved ? 'accepted' : 'rejected';
      proposal.reviewComment = comment;
      proposal.reviewedAt = Date.now();

      // harness 0.17.0 起不再有自动执行（ConstraintLifecycleRunner 删除，ADR-0001 决策 8）：
      // 提案只是"人看的建议记录"，accepted 后由人工实施，再经 harness constraints retire/report 闭环。

      await writeFile(proposalFile, JSON.stringify(proposal, null, 2));
      return res.json({ data: proposal, executionResult: null });
    } catch {
      return res.status(404).json({ error: `Proposal not found: ${id}` });
    }
  } catch (error) {
    logger.error('Failed to review proposal', { error: String(error) });
    return res.status(500).json({ error: 'Failed to review proposal' });
  }
});

// ─── Constraint Evolution (T-002) ───
// POST /evolve 已随 harness 0.17.0 移除：autoEvolve / ConstraintEvolver 删除
// （ADR-0001 决策 8，约束进化链路退役）。

/**
 * POST /api/v1/harness/proposals/:id/execute
 * 410 Gone：提案自动执行已随 harness 0.17.0 移除（ConstraintLifecycleRunner 删除，
 * ADR-0001 决策 8）。提案仅作人工建议记录；accepted 后请人工实施，
 * 再经 `harness constraints retire/report` 流程闭环。
 */
proposalsRoutes.post('/proposals/:id/execute', async (req: Request, res: Response) => {
  try {
    const { readFile } = await import('fs/promises');
    const { join } = await import('path');

    const proposalsDir = join(process.cwd(), '.harness', 'proposals');
    const proposalFile = join(proposalsDir, `${req.params.id}.json`);

    try {
      await readFile(proposalFile, 'utf-8');
    } catch {
      return res.status(404).json({ error: `Proposal not found: ${req.params.id}` });
    }
    return res.status(410).json({
      error: 'Proposal auto-execution was removed in harness 0.17.0. '
        + 'Apply the proposal manually, then close the loop via `harness constraints retire/report`.',
    });
  } catch (error) {
    logger.error('Failed to execute proposal', { error: String(error) });
    return res.status(500).json({ error: 'Failed to execute proposal' });
  }
});
