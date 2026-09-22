/**
 * PatternMiner (G-005) — 从 MCP traces 中挖掘交互模式
 *
 * 存储：KnowledgeStore (type='pattern', tags=['pattern', category])
 * 滑动窗口 N=3 挖掘工具序列模式，每日运行。
 */

import { logger, FileStore } from '@dommaker/studio-shared';
import { skillStore } from '../skills/skill-store.js';
import { sharedStore } from './knowledge-singletons.js';
import { listInteractionPatterns, parsePatternContent } from './pattern-entry.js';
import {
  resolveStudioEventsFile,
  parseStudioEventPayload,
  getStudioEventTime,
} from '../../utils/studio-events.js';
// #335：窗口读口（尾部倒读 + 窗口外早停），替代 readFileSync 全量读
import { readStudioEventsSince } from '../../utils/studio-events-tail.js';

// D18: tool:call trace 读自统一事件文件（~/.studio/logs/studio-events.jsonl，测试期隔离）
const fileStore = new FileStore();

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

function newId(): string {
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 8);
  return `pat-${ts}-${rnd}`;
}

export class PatternMiner {
  private readonly windowSize = 3;

  async analyzeDaily(): Promise<number> {
    const yesterday = Date.now() - 24 * 60 * 60 * 1000;
    const traces = await this.loadTracesSince(yesterday);

    if (traces.length < 10) {
      logger.debug('[PatternMiner] Not enough traces for pattern analysis', { traceCount: traces.length });
      return 0;
    }

    const newPatterns: number[] = [];

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

    // 清理旧模式 — 标记 7 天前的为 outdated
    const allPatterns = listInteractionPatterns(sharedStore);
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const entry of allPatterns) {
      const data = parsePatternContent(entry.content);
      if (data === null) continue; // 正文损坏条目跳过（见 pattern-entry.ts 根因注释）
      if (data.status === 'active' && new Date(data.observedPeriodEnd).getTime() < weekAgo) {
        const tags = (entry as any).tags as string[];
        // #614：data.status 不随 tags 改写，本分支每次运行都命中——
        // 已标记 outdated 的条目不再重复追加
        if (tags.includes('outdated') && !tags.includes('active')) continue;
        sharedStore.save({ ...entry, tags: [...tags.filter((t: string) => t !== 'active' && t !== 'outdated'), 'outdated'] } as any);
      }
    }

    if (newPatterns.length > 0) {
      try {
        const activePatterns = listInteractionPatterns(sharedStore, ['active'])
          .filter((e) => {
            const d = parsePatternContent(e.content);
            return d !== null && d.confidence >= 0.7;
          })
          .sort((a, b) => {
            return (parsePatternContent(b.content)?.confidence || 0)
                 - (parsePatternContent(a.content)?.confidence || 0);
          })
          .slice(0, 3);

        if (activePatterns.length > 0) {
          const { channelMessageService } = await import('../channels/channel-message.service.js');
          const sysChannels = await fileStore.listChannels({ name: '#系统' });
          const sysChannel = sysChannels[0] ?? null;
          if (sysChannel) {
            const insightLines = activePatterns.map((e) => {
              const d = parsePatternContent(e.content) ?? {};
              return `- **${e.title}**: ${d.insight || d.description} (置信度: ${Math.round((d.confidence || 0) * 100)}%)`;
            }).join('\n');
            await channelMessageService.createAgentMessage(sysChannel.id, 'PatternMiner',
              `发现 ${activePatterns.length} 个高置信度模式:\n${insightLines}`,
              { meta: { cardType: 'pattern_insight', count: activePatterns.length } },
            );
          }
        }
      } catch { /* non-blocking */ }
    }

