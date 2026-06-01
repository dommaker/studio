/**
 * PatternMiner (G-005) — 从 MCP traces + 审查历史中挖掘交互模式
 *
 * 滑动窗口 N=3 挖掘工具序列模式，每日运行。
 * 未来：LLM 摘要 + 协作网络分析。
 */

import { prisma } from '@dommaker/studio-prisma';
import { logger } from '@dommaker/studio-shared';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import os from 'os';

const EVENTS_DIR = process.env.EVENTS_DIR || path.join(os.homedir(), 'events');

interface ToolTraceEvent {
  type: string;
  tool: string;
  success: boolean;
  durationMs: number;
  timestamp: number;
  riskLevel?: string;
}

interface ToolSequencePattern {
  sequence: string[];
  count: number;
  avgSuccess: number;
}

export class PatternMiner {
  private readonly windowSize = 3;

  /**
   * 每日分析：从 MCP traces 中挖掘工具使用模式
   */
  async analyzeDaily(): Promise<number> {
    const yesterday = Date.now() - 24 * 60 * 60 * 1000;
    const traces = this.loadTracesSince(yesterday);

    if (traces.length < 10) {
      logger.debug('[PatternMiner] Not enough traces for pattern analysis', { traceCount: traces.length });
      return 0;
    }

    const newPatterns: number[] = [];

    // 1. 工具序列模式
    const seqPatterns = this.mineToolSequences(traces);
    for (const sp of seqPatterns.slice(0, 5)) {
      const name = `序列: ${sp.sequence.join(' → ')}`;
      const p = await this.upsertPattern({
        name,
        category: 'tool_usage',
        description: `高频工具序列: ${sp.sequence.join(' → ')} (出现 ${sp.count} 次)`,
        pattern: JSON.stringify(sp.sequence),
        frequency: sp.count,
        confidence: Math.min(sp.count / 10, 0.95),
        insight: `用户倾向于先执行 ${sp.sequence[0]}，然后 ${sp.sequence[1]}，最后 ${sp.sequence[2]}`,
        suggestion: `可预连接 ${sp.sequence[0]} → ${sp.sequence[1]} 减少切换成本`,
        observedPeriodStart: new Date(yesterday),
        observedPeriodEnd: new Date(),
      });
      newPatterns.push(p);
    }

    // 2. 工具成功率模式
    const toolStats = this.computeToolStats(traces);
    for (const [tool, stats] of Object.entries(toolStats)) {
      if (stats.total < 5) continue;
      if (stats.errorRate > 0.3) {
        const name = `高频错误: ${tool}`;
        const p = await this.upsertPattern({
          name,
          category: 'error',
          description: `${tool} 失败率 ${stats.errorRate}% (${stats.failures}/${stats.total})`,
          pattern: JSON.stringify({ tool, errorRate: stats.errorRate }),
          frequency: stats.total,
          confidence: Math.min(stats.total / 20, 0.9),
          insight: `${tool} 在过去 24h 有异常高的失败率`,
          suggestion: `检查 ${tool} 的参数或环境配置`,
          observedPeriodStart: new Date(yesterday),
          observedPeriodEnd: new Date(),
        });
        newPatterns.push(p);
      }
    }

    // 3. B10-103: Mine UserBehaviorProfile for workflow patterns
    const behaviorPatterns = await this.mineBehaviorProfiles(yesterday);
    newPatterns.push(...behaviorPatterns);

    // 4. 清理旧模式
    await prisma.interactionPattern.updateMany({
      where: {
        observedPeriodEnd: { lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
        status: 'active',
      },
      data: { status: 'outdated' },
    });

    // S10: Push high-confidence pattern insights to #系统 channel
    if (newPatterns.length > 0) {
      try {
        const highConfPatterns = await prisma.interactionPattern.findMany({
          where: { status: 'active', confidence: { gte: 0.7 } },
          orderBy: { confidence: 'desc' },
          take: 3,
        });
        if (highConfPatterns.length > 0) {
          const { channelMessageService } = await import('../channels/channel-message.service.js');
          const sysChannel = await prisma.channel.findUnique({ where: { name: '#系统' } });
          if (sysChannel) {
            const insightLines = highConfPatterns.map(p =>
              `- **${p.name}**: ${p.insight || p.description} (置信度: ${Math.round(p.confidence * 100)}%)`
            ).join('\n');
            await channelMessageService.createAgentMessage(sysChannel.id, 'PatternMiner',
              `发现 ${highConfPatterns.length} 个高置信度模式:\n${insightLines}`,
              { meta: { cardType: 'pattern_insight', count: highConfPatterns.length } },
            );
          }
        }
      } catch { /* non-blocking */ }
    }

    logger.info('[PatternMiner] Daily analysis complete', { patternsFound: newPatterns.length });
    return newPatterns.length;
  }

  /**
   * 获取活跃模式
   */
  async getActivePatterns(category?: string): Promise<Record<string, any>[]> {
    const where: any = { status: 'active' };
    if (category) where.category = category;

    const patterns = await prisma.interactionPattern.findMany({
      where,
      orderBy: [{ confidence: 'desc' }, { frequency: 'desc' }],
      take: 20,
    });

    return patterns.map(p => ({
      ...p,
      pattern: JSON.parse(p.pattern),
    }));
  }

  /**
   * 格式化模式为 prompt 注入片段
   */
  async formatForPrompt(): Promise<string> {
    const patterns = await this.getActivePatterns();
    if (patterns.length === 0) return '';

    const lines = ['\n## 交互模式（24h 统计）'];
    for (const p of patterns.slice(0, 5)) {
      if (p.suggestion) {
        lines.push(`- ${p.insight}`);
        lines.push(`  建议: ${p.suggestion}`);
      } else {
        lines.push(`- ${p.description}`);
      }
    }

    return lines.join('\n') + '\n';
  }

  // ── private ──

  private loadTracesSince(since: number): ToolTraceEvent[] {
    const filePath = path.join(EVENTS_DIR, 'studio.jsonl');
    if (!existsSync(filePath)) return [];

    try {
      const content = readFileSync(filePath, 'utf-8');
      return content
        .split('\n')
        .filter(Boolean)
        .map(line => {
          try { return JSON.parse(line); } catch { return null; }
        })
        .filter((e: any) => e && e.type === 'tool:call' && e.timestamp > since && !(e.tool || '').startsWith('__'))
        .map((e: any) => ({
          type: e.type,
          tool: e.tool,
          success: e.success,
          durationMs: e.durationMs,
          timestamp: e.timestamp,
          riskLevel: e.riskLevel,
        }));
    } catch {
      return [];
    }
  }

  private mineToolSequences(traces: ToolTraceEvent[]): ToolSequencePattern[] {
    // 按时间排序
    const sorted = [...traces].sort((a, b) => a.timestamp - b.timestamp);

    // 滑动窗口 N=3
    const sequenceCount = new Map<string, { count: number; successes: number }>();
    for (let i = 0; i <= sorted.length - this.windowSize; i++) {
      const window = sorted.slice(i, i + this.windowSize);
      const seq = window.map(t => t.tool);
      const key = seq.join('|>|');
      const entry = sequenceCount.get(key) || { count: 0, successes: 0 };
      entry.count++;
      entry.successes += window.filter(t => t.success).length;
      sequenceCount.set(key, entry);
    }

    // 按频率排序
    return Array.from(sequenceCount.entries())
      .map(([key, { count, successes }]) => ({
        sequence: key.split('|>|'),
        count,
        avgSuccess: successes / (count * this.windowSize),
      }))
      .filter(sp => sp.count >= 3) // 至少出现 3 次
      .sort((a, b) => b.count - a.count);
  }

  private computeToolStats(traces: ToolTraceEvent[]): Record<string, { total: number; failures: number; errorRate: number }> {
    const stats: Record<string, { total: number; failures: number; errorRate: number }> = {};
    for (const t of traces) {
      const s = stats[t.tool] || { total: 0, failures: 0, errorRate: 0 };
      s.total++;
      if (!t.success) s.failures++;
      s.errorRate = Math.round((s.failures / s.total) * 100);
      stats[t.tool] = s;
    }
    return stats;
  }

  private async upsertPattern(data: {
    name: string;
    category: string;
    description: string;
    pattern: string;
    frequency: number;
    confidence: number;
    insight: string;
    suggestion?: string;
    observedPeriodStart: Date;
    observedPeriodEnd: Date;
  }): Promise<number> {
    const existing = await prisma.interactionPattern.findFirst({
      where: { name: data.name, status: 'active' },
    });

    if (existing) {
      await prisma.interactionPattern.update({
        where: { id: existing.id },
        data: {
          frequency: Math.round((existing.frequency + data.frequency) / 2 * 10) / 10,
          confidence: Math.round(Math.max(existing.confidence, data.confidence) * 100) / 100,
          observedPeriodEnd: data.observedPeriodEnd,
        },
      });
      return 0;
    }

    await prisma.interactionPattern.create({
      data: {
        ...data,
        suggestion: data.suggestion || null,
      },
    });
    return 1;
  }

  /**
   * B10-103: Mine UserBehaviorProfile entries for workflow/automation patterns.
   * Aggregates similar behavior profiles into InteractionPattern entries.
   */
  private async mineBehaviorProfiles(since: number): Promise<number[]> {
    const newPatterns: number[] = [];

    try {
      const profiles = await prisma.userBehaviorProfile.findMany({
        where: {
          createdAt: { gte: new Date(since) },
          status: { notIn: ['rejected'] },
          confidence: { gte: 0.5 },
        },
        orderBy: { confidence: 'desc' },
      });

      if (profiles.length === 0) return newPatterns;

      // Aggregate by category + suggestedAction
      const groups = new Map<string, typeof profiles>();
      for (const p of profiles) {
        const key = `${p.category}:${p.suggestedAction}`;
        const group = groups.get(key) || [];
        group.push(p);
        groups.set(key, group);
      }

      for (const [key, group] of groups) {
        if (group.length < 2) continue; // need at least 2 to form a pattern

        const [category, suggestedAction] = key.split(':');
        const avgConfidence = group.reduce((s, p) => s + p.confidence, 0) / group.length;
        const titles = group.map(p => p.title).slice(0, 5);

        const name = `行为模式: ${category} → ${suggestedAction}`;
        const p = await this.upsertPattern({
          name,
          category: 'workflow',
          description: `${group.length} 个行为模式指向 ${suggestedAction}（${titles.join(', ')}）`,
          pattern: JSON.stringify({ category, suggestedAction, titles }),
          frequency: group.length,
          confidence: Math.min(avgConfidence, 0.95),
          insight: `用户在 ${category} 类场景中反复出现相似模式，建议 ${suggestedAction}`,
          suggestion: suggestedAction === 'create_rule' ? '考虑自动创建规则' :
            suggestedAction === 'create_skill' ? '考虑创建 Skill 自动化' :
            suggestedAction === 'create_automation' ? '考虑脚本自动化' : undefined,
          observedPeriodStart: new Date(since),
          observedPeriodEnd: new Date(),
        });
        newPatterns.push(p);
      }
    } catch (err) {
      logger.warn('[PatternMiner] mineBehaviorProfiles failed', { error: String(err) });
    }

    return newPatterns;
  }

  /**
   * KE-001 Phase 5: Auto-suggest Skills from high-confidence patterns.
   * Called after analyzeDaily(). Creates Skill proposals for patterns with
   * confidence > 0.8 && frequency >= 5 that don't already have a Skill.
   */
  async suggestSkillsFromPatterns(): Promise<number> {
    const highConfidence = await prisma.interactionPattern.findMany({
      where: {
        status: 'active',
        confidence: { gt: 0.8 },
        frequency: { gte: 5 },
        category: 'tool_usage',
      },
      orderBy: { confidence: 'desc' },
      take: 10,
    });

    if (highConfidence.length === 0) return 0;

    let suggested = 0;
    for (const pattern of highConfidence) {
      // Check if a Skill with similar name already exists
      const existing = await prisma.skill.findFirst({
        where: {
          name: { contains: pattern.name.slice(0, 50) },
          source: { in: ['proposal', 'extraction', 'builtin'] },
        },
      });
      if (existing) continue;

      // Create Skill proposal
      const sequence = JSON.parse(pattern.pattern);
      const tools = Array.isArray(sequence) ? sequence : [];
      await prisma.skill.create({
        data: {
          companyId: 'system',
          name: `Auto: ${pattern.name}`.slice(0, 100),
          source: 'proposal',
          status: 'draft',
          category: pattern.category,
          description: pattern.description,
          tools: JSON.stringify(tools),
          metadata: JSON.stringify({
            patternId: pattern.id,
            confidence: pattern.confidence,
            frequency: pattern.frequency,
            insight: pattern.insight,
            suggestion: pattern.suggestion,
            autoGenerated: true,
          }),
        },
      });
      suggested++;
      logger.info('[PatternMiner] Skill proposal created', { patternName: pattern.name, confidence: pattern.confidence });
    }

    return suggested;
  }
}

export const patternMiner = new PatternMiner();
