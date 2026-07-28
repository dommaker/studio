/**
 * Review Agent - 跨分支 diff 多立场审查 (daemon async spawn)
 *
 * 唯一职责：reviewDiff() —— 审查 baseRef..headRef 之间的全部变更（拓扑无关，不依赖 worktree），
 * 在 repoPath 中 spawn Claude Code 执行多立场审查，结果经 .review-report.json 回收。
 * 仅供 /review/diff 管理端点（routes.ts）调用；生产审查链路走
 * ReviewDispatcher → reviewer 角色子 WU（AgentLoop + code-review skill）。
 *
 * 2026-07-28: 旧 worktree 路径 review()/reviewParallel() 及 fast-path 物理删除（D7 逾期收尾）。
 */

import { logger } from '@dommaker/studio-shared';
import { formatConstraintsForPrompt } from '@dommaker/studio-shared';
import { execSh } from '@dommaker/studio-shared/node';
import { knowledgeService } from '../knowledge/knowledge-service.js';
import { discoveryExposure } from '../channels/discovery-exposure.service.js';
import { skillLoader } from '@dommaker/studio-skill';
import * as fs from 'fs';
import * as path from 'path';
import type { ReviewResult, ReviewDiffParams } from './types.js';
import type { ReviewReport } from './review-report.js';
import { buildReviewPrompt } from './review-report.js';

/** 审查超时（分钟）— 环境变量覆盖默认值 */
const REVIEW_TIMEOUT_MINUTES = parseInt(process.env.REVIEW_TIMEOUT_MINUTES || '15', 10);

/** P3: 按复杂度动态计算审查超时 (ms) */
function getReviewTimeoutMs(complexity?: 'simple' | 'medium' | 'complex'): number {
  const minutes = { simple: 10, medium: 15, complex: 25 }[complexity || 'medium'] || REVIEW_TIMEOUT_MINUTES;
  return minutes * 60 * 1000;
}

