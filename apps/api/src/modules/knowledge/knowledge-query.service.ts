/**
 * KnowledgeQueryService (S8) — 统一知识检索入口
 *
 * 聚合五种知识类型的查询 + 格式化，供 Agent context injection 使用。
 */

import { logger } from '@dommaker/studio-shared';
import { KnowledgeStore } from '@dommaker/harness';
import { preferenceObserver } from './preference-observer.js';
import { ruleScanner } from './rule-scanner.js';
import { envSnapper } from './env-snapper.js';
import { decisionChainExtractor } from './decision-chain-extractor.js';
import { patternMiner } from './pattern-miner.js';

// KK 存储的知识（harness KnowledgeStore）
const kkStore = new KnowledgeStore();

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
      const kkPitfalls = kkStore.list({ type: 'pitfall' });
      const kkGuidelines = kkStore.list({ type: 'guideline' });
      const kkEntries = [...kkPitfalls, ...kkGuidelines]
        .filter(e => e.maturity !== 'archived')
        .sort((a, b) => b.lastReferenced.localeCompare(a.lastReferenced))
        .slice(0, 5);
      if (kkEntries.length > 0) {
        const lines = ['\n## 历史积累（KK 提取）'];
        for (const e of kkEntries) {
          const icon = e.type === 'pitfall' ? '⚠️' : '📋';
          lines.push(`- ${icon} ${e.title}: ${e.content.slice(0, 200)}`);
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
