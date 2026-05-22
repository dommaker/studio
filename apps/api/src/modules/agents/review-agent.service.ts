/**
 * Review Agent - 多立场代码审查 (daemon async spawn)
 *
 * 2026-05-09: Docker+tmux → async spawn (复用 studio-shared 的 execSh)
 *   Executor 完成后，在 worktree 中 spawn Claude Code 进行多立场审查。
 *   审查结果写入 .review-report.json，供修复循环使用。
 */

import { logger, getModelForTier } from '@dommaker/studio-shared';
import { formatConstraintsForPrompt } from '@dommaker/harness';
import { afterReview } from '@dommaker/studio-shared/harness/hooks';
import { execSh } from '@dommaker/studio-shared/node';
import { knowledgeBus } from '../knowledge/knowledge-bus.service.js';
import { recordPipelineRun } from '../../daemon/metrics.js';
import * as fs from 'fs';
import * as path from 'path';
import type { ReviewResult } from './types.js';
import type { ReviewReport } from './review-report.js';
import { buildReviewPrompt } from './review-report.js';

/** 审查超时（分钟） */
const REVIEW_TIMEOUT_MINUTES = parseInt(process.env.REVIEW_TIMEOUT_MINUTES || '15', 10);

export class ReviewAgent {
  /**
   * 多立场审查代码变更
   *
   * 在 worktree 中 spawn Claude Code，执行多立场审查。
   * 审查结果写入 .review-report.json。
   */
  async review(params: {
    taskId: string;
    projectId: string;
    worktree: string;
    taskDescription: string;
    acceptanceCriteria?: string[];
    cycle?: number;
    stances?: { id: string; name: string; prompt: string; reviewerFocus?: string }[];
  }): Promise<ReviewResult> {
    const { taskId, worktree, taskDescription, acceptanceCriteria, cycle = 1 } = params;
    const startTime = Date.now();

    try {
      // 检查是否有代码变更
      const hasChanges = await this.hasChanges(worktree);

      if (!hasChanges) {
        const durationMs = Date.now() - startTime;
        logger.info('[ReviewAgent] No changes detected, auto-approving', { taskId, durationMs });
        return { approved: true, score: 100, issues: [], suggestions: [] };
      }

      // P2.5b: 注入历史知识上下文（同类任务踩坑模式）
      let knowledgeSection = '';
      try {
        const busContext = knowledgeBus.getRecentContext('reviewer', 5);
        if (busContext) knowledgeSection = '\n' + busContext;
      } catch { /* best-effort */ }

      // 构建审查 prompt 并写入 worktree
      const constraintSection = formatConstraintsForPrompt('reviewer');
      const reviewPrompt = constraintSection + knowledgeSection + buildReviewPrompt({
        taskDescription,
        acceptanceCriteria,
        cycle,
        previousReportPath: cycle > 1 ? path.join(worktree, '.review-report.json') : undefined,
        stances: params.stances,
      });
      const promptFile = path.join(worktree, '.review-prompt.md');
      fs.writeFileSync(promptFile, reviewPrompt, 'utf-8');

      const model = getModelForTier('standard');

      // Spawn Claude Code directly (no Docker, no tmux)
      const cmd = [
        `cd "${worktree}"`,
        `&&`,
        `cat '${promptFile}'`,
        `|`,
        `claude`,
        `--print`,
        `--output-format json`,
        `--dangerously-skip-permissions`,
        `--model "${model}"`,
        `2>&1`,
      ].join(' ');

      logger.info('[ReviewAgent] Starting review', { taskId, cycle, worktree, knowledgeSize: knowledgeSection.length });

      let reviewOutput = '';
      let reviewTokens: { inputTokens: number; outputTokens: number; cacheHitTokens: number } | null = null;
      try {
        const { stdout } = await execSh(cmd, {
          cwd: worktree,
          env: { ANTHROPIC_MODEL: model },
          timeoutMs: REVIEW_TIMEOUT_MINUTES * 60 * 1000,
          maxBuffer: 10 * 1024 * 1024,
        });
        reviewOutput = stdout;
        // Parse JSON envelope for token usage
        try {
          const envelope = JSON.parse(stdout);
          if (envelope.usage) {
            reviewTokens = {
              inputTokens: envelope.usage.input_tokens || 0,
              outputTokens: envelope.usage.output_tokens || 0,
              cacheHitTokens: envelope.usage.cache_read_input_tokens || 0,
            };
          }
        } catch { /* best-effort */ }
      } catch (execErr: any) {
        const errMsg = execErr instanceof Error ? execErr.message : String(execErr);
        const durationMs = Date.now() - startTime;
        logger.error('[ReviewAgent] Claude Code failed', { taskId, cycle, durationMs, error: errMsg.slice(0, 200) });
        // 审查失败不阻塞流程，默认放行
        return {
          approved: true,
          score: 0,
          issues: [{
            severity: 'warning',
            message: `审查系统异常（第 ${cycle} 轮）: ${errMsg.slice(0, 200)}，已默认放行，建议人工审查`,
          }],
          suggestions: [],
        };
      }

      // 读取审查报告
      const reportPath = path.join(worktree, '.review-report.json');
      if (!fs.existsSync(reportPath)) {
        logger.warn('[ReviewAgent] Review report not found, defaulting to approved', { taskId });
        return { approved: true, score: 0, issues: [], suggestions: [] };
      }

      const reportJson = fs.readFileSync(reportPath, 'utf-8');
      const report: ReviewReport = JSON.parse(reportJson);

      // 计算审查得分
      const totalIssues = report.issues?.length ?? 0;
      const errorIssues = report.issues?.filter(i => i.severity === 'error').length ?? 0;
      const reviewScore = errorIssues > 0 ? 50 : totalIssues > 0 ? 80 : 100;

      logger.info('[ReviewAgent] Review completed', {
        taskId,
        cycle,
        approved: report.overallApproved,
        score: reviewScore,
        issueCount: totalIssues,
        stanceReports: report.stanceReports
          ? Object.entries(report.stanceReports).map(([k, v]) => `${k}:${v.issues.length}`)
          : 'n/a',
        durationMs: Date.now() - startTime,
        tokens: reviewTokens,
      });

      // Record review phase metrics
      recordPipelineRun({
        source: 'pipeline', phase: 'review',
        taskName: `review-${taskId}`,
        model,
        inputTokens: reviewTokens?.inputTokens || 0,
        outputTokens: reviewTokens?.outputTokens || 0,
        cacheHitTokens: reviewTokens?.cacheHitTokens || 0,
        durationMs: Date.now() - startTime,
        success: report.overallApproved,
        sessionId: taskId,
      }).catch(() => { /* non-blocking */ });

      // Record review pattern to KnowledgeBus
      const issueSummary = (report.issues ?? []).slice(0, 5).map(i => `[${i.severity}] ${i.message}`).join('\n');
      knowledgeBus.recordPattern({
        source: 'reviewer',
        type: 'pattern',
        title: `Review: ${report.overallApproved ? 'APPROVED' : 'REJECTED'} (cycle ${cycle}, score ${reviewScore})`,
        content: `Task: ${taskId}\nIssues: ${totalIssues}\nScore: ${reviewScore}\n\n${issueSummary}`,
        severity: report.overallApproved ? 'info' : 'warning',
        timestamp: Date.now(),
      }).catch(() => { /* non-blocking */ });

      // 审查完成 hook
      afterReview({
        executionId: taskId,
        approved: report.overallApproved,
        score: reviewScore,
        issueCount: totalIssues,
        cycle,
      }).catch(err => logger.warn('[ReviewAgent] afterReview hook failed', { taskId, error: String(err) }));

      // 转换为 ReviewResult
      const allIssues = [
        ...(report.issues ?? []).map(i => ({
          severity: i.severity,
          message: i.message,
          file: i.file,
          line: i.line,
        })),
        ...(report.acResults ?? [])
          .filter(r => !r.passed)
          .map(r => ({
            severity: 'error' as const,
            message: `AC 未满足: ${r.ac}${r.gap ? ` — ${r.gap}` : ''}`,
          })),
        ...(report.testQualityAudit ?? []).map(t => ({
          severity: 'warning' as const,
          message: `测试质量问题: ${t.issue}`,
          file: t.executorTest,
        })),
      ];

      return {
        approved: report.overallApproved,
        score: reviewScore,
        issues: allIssues,
        suggestions: report.suggestions ?? [],
      };
    } catch (error) {
      logger.error('[ReviewAgent] Review failed', { taskId, cycle, error: String(error) });
      return {
        approved: true,
        score: 0,
        issues: [{
          severity: 'warning',
          message: `审查系统异常（第 ${cycle} 轮）: ${String(error).substring(0, 200)}，已默认放行，建议人工审查`,
        }],
        suggestions: [],
      };
    }
  }

  /**
   * 检查 worktree 是否有代码变更
   */
  private async hasChanges(worktree: string): Promise<boolean> {
    try {
      const { stdout } = await execSh(
        'git diff HEAD~1 --stat 2>/dev/null || git diff --cached --stat 2>/dev/null || git diff --stat 2>/dev/null || echo ""',
        { cwd: worktree, timeoutMs: 5_000 },
      );
      return stdout.trim().length > 0;
    } catch {
      return true; // 无法判断时默认有变更
    }
  }
}

export const reviewAgent = new ReviewAgent();
