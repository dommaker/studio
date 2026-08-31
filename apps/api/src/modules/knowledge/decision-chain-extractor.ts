/**
 * DecisionChainExtractor (G-004) — 从 WorkUnit 执行中提取决策链
 *
 * 存储：KnowledgeStore (type=decision, tags=['decision'])
 * 提取完整推理链：背景→候选方案→选择理由→权衡。
 */

import { logger, FileStore } from '@dommaker/studio-shared';
import { getSystemExecutor } from '../agents/system-executor.js';
import { randomUUID } from 'crypto';
import { sharedStore } from './knowledge-singletons.js';
import type { KnowledgeEntry } from '@dommaker/harness';

const fileStore = new FileStore();

const EXTRACT_SYSTEM_PROMPT = `你是一个决策分析师。从以下讨论记录中提取决策链。

每个决策应包含：
- topic: 决策主题（简洁）
- context: 决策背景（当时面临什么问题，1-2 句话）
- options: 候选方案列表 [{ name, pros: [...], cons: [...] }]
- chosen: 最终选择的方案名称
- rationale: 选择理由（为什么选这个而不是其他，1-2 句话）
- tradeoffs: 已知权衡（放弃/妥协了什么）
- revisable: 是否可以推翻 (true/false)
- revisitCondition: 什么条件下应重新审视

请严格以 JSON 格式返回：
{
  "decisions": [
    {
      "topic": "...",
      "context": "...",
      "options": [{"name": "...", "pros": ["..."], "cons": ["..."]}],
      "chosen": "...",
      "rationale": "...",
      "tradeoffs": "...",
      "revisable": true,
      "revisitCondition": "..."
    }
  ]
}

提取规则：
- 只提取有实质内容的决策，忽略 trivial 选择
- 没有明确决策的讨论 → 返回空数组
- 最多提取 3 个决策`;

function newId(): string {
  return `decision-${randomUUID().slice(0, 8)}`;
}

function now(): string {
  return new Date().toISOString();
}

export class DecisionChainExtractor {
  /**
   * 从 WorkUnit 执行中提取（关键词预筛选）
   */
  async extractFromExecution(params: {
    taskId: string;
    projectId: string;
    taskDescription: string;
    changedFiles: string[];
    diff?: string;
  }): Promise<number> {
    const { taskId, projectId, taskDescription, changedFiles, diff } = params;

    const decisionKeywords = /选择|方案|决定|选型|设计|架构|改为|迁移|重构|替代|切换/;
    if (!decisionKeywords.test(taskDescription)) return 0;

    try {
      const prompt = `## 任务
${taskDescription}

## 变更文件
${changedFiles.join('\n')}

## Git Diff（截取前 3000 字符）
\`\`\`diff
${(diff || '').substring(0, 3000)}
\`\`\`

从这个任务执行中识别隐含的设计决策。这个任务做出了什么技术选择？`;

      const llmStart = Date.now();
      const result = await getSystemExecutor().runJson<{ decisions: any[] }>(prompt, { systemPrompt: EXTRACT_SYSTEM_PROMPT, eventSource: 'decision-chain-extraction' });
      const llmMs = Date.now() - llmStart;

      if (!result.decisions?.length) return 0;

      const ts = now();
      let count = 0;
      for (const d of result.decisions) {
        if (!d.topic || !d.chosen) continue;

        const entry = {
          id: newId(),
          type: 'decision' as any,
          title: d.topic,
          content: JSON.stringify({
            context: d.context || taskDescription,
            options: d.options || [],
            chosen: d.chosen,
            rationale: d.rationale || '',
            tradeoffs: d.tradeoffs || '',
            sourceType: 'execution',
            sourceId: taskId,
            participants: ['executor'],
            revisable: true,
          }),
          maturity: 'active' as any,
          layer: 'project',
          created: ts,
          lastReferenced: ts,
          contributors: ['decision-chain-extractor'],
          projects: [projectId],
          tags: ['decision', 'execution', this.inferCategory(d.topic, d.options)],
          applicablePhases: [],
          sourceReferences: [{ source: `execution:${taskId}`, timestamp: ts }] as any,
          referencedBy: [],
          executionResults: [],
          consumptionMode: 'reference',
          origin: 'agent',
        } as unknown as KnowledgeEntry;

        sharedStore.save(entry);
        count++;
      }

      logger.info('[DecisionChainExtractor] Extracted from execution', { taskId, count, llmMs });

      if (count > 0) {
        try {
          const { channelMessageService } = await import('../channels/channel-message.service.js');
          const sysChannels = await fileStore.listChannels({ name: '#系统' });
          const sysChannel = sysChannels[0] ?? null;
          if (sysChannel) {
            const decisionSummary = result.decisions
              .slice(0, 3)
              .map(d => `- **${d.topic}**: 选择 ${d.chosen}${d.rationale ? ` (${d.rationale.slice(0, 80)})` : ''}`)
              .join('\n');
            await channelMessageService.createAgentMessage(sysChannel.id, 'KK',
              `从执行 ${taskId.slice(0, 8)} 提取了 ${count} 个决策:\n${decisionSummary}`,
              { meta: { cardType: 'decision_chain', taskId, count } },
            );
          }
        } catch { /* non-blocking */ }
      }

      return count;
    } catch (err) {
      logger.error('[DecisionChainExtractor] Execution extraction failed', { taskId, error: String(err) });
      return 0;
    }
  }

