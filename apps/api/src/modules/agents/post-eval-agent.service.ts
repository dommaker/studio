/**
 * PostEval Agent — 交付完整性审计 (2026-05-21)
 *
 * 对比计划 vs 实际：AC 实现了没？遗漏了什么？多做了什么？
 *
 * Hybrid Agent: 80% 纯代码 + 20% LLM (语义匹配)
 */

import { prisma } from '@dommaker/studio-prisma';
import { logger, modelGateway } from '@dommaker/studio-shared';
import { channelMessageService } from '../channels/channel-message.service.js';
import { knowledgeBus } from '../knowledge/knowledge-bus.service.js';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

interface GapReport {
  goalId: string;
  goalTitle: string;
  totalAcs: number;
  matchedAcs: string[];
  missedAcs: string[];
  extraChanges: string[];
  completeness: number;  // 0-1
}

class PostEvalAgent {
  /**
   * Goal 完成后触发 — 比对 RequirementsDoc AC 和实际 git diff
   */
  async evaluate(goalId: string, sourceChannelId?: string): Promise<GapReport | null> {
    try {
      // P2.5b: Load historical post-eval patterns for comparison
      try {
        const ctx = knowledgeBus.getRecentContext('posteval', 5);
        if (ctx) logger.info('[PostEval] Historical eval context loaded');
      } catch { /* non-blocking */ }

      // 1. 获取 Goal 和关联的 RequirementsDoc
      const goal = await prisma.goal.findUnique({
        where: { id: goalId },
        select: { id: true, title: true, context: true, status: true, companyId: true },
      });
      if (!goal) return null;

      const ctx = (goal.context as unknown as Record<string, unknown>) || {};
      const docId = ctx.requirementsDocId as string | undefined;
      if (!docId) {
        logger.info('[PostEval] No requirementsDocId in goal context, skipping');
        return null;
      }

      const doc = await prisma.requirementsDoc.findUnique({ where: { id: docId } });
      if (!doc) return null;

      // 2. 解析 AC
      const acs = this.extractAcs(doc.content);
      if (acs.length === 0) return null;

      // 3. 获取 git diff (从 GoalExecution 的 worktree 或 REPO_DIR)
      const changes = await this.getExecutionChanges(goalId);

      // 4. LLM 语义匹配: 每个 AC → 是否在 changes 中有对应实现
      const report = await this.matchAcsToChanges(goal.title, acs, changes);

      // 5. 计算完成度
      report.completeness = acs.length > 0 ? report.matchedAcs.length / acs.length : 0;

      // 6. 推送 gap report 到 Channel
      if (sourceChannelId) {
        await this.pushGapReport(sourceChannelId, report);
      }

      logger.info('[PostEval] Evaluation complete', {
        goalId,
        completeness: Math.round(report.completeness * 100) + '%',
        matched: report.matchedAcs.length,
        missed: report.missedAcs.length,
      });

      // Record gap findings to KnowledgeBus
      knowledgeBus.recordPattern({
        source: 'posteval',
        type: 'pattern',
        title: `PostEval gap: ${report.goalTitle}`,
        content: `Completeness: ${Math.round(report.completeness * 100)}%, Matched: ${report.matchedAcs.length}, Missed: ${report.missedAcs.length}. Missed ACs: ${report.missedAcs.join('; ')}`,
        severity: report.completeness < 0.5 ? 'warning' : 'info',
        timestamp: Date.now(),
      }).catch(() => { /* non-blocking */ });

      return report;
    } catch (e: any) {
      logger.warn('[PostEval] Evaluation failed', { goalId, error: String(e) });
      return null;
    }
  }

  /**
   * 从 RequirementsDoc Markdown 提取 AC 列表
   */
  private extractAcs(content: string): string[] {
    const acs: string[] = [];
    const lines = content.split('\n');
    for (const line of lines) {
      const match = line.match(/^-\s*\[[ x]\]\s+(.+)/);
      if (match) acs.push(match[1].trim());
    }
    return acs;
  }

