/**
 * DecisionChainExtractor — decision_chain 历史数据只读查询。
 *
 * 提取与手工记录已退役；保留类名以兼容既有查询调用方。
 */

import { sharedStore } from '../knowledge-singletons.js';

export class DecisionChainExtractor {
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
}

export const decisionChainExtractor = new DecisionChainExtractor();