    logger.info('[PatternMiner] Daily analysis complete', { patternsFound: newPatterns.length });
    return newPatterns.length;
  }

  async getActivePatterns(category?: string): Promise<Record<string, any>[]> {
    const entries = listInteractionPatterns(sharedStore, ['active']);

    return entries
      .map((e) => {
        const d = parsePatternContent(e.content);
        if (d === null) return null; // 正文损坏条目跳过（见 pattern-entry.ts 根因注释）
        if (category && d.category !== category) return null;
        return { ...d, id: e.id, name: e.title, status: d.status || 'active' };
      })
      .filter(Boolean)
      .sort((a: any, b: any) => (b?.confidence || 0) - (a?.confidence || 0) || (b?.frequency || 0) - (a?.frequency || 0))
      .slice(0, 20);
  }

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

  private async loadTracesSince(since: number): Promise<ToolTraceEvent[]> {
    // D18: 统一事件文件；兼容 payload 嵌套（agent-loop/task-executor/mcp）与历史扁平形态
    // #335: 窗口读口——窗口外的行不 parse（原 readFileSync 全量 + 应用层过滤）
    const filePath = resolveStudioEventsFile();

    try {
      const rows = await readStudioEventsSince({ file: filePath, sinceMs: since });
      return rows
        .filter((e: any) => e && e.type === 'tool:call')
        .map((e: any) => {
          const p = parseStudioEventPayload(e) ?? {};
          const flat = { ...p, ...e };
          const ts = getStudioEventTime(e);
          return {
            type: 'tool:call',
            tool: flat.tool,
            success: flat.success,
            durationMs: flat.durationMs,
            timestamp: Number.isFinite(ts) ? ts : 0,
            riskLevel: flat.riskLevel,
          };
        })
        .filter((e: ToolTraceEvent) => e.timestamp > since && !(e.tool || '').startsWith('__'));
    } catch { return []; }
  }

  private mineToolSequences(traces: ToolTraceEvent[]): ToolSequencePattern[] {
    const sorted = [...traces].sort((a, b) => a.timestamp - b.timestamp);
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
    return Array.from(sequenceCount.entries())
      .map(([key, { count, successes }]) => ({
        sequence: key.split('|>|'),
        count,
        avgSuccess: successes / (count * this.windowSize),
      }))
      .filter(sp => sp.count >= 3)
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
    const entries = listInteractionPatterns(sharedStore, ['active']);
    const existing = entries.find((e) => e.title === data.name);

    if (existing) {
      const d = parsePatternContent(existing.content);
      // 正文损坏条目无法安全合并：跳过本次 upsert（不新建同标题副本），等数据修复
      if (d === null) {
        logger.warn('[PatternMiner] skip upsert: corrupted pattern content', { id: existing.id, title: data.name });
        return 0;
      }
      sharedStore.save({
        ...existing,
        content: JSON.stringify({
          ...d,
          frequency: Math.round((d.frequency + data.frequency) / 2 * 10) / 10,
          confidence: Math.round(Math.max(d.confidence, data.confidence) * 100) / 100,
          observedPeriodEnd: data.observedPeriodEnd.toISOString(),
        }),
      } as any);
      return 0;
    }

    const id = newId();
    const ts = new Date().toISOString();
    sharedStore.save({
      id,
      type: 'pattern' as any,
      title: data.name,
      content: JSON.stringify(data),
      maturity: 'active' as any,
      layer: 'project',
      created: ts,
      lastReferenced: ts,
      contributors: ['pattern-miner'],
      projects: [],
      tags: ['pattern', 'active', data.category],
      applicablePhases: [],
      sourceReferences: [],
      referencedBy: [],
      executionResults: [],
      consumptionMode: 'signal',
      // #371：统计挖掘批量产物非会话沉淀，标 system 不计入蒸馏 topic 信号
      origin: 'system',
    } as any);
    return 1;
  }

  async suggestSkillsFromPatterns(): Promise<number> {
    const entries = listInteractionPatterns(sharedStore, ['active', 'tool_usage']);
    const highConfidence = entries
      .filter((e) => {
        const d = parsePatternContent(e.content);
        return d !== null && d.confidence > 0.8 && d.frequency >= 5;
      })
      .sort((a, b) => {
        return (parsePatternContent(b.content)?.confidence || 0) - (parsePatternContent(a.content)?.confidence || 0);
      })
      .slice(0, 10);

    if (highConfidence.length === 0) return 0;

    let suggested = 0;
    for (const pattern of highConfidence) {
      const d = parsePatternContent(pattern.content) ?? {};
      const existing = skillStore.findFirst({
        name: { contains: pattern.title.slice(0, 50) },
        source: { in: ['proposal', 'extraction', 'builtin'] },
      });
      if (existing) continue;

      // d.pattern 是条目内嵌的 JSON 字符串，同样只是约定：解析失败按空工具列表处理
      let patternTools: unknown[] = [];
      try {
        const parsed: unknown = JSON.parse(d.pattern);
        if (Array.isArray(parsed)) patternTools = parsed;
      } catch { /* 见 pattern-entry.ts 根因注释 */ }

      skillStore.create({
        companyId: 'system',
        name: `Auto: ${pattern.title}`.slice(0, 100),
        source: 'proposal',
        status: 'draft',
        category: d.category,
        description: d.description,
        tools: JSON.stringify(patternTools),
        metadata: JSON.stringify({
          patternId: pattern.id,
          confidence: d.confidence,
          frequency: d.frequency,
          insight: d.insight,
          suggestion: d.suggestion,
          autoGenerated: true,
        }),
      });
      suggested++;
      logger.info('[PatternMiner] Skill proposal created', { patternName: pattern.title, confidence: d.confidence });
    }

    return suggested;
  }
}

export const patternMiner = new PatternMiner();
