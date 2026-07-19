/**
 * proposals.routes — Harness 约束进化与提案子路由（T-002）
 *
 * 从 routes.ts 提取（T3 大文件拆分，零行为变更），处理器逐字迁移：
 * - GET  /proposals               列出约束变更提案
 * - POST /proposals/:id/review    审核（接受/拒绝）提案，接受后自动执行
 * - POST /evolve                  自动进化：traces → 诊断 → 提案 → 审核 → 执行
 * - POST /proposals/:id/execute   手动执行已审核的提案
 *
 * 提案持久化于 process.cwd()/.harness/proposals/ 目录（与原实现一致）。
 */

import { Router, Request, Response } from 'express';
import { logger } from '@dommaker/studio-shared';
import { loadHarness, harnessModule, getCollector, getAnalyzer } from './runtime.js';

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

      // Approved → 自动执行
      let executionResult = null;
      if (approved) {
        try {
          await loadHarness();
          const runner = new harnessModule!.ConstraintLifecycleRunner();
          executionResult = runner.execute(proposal);
          proposal.status = executionResult.success ? 'implemented' : 'accepted';
          proposal.executionResult = executionResult;
        } catch (execError) {
          logger.warn('Proposal execution failed, keeping accepted status', { error: String(execError), proposalId: id });
        }
      }

      await writeFile(proposalFile, JSON.stringify(proposal, null, 2));
      return res.json({ data: proposal, executionResult });
    } catch {
      return res.status(404).json({ error: `Proposal not found: ${id}` });
    }
  } catch (error) {
    logger.error('Failed to review proposal', { error: String(error) });
    return res.status(500).json({ error: 'Failed to review proposal' });
  }
});

// ─── Constraint Evolution (T-002) ───

/**
 * POST /api/v1/harness/evolve
 * 自动进化：traces → 诊断 → 提案 → 审核 → 执行
 */
proposalsRoutes.post('/evolve', async (req: Request, res: Response) => {
  try {
    await loadHarness();
    const { autoEvolve } = harnessModule!;

    const { hours, autoApproveLowRisk } = req.body;
    const h = hours || 24;

    // 1. 从文件读取 traces（复用现有 TraceCollector）
    const collector = await getCollector();
    if (!collector) return res.status(503).json({ error: 'Harness not available' });

    const analyzer = await getAnalyzer();
    if (!analyzer) return res.status(503).json({ error: 'Harness not available' });

    // 2. 分析 + 检测异常
    const traces = collector.read({
      timeRange: { start: Date.now() - h * 3600_000, end: Date.now() },
    });
    const summaries = analyzer.analyzeRecent(h);
    const anomalies = analyzer.detectAnomalies(summaries);

    if (anomalies.length === 0) {
      return res.json({ data: { message: 'No anomalies detected', traces: traces.length, summaries: summaries.length } });
    }

    // 3. 调用 harness autoEvolve
    const result = await autoEvolve(traces, anomalies, { autoApproveLowRisk: autoApproveLowRisk !== false });

    // 4. 保存提案到文件
    const { mkdir, writeFile } = await import('fs/promises');
    const { join } = await import('path');
    const proposalsDir = join(process.cwd(), '.harness', 'proposals');
    await mkdir(proposalsDir, { recursive: true });

    for (const proposal of result.proposals) {
      const proposalFile = join(proposalsDir, `${proposal.id}.json`);
      await writeFile(proposalFile, JSON.stringify(proposal, null, 2));
    }

    return res.json({
      data: {
        anomalies: anomalies.length,
        diagnoses: result.diagnoses.length,
        proposals: result.proposals.length,
        autoApproved: result.autoApproved,
        needsReview: result.needsReview,
        executions: result.executions,
        details: result.proposals,
      },
    });
  } catch (error) {
    logger.error('Failed to run auto evolution', { error: String(error) });
    return res.status(500).json({ error: 'Failed to run auto evolution' });
  }
});

/**
 * POST /api/v1/harness/proposals/:id/execute
 * 手动执行已审核的提案
 */
proposalsRoutes.post('/proposals/:id/execute', async (req: Request, res: Response) => {
  try {
    const { readFile, writeFile } = await import('fs/promises');
    const { join } = await import('path');

    const proposalsDir = join(process.cwd(), '.harness', 'proposals');
    const proposalFile = join(proposalsDir, `${req.params.id}.json`);

    try {
      const content = await readFile(proposalFile, 'utf-8');
      const proposal = JSON.parse(content);

      if (proposal.status !== 'accepted' && proposal.status !== 'reviewing') {
        return res.status(400).json({ error: `Cannot execute proposal with status: ${proposal.status}` });
      }

      await loadHarness();
      const runner = new harnessModule!.ConstraintLifecycleRunner();
      const executionResult = runner.execute(proposal);

      proposal.status = executionResult.success ? 'implemented' : 'accepted';
      proposal.executionResult = executionResult;
      proposal.executedAt = Date.now();

      await writeFile(proposalFile, JSON.stringify(proposal, null, 2));
      return res.json({ data: proposal, executionResult });
    } catch {
      return res.status(404).json({ error: `Proposal not found: ${req.params.id}` });
    }
  } catch (error) {
    logger.error('Failed to execute proposal', { error: String(error) });
    return res.status(500).json({ error: 'Failed to execute proposal' });
  }
});
