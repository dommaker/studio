/**
 * Deploy Agent — merge to master, push, deploy, cleanup
 *
 * Pipeline position: last consumer of integration worktree.
 * Input:  reviewed + QA-passed code in worktree
 * Output: deployed release + cleaned worktrees/branches
 */
import * as fs from 'fs';
import * as path from 'path';
import { prisma } from '@dommaker/studio-prisma';
import { getDefaultBranch } from '../../utils/git.js';
import { logger, eventBus } from '@dommaker/studio-shared';
import { execSh } from '@dommaker/studio-shared/node';
import { knowledgeService } from '../knowledge/knowledge-service.js';
import { recordExecution } from '../../daemon/metrics.js';
import { classifyFailureAction } from '../shared/failure-classifier.js';
import type { DeployParams, DeployResult, DeployFinding, MergeBranchesParams, MergeBranchesResult } from './types.js';

class DeployAgent {
  // O3f: static merge queue for priority-based ordering
  private static mergeQueue: Array<{ executionId: string; projectId: string; priority: string; createdAt: Date }> = [];
  private static mergeInProgress = false;

  /**
   * O3f: Wait for turn in merge queue, ordered by priority then creation time.
   */
  private async acquireMergeSlot(params: DeployParams): Promise<void> {
    const project = await prisma.project.findUnique({ where: { id: params.projectId }, select: { priority: true, createdAt: true, pmoNumber: true } });
    const priority = project?.priority || 'medium';
    const createdAt = project?.createdAt || new Date();

    const entry = { executionId: params.executionId, projectId: params.projectId, priority, createdAt };
    if (!DeployAgent.mergeQueue.some(e => e.executionId === entry.executionId)) {
      DeployAgent.mergeQueue.push(entry);
    }

    // Sort queue: critical > high > medium > low, then by createdAt
    const priorityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    DeployAgent.mergeQueue.sort((a, b) => {
      const pa = priorityOrder[a.priority] ?? 99;
      const pb = priorityOrder[b.priority] ?? 99;
      if (pa !== pb) return pa - pb;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });

    // Wait for our turn with timeout (5 min max to prevent deadlock)
    const queueStart = Date.now();
    const QUEUE_TIMEOUT_MS = 5 * 60 * 1000;
    while (true) {
      const first = DeployAgent.mergeQueue[0];
      if (first?.executionId === params.executionId && !DeployAgent.mergeInProgress) break;
      if (Date.now() - queueStart > QUEUE_TIMEOUT_MS) {
        // Force-release stuck queue
        DeployAgent.mergeQueue = DeployAgent.mergeQueue.filter(e => e.executionId !== params.executionId);
        DeployAgent.mergeInProgress = false;
        logger.error('[DeployAgent] Merge queue timeout — force releasing', { executionId: params.executionId });
        break;
      }
      await new Promise(r => setTimeout(r, 2000));
    }

    DeployAgent.mergeInProgress = true;
    logger.info('[DeployAgent] Acquired merge slot', {
      executionId: params.executionId,
      pmoNumber: project?.pmoNumber,
      queuePosition: DeployAgent.mergeQueue.findIndex(e => e.executionId === params.executionId),
      queueOrder: DeployAgent.mergeQueue.map(e => e.executionId),
    });
  }

  /**
   * O3f: Release merge slot, allowing next in queue to proceed.
   */
  private releaseMergeSlot(executionId: string): void {
    DeployAgent.mergeQueue = DeployAgent.mergeQueue.filter(e => e.executionId !== executionId);
    DeployAgent.mergeInProgress = false;
    logger.info('[DeployAgent] Released merge slot', {
      executionId,
      remainingQueue: DeployAgent.mergeQueue.map(e => e.executionId),
    });
  }

