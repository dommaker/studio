/**
 * Knowledge Agent - 知识库冷启动与每日维护
 *
 * 结构（T3 拆分：提取/冷启动/分析分离；本文件为门面，保留聚合逻辑）：
 *   - knowledge-extraction.ts  提取 prompt 单一来源（EXTRACT_FROM_TEXT_SYSTEM_PROMPT
 *                              + E1 文件覆盖 getter，KnowledgeService.extractFromConversation 经此取用）
 *   - knowledge-cold-start.ts  冷启动四源导入（P1b: docs/code/git/manual）
 *   - knowledge-maintenance.ts 语料分析（F1 每日维护：语义去重/质量评估/过期验证/矛盾审查）
 * 门面保留：KnowledgeAgent/knowledgeAgent 公共 API（coldStartAll + runDailyMaintenance 聚合）。
 * 注意：knowledge-service.ts 有自己独立的门禁实现 ingestConversationEntry，与本门面无关。
 */

import { logger, FileStore } from '@dommaker/studio-shared';
import * as coldStart from './knowledge-cold-start.js';
import * as maintenance from './knowledge-maintenance.js';

/**
 * R3 单一 prompt 来源 + E1 文件覆盖 getter：实现迁至 knowledge-extraction.ts，
 * 此处 re-export 保持对外公共 API 不变（KnowledgeService.extractFromConversation 经此路径取用）。
 */
export { EXTRACT_FROM_TEXT_SYSTEM_PROMPT, getExtractFromTextSystemPrompt } from './knowledge-extraction.js';

export class KnowledgeAgent {

  private fileStore: FileStore;

  constructor(fileStore?: FileStore) {
    this.fileStore = fileStore ?? new FileStore();
  }

  // ── 冷启动（knowledge-cold-start）──

  /**
   * P1b: Four-source cold start import
   * 1. Docs: memory/*.md + CLAUDE.md + README.md (layer: 'system', types: architecture/process/decision)
   * 2. Code: package.json + tsconfig.json (layer: 'tech', types: model)
   * 3. Git: recent refactor/fix commits (layer: 'project', types: pitfall/guideline)
   * 4. Manual: agent network flow, agent responsibilities (layer: 'system', types: process)
   */
  async coldStartAll(): Promise<void> {
    return coldStart.coldStartAll();
  }

  // ── LLM-Powered Daily Maintenance (F1) ──────────────────

  /**
   * 每日知识维护入口（由 MonitorAgent daily cycle 调用）
   * 执行 4 个 LLM 驱动的质量操作：语义去重、内容质量评估、过期验证、矛盾审查
   */
  async runDailyMaintenance(): Promise<{
    dedupMerged: number;
    qualityArchived: number;
    freshnessUpdated: number;
    contradictionsResolved: number;
  }> {
    const startTime = Date.now();
    logger.info('[KnowledgeAgent] Daily maintenance started');

    const results = {
      dedupMerged: 0,
      qualityArchived: 0,
      freshnessUpdated: 0,
      contradictionsResolved: 0,
    };

    try {
      // 1. Semantic dedup
      results.dedupMerged = await this.semanticDedup();

      // 2. Content quality assessment
      results.qualityArchived = await this.assessQuality();

      // 3. Freshness validation (only if git repo available)
      results.freshnessUpdated = await this.validateFreshness();

      // 4. Contradiction resolution
      results.contradictionsResolved = await this.resolveContradictions();
    } catch (err) {
      logger.error('[KnowledgeAgent] Daily maintenance failed', { error: String(err) });
    }

    const durationMs = Date.now() - startTime;
    logger.info('[KnowledgeAgent] Daily maintenance completed', { ...results, durationMs });

    return results;
  }

  // ── 语料分析（knowledge-maintenance）──

  private async semanticDedup(): Promise<number> {
    return maintenance.semanticDedup();
  }

  private async assessQuality(): Promise<number> {
    return maintenance.assessQuality();
  }

  private async validateFreshness(): Promise<number> {
    return maintenance.validateFreshness();
  }

  private async resolveContradictions(): Promise<number> {
    return maintenance.resolveContradictions();
  }
}

export const knowledgeAgent = new KnowledgeAgent();
