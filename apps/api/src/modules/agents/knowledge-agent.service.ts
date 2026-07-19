/**
 * Knowledge Agent - 从执行结果中异步提取知识
 *
 * 被动模式：Executor 完成后自动触发，从 git diff + 测试结果中抽取知识。
 * 使用 harness KnowledgeStore + KnowledgeIngest 存储。
 *
 * 结构（T3 拆分：提取/冷启动/分析分离，零行为变更；本文件为门面，保留聚合逻辑）：
 *   - knowledge-extraction.ts  提取（执行结果/审查/错误/完成输出/部署结果/任意文本）
 *                              + 提取 prompt 单一来源 + #系统 Channel helper + git diff 读取
 *   - knowledge-cold-start.ts  冷启动四源导入（P1b: docs/code/git/manual）
 *   - knowledge-analysis.ts    会话分析（决策记录提取 / 用户行为模式 KE-003）
 *   - knowledge-maintenance.ts 语料分析（F1 每日维护：语义去重/质量评估/过期验证/矛盾审查）
 * 门面保留：KnowledgeAgent/knowledgeAgent 公共 API、safeIngest（P2.5 形态门禁+质量门）、
 * runDailyMaintenance 聚合。
 */

import { logger, FileStore } from '@dommaker/studio-shared';
import { KnowledgeLinter, ReferenceTracker } from '@dommaker/harness';
import type { DecisionRecord } from '@dommaker/harness';
import { sharedStore, sharedIngest, scheduleVectorDbSync } from '../knowledge/knowledge-bus.service.js';
import { validateKnowledgeForm, writeTrendData } from '../knowledge/knowledge-service.js';
import * as extraction from './knowledge-extraction.js';
import * as coldStart from './knowledge-cold-start.js';
import * as analysis from './knowledge-analysis.js';
import * as maintenance from './knowledge-maintenance.js';