  async deploy(params: DeployParams): Promise<DeployResult> {
    const startTime = Date.now();
    const timings: Record<string, number> = {};
    logger.info('[DeployAgent] Starting deploy', { executionId: params.executionId, environment: params.environment });

    // O3f: Acquire merge queue slot before merging
    await this.acquireMergeSlot(params);

    // 1. Merge to master
    const mergeStart = Date.now();
    const mergeResult = await this.mergeToMaster(params);
    timings.mergeMs = Date.now() - mergeStart;
    if (!mergeResult.success) {
      this.releaseMergeSlot(params.executionId);
      recordExecution({ source: 'execution', phase: 'deploy', taskName: `deploy-${params.executionId}`, model: 'system', inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, durationMs: Date.now() - startTime, success: false, error: mergeResult.summary, sessionId: params.executionId }).catch(() => {});

      // Emit deploy.completed event so Monitor/OKR can track merge failures
      eventBus.publish('deploy.completed', { executionId: params.executionId, result: mergeResult });
      prisma.studioEvent.create({
        data: {
          type: 'deploy.completed',
          source: 'deploy-agent',
          executionId: params.executionId,
          payload: JSON.stringify({
            success: false,
            type: 'merge-failed',
            durationMs: Date.now() - startTime,
            timings,
            failureClass: classifyFailureAction(mergeResult.summary || '').failureClass,
          }),
        },
      }).catch((e: unknown) => { logger.warn('[DeployAgent] StudioEvent write failed', { error: String(e) }); });

      await this.cleanupTaskBranches(params); // cleanup: merge failed, nothing to keep
      return mergeResult;
    }

    // 2. Push to origin (non-blocking — cleanup still runs even if push fails)
    const pushStart = Date.now();
    const pushResult = await this.pushToOrigin(params);
    timings.pushMs = Date.now() - pushStart;

    // 3. Environment-specific deployment (skip if push failed — no reason to deploy what isn't pushed)
    const deployStart = Date.now();
    let deployResult: DeployResult;
    if (!pushResult.success) {
      deployResult = pushResult;
    } else if (params.environment === 'vps') {
      // VPS: systemd + tsx 自动重编译，merge+push 即完成部署
      deployResult = { success: true, type: 'vps', findings: [], summary: 'Pushed to master — systemd auto-restarts with tsx recompilation' };
    } else {
      deployResult = await this.generateCompanyChecklist(params);
    }
    timings.deployMs = Date.now() - deployStart;

    // O3f: Release merge slot so next in queue can proceed
    this.releaseMergeSlot(params.executionId);

    // 4. Cleanup worktrees + task branches (always run, regardless of push/deploy outcome)
    const cleanupStart = Date.now();
    const cleanupCount = await this.cleanupTaskBranches(params);
    timings.cleanupMs = Date.now() - cleanupStart;

    const durationMs = Date.now() - startTime;

    eventBus.publish('deploy.completed', { executionId: params.executionId, result: deployResult });

    // T3: Enrich failure event with failureClass for OKR/monitoring
    const failureClass = !deployResult.success
      ? classifyFailureAction(deployResult.summary || '').failureClass
      : undefined;

    // Persist deploy.completed to StudioEvent for OKR/monitoring
    prisma.studioEvent.create({
      data: {
        type: 'deploy.completed',
        source: 'deploy-agent',
        executionId: params.executionId,
        payload: JSON.stringify({
          success: deployResult.success,
          type: deployResult.type,
          durationMs,
          timings,
          ...(failureClass ? { failureClass } : {}),
        }),
      },
    }).catch((e: unknown) => { logger.warn('[DeployAgent] StudioEvent write failed', { error: String(e) }); });

    // Record deploy findings to KnowledgeBus
    const deployFindings = deployResult.findings?.map(f => `[${f.severity}] ${f.category}: ${f.message}`).join('\n') || 'No findings';
    knowledgeService.recordPattern({
      type: 'pattern',
      title: `Deploy result: ${deployResult.success ? 'SUCCESS' : 'FAILED'} (${deployResult.type})`,
      content: `${deployResult.summary || 'No summary'}\n\nFindings:\n${deployFindings}`,
      tags: ['deploy'],
    }).catch(() => { /* non-blocking */ });

    // Record deploy phase metrics
    recordExecution({
      source: 'execution', phase: 'deploy',
      taskName: `deploy-${params.executionId}`,
      model: 'system',
      inputTokens: 0, outputTokens: 0, cacheHitTokens: 0,
      durationMs,
      success: deployResult.success,
      error: deployResult.success ? undefined : deployResult.summary,
      sessionId: params.executionId,
    }).catch(() => { /* non-blocking */ });

    logger.info('[DeployAgent] Deploy completed', {
      executionId: params.executionId, success: deployResult.success,
      durationMs, timings, cleanupCount,
    });
    return deployResult;
  }

