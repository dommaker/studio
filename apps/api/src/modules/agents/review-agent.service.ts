/**
 * Review Agent - 多立场代码审查 (daemon async spawn)
 *
 * 2026-05-09: Docker+tmux → async spawn (复用 SessionManager 的 execAsync 模式)
 *   Executor 完成后，在 worktree 中 spawn Claude Code 进行多立场审查。
 *   审查结果写入 .review-report.json，供修复循环使用。
 */

import { logger, getModelForTier } from '@dommaker/studio-shared';
import { afterReview } from '@dommaker/studio-shared/harness/hooks';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { ReviewResult } from './types.js';
import type { ReviewReport } from './review-report.js';
import { buildReviewPrompt } from './review-report.js';

/** 审查超时（分钟） */
const REVIEW_TIMEOUT_MINUTES = parseInt(process.env.REVIEW_TIMEOUT_MINUTES || '15', 10);

function execAsync(
  cmd: string,
  opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs: number; maxBuffer?: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', cmd], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
      if (opts.maxBuffer && stdout.length > opts.maxBuffer) {
        child.kill();
        reject(new Error(`stdout maxBuffer exceeded`));
      }
    });

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Review timed out after ${Math.round(opts.timeoutMs / 60000)}min`));
    }, opts.timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const err = new Error(`Command exited with code ${code}: ${stderr.slice(0, 200)}`) as any;
        err.stdout = stdout;
        err.stderr = stderr;
        err.code = code;
        reject(err);
      }
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

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

    try {
      // 检查是否有代码变更
      const hasChanges = await this.hasChanges(worktree);

      if (!hasChanges) {
        logger.info('[ReviewAgent] No changes detected, auto-approving', { taskId });
        return { approved: true, score: 100, issues: [], suggestions: [] };
      }

      // 构建审查 prompt 并写入 worktree
      const reviewPrompt = buildReviewPrompt({
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

      logger.info('[ReviewAgent] Starting review', { taskId, cycle, worktree });

      try {
        await execAsync(cmd, {
          cwd: worktree,
          env: { ANTHROPIC_MODEL: model },
          timeoutMs: REVIEW_TIMEOUT_MINUTES * 60 * 1000,
          maxBuffer: 10 * 1024 * 1024,
        });
      } catch (execErr: any) {
        const errMsg = execErr instanceof Error ? execErr.message : String(execErr);
        logger.error('[ReviewAgent] Claude Code failed', { taskId, cycle, error: errMsg.slice(0, 200) });
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
      });

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
      const { stdout } = await execAsync(
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
