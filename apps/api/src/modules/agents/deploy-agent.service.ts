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
import { logger, eventBus } from '@dommaker/studio-shared';
import { execSh } from '@dommaker/studio-shared/node';
import { knowledgeBus } from '../knowledge/knowledge-bus.service.js';
import type { DeployParams, DeployResult, DeployFinding } from './types.js';

class DeployAgent {
  async deploy(params: DeployParams): Promise<DeployResult> {
    logger.info('[DeployAgent] Starting deploy', { executionId: params.executionId, environment: params.environment });

    // 1. Merge to master
    const mergeResult = await this.mergeToMaster(params);
    if (!mergeResult.success) return mergeResult;

    // 2. Push to origin
    const pushResult = await this.pushToOrigin(params);
    if (!pushResult.success) return pushResult;

    // 3. Environment-specific deployment
    const deployResult = params.environment === 'vps'
      ? await this.deployVps(params)
      : await this.generateCompanyChecklist(params);

    // 4. Cleanup worktrees + task branches
    await this.cleanupTaskBranches(params);

    eventBus.publish('deploy.completed', { executionId: params.executionId, result: deployResult });

    // Record deploy findings to KnowledgeBus
    const deployFindings = deployResult.findings?.map(f => `[${f.severity}] ${f.category}: ${f.message}`).join('\n') || 'No findings';
    knowledgeBus.recordPattern({
      source: 'deploy',
      type: 'pattern',
      title: `Deploy result: ${deployResult.success ? 'SUCCESS' : 'FAILED'} (${deployResult.type})`,
      content: `${deployResult.summary || 'No summary'}\n\nFindings:\n${deployFindings}`,
      severity: deployResult.success ? 'info' : 'warning',
      timestamp: Date.now(),
    }).catch(() => { /* non-blocking */ });

    logger.info('[DeployAgent] Deploy completed', { executionId: params.executionId, success: deployResult.success });
    return deployResult;
  }

  // ── Merge to master ────────────────────────────────────

  private async mergeToMaster(params: DeployParams): Promise<DeployResult> {
    const repoDir = await this.getRepoDir();
    try {
      // Get the current integration branch name
      const { stdout: branchOut } = await execSh('git -C . rev-parse --abbrev-ref HEAD', {
        cwd: params.worktree,
        timeoutMs: 10_000,
      });
      const branch = branchOut.trim();

      if (branch === 'master' || branch === 'main') {
        logger.info('[DeployAgent] Already on main branch, skipping merge');
        return this.okResult(params);
      }

      logger.info('[DeployAgent] Merging to master', { branch, repoDir });

      // Merge the integration/task branch into master
      await execSh(`git checkout master && git merge "${branch}" --no-edit`, {
        cwd: repoDir,
        timeoutMs: 60_000,
      });

      return this.okResult(params);
    } catch (e) {
      logger.error('[DeployAgent] Merge to master failed', { error: String(e) });
      return {
        success: false, type: params.environment, findings: [],
        summary: `Merge to master failed: ${String(e).slice(0, 200)}`,
      };
    }
  }

  // ── Push to origin ─────────────────────────────────────

  private async pushToOrigin(params: DeployParams): Promise<DeployResult> {
    const repoDir = await this.getRepoDir();
    try {
      logger.info('[DeployAgent] Pushing to origin');
      await execSh('git push origin master', {
        cwd: repoDir,
        timeoutMs: 60_000,
      });
      return this.okResult(params);
    } catch (e) {
      logger.error('[DeployAgent] Push failed', { error: String(e) });
      return {
        success: false, type: params.environment, findings: [],
        summary: `Push failed: ${String(e).slice(0, 200)}`,
      };
    }
  }

  // ── VPS Deploy ─────────────────────────────────────────