  // ── Merge branches (topology-agnostic) ─────────────────

  /**
   * Merge source branch into target branch.
   * Does NOT assume main or master — caller specifies both.
   */
  async mergeBranches(params: MergeBranchesParams): Promise<MergeBranchesResult> {
    const repoDir = params.repoPath || await this.getRepoDir();
    const { source, target, push = false } = params;

    try {
      logger.info('[DeployAgent] mergeBranches', { source, target, repoDir, push });

      try {
        await execSh(`git fetch origin ${target} ${source} 2>/dev/null || true`, { cwd: repoDir, timeoutMs: 30_000 });
      } catch { /* no remote — use local branches */ }

      const sourceRef = await this.resolveRef(repoDir, source);

      await execSh(`git checkout ${target} && git merge "${sourceRef}" --no-edit`, { cwd: repoDir, timeoutMs: 60_000 });

      const result: MergeBranchesResult = {
        success: true, merged: true, pushed: false,
        summary: `Merged ${source} → ${target} successfully`,
      };

      if (push) {
        const pushResult = await this.pushBranch({ branch: target, repoDir });
        result.pushed = pushResult.success;
        result.summary += pushResult.success
          ? `, pushed to origin/${target}`
          : `, push failed: ${pushResult.summary}`;
        if (!pushResult.success) {
          result.success = result.merged;
          logger.warn('[DeployAgent] mergeBranches merge OK but push failed', { source, target });
        }
      }

      // Delete source branch after successful merge (not default branch)
      const defaultBranch = getDefaultBranch(repoDir);
      if (result.merged && source !== defaultBranch) {
        await this.deleteBranch(source, repoDir);
      }

      return result;
    } catch (e) {
      try { await execSh('git merge --abort 2>/dev/null || true', { cwd: repoDir, timeoutMs: 5_000 }); } catch { }
      logger.error('[DeployAgent] mergeBranches failed', { source, target, error: String(e) });
      return { success: false, merged: false, pushed: false, summary: `Merge ${source} → ${target} failed: ${String(e).slice(0, 200)}` };
    }
  }

  /**
   * Push a branch to origin.
   * Pre-flight: git ls-remote --heads origin checks connectivity before push.
   */
  async pushBranch(params: { branch: string; repoDir?: string }): Promise<{ success: boolean; summary: string }> {
    const repoDir = params.repoDir || await this.getRepoDir();
    try {
      // Pre-flight: lightweight connectivity probe (few KB, no data transfer)
      await execSh(`git ls-remote --heads origin 2>&1`, { cwd: repoDir, timeoutMs: 15_000 });
    } catch (e) {
      const err = String(e).slice(0, 200);
      logger.error('[DeployAgent] Pre-flight connectivity check failed — cannot reach origin', { branch: params.branch, error: err });
      await this.emitPushFailedAlert(params.branch, `Cannot reach origin: ${err}`);
      return { success: false, summary: `Push aborted — cannot reach origin: ${err}` };
    }
    try {
      logger.info('[DeployAgent] pushBranch', { branch: params.branch });
      await execSh(`git push origin ${params.branch}`, { cwd: repoDir, timeoutMs: 60_000 });
      return { success: true, summary: `Pushed origin/${params.branch}` };
    } catch (e) {
      const err = String(e).slice(0, 200);
      logger.error('[DeployAgent] pushBranch failed', { branch: params.branch, error: err });
      await this.emitPushFailedAlert(params.branch, err);
      return { success: false, summary: `Push failed: ${err}` };
    }
  }

