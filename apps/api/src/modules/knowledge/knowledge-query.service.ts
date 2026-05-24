/**
 * KnowledgeQueryService (S8) — 统一知识检索入口
 *
 * 聚合五种知识类型的查询 + 格式化，供 Agent context injection 使用。
 */

import { logger } from '@dommaker/studio-shared';
import { sharedStore } from './knowledge-bus.service.js';
import { preferenceObserver } from './preference-observer.js';
import { ruleScanner } from './rule-scanner.js';
import { envSnapper } from './env-snapper.js';
import { decisionChainExtractor } from './decision-chain-extractor.js';
import { patternMiner } from './pattern-miner.js';

// H1: 知识总线（Agent 间共享）
import { knowledgeBus } from './knowledge-bus.service.js';

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
   * 全量格式化：五种知识类型合并为 prompt 注入文本
   */
  async formatAllForPrompt(agentType?: string): Promise<string> {
    const parts: string[] = [];

    try {
      const prefPrompt = await preferenceObserver.formatForPrompt();
      if (prefPrompt) parts.push(prefPrompt);
    } catch { /* best-effort */ }

    try {
      const rulesPrompt = await ruleScanner.formatForPrompt(agentType);
      if (rulesPrompt) parts.push(rulesPrompt);
    } catch { /* best-effort */ }

    try {
      const envPrompt = await envSnapper.formatForPrompt();
      if (envPrompt) parts.push(envPrompt);
    } catch { /* best-effort */ }

    try {
      const dcPrompt = await decisionChainExtractor.formatForPrompt();
      if (dcPrompt) parts.push(dcPrompt);
    } catch { /* best-effort */ }

    try {
      const patPrompt = await patternMiner.formatForPrompt();
      if (patPrompt) parts.push(patPrompt);
    } catch { /* best-effort */ }

    // KK 提取的 pitfall/guideline（harness KnowledgeStore）
    try {
      const kkPitfalls = sharedStore.list({ types: ['pitfall'] });
      const kkGuidelines = sharedStore.list({ types: ['guideline'] });
      const kkEntries = [...kkPitfalls, ...kkGuidelines]
        .filter(e => e.maturity !== 'archived')
        .sort((a, b) => b.lastReferenced.localeCompare(a.lastReferenced))
        .slice(0, 5);
      if (kkEntries.length > 0) {
        const lines = ['\n## 历史积累（KK 提取）'];
        lines.push('（引用知识条目时请标注 ID，如 [REF:DEC-001]）');
        for (const e of kkEntries) {
          const icon = e.type === 'pitfall' ? '⚠️' : '📋';
          lines.push(`- ${icon} [REF:${e.id}] ${e.title}: ${e.content.slice(0, 200)}`);
        }
        parts.push(lines.join('\n'));
      }
    } catch { /* best-effort */ }

    // H1: 知识总线（Monitor/KK/Auditor/Ops 的产出汇总）
    try {
      const busContext = knowledgeBus.getRecentContext(agentType || 'analyst', 8);
      if (busContext) parts.push(busContext);
    } catch { /* best-effort */ }

    return parts.join('\n').trim();
  }

  /**
   * P0.2: 按需求相关性评分查询知识（KK→Analyst feedback loop）
   *
   * 与 getRecentContext 不同：不是取最近的 N 条，而是按关键词匹配度评分排序。
   * 这确保 Analyst 拿到的是"和这次需求相关的历史教训"，而不是"最近发生的任意事件"。
   */
  async queryRelevantForRequirement(requirement: string, maxItems = 8): Promise<string> {
    try {
      const all = sharedStore.list({});
      if (all.length === 0) return '';

      // Extract keywords: split by non-word chars, filter short/common words
      const stopWords = new Set([
        'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
        'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
        'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
        'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
        'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'both', 'either',
        'each', 'every', 'all', 'any', 'few', 'more', 'most', 'other', 'some',
        'such', 'only', 'own', 'same', 'than', 'too', 'very', 'just',
        'this', 'that', 'these', 'those', 'it', 'its', 'it\'s',
        '需要', '实现', '增加', '修改', '支持', '添加', '使用', '一个',
      ]);
      const keywords = requirement
        .toLowerCase()
        .split(/[\s,，。！？、；：""''（）\(\)\[\]{}<>\/\\|@#$%^&*+=~`!\-_]+/)
        .filter(w => w.length >= 2 && !stopWords.has(w));

      if (keywords.length === 0) return '';

      // Score entries by keyword match count in title + content
      const scored = all
        .filter(e => e.maturity !== 'archived')
        .map(e => {
          const titleLower = (e.title || '').toLowerCase();
          const contentLower = (e.content || '').toLowerCase();
          let score = 0;
          for (const kw of keywords) {
            if (titleLower.includes(kw)) score += 3;
            if (contentLower.includes(kw)) score += 1;
          }
          return { entry: e, score };
        })
        .filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, maxItems);

      if (scored.length === 0) return '';

      const lines = ['\n## 历史相关知识（按需求匹配度排序）'];
      for (const { entry, score } of scored) {
        const icon = entry.type === 'pitfall' ? '⚠️' : entry.type === 'guideline' ? '📋' : '🔍';
        const source = entry.contributors?.[0] || '?';
        lines.push(`- [匹配度:${score}] [${source}] ${icon} ${entry.title}: ${entry.content.slice(0, 200)}`);
      }
      return lines.join('\n');
    } catch (e: any) {
      logger.warn('[KnowledgeQuery] Relevance query failed', { error: String(e) });
      return '';
    }
  }

  /**
   * 精简版：仅注入偏好+规则+环境（tokens 敏感场景）
   */
  async formatCompactForPrompt(agentType?: string): Promise<string> {
    const parts: string[] = [];

    try {
      const prefs = await preferenceObserver.getPreferences();
      if (prefs && prefs.confidence > 0.4) {
        const lines = ['\n## 用户偏好'];
        if (prefs.responseStyle) lines.push(`- 回复风格: ${prefs.responseStyle}`);
        if (prefs.preferredModel) lines.push(`- 偏好模型: ${prefs.preferredModel}`);
        parts.push(lines.join('\n'));
      }
    } catch { /* best-effort */ }

    try {
      const rules = await ruleScanner.getActiveRules();
      if (rules.length > 0) {
        const lines = ['\n## 系统规则'];
        const topRules = rules.slice(0, 5);
        for (const r of topRules) {
          lines.push(`- ${r.name}: ${r.description}`);
        }
        parts.push(lines.join('\n'));
      }
    } catch { /* best-effort */ }

    try {
      const snap = await envSnapper.getLatest();
      if (snap) {
        const lines = ['\n## 环境'];
        lines.push(`- ${snap.nodeEnv}, Node ${snap.nodeVersion}, API:${snap.apiPort}`);
        const lims = snap.knownLimitations || [];
        if (lims.length > 0) {
          lines.push(`- 已知限制: ${lims.map((l: any) => l.issue).join('; ')}`);
        }
        parts.push(lines.join('\n'));
      }
    } catch { /* best-effort */ }

    return parts.join('\n').trim();
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
