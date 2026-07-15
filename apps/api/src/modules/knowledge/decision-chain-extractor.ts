/**
 * DecisionChainExtractor (G-004) — 从 Meeting 辩论 + WorkUnit 执行中提取决策链
 *
 * 提取完整推理链：背景→候选方案→选择理由→权衡，而非仅存最终决策。
 */

import { prisma } from '@dommaker/studio-prisma';
import { modelGateway, logger, FileStore } from '@dommaker/studio-shared';

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

export class DecisionChainExtractor {
  /**
   * 从 WorkUnit 执行中提取（架构变更时调用）
   */
  async extractFromExecution(params: {
    taskId: string;
    projectId: string;
    taskDescription: string;
    changedFiles: string[];
    diff?: string;
  }): Promise<number> {
    const { taskId, projectId, taskDescription, changedFiles, diff } = params;

    // T-1.3: 用 task description 关键词预筛选替代架构文件正则
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
      const result = await modelGateway.promptJson<{ decisions: any[] }>(prompt, EXTRACT_SYSTEM_PROMPT);
      const llmMs = Date.now() - llmStart;

      if (!result.decisions?.length) return 0;

      let count = 0;
      for (const d of result.decisions) {
        if (!d.topic || !d.chosen) continue;

        await prisma.decisionChain.create({
          data: {
            topic: d.topic,
            category: this.inferCategory(d.topic, d.options),
            context: d.context || taskDescription,
            options: JSON.stringify(d.options || [{ name: d.chosen, pros: [], cons: [] }]),
            chosen: d.chosen,
            rationale: d.rationale || '',
            tradeoffs: d.tradeoffs || '',
            sourceType: 'execution',
            sourceId: taskId,
            participants: JSON.stringify(['executor']),
            revisable: true,
          },
        });
        count++;
      }

      logger.info('[DecisionChainExtractor] Extracted from execution', { taskId, count, llmMs });

      // S10: Push decision confirmation card to #系统 channel
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
    const record = await prisma.decisionChain.create({
      data: {
        topic: params.topic,
        category: params.category,
        context: params.context,
        options: JSON.stringify(params.options || []),
        chosen: params.chosen,
        rationale: params.rationale,
        tradeoffs: params.tradeoffs || '',
        sourceType: params.sourceType || 'audit',
        sourceId: params.sourceId || null,
        participants: JSON.stringify(['manual']),
        revisable: params.revisable !== false,
        revisitCondition: params.revisitCondition || null,
      },
    });

    logger.info('[DecisionChainExtractor] Manual decision recorded', { id: record.id, topic: params.topic });
    return record.id;
  }

  /**
   * 查询决策链
   */
  async query(params: {
    topic?: string;
    category?: string;
    sourceType?: string;
    limit?: number;
  }): Promise<Record<string, any>[]> {
    const where: any = {};
    if (params.topic) where.topic = { contains: params.topic };
    if (params.category) where.category = params.category;
    if (params.sourceType) where.sourceType = params.sourceType;

    const chains = await prisma.decisionChain.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: params.limit || 20,
    });

    return chains.map(c => ({
      ...c,
      options: JSON.parse(c.options),
      participants: JSON.parse(c.participants),
    }));
  }

  /**
   * 获取应重新审视的决策
   */
  async getRevisable(): Promise<Record<string, any>[]> {
    const chains = await prisma.decisionChain.findMany({
      where: { revisable: true },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    return chains
      .filter(c => c.revisitCondition)
      .map(c => ({
        ...c,
        options: JSON.parse(c.options),
        participants: JSON.parse(c.participants),
      }));
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

  // ── private ──

  private inferCategory(topic: string, options: any[]): string {
    const t = topic.toLowerCase();
    if (t.match(/db|database|sqlite|postgres|storage|orm/)) return 'tooling';
    if (t.match(/arch|架构|分层|模块|service|repository/)) return 'architecture';
    if (t.match(/deploy|pipeline|ci|cd|nginx|docker/)) return 'process';
    if (t.match(/ui|frontend|component|page|route/)) return 'design';
    if (t.match(/api|endpoint|route|protocol/)) return 'design';
    return 'process';
  }

  private isArchitectureChange(files: string[]): boolean {
    const signals = [
      /schema\.prisma$/,
      /\.architect\//,
      /tsconfig.*\.json$/,
      /package\.json$/,
      /docker/i,
      /nginx/i,
      /config\.(yml|yaml)$/,
      /\.env\./,
      /src\/core\//,
      /src\/modules\//,
    ];
    return signals.some(re => files.some(f => re.test(f)));
  }
}

export const decisionChainExtractor = new DecisionChainExtractor();
