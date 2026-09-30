/**
 * knowledge-injector — 知识注入策略（studio 本地正本）
 *
 * 知识消费编排归 studio（harness 仓 docs/positioning.md + ADR-0031~0034 分工：
 * harness 只保留存储/检索家具与标准），harness 侧 KnowledgeInjector 正从源码
 * 移除；本模块承接其注入策略逻辑：按阶段/预算查询 → exclude 去重 → 预算不足
 * 摘要降级 → 产出 ContextSource。
 *
 * 只依赖 harness 的公开家具面（KnowledgeQuery / estimateTokens / KnowledgeEntry
 * 类型），不复制 harness 的存储/检索实现。
 */

import { estimateTokens } from '@dommaker/harness';
import type { KnowledgeEntry, KnowledgeQuery, KnowledgeSubsystem } from '@dommaker/harness';

/**
 * ContextSource 同构类型（本地定义）。
 * harness 侧该类型挂在 context/types，将随 KnowledgeInjector 一并移除且不属于
 * harness 保留的家具面，故 studio 本地自持同构定义，不再 import。
 */
export interface ContextSource {
  type: 'session_event' | 'tool_output' | 'knowledge' | 'user_message' | 'system_prompt' | 'tool_definition';
  id: string;
  content: string;
  priority: number;
  metadata?: Record<string, any>;
}

export interface InjectionConfig {
  /** Token 预算（默认 800） */
  budget: number;
  /** 关注的知识类型 */
  focusTypes?: KnowledgeSubsystem[];
  /** 当前阶段 */
  phase?: string;
  /** 已注入的条目 ID（去重） */
  exclude?: string[];
  /** 是否注入摘要版本（已注入的条目） */
  injectSummaryForExcluded?: boolean;
}

export interface InjectionResult {
  sources: ContextSource[];
  tokensUsed: number;
  entriesIncluded: number;
  entriesExcluded: number;
  entriesSummarized: number;
}

/**
 * 外部来源条目的 prompt 标记。
 * 正本在 harness knowledge/query.ts（EXTERNAL_SOURCE_MARKER，harness#161 三层防御
 * 第二层 retrieval marking，标记值仓内唯一）；已安装 harness 版本未从包根导出该
 * 常量，故此处保留同值字面量。formatEntry/formatEntrySummary 同理——已安装版
 * KnowledgeQuery.formatForPrompt 是另一种简化格式（无 ID/成熟度/层级/标签头），
 * 与注入路径格式不等价，本地复刻以保持注入输出不变。待 harness 发版导出后切换为
 * import，删除本地复刻。
 */
export const EXTERNAL_SOURCE_MARKER = '[External Source — verify before acting]';

export class KnowledgeInjector {
  private query: KnowledgeQuery;

  constructor(query: KnowledgeQuery) {
    this.query = query;
  }

  /**
   * 注入知识到上下文
   */
  inject(config: InjectionConfig): InjectionResult {
    const {
      budget,
      focusTypes,
      phase,
      exclude = [],
      injectSummaryForExcluded = true,
    } = config;

    // 查询知识
    const queryResult = this.query.query({
      phase: phase || 'default',
      maxTokens: budget,
      maxEntries: 20,
      focusTypes: focusTypes || [],
    });

    const sources: ContextSource[] = [];
    let tokensUsed = 0;
    let entriesIncluded = 0;
    let entriesExcluded = 0;
    let entriesSummarized = 0;

    const excludeSet = new Set(exclude);

    for (const entry of queryResult.entries) {
      if (excludeSet.has(entry.id)) {
        entriesExcluded++;

        // 注入摘要版本
        if (injectSummaryForExcluded) {
          const summary = this.formatEntrySummary(entry);
          const summaryTokens = estimateTokens(summary);

          if (tokensUsed + summaryTokens <= budget) {
            sources.push({
              type: 'knowledge',
              id: `knowledge-summary-${entry.id}`,
              content: summary,
              priority: 3,
              metadata: { entryId: entry.id, isSummary: true, origin: entry.origin },
            });
            tokensUsed += summaryTokens;
            entriesSummarized++;
          }
        }

        continue;
      }

      // 注入完整版本
      const formatted = this.formatEntry(entry);
      const entryTokens = estimateTokens(formatted);

      if (tokensUsed + entryTokens <= budget) {
        sources.push({
          type: 'knowledge',
          id: `knowledge-${entry.id}`,
          content: formatted,
          priority: 3,
          metadata: { entryId: entry.id, maturity: entry.maturity, origin: entry.origin },
        });
        tokensUsed += entryTokens;
        entriesIncluded++;
      } else {
        // 预算不足，尝试注入摘要
        const summary = this.formatEntrySummary(entry);
        const summaryTokens = estimateTokens(summary);

        if (tokensUsed + summaryTokens <= budget) {
          sources.push({
            type: 'knowledge',
            id: `knowledge-summary-${entry.id}`,
            content: summary,
            priority: 3,
            metadata: { entryId: entry.id, isSummary: true, origin: entry.origin },
          });
          tokensUsed += summaryTokens;
          entriesSummarized++;
        }
      }
    }

    return {
      sources,
      tokensUsed,
      entriesIncluded,
      entriesExcluded,
      entriesSummarized,
    };
  }

  /**
   * 将知识条目格式化为上下文内容。
   * 外部来源条目带 EXTERNAL_SOURCE_MARKER 前缀（harness#161：
   * 三层防御第二层 retrieval marking 的正本接线，标记唯一来源是 knowledge/query）。
   */
  formatEntry(entry: KnowledgeEntry): string {
    const parts: string[] = [];

    if (entry.origin === 'external') {
      parts.push(EXTERNAL_SOURCE_MARKER);
    }

    parts.push(`## [${entry.type.toUpperCase()}] ${entry.title}`);
    parts.push(`ID: ${entry.id} | 成熟度: ${entry.maturity} | 层级: ${entry.layer}`);

    if (entry.tags.length > 0) {
      parts.push(`标签: ${entry.tags.join(', ')}`);
    }

    parts.push('');
    parts.push(entry.content);

    return parts.join('\n');
  }

  /**
   * 将知识条目格式化为摘要（一行）；外部来源条目同样带来源标记前缀
   */
  formatEntrySummary(entry: KnowledgeEntry): string {
    const prefix = entry.origin === 'external' ? `${EXTERNAL_SOURCE_MARKER} ` : '';
    return `${prefix}[${entry.id}] ${entry.title} (${entry.maturity}) — ${entry.content.slice(0, 100)}${entry.content.length > 100 ? '...' : ''}`;
  }

  /**
   * 获取查询引擎
   */
  getQuery(): KnowledgeQuery {
    return this.query;
  }
}
