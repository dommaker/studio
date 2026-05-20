/**
 * Auditor Agent — 跨任务审计 + 周期洞察
 *
 * 2026-05-09: 初始实现。每日扫描审计事件和执行结果，产出入门级洞察。
 * 远期 B4-001：系统级 GC + 模型 tier 成功率矩阵 + 约束效果评估。
 */

import { prisma } from '@dommaker/studio-prisma';
import { logger } from '@dommaker/studio-shared';

const AUDIT_INTERVAL_MS = 24 * 60 * 60 * 1000; // Daily
const SYSTEM_CHANNEL_NAME = '#系统';

interface Suggestion {
  type: 'skill_weight' | 'skill_status' | 'param_tuning' | 'prompt_optimization';
  risk: 'low' | 'high';
  skillId?: string;
  skillName?: string;
  agentType?: string;
  detail: string;
  data?: Record<string, unknown>;
}

export class AuditorAgent {
  private interval: NodeJS.Timeout | null = null;

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => this.dailyAudit(), AUDIT_INTERVAL_MS);
    logger.info('[AuditorAgent] Started', { interval: '24h' });
    // 首次启动 5 分钟后跑一次
    setTimeout(() => this.dailyAudit(), 5 * 60 * 1000);
  }

  stop(): void {
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
    logger.info('[AuditorAgent] Stopped');
  }

  // ── Daily Audit ──

  private async dailyAudit(): Promise<void> {
    try {
      const now = new Date();
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

      // 1. 过去 24h 的执行统计（含 agentType 用于 3D 分析）
      const recentExecs = await prisma.goalExecution.findMany({
        where: { completedAt: { gte: yesterday } },
        select: { status: true, error: true, agentType: true, input: true },
      });
      const total = recentExecs.length;
      const failed = recentExecs.filter(e => e.status === 'failed').length;
      const successRate = total > 0 ? Math.round((1 - failed / total) * 100) : 100;

      // 2. 失败归类（全局 + 按 agent-type）
      const errorCounts = new Map<string, number>();
      const errorByAgentType = new Map<string, Map<string, number>>();
      for (const e of recentExecs) {
        if (e.status !== 'failed' || !e.error) continue;
        const errorType = this.classifyError(e.error as string);
        errorCounts.set(errorType, (errorCounts.get(errorType) || 0) + 1);

        const agentType = e.agentType || 'unknown';
        if (!errorByAgentType.has(agentType)) {
          errorByAgentType.set(agentType, new Map());
        }
        const perType = errorByAgentType.get(agentType)!;
        perType.set(errorType, (perType.get(errorType) || 0) + 1);
      }

      // 3. 最近 24h 的审计事件统计
      const auditCount = await prisma.decisionAudit.count({
        where: { createdAt: { gte: yesterday } },
      });

      // 4. Agent-type × tier 3D 交叉分析
      const agentTypeStats = new Map<string, { total: number; failed: number }>();
      const tierStats = new Map<string, { total: number; failed: number }>();

      for (const e of recentExecs) {
        const agentType = e.agentType || 'unknown';
        const ag = agentTypeStats.get(agentType) || { total: 0, failed: 0 };
        ag.total++;
        if (e.status === 'failed') ag.failed++;
        agentTypeStats.set(agentType, ag);

        // Extract modelTier from input JSON or default to 'standard'
        let tier = 'standard';
        try {
          if (e.input) {
            const parsed = typeof e.input === 'string' ? JSON.parse(e.input) : e.input;
            tier = (parsed as any)?.modelTier || 'standard';
          }
        } catch { /* use default */ }
        const tr = tierStats.get(tier) || { total: 0, failed: 0 };
        tr.total++;
        if (e.status === 'failed') tr.failed++;
        tierStats.set(tier, tr);
      }

      // 5. Goal 状态分布
      const goalStats = await prisma.goal.groupBy({
        by: ['status'],
        where: { updatedAt: { gte: yesterday } },
        _count: true,
      });

      const summary = [
        `## 📊 每日审计 — ${now.toISOString().slice(0, 10)}`,
        '',
        '### 执行统计',
        `- 总执行: ${total} | 成功: ${total - failed} | 失败: ${failed} | 成功率: ${successRate}%`,
        `- 审计事件: ${auditCount}`,
        '',
        '### 按 Agent 类型',
        ...[...agentTypeStats.entries()]
          .sort((a, b) => b[1].total - a[1].total)
          .map(([type, s]) => {
            const rate = s.total > 0 ? Math.round((1 - s.failed / s.total) * 100) : 100;
            return `- **${type}**: ${s.total} 次 (成功: ${s.total - s.failed}, 失败: ${s.failed}, 成功率: ${rate}%)`;
          }),
        '',
        '### 按模型档位',
        ...[...tierStats.entries()]
          .sort((a, b) => b[1].total - a[1].total)
          .map(([tier, s]) => {
            const rate = s.total > 0 ? Math.round((1 - s.failed / s.total) * 100) : 100;
            return `- **${tier}**: ${s.total} 次 (成功: ${s.total - s.failed}, 失败: ${s.failed}, 成功率: ${rate}%)`;
          }),
        '',
        '### Goal 状态',
        ...goalStats.map(g => `- ${g.status}: ${g._count}`),
      ];

      if (errorCounts.size > 0) {
        summary.push('', '### 失败归类', ...[...errorCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([type, count]) => `- ${type}: ${count}`));
      }

      if (failed > 0 && successRate < 80) {
        summary.push('', '### ⚠️ 关注', `成功率 ${successRate}% < 80%，建议人工检查失败原因。`);
      }

      const content = summary.join('\n');

      // 6. 生成审计建议 → 分权限执行
      const suggestions = await this.generateSuggestions(agentTypeStats, errorByAgentType);
      const lowRisk = suggestions.filter(s => s.risk === 'low');
      const highRisk = suggestions.filter(s => s.risk === 'high');

      const appliedSummary = await this.applyLowRiskSuggestions(lowRisk);
      if (appliedSummary.length > 0) {
        summary.push('', '### 已自动应用', ...appliedSummary.map(s => `- ✅ ${s}`));
      }

      if (highRisk.length > 0) {
        await this.pushConfirmationCards(highRisk);
        summary.push('', '### 待人工确认', ...highRisk.map(s => `- ⚠️ ${s.detail}`));
      }

      const finalContent = summary.join('\n');

      // 7. 推送到 #系统 channel
      await this.postToSystemChannel(finalContent);

      // 8. Escalate anomalies to Triage (Phase 3)
      await this.escalateToTriage(agentTypeStats, successRate, total, failed);

      // 9. 保存 tier 成功率 → Analyst 反馈回路
      await this.saveTierStats(tierStats);

      // 10. Better-Harness: 失败 → eval case 生成
      await this.generateEvalCases(recentExecs);

      logger.info('[AuditorAgent] Daily audit completed', { total, failed, successRate });
    } catch (e) {
      logger.error('[AuditorAgent] Daily audit failed', { error: String(e) });
    }
  }

  // ── Error Classification ──

  private classifyError(errorMsg: string): string {
    const msg = (typeof errorMsg === 'string' ? errorMsg : String(errorMsg)).toLowerCase();
    if (msg.includes('timeout') || msg.includes('timed out')) return 'timeout';
    if (msg.includes('docker') || msg.includes('container')) return 'docker';
    if (msg.includes('git') || msg.includes('worktree')) return 'git/worktree';
    if (msg.includes('prisma') || msg.includes('database') || msg.includes('sqlite')) return 'database';
    if (msg.includes('type') || msg.includes('tsc') || msg.includes('lint')) return 'type/lint';
    if (msg.includes('test')) return 'test_failure';
    if (msg.includes('port') || msg.includes('eaddrinuse')) return 'port_conflict';
    if (msg.includes('permission') || msg.includes('denied')) return 'permission';
    if (msg.includes('model') || msg.includes('token') || msg.includes('llm')) return 'llm/model';
    return 'other';
  }

  // ── Triage Escalation (Phase 3) ──

  private async escalateToTriage(
    agentTypeStats: Map<string, { total: number; failed: number }>,
    overallSuccessRate: number,
    total: number,
    failed: number,
  ): Promise<void> {
    // Check per-agent-type: >30% failure rate for any type → agent_type_failure_trend
    for (const [agentType, stats] of agentTypeStats) {
      if (stats.total >= 3) {
        const failureRate = stats.failed / stats.total;
        if (failureRate > 0.3) {
          try {
            const { triageAgent } = await import('./triage-agent.service.js');
            triageAgent.handleAlert({
              type: 'agent_type_failure_trend',
              severity: 'critical',
              message: `Agent type "${agentType}" failure rate ${(failureRate * 100).toFixed(0)}% (${stats.failed}/${stats.total})`,
              details: {
                failingAgentType: agentType,
                failureRate: Math.round(failureRate * 100),
                total: stats.total,
                failed: stats.failed,
              },
            }).catch(err => {
              logger.error('[AuditorAgent] Triage escalation failed (agent_type)', {
                agentType,
                error: String(err),
              });
            });
          } catch (err) {
            logger.warn('[AuditorAgent] Failed to import triageAgent for agent_type_failure_trend', { error: String(err) });
          }
        }
      }
    }

    // Overall successRate < 50% → pipeline_health_degraded
    if (total >= 5 && overallSuccessRate < 50) {
      try {
        const { triageAgent } = await import('./triage-agent.service.js');
        triageAgent.handleAlert({
          type: 'pipeline_health_degraded',
          severity: 'critical',
          message: `Pipeline success rate ${overallSuccessRate}% (${failed}/${total} failed) below 50% threshold`,
          details: {
            overallSuccessRate,
            total,
            failed,
          },
        }).catch(err => {
          logger.error('[AuditorAgent] Triage escalation failed (pipeline_health)', {
            error: String(err),
          });
        });
      } catch (err) {
        logger.warn('[AuditorAgent] Failed to import triageAgent for pipeline_health_degraded', { error: String(err) });
      }
    }
  }

  // ── Generate Suggestions (B3-005) ──

  private async generateSuggestions(
    agentTypeStats: Map<string, { total: number; failed: number }>,
    errorByAgentType: Map<string, Map<string, number>>,
  ): Promise<Suggestion[]> {
    const suggestions: Suggestion[] = [];

    try {
      // Query skills with sufficient usage for weight/status analysis
      const skills = await prisma.skill.findMany({
        where: { usageCount: { gte: 5 } },
      });

      // Detection rule 1: skill_weight — low successRate + sufficient usage
      for (const skill of skills) {
        if (skill.successRate < 0.3) {
          suggestions.push({
            type: 'skill_weight',
            risk: 'low',
            skillId: skill.id,
            skillName: skill.name,
            detail: `Skill "${skill.name}" 成功率 ${(skill.successRate * 100).toFixed(0)}% < 30%，建议调整权重`,
            data: { successRate: skill.successRate, usageCount: skill.usageCount },
          });
        }

        // Detection rule 2: skill_status — high successRate + still draft
        if (skill.successRate >= 0.8 && skill.status === 'draft') {
          suggestions.push({
            type: 'skill_status',
            risk: 'low',
            skillId: skill.id,
            skillName: skill.name,
            detail: `Skill "${skill.name}" 成功率达 ${(skill.successRate * 100).toFixed(0)}%，建议发布`,
            data: { successRate: skill.successRate, currentStatus: skill.status },
          });
        }
      }

      // Detection rule 3: param_tuning — agent-type timeout errors >= 3
      for (const [agentType, errorMap] of errorByAgentType) {
        const timeoutCount = errorMap.get('timeout') || 0;
        const totalErrors = [...errorMap.values()].reduce((a, b) => a + b, 0);
        const stats = agentTypeStats.get(agentType);
        const execTotal = stats?.total || 0;

        if (timeoutCount >= 3 && totalErrors >= 5) {
          suggestions.push({
            type: 'param_tuning',
            risk: 'high',
            agentType,
            detail: `${agentType} 超时错误 ${timeoutCount}/${totalErrors}，建议调整 sessionTimeoutMinutes`,
            data: { agentType, timeoutCount, totalErrors, execTotal },
          });
        }

        // Detection rule 4: prompt_optimization — agent-type failureRate > 0.3 + llm/model dominant
        if (stats && stats.total >= 5) {
          const failureRate = stats.failed / stats.total;
          const llmErrors = errorMap.get('llm/model') || 0;
          if (failureRate > 0.3 && llmErrors >= totalErrors * 0.4) {
            suggestions.push({
              type: 'prompt_optimization',
              risk: 'high',
              agentType,
              detail: `${agentType} 失败率 ${(failureRate * 100).toFixed(0)}%，LLM/模型错误占主导 (${llmErrors}/${totalErrors})，建议优化 prompt`,
              data: { agentType, failureRate: Math.round(failureRate * 100), llmErrors, totalErrors },
            });
          }
        }
      }
    } catch (err) {
      logger.warn('[AuditorAgent] Failed to generate suggestions', { error: String(err) });
    }

    return suggestions;
  }

  // ── Apply Low-Risk Suggestions (B3-005) ──

  private async applyLowRiskSuggestions(suggestions: Suggestion[]): Promise<string[]> {
    const applied: string[] = [];

    for (const s of suggestions) {
      try {
        if (s.type === 'skill_weight' && s.skillId) {
          await prisma.skill.update({
            where: { id: s.skillId },
            data: { successRate: s.data?.successRate as number },
          });
          applied.push(`Skill "${s.skillName}" 成功率权重已更新`);
          logger.info('[AuditorAgent] Auto-applied skill_weight', { skillId: s.skillId, skillName: s.skillName });
        } else if (s.type === 'skill_status' && s.skillId) {
          await prisma.skill.update({
            where: { id: s.skillId },
            data: { status: 'published' },
          });
          applied.push(`Skill "${s.skillName}" 已自动发布`);
          logger.info('[AuditorAgent] Auto-applied skill_status', { skillId: s.skillId, skillName: s.skillName });
        }
      } catch (err) {
        logger.warn('[AuditorAgent] Failed to apply low-risk suggestion', {
          type: s.type,
          skillId: s.skillId,
          error: String(err),
        });
      }
    }

    return applied;
  }

  // ── Push Confirmation Cards (B3-005) ──

  private async pushConfirmationCards(suggestions: Suggestion[]): Promise<void> {
    if (suggestions.length === 0) return;

    try {
      const channel = await prisma.channel.findUnique({ where: { name: SYSTEM_CHANNEL_NAME } });
      if (!channel) {
        logger.warn('[AuditorAgent] System channel not found for suggestion cards');
        return;
      }

      const { channelMessageService } = await import('../channels/channel-message.service.js');

      const content = [
        '## 🔧 审计建议 — 待人工确认',
        '',
        ...suggestions.map((s, i) => {
          const icon = s.type === 'param_tuning' ? '⚙️' : '📝';
          return `${i + 1}. ${icon} **${s.detail}**`;
        }),
        '',
        '请确认是否执行以上建议。',
      ].join('\n');

      await channelMessageService.createCardMessage(
        channel.id,
        'Auditor',
        content,
        'auditor_suggestion',
        { suggestions, status: 'ready' },
      );

      logger.info('[AuditorAgent] Pushed suggestion confirmation cards', { count: suggestions.length });
    } catch (err) {
      logger.warn('[AuditorAgent] Failed to push suggestion cards', { error: String(err) });
    }
  }

  // ── Save Tier Stats (Auditor → Analyst feedback loop) ──

  private async saveTierStats(
    tierStats: Map<string, { total: number; failed: number }>,
  ): Promise<void> {
    if (tierStats.size === 0) return;

    try {
      const stats = [...tierStats.entries()].map(([tier, s]) => ({
        tier,
        total: s.total,
        failed: s.failed,
        successRate: s.total > 0 ? Math.round((1 - s.failed / s.total) * 100) : 100,
      }));

      await prisma.decisionAudit.create({
        data: {
          entityType: 'model_tier',
          entityId: `daily-${new Date().toISOString().slice(0, 10)}`,
          eventType: 'tier_success_rate',
          summary: JSON.stringify(stats),
        },
      });

      logger.info('[AuditorAgent] Tier stats saved', { tiers: stats.length });
    } catch (err) {
      logger.warn('[AuditorAgent] Failed to save tier stats', { error: String(err) });
    }
  }

  // ── Eval Case Generation (Better-Harness hill-climbing) ──

  private async generateEvalCases(recentExecs: Array<{
    status: string;
    error: string | null;
    agentType: string | null;
    input: any;
    id?: string;
    goalId?: string;
  }>): Promise<void> {
    const failures = recentExecs
      .filter(e => e.status === 'failed' && e.error)
      .map(e => ({
        goalId: (e as any).goalId || 'unknown',
        executionId: (e as any).id || 'unknown',
        error: e.error!,
        taskDescription: this.extractTaskDescription(e.input),
        changedFiles: [],
        agentType: e.agentType || undefined,
      }));

    if (failures.length === 0) return;

    try {
      const { evalCaseGenerator } = await import('../knowledge/eval-case-generator.js');
      await evalCaseGenerator.generateFromFailures(failures);
    } catch (err) {
      logger.warn('[AuditorAgent] Eval case generation failed', { error: String(err) });
    }
  }

  private extractTaskDescription(input: any): string | undefined {
    try {
      if (!input) return undefined;
      const parsed = typeof input === 'string' ? JSON.parse(input) : input;
      return (parsed as any)?.taskDescription || (parsed as any)?.prompt?.substring?.(0, 200);
    } catch {
      return undefined;
    }
  }

  // ── Post to Channel ──

  private async postToSystemChannel(content: string): Promise<void> {
    try {
      const channel = await prisma.channel.findUnique({ where: { name: SYSTEM_CHANNEL_NAME } });
      if (!channel) {
        logger.warn('[AuditorAgent] System channel not found');
        return;
      }

      const { channelMessageService } = await import('../channels/channel-message.service.js');
      await channelMessageService.createAgentMessage(
        channel.id,
        'Auditor',
        content,
        { meta: { cardType: 'audit-report', source: 'auditor-agent' } },
      );
    } catch (e) {
      logger.warn('[AuditorAgent] Failed to post to system channel', { error: String(e) });
    }
  }
}

export const auditorAgent = new AuditorAgent();
