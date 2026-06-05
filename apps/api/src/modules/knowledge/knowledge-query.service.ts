/**
 * KnowledgeQueryService (S8) — 统一知识检索入口
 *
 * 聚合五种知识类型的查询 + 格式化，供 Agent context injection 使用。
 */

import { logger } from '@dommaker/studio-shared';
import { preferenceObserver } from './preference-observer.js';
import { ruleScanner } from './rule-scanner.js';
import { envSnapper } from './env-snapper.js';
import { decisionChainExtractor } from './decision-chain-extractor.js';
import { patternMiner } from './pattern-miner.js';

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
        const snap = await envSnapper.getLatest();
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

  /**
   * 获取知识统计概览
   */
  async getStats(): Promise<Record<string, any>> {
    const stats: Record<string, any> = {};

    try {
      const prefs = await preferenceObserver.getPreferences();
      stats.preference = prefs ? { confidence: prefs.confidence } : { status: 'cold_start' };
    } catch { stats.preference = { error: true }; }

    try {
      const rules = await ruleScanner.getActiveRules();
      stats.business_rule = { count: rules.length };
    } catch { stats.business_rule = { error: true }; }

    try {
      const snap = await envSnapper.getLatest();
      stats.environment = snap ? { takenAt: snap.takenAt } : { status: 'no_snapshot' };
    } catch { stats.environment = { error: true }; }

    try {
      const chains = await decisionChainExtractor.query({ limit: 0 });
      stats.decision_chain = { count: chains.length };
    } catch { stats.decision_chain = { error: true }; }

    try {
      const patterns = await patternMiner.getActivePatterns();
      stats.interaction = { count: patterns.length };
    } catch { stats.interaction = { error: true }; }

    return stats;
  }
}

export const knowledgeQuery = new KnowledgeQueryService();