  // ── Merge to master ────────────────────────────────────

  private async mergeToMaster(params: DeployParams): Promise<DeployResult> {
    const repoDir = await this.getRepoDir();
    const defaultBranch = getDefaultBranch(repoDir);
    try {
      const { stdout: branchOut } = await execSh('git -C . rev-parse --abbrev-ref HEAD', {
        cwd: params.worktree,
        timeoutMs: 10_000,
      });
      const branch = branchOut.trim();

      if (branch === defaultBranch) {
        logger.info(`[DeployAgent] Already on ${defaultBranch}, skipping merge`);
        return this.okResult(params);
      }

      logger.info(`[DeployAgent] Merging to ${defaultBranch}`, { branch, repoDir, worktree: params.worktree });
      // Fix #1 (repo selection) ensures task branch exists in repoDir's git DB
      await execSh(`git checkout ${defaultBranch} && git merge "${branch}" --no-edit`, { cwd: repoDir, timeoutMs: 60_000 });

      return this.okResult(params);
    } catch (e) {
      const errMsg = String(e).slice(0, 200);
      logger.error(`[DeployAgent] Merge to ${defaultBranch} failed`, { error: errMsg });
      // B11-007: Resolution 查询 — 已知解法匹配
      let resolutionHint = '';
      try {
        const { resolutionService } = await import('../knowledge/resolution.service.js');
        const matched = await resolutionService.matchResolutions({ errorMessage: errMsg });
        if (matched.resolutions.length > 0) {
          resolutionHint = `\n已知解法: ${matched.resolutions[0].fix}`;
          logger.info('[DeployAgent] Resolution matched', { title: matched.resolutions[0].title });
          // B13-001: Verify matched resolution (pending→verified→canonical)
          try { await knowledgeService.verifyResolution(matched.resolutions[0].id); } catch { /* non-blocking */ }
        }
      } catch { /* best-effort */ }
      // B11-009: LLM 兜底 — 未知场景升级到 LLM 推理
      if (!resolutionHint) {
        try {
          const { modelGateway } = await import('@dommaker/studio-shared');
          const llmHint = await modelGateway.prompt(
            `Git merge 失败:\n${errMsg}\n\n请简要分析根因并建议修复策略（1-3 句话）。`,
            '你是 DevOps 专家。简短回答，给出可执行的修复建议。',
          );
          if (llmHint) resolutionHint = `\nLLM 建议: ${llmHint}`;
          logger.info('[DeployAgent] LLM fallback diagnosis (merge)', { hint: llmHint?.slice(0, 200) });
        } catch { /* LLM unavailable */ }
      }
      return { success: false, type: params.environment, findings: [], summary: `Merge to ${defaultBranch} failed: ${errMsg}${resolutionHint}` };
    }
  }

  // ── Push to origin ─────────────────────────────────────

