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

export interface GapReport {
  goalId: string;
  goalTitle: string;
  totalAcs: number;
  matchedAcs: string[];
  missedAcs: string[];
  extraChanges: string[];
  completeness: number;  // 0-1
  /** LLM 调用消耗（仅当使用了 LLM 匹配时有值，keyword fallback 时为 null） */
  tokensUsed?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheHitTokens: number;
    model: string;
    provider: string;
    latencyMs: number;
  } | null;
}

/** Analyst 预测准确率 — PostEval 归因分析产出 */
export interface AnalystAccuracy {
  docId: string;
  goalTitle: string;
  predictedFiles: string[];
  actualFiles: string[];
  predictedDeps: string[];
  actualDeps: string[];
  acMatchRate: number;
  missesByType: Record<string, number>;
  tierStats?: Record<string, { total: number; succeeded: number; failed: number; avgDurationMs: number }>;
}

class PostEvalAgent {
  /**
   * Goal 完成后触发 — 比对 RequirementsDoc AC 和实际 git diff
   */
  async evaluate(goalId: string, sourceChannelId?: string): Promise<GapReport | null> {
    const evalStart = Date.now();
    try {
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

      // 5a. 归因分析: 对比 Analyst 预测 vs 实际执行
      await this.attributeAnalystAccuracy(goalId, goal.title, docId).catch(e => {
        logger.warn('[PostEval] Attribution analysis failed', { goalId, error: String(e) });
      });

      // 6. 推送 gap report 到 Channel
      if (sourceChannelId) {
        await this.pushGapReport(sourceChannelId, report);
      }

      const evalDurationMs = Date.now() - evalStart;
      logger.info('[PostEval] Evaluation complete', {
        goalId,
        completeness: Math.round(report.completeness * 100) + '%',
        matched: report.matchedAcs.length,
        missed: report.missedAcs.length,
        tokensUsed: report.tokensUsed,
        durationMs: evalDurationMs,
      });

      // 7. AS-018 UPDATE: sync KR progress after pipeline completion
      const projectId = ctx.projectId as string | undefined;
      if (projectId) {
        try {
          const project = await prisma.project.findUnique({
            where: { id: projectId },
            select: { okrId: true },
          });
          if (project?.okrId) {
            const { okrService } = await import('../pmo/okr.service.js');
            await okrService.syncKRProgress(project.okrId);
            logger.info('[PostEval] KR progress synced', { okrId: project.okrId });
          }
        } catch (e) {
          logger.warn('[PostEval] syncKRProgress failed', { error: String(e) });
        }
      }

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
      logger.warn('[PostEval] Evaluation failed', { goalId, error: String(e), durationMs: Date.now() - evalStart });
      return null;
    }
  }