  /**
   * 获取 Goal 执行期间的代码变更
   */
  private async getExecutionChanges(goalId: string): Promise<string> {
    const lines: string[] = [];

    // PipelineRun 汇总
    const runs = await prisma.pipelineRun.findMany({
      where: {
        sessionId: {
          in: (await prisma.goalExecution.findMany({
            where: { goalId },
            select: { id: true },
          })).map(e => e.id),
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (runs.length > 0) {
      lines.push(`## PipelineRun (${runs.length} records)`);
      for (const r of runs.slice(0, 5)) {
        lines.push(`- ${r.phase}: ${r.success ? '✅' : '❌'} ${r.inputTokens}→${r.outputTokens} tokens ${r.durationMs}ms`);
      }
    }

    // Worktree git diff
    try {
      const worktreesDir = process.env.WORKTREES_DIR || path.join(os.homedir(), '.studio', 'worktrees');
      if (fs.existsSync(worktreesDir)) {
        const execs = await prisma.goalExecution.findMany({
          where: { goalId },
          select: { id: true },
        });
        for (const e of execs) {
          const wtPath = path.join(worktreesDir, e.id);
          if (fs.existsSync(wtPath)) {
            try {
              const diff = execSync('git diff --stat HEAD', {
                cwd: wtPath, encoding: 'utf-8', stdio: 'pipe', timeout: 10_000,
              }).trim();
              if (diff) {
                lines.push(`\n## Worktree ${e.id.slice(0, 8)}`);
                lines.push(diff);
              }
            } catch { /* worktree may not be a git repo */ }
          }
        }
      }
    } catch { /* best-effort */ }

    return lines.join('\n') || 'No changes detected';
  }

  /**
   * LLM 匹配: 每个 AC 是否被实现
   */
  private async matchAcsToChanges(
    title: string,
    acs: string[],
    changes: string,
  ): Promise<GapReport> {
    if (!modelGateway.isAvailable()) {
      // Fast path: keyword matching fallback
      return this.keywordMatch(acs, changes) as GapReport;
    }

    const prompt = `你是交付审计师。对比需求 AC 和代码变更，判断哪些 AC 已实现、哪些遗漏。

## 目标
${title}

## 验收标准 (AC)
${acs.map((ac, i) => `${i + 1}. ${ac}`).join('\n')}

## 代码变更
${changes.slice(0, 4000)}

请输出 JSON:
{
  "matched": ["已实现的 AC 序号列表，如 1,3,5"],
  "missed": ["未实现的 AC 序号列表"],
  "extra": ["做了什么不在 AC 范围内的事情"]
}

要求：只从代码变更判断，不推测。没有对应变更的 AC 放入 missed。`;

    try {
      const result = await modelGateway.promptJson<{
        matched: number[];
        missed: number[];
        extra: string[];
      }>(prompt, '你是交付审计师，严格按变更证据判断。');

      return {
        goalId: '', goalTitle: title, totalAcs: acs.length, completeness: 0,
        matchedAcs: result.matched.map(i => acs[i - 1] || `AC#${i}`),
        missedAcs: result.missed.map(i => acs[i - 1] || `AC#${i}`),
        extraChanges: result.extra || [],
      };
    } catch {
      // LLM failed → keyword fallback
      return this.keywordMatch(acs, changes) as GapReport;
    }
  }

  /**
   * 关键词匹配（LLM 不可用时的回退）
   */
  private keywordMatch(acs: string[], changes: string): GapReport {
    const matched: string[] = [];
    const missed: string[] = [];
    for (const ac of acs) {
      const keywords = ac.toLowerCase().replace(/[，,]/g, ' ').split(/\s+/).filter(w => w.length > 2);
      const hits = keywords.filter(kw => changes.toLowerCase().includes(kw));
      if (hits.length >= Math.min(2, keywords.length)) {
        matched.push(ac);
      } else {
        missed.push(ac);
      }
    }
    return {
      goalId: '', goalTitle: '', totalAcs: acs.length, completeness: 0,
      matchedAcs: matched, missedAcs: missed, extraChanges: [],
    };
  }

  /**
   * 推送 gap report 到 Channel
   */
  private async pushGapReport(channelId: string, report: GapReport): Promise<void> {
    const pct = Math.round(report.completeness * 100);
    const icon = pct >= 80 ? '✅' : pct >= 50 ? '⚠️' : '❌';

    const lines = [
      `## ${icon} 交付审计: ${report.goalTitle}`,
      '',
      `**完成度**: ${report.matchedAcs.length}/${report.totalAcs} (${pct}%)`,
      '',
      ...(report.matchedAcs.length > 0 ? ['### ✅ 已实现', ...report.matchedAcs.map(a => `- ${a}`), ''] : []),
      ...(report.missedAcs.length > 0 ? ['### ❌ 未实现', ...report.missedAcs.map(a => `- ${a}`), ''] : []),
      ...(report.extraChanges.length > 0 ? ['### 🔀 额外变更', ...report.extraChanges.map(e => `- ${e}`), ''] : []),
    ];

    try {
      await channelMessageService.createAgentMessage(channelId, 'PostEval', lines.join('\n'), {
        meta: { goalId: report.goalId, cardType: 'post_eval_report' },
      });
    } catch (e: any) {
      logger.warn('[PostEval] Failed to push gap report', { error: String(e) });
    }
  }
}

export const postEvalAgent = new PostEvalAgent();