  private async pushToOrigin(params: DeployParams): Promise<DeployResult> {
    const repoDir = await this.getRepoDir();
    const defaultBranch = getDefaultBranch(repoDir);
    const maxRetries = 3;
    let lastError = '';

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // Pre-flight INSIDE retry loop — connectivity may recover
        await execSh(`git ls-remote --heads origin 2>&1`, { cwd: repoDir, timeoutMs: 15_000 });
        logger.info(`[DeployAgent] Pushing to origin (attempt ${attempt + 1}/${maxRetries})`);
        await execSh(`git push origin ${defaultBranch}`, {
          cwd: repoDir,
          timeoutMs: 120_000,
        });
        return this.okResult(params);
      } catch (e) {
        lastError = String(e);
        if (attempt < maxRetries - 1) {
          const delay = Math.pow(2, attempt) * 10_000;
          logger.warn(`[DeployAgent] Push failed, retrying in ${delay / 1000}s`, { attempt: attempt + 1, error: lastError.slice(0, 100) });
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }
    logger.error('[DeployAgent] Push failed after all retries', { retries: maxRetries, error: lastError });
    await this.emitPushFailedAlert(defaultBranch, lastError);
    // B11-007: Resolution 查询 — 已知解法匹配
    let resolutionHint = '';
    try {
      const { resolutionService } = await import('../knowledge/resolution.service.js');
      const matched = await resolutionService.matchResolutions({ errorMessage: lastError });
      if (matched.resolutions.length > 0) {
        resolutionHint = `\n已知解法: ${matched.resolutions[0].fix}`;
        logger.info('[DeployAgent] Resolution matched', { title: matched.resolutions[0].title });
        // B13-001: Verify matched resolution (pending→verified→canonical)
        try { await knowledgeService.verifyResolution(matched.resolutions[0].id); } catch { /* non-blocking */ }
      }
    } catch { /* best-effort */ }
    // B11-009: LLM 兜底 — 未知场景升级到 LLM 推理
    if (!resolutionHint) {
      try {
        const { modelGateway } = await import('@dommaker/studio-shared');
        const llmHint = await modelGateway.prompt(
          `Git push 失败 (重试 ${maxRetries} 次):\n${lastError.slice(0, 500)}\n\n请简要分析根因并建议修复策略（1-3 句话）。`,
          '你是 DevOps 专家。简短回答，给出可执行的修复建议。',
        );
        if (llmHint) resolutionHint = `\nLLM 建议: ${llmHint}`;
        logger.info('[DeployAgent] LLM fallback diagnosis (push)', { hint: llmHint?.slice(0, 200) });
      } catch { /* LLM unavailable */ }
    }
    return {
      success: false, type: params.environment, findings: [],
      summary: `Push failed after ${maxRetries} attempts: ${lastError.slice(0, 200)}${resolutionHint}`,
    };
  }

  // ── Company Checklist ──────────────────────────────────

  private async generateCompanyChecklist(params: DeployParams): Promise<DeployResult> {
    const findings = [
      ...(await this.checkAcCompletion(params)),
      ...(await this.detectSqlChanges(params)),
      ...(await this.detectDependencyChanges(params)),
    ];

    const isBackend = params.environment === 'company_backend';
    const hasSqlChanges = findings.some(f => f.category === 'sql_change' && f.message.includes('migrations'));

    const lines = [
      '## 发布清单',
      '',
      `**执行 ID**: ${params.executionId.slice(0, 8)}`,
      `**时间**: ${new Date().toISOString()}`,
      '',
      '### 变更摘要',
      ...findings.map(f => `- [${f.severity === 'info' ? 'i' : '!'}] ${f.message}`),
      ...(hasSqlChanges && isBackend ? [
        '', '### DBA 提交单', '',
        '请 DBA 团队审批数据库变更：', '- 检查 schema.prisma 变更', '- 检查 prisma/migrations/ 新增迁移',
        '', '负责人: ________   日期: ________',
      ] : []),
      '', '### 回归测试建议', '- [ ] E2E 测试通过', '- [ ] API 集成测试通过',
      ...(isBackend ? ['- [ ] 数据库迁移回滚测试'] : []),
    ];

    return { success: true, type: params.environment, findings, summary: lines.join('\n') };
  }

  // ── Cleanup ────────────────────────────────────────────

  /**
   * Delete a single branch (local + remote) and its worktree if any.
   */
  private async deleteBranch(branch: string, repoDir: string): Promise<void> {
    try {
      // Remove worktree first
      await execSh(`git worktree remove --force "$(git worktree list | grep "${branch}" | head -1 | awk "{print \\$1}")" 2>/dev/null || true`, {
        cwd: repoDir, timeoutMs: 10_000,
      });
    } catch { /* worktree may not exist */ }

    try {
      await execSh(`git push origin --delete "${branch}" 2>/dev/null || true`, {
        cwd: repoDir, timeoutMs: 15_000,
      });
    } catch { /* may not have remote */ }

    try {
      await execSh(`git branch -D "${branch}" 2>/dev/null || true`, {
        cwd: repoDir, timeoutMs: 10_000,
      });
    } catch { /* may not exist locally */ }

    logger.debug('[DeployAgent] Branch deleted', { branch });
  }