const sharedLinter = new KnowledgeLinter(sharedStore, new ReferenceTracker(sharedStore));

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

  // ── 提取（knowledge-extraction）──

  /**
   * 从执行结果中提取知识（异步，不阻塞主流程）
   */
  async extract(params: {
    taskId: string;
    projectId: string;
    worktree: string;
    taskDescription: string;
    result: 'success' | 'failure';
    error?: string;
  }): Promise<void> {
    return extraction.extract(this.fileStore, safeIngest, params);
  }

  /**
   * P0a-1: 从审查结果中提取可复用知识
   */
  async extractFromReview(
    reviewResult: { approved: boolean; score: number; issues: Array<{ severity: string; message: string; file?: string; line?: number }>; suggestions: string[] },
    taskId: string,
    projectId: string,
  ): Promise<void> {
    return extraction.extractFromReview(this.fileStore, safeIngest, reviewResult, taskId, projectId);
  }

  /**
   * P0a-2: 从失败任务的错误中提取踩坑记录
   */
  async extractFromError(
    error: string,
    errorChain: string,
    taskDescription: string,
    taskId: string,
    projectId: string,
  ): Promise<void> {
    return extraction.extractFromError(safeIngest, error, errorChain, taskDescription, taskId, projectId);
  }

  /**
   * P0a-3: 从执行完成输出中提取设计决策和最佳实践
   */
  async extractFromCompletion(
    completionOutput: Record<string, any>,
    taskId: string,
    projectId: string,
  ): Promise<void> {
    return extraction.extractFromCompletion(safeIngest, completionOutput, taskId, projectId);
  }

  /**
   * P0a-4: 从部署结果中提取部署相关的踩坑和最佳实践
   */
  async extractFromDeploy(
    deployResult: { success: boolean; type: string; findings: Array<{ severity: string; category: string; message: string }>; summary: string; artifact?: string },
    taskId: string,
    projectId: string,
  ): Promise<void> {
    return extraction.extractFromDeploy(this.fileStore, safeIngest, deployResult, taskId, projectId);
  }

  /**
   * P0b: Extract knowledge from arbitrary text content (generic API)
   *
   * Studio's public interface for knowledge extraction from any text source.
   * Source-specific preprocessing (format parsing, message filtering, truncation)
   * belongs in the caller, not here.
   *
   * @param content - Raw text to extract knowledge from
   * @param source - Identifier for the source (e.g. "chat:20260522", "discord:channel:123")
   * @param layer - Storage layer (default: 'system')
   */
  async extractFromText(
    content: string,
    source: string,
    layer: 'project' | 'system' | 'tech' | 'team' | 'domain' | 'personal' = 'system',
  ): Promise<void> {
    return extraction.extractFromText(this.fileStore, safeIngest, content, source, layer);
  }

  // ── 会话分析（knowledge-analysis）──

  /**
   * Extract a decision record from text content using LLM.
   *
   * Returns null if no decision found or on any error.
   */
  async extractDecision(
    content: string,
    source: string,
  ): Promise<DecisionRecord | null> {
    return analysis.extractDecision(content, source);
  }

  /**
   * KE-003: Extract user behavior patterns from session transcript.
   *
   * Three signal types: correction (user corrects assistant), pattern (decision chain),
   * automation (repeated manual ops). Results stored in UserBehaviorProfile table.
   *
   * Layer 1 context injection: existing profiles + memory rules into prompt to avoid re-extraction.
   *
   * @param content - Preprocessed transcript (filtered + truncated by caller)
   * @param source - "session:<uuid>" identifier
   * @param threshold - Minimum confidence (default 0.6)
   */
  async extractUserBehavior(
    content: string,
    source: string,
    threshold: number = 0.6,
  ): Promise<void> {
    return analysis.extractUserBehavior(this.fileStore, content, source, threshold);
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

/**
 * 直接写入知识库（fallback：当 #系统 Channel 不可用时）
 */
/**
 * P2.5: Validated ingest — runs quality gate before storing.
 * Same signature as KnowledgeIngest.ingestEntry().
 * Skips entries that fail validation (content too short, vague title, contradiction).
 */
function safeIngest(
  partial: Partial<{ type: string; title: string; content: string; tags: string[]; projects: string[] }>,
  options: { source: string; layer: string; maturity?: string; tags?: string[]; projects?: string[] },
): boolean {
  const entry = { title: partial.title || '', content: partial.content || '', tags: partial.tags || [], type: partial.type || 'guideline' };

  // 形态门禁：判断是否属于知识形态
  const formResult = validateKnowledgeForm({
    type: entry.type,
    content: entry.content,
    tags: [...entry.tags, ...(options.tags || [])],
  });

  if (!formResult.valid) {
    logger.info('[KnowledgeAgent] Form gate rejected', {
      form: formResult.form,
      reason: formResult.reason,
      title: entry.title.slice(0, 50),
    });

    if (formResult.form === 'data') {
      // 数据重定向到 data/trends/ 目录（复用 writeTrendData 追加模式）
      const dateStr = new Date().toISOString().split('T')[0];
      const content = `## ${entry.title}\n\n${entry.content}\n\nsource: ${options.source}`;
      writeTrendData(`${dateStr}-extracted.md`, content);
    }
    // form='skill'/'rule' → 只记日志，不写入
    return false;
  }

  const issues = sharedLinter.validateEntry(entry);

  const blockers = issues.filter(i => i.severity === 'high');
  if (blockers.length > 0) {
    logger.warn('[KnowledgeAgent] Entry rejected by quality gate', {
      title: entry.title,
      issues: blockers.map(i => i.description),
      source: options.source,
    });
    return false;
  }

  const warnings = issues.filter(i => i.severity !== 'high');
  if (warnings.length > 0) {
    logger.info('[KnowledgeAgent] Entry ingested with warnings', {
      title: entry.title,
      warnings: warnings.map(i => i.description),
    });
  }

  const result = sharedIngest.ingestEntry(partial as any, options as any);
  scheduleVectorDbSync();
  logger.info('[KnowledgeAgent] Entry ingested', {
    id: result.id,
    title: entry.title,
    maturity: result.maturity,
    sourceRefs: result.sourceReferences?.length ?? 0,
  });
  return true;
}

export const knowledgeAgent = new KnowledgeAgent();
