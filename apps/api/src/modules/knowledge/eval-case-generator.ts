/**
 * EvalCaseGenerator — Better-Harness hill-climbing 吸收
 *
 * 从生产失败中自动生成 eval case，打标签，存入 EvalCaseStore。
 * 飞轮：失败 → eval case → harness 改进 → 回归验证 → 标记饱和。
 */

import { prisma } from '@dommaker/studio-prisma';
import { logger } from '@dommaker/studio-shared';
import { channelMessageService } from '../channels/channel-message.service.js';
import { listEvalCases, createEvalCase, updateEvalCase } from './eval-case-store.js';

const SYSTEM_CHANNEL_NAME = '#系统';

export type EvalTag =
  | 'tool_selection'
  | 'multi_step'
  | 'edge_case'
  | 'schema_change'
  | 'constraint'
  | 'other';

interface EvalCaseInput {
  goalId: string;
  executionId: string;
  error: string;
  taskDescription?: string;
  changedFiles?: string[];
  agentType?: string;
}

export class EvalCaseGenerator {
  /**
   * 分类失败 → eval tag
   */
  classifyTag(errorMsg: string, changedFiles: string[] = []): EvalTag {
    const msg = (typeof errorMsg === 'string' ? errorMsg : String(errorMsg)).toLowerCase();

    // schema_change: prisma/schema/数据库变更相关
    if (changedFiles.some(f => f.includes('schema.prisma') || f.includes('migration'))) {
      return 'schema_change';
    }
    if (msg.includes('prisma') || msg.includes('database') || msg.includes('sqlite')) {
      return 'schema_change';
    }

    // tool_selection: 工具选择/权限相关
    if (msg.includes('tool') || msg.includes('bash') || msg.includes('command not found')) {
      return 'tool_selection';
    }
    if (msg.includes('permission') || msg.includes('denied') || msg.includes('eaccess')) {
      return 'tool_selection';
    }

    // multi_step: 多步推理断裂
    if (msg.includes('step') || msg.includes('integration') || msg.includes('merge')) {
      return 'multi_step';
    }
    if (msg.includes('review') || msg.includes('rejected') || msg.includes('exhausted')) {
      return 'multi_step';
    }

    // constraint: harness 约束违反
    if (msg.includes('constraint') || msg.includes('violation') || msg.includes('iron_law')) {
      return 'constraint';
    }

    // edge_case: 类型/测试/边界
    if (msg.includes('type') || msg.includes('tsc') || msg.includes('lint')) {
      return 'edge_case';
    }
    if (msg.includes('test') || msg.includes('assert')) {
      return 'edge_case';
    }

    return 'other';
  }

  /**
   * 从一批 GoalExecution 失败中生成 eval cases
   */
  async generateFromFailures(failures: Array<{
    goalId: string;
    executionId: string;
    error: string;
    taskDescription?: string;
    changedFiles?: string[];
    agentType?: string;
  }>): Promise<number> {
    let created = 0;

    // 获取已有 eval cases 用于去重
    const existing = listEvalCases().map(e => ({ sourceGoalId: e.sourceGoalId, content: e.content }));

    for (const f of failures) {
      if (!f.error) continue;

      const tag = this.classifyTag(f.error, f.changedFiles || []);

      // 去重：同 goal + 同 tag 不重复
      const dup = existing.some(e =>
        e.sourceGoalId === f.goalId &&
        this.parseContentTag(e.content) === tag,
      );
      if (dup) continue;

      const content = JSON.stringify({
        tag,
        description: this.buildDescription(f, tag),
        expectedBehavior: this.buildExpectedBehavior(f, tag),
        source: `production_failure:${f.executionId}`,
        agentType: f.agentType || 'unknown',
        firstSeen: new Date().toISOString(),
      });

      const triggerCondition = this.buildTriggerCondition(f, tag);

      try {
        createEvalCase({
          content,
          triggerCondition,
          sourceGoalId: f.goalId,
          status: 'active',
        });

        existing.push({ sourceGoalId: f.goalId, content });
        created++;
      } catch (err) {
        logger.warn('[EvalCaseGenerator] Failed to create eval case', {
          executionId: f.executionId,
          tag,
          error: String(err),
        });
      }
    }

    if (created > 0) {
      logger.info('[EvalCaseGenerator] Generated eval cases', { created, totalFailures: failures.length });
      await this.pushToSystemChannel(created, failures.length);
    }

    return created;
  }