export class ReviewAgent {
  /**
   * 参数化跨分支 diff 审查（拓扑无关）
   *
   * 审查 baseRef..headRef 之间的所有变更，不依赖 worktree。
   * 适用于 main→master、release→main 等任意分支间 diff。
   */
  async reviewDiff(params: ReviewDiffParams): Promise<ReviewResult> {
    const { baseRef, headRef, repoPath, description, acceptanceCriteria, stances } = params;
    const startTime = Date.now();

    try {
      const hasDiff = await this.hasBranchChanges(repoPath, baseRef, headRef);
      if (!hasDiff) {
        const durationMs = Date.now() - startTime;
        logger.info('[ReviewAgent] No diff between refs, auto-approving', { baseRef, headRef, durationMs });
        return { approved: true, score: 100, issues: [], suggestions: [] };
      }

      const constraintSection = formatConstraintsForPrompt('reviewer');
      // AS-022: unified knowledge injection
      let indexSection = '';
      try {
        const knowledgeContext = await knowledgeService.injectContext('reviewer');
        if (knowledgeContext.prompt) indexSection = '\n## 知识检索\n' + knowledgeContext.prompt + '\n';
      } catch { /* best-effort */ }
      // TDD-04: Load reviewer skills for branch diff review too
      const reviewerSkills = skillLoader.load({ agentType: 'reviewer' });
      const skillSection = reviewerSkills.length > 0
        ? '\n' + skillLoader.formatForPrompt(reviewerSkills) + '\n'
        : '';
      const reviewPrompt = constraintSection + indexSection + skillSection + buildReviewPrompt({
        taskDescription: description || `Branch diff: ${baseRef} → ${headRef}`,
        acceptanceCriteria: acceptanceCriteria || [
          `All changes between ${baseRef} and ${headRef} are correct and safe`,
          'No breaking changes unless intended',
          'Tests pass for all modified code paths',
        ],
        cycle: 1,
        stances,
      });

      const promptFile = path.join(repoPath, '.review-prompt.md');
      fs.writeFileSync(promptFile, reviewPrompt, 'utf-8');

      // 写入 .claude/settings.json 使 root daemon 无需 --dangerously-skip-permissions
      // CLI flag 被 root 用户禁用，但 settings-based bypassPermissions 无此限制
      const claudeDir2 = path.join(repoPath, '.claude');
      const settingsPath2 = path.join(claudeDir2, 'settings.json');
      if (!fs.existsSync(settingsPath2)) {
        fs.mkdirSync(claudeDir2, { recursive: true });
        fs.writeFileSync(settingsPath2, JSON.stringify({
          permissions: { defaultMode: 'bypassPermissions' },
        }, null, 2), 'utf-8');
      }

      const cmd = [
        `cd "${repoPath}"`,
        `&&`,
        `cat '${promptFile}'`,
        `|`,
        `claude`,
        `--print`,
        `--output-format json`,
        `--allowedTools "Bash(git diff ${baseRef}..${headRef} --stat),Bash(git diff ${baseRef}..${headRef}),Bash(git log ${baseRef}..${headRef} --oneline),Read,Grep,Glob"`,
        `2>&1`,
      ].join(' ');

      logger.info('[ReviewAgent] Starting branch diff review', { baseRef, headRef, repoPath });

      try {
        await execSh(cmd, {
          cwd: repoPath,
          env: { HOME: `/tmp/execution-review-${Date.now()}` },
          timeoutMs: getReviewTimeoutMs(),
          maxBuffer: 10 * 1024 * 1024,
        });
      } catch (execErr: any) {
        const errMsg = execErr instanceof Error ? execErr.message : String(execErr);
        logger.error('[ReviewAgent] reviewDiff Claude Code failed', { baseRef, headRef, error: errMsg.slice(0, 200) });
        return { approved: false, score: 0, issues: [{ severity: 'error', message: `审查异常: ${errMsg.slice(0, 200)}` }], suggestions: [] };
      }

      const reportPath = path.join(repoPath, '.review-report.json');
      if (!fs.existsSync(reportPath)) {
        logger.warn('[ReviewAgent] reviewDiff report not found, rejecting', { baseRef, headRef });
        return { approved: false, score: 0, issues: [{ severity: 'error', message: '审查报告未生成' }], suggestions: [] };
      }

      const reportJson = fs.readFileSync(reportPath, 'utf-8');
      const report: ReviewReport = JSON.parse(reportJson);

      try { fs.unlinkSync(promptFile); } catch { }
      try { fs.unlinkSync(reportPath); } catch { }

      const totalIssues = report.issues?.length ?? 0;
      const errorIssues = report.issues?.filter(i => i.severity === 'error').length ?? 0;
      const reviewScore = errorIssues > 0 ? 50 : totalIssues > 0 ? 80 : 100;

      const durationMs = Date.now() - startTime;
      logger.info('[ReviewAgent] reviewDiff completed', { baseRef, headRef, approved: report.overallApproved, score: reviewScore, issueCount: totalIssues, durationMs });

      const allIssues = [
        ...(report.issues ?? []).map(i => ({ severity: i.severity, message: i.message, file: i.file, line: i.line })),
        ...(report.acResults ?? []).filter(r => !r.passed).map(r => ({ severity: 'error' as const, message: `AC 未满足: ${r.ac}${r.gap ? ` — ${r.gap}` : ''}` })),
      ];

      knowledgeService.recordPattern({
        type: 'pattern',
        title: `Branch diff (${baseRef}..${headRef}): ${report.overallApproved ? 'APPROVED' : 'REJECTED'}`,
        content: `Diff: ${baseRef}..${headRef}\nIssues: ${totalIssues}\nScore: ${reviewScore}`,
        tags: ['reviewer'],
      }).catch(() => {});

      // G33: 暴露非阻断发现
      const nonBlocking = (report.issues ?? []).filter(i => i.severity === 'warning' || i.severity === 'info');
      if (nonBlocking.length > 0) {
        discoveryExposure.expose(nonBlocking.slice(0, 5).map(i => ({
          source: 'reviewer' as const, type: 'improvement' as const,
          severity: (i.severity === 'warning' ? 'medium' : 'low') as 'medium' | 'low',
          file: i.file || 'unknown', title: i.message.slice(0, 100),
          description: `[Branch diff ${baseRef}..${headRef}] ${i.message}`,
        }))).catch(() => {});
      }

      // FIX #8: error issues 存在时强制 rejected（reviewDiff 路径）
      const totalErrorIssues = allIssues.filter(i => i.severity === 'error').length;
      const finalApproved = totalErrorIssues > 0 ? false : report.overallApproved;
      if (totalErrorIssues > 0 && report.overallApproved) {
        logger.warn('[ReviewAgent] reviewDiff override: error issues present, forcing rejection', {
          baseRef, headRef, totalErrorIssues,
        });
      }

      return { approved: finalApproved, score: reviewScore, issues: allIssues, suggestions: report.suggestions ?? [] };
    } catch (error) {
      logger.error('[ReviewAgent] reviewDiff failed', { baseRef, headRef, error: String(error) });
      return { approved: false, score: 0, issues: [{ severity: 'error', message: `审查异常: ${String(error).slice(0, 200)}` }], suggestions: [] };
    }
  }

  /**
   * 检查两个分支/引用之间是否有差异
   */
  private async hasBranchChanges(repoPath: string, baseRef: string, headRef: string): Promise<boolean> {
    try {
      const { stdout } = await execSh(
        `git diff ${baseRef}..${headRef} --stat 2>/dev/null || echo ""`,
        { cwd: repoPath, timeoutMs: 10_000 },
      );
      return stdout.trim().length > 0;
    } catch {
      return true;
    }
  }
}

export const reviewAgent = new ReviewAgent();