  /**
   * 手动记录决策
   */
  async recordManual(params: {
    topic: string;
    category: string;
    context: string;
    options: any[];
    chosen: string;
    rationale: string;
    tradeoffs?: string;
    sourceType?: string;
    sourceId?: string;
    revisable?: boolean;
    revisitCondition?: string;
  }): Promise<string> {
    const id = newId();
    const ts = now();

    const entry = {
      id,
      type: 'decision' as any,
      title: params.topic,
      content: JSON.stringify({
        context: params.context,
        options: params.options || [],
        chosen: params.chosen,
        rationale: params.rationale,
        tradeoffs: params.tradeoffs || '',
        sourceType: params.sourceType || 'manual',
        sourceId: params.sourceId || null,
        participants: ['manual'],
        revisable: params.revisable !== false,
        revisitCondition: params.revisitCondition || null,
      }),
      maturity: 'active' as any,
      layer: 'project',
      created: ts,
      lastReferenced: ts,
      contributors: ['decision-chain-extractor'],
      projects: [],
      tags: ['decision', params.category],
      applicablePhases: [],
      sourceReferences: [],
      referencedBy: [],
      executionResults: [],
      consumptionMode: 'reference',
      origin: 'human',
    } as unknown as KnowledgeEntry;

    sharedStore.save(entry);
    logger.info('[DecisionChainExtractor] Manual decision recorded', { id, topic: params.topic });
    return id;
  }

  /**
   * 查询决策链
   *
   * R1（type-repair）：口径放宽为 type='decision' OR tags 含 'decision' ——
   * LLM 会话提取产物（ingestConversationEntry，tags 约定 ['decision', <category>]）
   * 与存量 type='decision' 但无 tag 的条目均可查到。
   * content 逐条容错：extractor 产物是 JSON，LLM 产物是自然语言（解析失败按 {} 处理，不整单失败）。
   */
  async query(params: {
    topic?: string;
    category?: string;
    sourceType?: string;
    limit?: number;
  }): Promise<Record<string, any>[]> {
    const entries = sharedStore.list({})
      .filter(e => (e as any).type === 'decision' || e.tags?.includes('decision'));
    let results = entries.map(e => {
      let data: Record<string, any> = {};
      try {
        const parsed = JSON.parse((e as any).content || '{}');
        if (parsed && typeof parsed === 'object') data = parsed;
      } catch { /* LLM 产物为自然语言 content — 按空 data 容错 */ }
      return {
        id: e.id,
        topic: e.title,
        category: (e as any).tags?.find((t: string) => t !== 'decision') || 'process',
        context: data.context || '',
        chosen: data.chosen || '',
        rationale: data.rationale || '',
        tradeoffs: data.tradeoffs || '',
        sourceType: data.sourceType || '',
        sourceId: data.sourceId,
        options: data.options || [],
        participants: data.participants || [],
        revisable: data.revisable !== false,
        revisitCondition: data.revisitCondition,
        createdAt: e.created,
      };
    });

    // Filter
    if (params.topic) {
      const q = params.topic.toLowerCase();
      results = results.filter(r => r.topic.toLowerCase().includes(q));
    }
    if (params.category) {
      results = results.filter(r => r.category === params.category);
    }
    if (params.sourceType) {
      results = results.filter(r => r.sourceType === params.sourceType);
    }

    // Sort by createdAt desc
    results.sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));
    return results.slice(0, params.limit || 20);
  }

  /**
   * 获取应重新审视的决策
   */
  async getRevisable(): Promise<Record<string, any>[]> {
    const entries = sharedStore.list({ tags: ['decision'] });
    return entries
      .map(e => {
        const data = JSON.parse((e as any).content || '{}');
        if (!data.revisable || !data.revisitCondition) return null;
        return {
          id: e.id,
          topic: e.title,
          options: data.options || [],
          chosen: data.chosen || '',
          rationale: data.rationale || '',
          tradeoffs: data.tradeoffs || '',
          sourceType: data.sourceType || '',
          revisitCondition: data.revisitCondition,
          createdAt: e.created,
        };
      })
      .filter(Boolean) as Record<string, any>[];
  }

  /**
   * 格式化决策为 prompt 注入片段
   */
  async formatForPrompt(topic?: string): Promise<string> {
    const chains = await this.query({ topic, limit: 5 });
    if (chains.length === 0) return '';

    const lines = ['\n## 历史决策（相关）'];
    for (const c of chains) {
      lines.push(`- **${c.topic}**: 选择了 ${c.chosen}，理由: ${c.rationale}`);
      if (c.tradeoffs) lines.push(`  权衡: ${c.tradeoffs}`);
    }
    return lines.join('\n') + '\n';
  }

  private inferCategory(topic: string, options: any[]): string {
    const t = topic.toLowerCase();
    if (t.match(/db|database|sqlite|postgres|storage|orm/)) return 'tooling';
    if (t.match(/arch|架构|分层|模块|service|repository/)) return 'architecture';
    if (t.match(/deploy|pipeline|ci|cd|nginx|docker/)) return 'process';
    if (t.match(/ui|frontend|component|page|route/)) return 'design';
    if (t.match(/api|endpoint|route|protocol/)) return 'design';
    return 'process';
  }
}

export const decisionChainExtractor = new DecisionChainExtractor();