  /**
   * Spring cleaning: 标记饱和 eval cases
   */
  async markSaturatedEvals(passThreshold = 10): Promise<number> {
    const evalCases = listEvalCases({ status: 'active' });

    let marked = 0;
    for (const ec of evalCases) {
      // 通过连续通过次数判断（这里简化：createdAt 超过 30 天且仍在 active）
      const age = Date.now() - new Date(ec.createdAt).getTime();
      if (age > 30 * 24 * 60 * 60 * 1000) {
        updateEvalCase(ec.id, { status: 'deprecated' });
        marked++;
      }
    }

    if (marked > 0) {
      logger.info('[EvalCaseGenerator] Marked saturated evals', { marked, total: evalCases.length });
    }

    return marked;
  }

  /**
   * 获取活跃 eval cases（供 harness 加载）
   */
  async getActiveEvals(): Promise<Record<string, any>[]> {
    return listEvalCases({ status: 'active' })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * 按标签分组统计
   */
  async getEvalStats(): Promise<Record<string, number>> {
    const cases = listEvalCases();

    const stats: Record<string, { active: number; deprecated: number }> = {};
    for (const c of cases) {
      const tag = this.parseContentTag(c.content);
      const entry = stats[tag] || { active: 0, deprecated: 0 };
      if (c.status === 'active') entry.active++;
      else entry.deprecated++;
      stats[tag] = entry;
    }

    const result: Record<string, number> = {};
    for (const [tag, counts] of Object.entries(stats)) {
      result[tag] = counts.active;
    }
    return result;
  }

  // ── private ──

  private parseContentTag(content: string): string {
    try {
      return JSON.parse(content).tag || 'other';
    } catch {
      return 'other';
    }
  }

  private buildDescription(f: EvalCaseInput, tag: EvalTag): string {
    const errorSnippet = f.error.substring(0, 150);
    return `[${tag}] Goal 执行失败: ${errorSnippet}`;
  }

  private buildExpectedBehavior(f: EvalCaseInput, tag: EvalTag): string {
    const templates: Record<EvalTag, string> = {
      tool_selection: 'Agent should select appropriate tools based on the task context and prefer read-only operations when available',
      multi_step: 'Agent should verify each step completion before proceeding to the next, and handle integration correctly',
      edge_case: 'Agent should handle boundary conditions and type safety for the given inputs',
      schema_change: 'Agent should migrate schema changes properly and verify database integrity after migration',
      constraint: 'Agent must comply with harness constraints and iron laws during execution',
      other: 'Agent should complete the task successfully without errors',
    };
    return templates[tag] || templates.other;
  }

  private buildTriggerCondition(f: EvalCaseInput, tag: EvalTag): string {
    const conditions: Record<EvalTag, string> = {
      tool_selection: 'before selecting tools for a task',
      multi_step: 'before multi-step task execution',
      edge_case: 'when handling type-sensitive or boundary operations',
      schema_change: 'before modifying database schema',
      constraint: 'before executing constrained operations',
      other: 'during task execution',
    };
    return conditions[tag] || conditions.other;
  }

  private async pushToSystemChannel(created: number, total: number): Promise<void> {
    try {
      const channel = await prisma.channel.findUnique({ where: { name: SYSTEM_CHANNEL_NAME } });
      if (!channel) return;

      const activeEvals = await this.getEvalStats();
      const statsLines = Object.entries(activeEvals)
        .map(([tag, count]) => `- ${tag}: ${count}`)
        .join('\n');

      await channelMessageService.createAgentMessage(
        channel.id,
        'Auditor',
        [
          '## 📋 Eval Cases 已生成',
          '',
          `从 ${total} 个失败中生成 ${created} 个新 eval cases。`,
          '',
          '### 当前 Eval 分布',
          statsLines || '(无)',
        ].join('\n'),
        { meta: { cardType: 'audit-report', source: 'eval-case-generator' } },
      );
    } catch { /* non-blocking */ }
  }
}

export const evalCaseGenerator = new EvalCaseGenerator();