  /**
   * Plan 覆盖率验证 — 对比 plan.md checklist items 和 staged diff
   * 用于 pre-commit hook 防止"假装完成"
   */
  async evaluatePlanCoverage(planPath: string): Promise<GapReport> {
    const startTime = Date.now();
    let executionMode: 'llm' | 'keyword' | 'empty' = 'llm';
    let planSize = 0;
    let diffSize = 0;
    let stagedFiles = 0;

    try {
      // 1. 读取 plan 文件
      const planContent = fs.readFileSync(planPath, 'utf-8');
      planSize = planContent.length;

      // 2. 提取 checklist items（复用 extractAcs 的 markdown checkbox 解析）
      const items = this.extractAcs(planContent);
      if (items.length === 0) {
        executionMode = 'empty';
        const durationMs = Date.now() - startTime;
        logger.info('[PostEval] Plan coverage: no items found', { planPath, planSize, durationMs });
        return {
          goalId: planPath,
          goalTitle: path.basename(planPath),
          totalAcs: 0,
          matchedAcs: [],
          missedAcs: [],
          extraChanges: [],
          completeness: 1,
        };
      }

      // 3. 获取 staged diff
      let diff: string;
      try {
        diff = execSync('git diff --cached', { encoding: 'utf-8', stdio: 'pipe', timeout: 10_000 });
        diffSize = diff.length;
        stagedFiles = (execSync('git diff --cached --name-only', { encoding: 'utf-8', stdio: 'pipe', timeout: 5_000 }))
          .trim().split('\n').filter(Boolean).length;
      } catch (e: any) {
        logger.warn('[PostEval] git diff --cached failed', { planPath, error: String(e) });
        diff = '';
      }

      // 4. 检测执行路径
      if (!modelGateway.isAvailable()) {
        executionMode = 'keyword';
      }

      // 5. LLM 语义匹配（复用 matchAcsToChanges）
      const matchStart = Date.now();
      const report = await this.matchAcsToChanges(
        path.basename(planPath),
        items,
        diff || 'No staged changes',
      );
      const matchMs = Date.now() - matchStart;

      // 6. 计算完成度
      report.completeness = items.length > 0 ? report.matchedAcs.length / items.length : 1;
      const durationMs = Date.now() - startTime;

      // 7. 日志（完整上下文）
      logger.info('[PostEval] Plan coverage evaluated', {
        planPath,
        planSize,
        diffSize,
        stagedFiles,
        totalItems: items.length,
        completeness: Math.round(report.completeness * 100) + '%',
        matched: report.matchedAcs.length,
        missed: report.missedAcs.length,
        executionMode,
        durationMs,
        matchMs,
        tokensUsed: report.tokensUsed,
      });

      // 8. 写入知识库（知识积累闭环）
      knowledgeBus.recordPattern({
        source: 'posteval',
        type: 'pattern',
        title: `Plan coverage: ${path.basename(planPath)}`,
        content: [
          `Completeness: ${Math.round(report.completeness * 100)}%`,
          `Mode: ${executionMode}`,
          `Items: ${report.matchedAcs.length}/${items.length} matched`,
          `Plan size: ${planSize}B, Diff: ${diffSize}B, Files: ${stagedFiles}`,
          `Duration: ${durationMs}ms (match: ${matchMs}ms)`,
          `Tokens: ${report.tokensUsed ? `${report.tokensUsed.totalTokens} (${report.tokensUsed.model})` : 'N/A'}`,
          report.missedAcs.length > 0 ? `Missed: ${report.missedAcs.join('; ')}` : '',
        ].filter(Boolean).join('\n'),
        severity: report.completeness < 0.5 ? 'warning' : 'info',
        timestamp: Date.now(),
      }).catch(() => { /* non-blocking */ });

      return report;
    } catch (e: any) {
      const durationMs = Date.now() - startTime;
      logger.warn('[PostEval] Plan coverage failed', {
        planPath,
        planSize,
        diffSize,
        durationMs,
        error: String(e),
      });
      throw e; // 重新抛出，让 API route 返回 500
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
   * 归因分析：对比 Analyst 预测的 files/deps vs git diff 实际结果
   * 产出 AnalystAccuracy → KnowledgeBus → 下次 Analyst 运行时注入
   */
  private async attributeAnalystAccuracy(
    goalId: string,
    goalTitle: string,
    docId: string,
  ): Promise<AnalystAccuracy | null> {
    try {
      // 1. 从 GoalExecutions 提取 Analyst 预测的 acGroup 数据 + 执行统计
      const execs = await prisma.goalExecution.findMany({
        where: { goalId },
        select: { input: true, id: true, status: true, startedAt: true, completedAt: true },
      });

      const predictedFiles: string[] = [];
      const predictedDeps: string[] = [];
      // G34-feedback-loop: 收集每个 execution 的 modelTier + 状态 + 耗时
      const tierBuckets: Record<string, { total: number; succeeded: number; failed: number; totalDurationMs: number }> = {};
      for (const e of execs) {
        const input = (typeof e.input === 'string' ? JSON.parse(e.input) : e.input) as Record<string, any>;
        const acGroup = input?.acGroup as Record<string, any> | undefined;
        if (acGroup?.files?.length) predictedFiles.push(...acGroup.files.map((f: string) => f.replace(/`/g, '').trim()));
        if (acGroup?.dependencies?.length) predictedDeps.push(...(acGroup.dependencies as string[]));
        const tier = (acGroup?.modelTier as string) || 'standard';
        if (!tierBuckets[tier]) tierBuckets[tier] = { total: 0, succeeded: 0, failed: 0, totalDurationMs: 0 };
        tierBuckets[tier].total++;
        if (e.status === 'succeeded') tierBuckets[tier].succeeded++;
        else if (e.status === 'failed') tierBuckets[tier].failed++;
        if (e.startedAt && e.completedAt) {
          tierBuckets[tier].totalDurationMs += e.completedAt.getTime() - e.startedAt.getTime();
        }
      }

      // 2. 从 git diff 提取实际改动的文件
      const actualFiles: string[] = [];
      try {
        const diffNameOnly = execSync('git diff --name-only HEAD', {
          encoding: 'utf-8', stdio: 'pipe', timeout: 10_000,
        }).trim();
        if (diffNameOnly) {
          actualFiles.push(...diffNameOnly.split('\n').filter(Boolean).map(f => f.trim()));
        }
      } catch {
        // 不在 git repo 中，使用 worktree diff
        const worktreesDir = process.env.WORKTREES_DIR || path.join(os.homedir(), '.studio', 'worktrees');
        for (const e of execs) {
          const wtPath = path.join(worktreesDir, e.id);
          if (fs.existsSync(wtPath)) {
            try {
              const nameOnly = execSync('git diff --name-only HEAD', {
                cwd: wtPath, encoding: 'utf-8', stdio: 'pipe', timeout: 10_000,
              }).trim();
              if (nameOnly) actualFiles.push(...nameOnly.split('\n').filter(Boolean).map(f => f.trim()));
            } catch { /* worktree may not be a git repo */ }
          }
        }
      }

      // 3. 对比：哪些文件命中了预测
      const missedFiles = predictedFiles.filter(pf =>
        !actualFiles.some(af => af.includes(pf) || pf.includes(af)),
      );
      const extraFiles = actualFiles.filter(af =>
        !predictedFiles.some(pf => af.includes(pf) || pf.includes(af)),
      );

      // 4. 误判类型分类
      const missesByType: Record<string, number> = {};
      if (missedFiles.length > 0) missesByType.missingFile = missedFiles.length;
      if (extraFiles.length > 0) missesByType.extraFile = extraFiles.length;
      // predictedDeps 在实际中无法直接验证（需要执行日志），暂时记录预测值供分析
      if (predictedDeps.length === 0 && execs.length > 1) missesByType.missingDep = 1;

      // 5. AC 匹配率（复用 evaluate() 中已计算的 GapReport completeness）
      // 注: 此时 GapReport 尚未返回，使用文件级近似: 1 - missedFiles/predictedFiles
      const acMatchRate = predictedFiles.length > 0
        ? 1 - missedFiles.length / Math.max(predictedFiles.length, 1)
        : 1;

      // G34-feedback-loop: 计算 per-tier 统计
      const tierStats: Record<string, { total: number; succeeded: number; failed: number; avgDurationMs: number }> = {};
      for (const [tier, bucket] of Object.entries(tierBuckets)) {
        tierStats[tier] = {
          total: bucket.total,
          succeeded: bucket.succeeded,
          failed: bucket.failed,
          avgDurationMs: bucket.total > 0 ? Math.round(bucket.totalDurationMs / bucket.total) : 0,
        };
      }

      const accuracy: AnalystAccuracy = {
        docId,
        goalTitle,
        predictedFiles: [...new Set(predictedFiles)],
        actualFiles: [...new Set(actualFiles)],
        predictedDeps: [...new Set(predictedDeps)],
        actualDeps: [], // 无法从 git diff 直接推断
        acMatchRate: Math.max(0, Math.min(1, acMatchRate)),
        missesByType,
        tierStats: Object.keys(tierStats).length > 0 ? tierStats : undefined,
      };

      // 6. 写入 KnowledgeBus（闭环反馈）
      await knowledgeBus.recordAnalystAccuracy(accuracy);
      logger.info('[PostEval] Analyst accuracy recorded', {
        goalId: goalId.slice(0, 16),
        fileMatchRate: Math.round(accuracy.acMatchRate * 100) + '%',
        missed: missedFiles.length,
        extra: extraFiles.length,
        tierStats: accuracy.tierStats,
      });

      return accuracy;
    } catch (e: any) {
      logger.warn('[PostEval] Analyst accuracy attribution failed', { error: String(e) });
      return null;
    }
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

      // 读回 modelGateway 内部已记录的 token 用量（promptJson → prompt → chat 链中 chat 已写入 usageLog）
      const [lastUsage] = modelGateway.getRecentUsage(1);
      const tokensUsed = lastUsage?.success ? {
        promptTokens: lastUsage.promptTokens,
        completionTokens: lastUsage.completionTokens,
        totalTokens: lastUsage.totalTokens,
        cacheHitTokens: lastUsage.cacheHitTokens,
        model: lastUsage.model,
        provider: lastUsage.provider,
        latencyMs: lastUsage.latencyMs,
      } : null;

      return {
        goalId: '', goalTitle: title, totalAcs: acs.length, completeness: 0,
        matchedAcs: result.matched.map(i => acs[i - 1] || `AC#${i}`),
        missedAcs: result.missed.map(i => acs[i - 1] || `AC#${i}`),
        extraChanges: result.extra || [],
        tokensUsed,
      };
    } catch {
      // LLM failed → keyword fallback
      return { ...this.keywordMatch(acs, changes), tokensUsed: null };
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