  /**
   * Delete all stale branches: task/*, daemon/*, worktree-* and their worktrees.
   * Called after successful merge+push.
   */
  private async cleanupTaskBranches(params: DeployParams): Promise<number> {
    const repoDir = await this.getRepoDir();
    let cleanedBranches = 0;
    let cleanedDirs = 0;
    try {
      // Scope: task/* by execution IDs, daemon/* and worktree-* always full cleanup
      const { stdout } = await execSh(
        `git branch | grep -E "(task/|daemon/|worktree-)" | sed "s/^[* ]*//" | sort -u`,
        { cwd: repoDir, timeoutMs: 10_000 },
      );
      const branches = stdout.trim().split('\n').filter(Boolean);

      for (const branch of branches) {
        // B5-C01: Only delete branches belonging to this execution
        if (params.executionIds?.length) {
          if (branch.startsWith('task/')) {
            const branchExecId = branch.slice('task/'.length);
            if (!params.executionIds.includes(branchExecId)) continue;
          } else {
            // daemon/* and worktree-*: skip unless branch name contains an executionId
            const belongsToThis = params.executionIds.some(id => branch.includes(id));
            if (!belongsToThis) continue;
          }
        }
        await this.deleteBranch(branch, repoDir);
        cleanedBranches++;
      }

      // Prune stale worktree references
      try {
        await execSh('git worktree prune', { cwd: repoDir, timeoutMs: 5_000 });
      } catch { /* non-critical */ }
    } catch (e) {
      logger.warn('[DeployAgent] Branch cleanup failed (non-blocking)', { error: String(e) });
    }

    // Clean up worktree directories on disk (scoped to execution IDs)
    // OBS-3: Preserve .agent.log to persistent session storage before deleting
    try {
      const worktreesDir = path.join(require('os').homedir(), 'worktrees');
      const sessionsDir = path.join(require('os').homedir(), '.studio', 'sessions');
      if (fs.existsSync(worktreesDir)) {
        const entries = fs.readdirSync(worktreesDir);
        for (const entry of entries) {
          if (params.executionIds?.length) {
            if (!params.executionIds.some(id => entry === id)) continue;
          } else {
            logger.warn('[DeployAgent] No execution IDs for cleanup, skipping worktree cleanup');
            break;
          }
          const wtPath = path.join(worktreesDir, entry);
          try {
            if (!fs.statSync(wtPath).isDirectory()) continue;

            // OBS-3: Copy .agent.log before deleting worktree
            const agentLog = path.join(wtPath, '.agent.log');
            if (fs.existsSync(agentLog)) {
              fs.mkdirSync(sessionsDir, { recursive: true });
              const dest = path.join(sessionsDir, `${entry}-${Date.now()}.log`);
              fs.copyFileSync(agentLog, dest);
              logger.debug('[DeployAgent] Preserved session log', { executionId: entry, dest });
            }

            fs.rmSync(wtPath, { recursive: true, force: true });
            cleanedDirs++;
          } catch { /* skip */ }
        }
      }
    } catch (e) {
      logger.warn('[DeployAgent] Worktree directory cleanup failed', { error: String(e) });
    }

    if (cleanedBranches > 0 || cleanedDirs > 0) {
      logger.info('[DeployAgent] Cleanup summary', { cleanedBranches, cleanedDirs });
    }
    return cleanedBranches + cleanedDirs;
  }

  // ── Checks (unchanged from original) ────────────────────