  private async deployVps(params: DeployParams): Promise<DeployResult> {
    const repoDir = await this.getRepoDir();
    const tag = `studio-api:${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${params.executionId.slice(0, 8)}`;

    const steps = [
      { desc: 'docker build', cmd: `docker build -t ${tag} .` },
      { desc: 'docker push', cmd: `docker push ${tag}` },
      { desc: 'docker-compose up', cmd: 'docker-compose up -d' },
      { desc: 'health check', cmd: 'curl -f http://localhost:3001/health' },
    ];

    const results: string[] = [];
    for (const step of steps) {
      try {
        logger.info('[DeployAgent] VPS deploy step', { step: step.desc });
        const { stdout } = await execSh(step.cmd, { cwd: repoDir, timeoutMs: 120_000 });
        results.push(`✓ ${step.desc}`);
      } catch (e) {
        logger.error('[DeployAgent] VPS deploy step failed', { step: step.desc, error: String(e) });
        return {
          success: false, type: 'vps', findings: [],
          artifact: tag,
          summary: `VPS deploy failed at "${step.desc}": ${String(e).slice(0, 200)}\n\nCompleted:\n${results.join('\n')}`,
        };
      }
    }

    return {
      success: true, type: 'vps', findings: [],
      artifact: tag,
      summary: `VPS Deploy complete:\n${results.join('\n')}\n\nTag: ${tag}`,
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
   * Delete all task/* branches and their worktrees.
   * Called after successful merge+push — branches already merged to master.
   */
  private async cleanupTaskBranches(params: DeployParams): Promise<void> {
    const repoDir = await this.getRepoDir();
    try {
      // List all task/ branches
      const { stdout } = await execSh(
        'git branch -a | grep "task/" | sed "s/[* ]*remotes\\/origin\\///" | sed "s/^[* ]*//" | sort -u',
        { cwd: repoDir, timeoutMs: 10_000 },
      );
      const branches = stdout.trim().split('\n').filter(Boolean);

      for (const branch of branches) {
        try {
          // Remove worktree first
          await execSh(`git worktree remove --force "$(git worktree list | grep "${branch}" | head -1 | awk "{print \\$1}")" 2>/dev/null || true`, {
            cwd: repoDir, timeoutMs: 10_000,
          });
        } catch { /* worktree may already be gone */ }

        try {
          // Delete remote branch
          await execSh(`git push origin --delete "${branch}" 2>/dev/null || true`, {
            cwd: repoDir, timeoutMs: 15_000,
          });
        } catch { /* may not have remote */ }

        try {
          // Delete local branch
          await execSh(`git branch -D "${branch}" 2>/dev/null || true`, {
            cwd: repoDir, timeoutMs: 10_000,
          });
        } catch { /* may not exist locally */ }

        logger.info('[DeployAgent] Cleaned up task branch', { branch });
      }

      // Prune stale worktree references
      try {
        await execSh('git worktree prune', { cwd: repoDir, timeoutMs: 5_000 });
      } catch { /* non-critical */ }
    } catch (e) {
      logger.warn('[DeployAgent] Branch cleanup failed (non-blocking)', { error: String(e) });
    }

    // Clean up worktree directories on disk
    try {
      const worktreesDir = path.join(require('os').homedir(), 'worktrees');
      if (fs.existsSync(worktreesDir)) {
        const entries = fs.readdirSync(worktreesDir);
        for (const entry of entries) {
          const wtPath = path.join(worktreesDir, entry);
          try {
            if (fs.statSync(wtPath).isDirectory()) {
              fs.rmSync(wtPath, { recursive: true, force: true });
            }
          } catch { /* skip */ }
        }
      }
    } catch (e) {
      logger.warn('[DeployAgent] Worktree directory cleanup failed', { error: String(e) });
    }
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
        return [
          { severity: 'warning', category: 'sql_change', message: `数据库变更: ${sqlFiles.join(', ')}` },
          ...(sqlFiles.some(f => f.includes('migrations'))
            ? [{ severity: 'info', category: 'sql_change', message: '新迁移文件需要 DBA 审批' }]
            : []),
        ];
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

  private okResult(params: DeployParams): DeployResult {
    return { success: true, type: params.environment, findings: [], summary: '' };
  }

  private async getRepoDir(): Promise<string> {
    return process.env.REPO_DIR || path.join(require('os').homedir(), 'projects');
  }
}

export const deployAgent = new DeployAgent();
