/**
 * KnowledgeQueryService (S8) — 统一知识检索入口
 *
 * 聚合五种知识类型的查询 + 格式化，供 Agent context injection 使用。
 * P4.2（2026-10-17）：getStats（五类统计概览）原唯一消费方
 * GET /knowledge/gaps 端点已删，方法随之摘除。
 */

import { preferenceObserver } from './producers/preference-observer.js';
import { ruleScanner } from './producers/rule-scanner.js';
import { getEnvSnapper } from './producers/env-snapper.js';
import { decisionChainExtractor } from './producers/decision-chain-extractor.js';
import { patternMiner } from './producers/pattern-miner.js';

export type KnowledgeType =
  | 'preference'
  | 'business_rule'
  | 'environment'
  | 'decision_chain'
  | 'interaction';

export class KnowledgeQueryService {
  /**
   * 按类型查询知识
   */
  async query(params: {
    type: KnowledgeType;
    topic?: string;
    category?: string;
    limit?: number;
  }): Promise<Record<string, any>[]> {
    switch (params.type) {
      case 'preference': {
        const prefs = await preferenceObserver.getPreferences();
        return prefs ? [prefs] : [];
      }
      case 'business_rule': {
        return ruleScanner.getActiveRules();
      }
      case 'environment': {
        const snap = await getEnvSnapper().getLatest();
        return snap ? [snap] : [];
      }
      case 'decision_chain': {
        return decisionChainExtractor.query({
          topic: params.topic,
          category: params.category,
          limit: params.limit || 10,
        });
      }
      case 'interaction': {
        return patternMiner.getActivePatterns(params.category);
      }
      default:
        return [];
    }
  }
}

export const knowledgeQuery = new KnowledgeQueryService();