  private async checkAcCompletion(params: DeployParams): Promise<DeployFinding[]> {
    const progressPath = path.join(params.worktree, '.progress.json');
    try {
      if (fs.existsSync(progressPath)) {
        const progress = JSON.parse(fs.readFileSync(progressPath, 'utf-8'));
        const completed = progress.completedSteps?.length || 0;
        const total = progress.totalSteps || 0;
        if (total > 0 && completed < total) {
          return [{ severity: 'blocker', category: 'ac_completion', message: `AC 完成 ${completed}/${total}` }];
        }
        return [{ severity: 'info', category: 'ac_completion', message: `All ${total} ACs completed` }];
      }
      return [{ severity: 'warning', category: 'ac_completion', message: '.progress.json not found' }];
    } catch (e) {
      return [{ severity: 'warning', category: 'ac_completion', message: `Failed to read .progress.json: ${String(e)}` }];
    }
  }

  private async detectSqlChanges(params: DeployParams): Promise<DeployFinding[]> {
    try {
      const { stdout } = await execSh('git diff HEAD~1 --name-only 2>/dev/null || echo ""', {
        cwd: params.worktree, timeoutMs: 10_000,
      });
      const sqlFiles = stdout.trim().split('\n').filter(f =>
        f.includes('schema.prisma') || f.includes('prisma/migrations/') || f.endsWith('.sql'));
      if (sqlFiles.length > 0) {
        const findings: DeployFinding[] = [
          { severity: 'warning', category: 'sql_change', message: `数据库变更: ${sqlFiles.join(', ')}` },
        ];
        if (sqlFiles.some(f => f.includes('migrations'))) {
          findings.push({ severity: 'info', category: 'sql_change', message: '新迁移文件需要 DBA 审批' });
        }
        return findings;
      }
      return [{ severity: 'info', category: 'sql_change', message: 'No database changes' }];
    } catch (e) {
      return [{ severity: 'warning', category: 'sql_change', message: `SQL detection failed: ${String(e)}` }];
    }
  }

  private async detectDependencyChanges(params: DeployParams): Promise<DeployFinding[]> {
    try {
      const { stdout } = await execSh('git diff HEAD~1 --name-only 2>/dev/null || echo ""', {
        cwd: params.worktree, timeoutMs: 10_000,
      });
      const depFiles = stdout.trim().split('\n').filter(f =>
        /^(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/.test(f));
      if (depFiles.length > 0) {
        return [{ severity: 'warning', category: 'dependency_change', message: `依赖变更: ${depFiles.join(', ')}` }];
      }
      return [{ severity: 'info', category: 'dependency_change', message: 'No dependency changes' }];
    } catch (e) {
      return [{ severity: 'warning', category: 'dependency_change', message: `Dependency check failed: ${String(e)}` }];
    }
  }

  // ── Helpers ────────────────────────────────────────────

  /**
   * Emit deploy_push_failed alert via StudioEvent for Monitor to pick up.
   */
  private async emitPushFailedAlert(branch: string, error: string): Promise<void> {
    try {
      await prisma.studioEvent.create({
        data: {
          type: 'deploy_push_failed',
          source: 'deploy-agent',
          payload: JSON.stringify({ branch, error: error.slice(0, 500), timestamp: Date.now() }),
        },
      });
    } catch (e) {
      logger.warn('[DeployAgent] Failed to emit push failed alert', { error: String(e) });
    }
  }

  private okResult(params: DeployParams): DeployResult {
    return { success: true, type: params.environment, findings: [], summary: '' };
  }

  private async getRepoDir(): Promise<string> {
    return process.env.REPO_DIR || path.join(require('os').homedir(), 'projects');
  }

  /**
   * Resolve a branch ref: prefer origin/<branch> if it exists, fall back to local branch.
   */
  private async resolveRef(repoDir: string, branch: string): Promise<string> {
    try {
      await execSh(`git rev-parse --verify "origin/${branch}" 2>/dev/null`, { cwd: repoDir, timeoutMs: 5_000 });
      return `origin/${branch}`;
    } catch {
      return branch;
    }
  }
}

export const deployAgent = new DeployAgent();
