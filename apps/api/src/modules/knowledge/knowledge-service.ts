/**
 * KnowledgeService — Unified knowledge capability layer
 *
 * Single owner of all knowledge capabilities. Not a facade — real implementation.
 * All consumers (Pipeline Agents, Channel, External Agent Runtime, Studio UI)
 * access knowledge through KnowledgeService.
 *
 * 6 capabilities:
 *   Produce  — write knowledge (extract, record)
 *   Consume  — read knowledge (search, inject context, match resolutions)
 *   Track    — record consumption + outcomes (feedback loop)
 *   Lifecycle — promote, decay, merge, graduate
 *   Resolve  — known problem→fix management
 *   Measure  — flywheel metrics, health, audit, accuracy
 *
 * @see docs/specs/arch/knowledge-service.md
 */

import type {
  KnowledgeEntry,
  KnowledgeStore,
  KnowledgeIngest,
  KnowledgeLifecycle,
  KnowledgeLinter,
  QueryFilter,
  MaturityLevel,
  KnowledgeSubsystem,
} from '@dommaker/harness';
import { FileStore, logger } from '@dommaker/studio-shared';
import type { CreateResolutionInput, MatchResolutionResult, Resolution } from '@dommaker/studio-shared';
import { scheduleVectorDbSync } from './knowledge-bus.service.js';
import { execFile } from 'child_process';
import { readFile } from 'fs/promises';
import { join, basename } from 'path';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ── Type mapping (absorbed from KnowledgeBus) ──

const ENTRY_TYPE_MAP: Record<string, KnowledgeSubsystem> = {
  pattern: 'guideline',
  failure: 'pitfall',
  incident: 'pitfall',
  pitfall: 'pitfall',
  guideline: 'guideline',
  trend: 'process',
  fix: 'guideline',
  analyst_accuracy: 'model',
  review: 'guideline',
  alert: 'pitfall',
  audit: 'guideline',
  deploy: 'guideline',
  gap: 'guideline',
  resolution: 'guideline',
};

// ── Data layer: trends directory ──

const DATA_TRENDS_DIR = path.join(os.homedir(), '.studio', 'data', 'trends');
const STUDIO_EVENTS_JSONL = path.join(os.homedir(), '.studio', 'logs', 'studio-events.jsonl');
const fileStore = new FileStore();

/**
 * 写入趋势数据到 data/trends/ 目录。
 * 替代原 recordTrend 写入 knowledge/ 的行为。
 * 被 knowledgeService.recordTrend/recordAnalystAccuracy、
 * monitorAgent.precipitateRouting、signalAggregator.upsertTrend 共用。
 */
export function writeTrendData(filename: string, content: string): void {
  fs.mkdirSync(DATA_TRENDS_DIR, { recursive: true });
  const filePath = path.join(DATA_TRENDS_DIR, filename);
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, 'utf-8');
    fs.writeFileSync(filePath, existing + '\n\n---\n\n' + content, 'utf-8');
  } else {
    fs.writeFileSync(filePath, content, 'utf-8');
  }
}

// ── Form validation gate ──

export interface FormValidationResult {
  valid: boolean;
  form: 'knowledge' | 'data' | 'skill' | 'rule';
  reason?: string;
}

/**
 * 判断条目是否属于知识形态。
 * 代码层判断，不调 LLM。遵循 no_model_for_deterministic。
 */
export function validateKnowledgeForm(entry: {
  type: string;
  content: string;
  tags: string[];
}): FormValidationResult {
  // 规则形态检测：短指令式（优先于空检查，因为规则本身就短）
  const rulePatterns = [/^禁止/, /^必须/, /^不得/];
  if (rulePatterns.some(p => p.test(entry.content.trim())) && entry.content.length < 100) {
    return { valid: false, form: 'rule', reason: 'short imperative directive' };
  }

  // 空内容或太短
  if (!entry.content || entry.content.trim().length < 20) {
    return { valid: false, form: 'data', reason: 'content too short' };
  }

  // 数据形态检测：含具体数值/百分比/日期
  const dataPatterns = [
    /\d+%/,
    /\d{4}-\d{2}-\d{2}/,
    /premium:\s*\d+/,
    /analyst_accuracy/,
  ];
  if (entry.type === 'process' && dataPatterns.some(p => p.test(entry.content))) {
    return { valid: false, form: 'data', reason: 'contains statistical data' };
  }
  if (entry.tags.includes('trend') || entry.tags.includes('analyst_accuracy')) {
    return { valid: false, form: 'data', reason: 'data-type tag' };
  }

  // Skill 形态检测：多步骤流程
  const skillPatterns = [
    /step\s*\d/i,
    /步骤\s*\d/,
    /^\d+\.\s+.+\n\d+\.\s+.+\n\d+\./m,
  ];
  if (skillPatterns.some(p => p.test(entry.content)) && entry.content.length > 500) {
    return { valid: false, form: 'skill', reason: 'multi-step process detected' };
  }

  // 默认：知识形态
  return { valid: true, form: 'knowledge' };
}

// ── Stop words for keyword extraction ──

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'both', 'either',
  'each', 'every', 'all', 'any', 'few', 'more', 'most', 'other', 'some',
  'such', 'only', 'own', 'same', 'than', 'too', 'very', 'just',
  'this', 'that', 'these', 'those', 'it', 'its',
  '需要', '实现', '增加', '修改', '支持', '添加', '使用', '一个',
]);

const TYPE_WEIGHT: Record<string, number> = {
  pitfall: 3, pattern: 2, guideline: 2, fix: 2,
  process: 1, analysis: 1, trend: 1,
};

// ── Studio-side types ──

export interface PatternEntry {
  type: string;
  title: string;
  content: string;
  tags: string[];
  maturity?: MaturityLevel;
}

export interface IncidentEntry {
  title: string;
  content: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  tags: string[];
}

export interface TrendEntry {
  title: string;
  content: string;
  metric: string;
  tags: string[];
}

export interface AccuracyData {
  analystId: string;
  prediction: string;
  actual: string;
  accurate: boolean;
  timestamp: string;
}

export interface AnalystAccuracyInput {
  docId: string;
  goalTitle: string;
  predictedFiles: string[];
  actualFiles: string[];
  predictedDeps: string[];
  actualDeps: string[];
  acMatchRate: number;
  missesByType: Record<string, number>;
  tierStats?: Record<string, { total: number; succeeded: number; failed: number; avgDurationMs: number }>;
}

export interface ExtractionResult {
  task: string;
  diff: string;
  success: boolean;
  duration: number;
  agentType: string;
  consumedKnowledge: string[];
  /** 来源 execution ID，用于 AC-3.2 来源追溯 */
  sourceExecutionId?: string;
}

export interface ExecutionOutcome {
  executionId: string;
  agentType: string;
  consumedKnowledge: string[];
  success: boolean;
  details: string;
  timestamp: string;
  mode?: 'external_agent' | 'channel';
}

export interface InjectContextResult {
  prompt: string;
  injectedIds: string[];
}

export interface InjectOpts {
  tags?: string[];
  maxTokens?: number;
  includeRules?: boolean;
}

export interface SearchOpts {
  limit?: number;
  tags?: string[];
  type?: string;
  mode?: 'keyword' | 'semantic' | 'hybrid';
}

export interface SemanticSearchResult {
  entryId: string;
  filePath: string;
  chunkIndex: number;
  text: string;
  score: number;
  fileTitle: string;
}

export interface SearchResult {
  entry: KnowledgeEntry;
  score: number;
  highlights: string[];
}

export interface FlywheelMetrics {
  quality: number;
  hitRate: number;
  improvement: number;
  freshness: number;
  timestamp: string;
}

export interface HealthReport {
  score: number;
  totalEntries: number;
  staleEntries: number;
  orphanEntries: number;
  duplicateEntries: number;
  timestamp: string;
}

export interface AuditReport {
  findings: AuditFinding[];
  trend: string;
  timestamp: string;
}

export interface AuditFinding {
  type: string;
  severity: 'low' | 'medium' | 'high';
  description: string;
  entryId?: string;
}

export interface AccuracyReport {
  overallAccuracy: number;
  byAnalyst: Record<string, number>;
  recentPredictions: AccuracyData[];
  timestamp: string;
}

// ── Dependencies interface ──

export interface KnowledgeServiceDeps {
  store: KnowledgeStore;
  lifecycle: KnowledgeLifecycle;
  ingest: KnowledgeIngest;
  linter: KnowledgeLinter;
  prisma: any; // PrismaClient
  query: any;  // UnifiedQuery
  eventEmitter: any; // EventEmitter
}

// ── KnowledgeService ─────────────────────────────────────────

export class KnowledgeService {
  private store: KnowledgeStore;
  private lifecycle: KnowledgeLifecycle;
  private ingest: KnowledgeIngest;
  private linter: KnowledgeLinter;
  private prisma: any;
  private query: any;
  private eventEmitter: any;

  constructor(deps: KnowledgeServiceDeps) {
    this.store = deps.store;
    this.lifecycle = deps.lifecycle;
    this.ingest = deps.ingest;
    this.linter = deps.linter;
    this.prisma = deps.prisma;
    this.query = deps.query;
    this.eventEmitter = deps.eventEmitter;
  }

  // ═══════════ Produce (write knowledge) ════════════

  async extractFromExecution(result: ExtractionResult): Promise<void> {
    // Extract knowledge patterns from execution diff/task
    if (!result.diff && !result.task) return;

    const title = `[Exec] ${result.agentType}: ${result.task.slice(0, 80)}`;
    const content = [
      `Agent: ${result.agentType}`,
      `Success: ${result.success}`,
      `Duration: ${result.duration}ms`,
      result.diff ? `Diff (${result.diff.length} chars): ${result.diff.slice(0, 500)}` : '',
      result.consumedKnowledge.length > 0 ? `Consumed: ${result.consumedKnowledge.join(', ')}` : '',
    ].filter(Boolean).join('\n');

    // AC-3.1: Failure → mark for review with need_review tag
    const tags = ['execution', result.agentType];
    if (!result.success) {
      tags.push('need_review');
    }

    // AC-3.3: Dedup — check if existing published entry on same topic exists
    const allEntries = this.store.list({});
    const existingSameTopic = allEntries.find((e: any) =>
      e.title && e.title.startsWith(`[Exec] ${result.agentType}:`) &&
      e.title.includes(result.task.slice(0, 40))
    );

    if (existingSameTopic) {
      // Merge: update existing entry with new content
      const mergedContent = `${existingSameTopic.content}\n\n---\n${content}`;
      const updatedRefs = [
        ...(existingSameTopic.sourceReferences || []),
        { source: `execution:${result.agentType}`, timestamp: new Date().toISOString() },
      ];
      this.store.save({ ...existingSameTopic, content: mergedContent, sourceReferences: updatedRefs.slice(-20) });
    } else {
      await this.recordPattern({
        type: result.success ? 'pattern' : 'failure',
        title,
        content,
        tags,
      });
    }

    // Record outcome for consumed knowledge entries
    if (result.consumedKnowledge.length > 0) {
      this.recordConsumption(result.consumedKnowledge, `execution:${result.agentType}`);
    }

    this.eventEmitter.emit('knowledge', { type: 'extractFromExecution', data: { agentType: result.agentType, success: result.success } });

    // B59-002: persist to StudioEvent for OKR queryKnowledgeQualityGatePassRate
    try {
      await fileStore.appendJsonl(STUDIO_EVENTS_JSONL, {
        type: 'extractFromExecution',
        payload: JSON.stringify({ agentType: result.agentType, success: result.success }),
        createdAt: new Date().toISOString(),
      });
    } catch (e) {
      logger.warn('[KnowledgeService] Failed to persist extractFromExecution event', { error: String(e) });
    }
  }

  async extractFromConversation(_messages: { role: string; content: string }[]): Promise<void> {
    // Phase 5: new capability
  }

  async recordPattern(entry: PatternEntry): Promise<void> {
    try {
      const source = entry.tags?.[0] || 'monitor';

      // Triage quality gate: require root_cause + fix_action
      if (entry.type === 'triage') {
        const content = (entry.content || '').toLowerCase();
        if (!content.includes('root_cause') || !content.includes('fix_action')) {
          return; // silently skip invalid triage entries
        }
      }

      // Validate entry quality — mark low_quality instead of rejecting
      // Merge input tags (e.g., need_review) with type-derived tags
      const tags: string[] = [entry.type, ...(entry.tags || []).filter(t => t !== entry.type)];
      const knowledgeType = ENTRY_TYPE_MAP[entry.type] || 'guideline';
      const issues = this.linter.validateEntry({
        title: entry.title || '',
        content: entry.content || '',
        tags,
        type: knowledgeType,
      });
      const blockers = issues.filter((i: any) => i.severity === 'high');
      if (blockers.length > 0) {
        tags.push('low_quality');
      }

      this.ingest.ingestEntry(
        {
          type: knowledgeType,
          title: entry.title,
          content: entry.content,
          tags,
        },
        {
          source: `pattern:${source}`,
          layer: 'project',
          maturity: 'active',
          tags,
          consumptionMode: 'signal',
        },
      );
      scheduleVectorDbSync();
    } catch {
      // best-effort — don't block producers
    }
  }

  async recordIncident(entry: IncidentEntry): Promise<void> {
    try {
      this.ingest.ingestEntry(
        {
          type: 'pitfall',
          title: entry.title,
          content: entry.content,
          tags: ['incident', entry.severity],
        },
        {
          source: `incident:ops:${new Date().toISOString()}`,
          layer: 'tech',
          maturity: 'active',
          tags: ['incident', entry.severity],
          consumptionMode: 'signal',
        },
      );
      scheduleVectorDbSync();
    } catch {
      // best-effort
    }
  }

  async recordTrend(entry: TrendEntry): Promise<void> {
    try {
      const dateStr = new Date().toISOString().split('T')[0];
      const content = `## ${entry.title}\n\n${entry.content}\n\nmetric: ${entry.metric}`;
      writeTrendData(`${dateStr}.md`, content);
      logger.debug('[KnowledgeService] recordTrend → data/', { metric: entry.metric });
    } catch (e) {
      logger.warn('[KnowledgeService] recordTrend failed', { error: String(e) });
    }
  }

  async recordAnalystAccuracy(data: AnalystAccuracyInput): Promise<void> {
    try {
      const dateStr = new Date().toISOString().split('T')[0];
      const missedFiles = data.predictedFiles.filter(f => !data.actualFiles.includes(f));
      const extraFiles = data.actualFiles.filter(f => !data.predictedFiles.includes(f));
      const missedDeps = data.predictedDeps.filter(d => !data.actualDeps.includes(d));

      const content = [
        `## AnalystAccuracy: ${data.goalTitle.slice(0, 80)}`,
        ``,
        `- AC匹配率: ${Math.round(data.acMatchRate * 100)}%`,
        `- 预测文件: [${data.predictedFiles.join(', ')}]`,
        `- 实际文件: [${data.actualFiles.join(', ')}]`,
        missedFiles.length > 0 ? `- 漏预测: [${missedFiles.join(', ')}]` : '',
        extraFiles.length > 0 ? `- 多预测: [${extraFiles.join(', ')}]` : '',
        missedDeps.length > 0 ? `- 漏依赖: [${missedDeps.join(', ')}]` : '',
      ].filter(Boolean).join('\n');

      writeTrendData(`${dateStr}.md`, content);
      logger.debug('[KnowledgeService] recordAnalystAccuracy → data/');
    } catch (e) {
      logger.warn('[KnowledgeService] recordAnalystAccuracy failed', { error: String(e) });
    }
  }

  // ═══════════ Consume (read knowledge) ════════════

  async injectContext(agentType: string, _opts?: InjectOpts): Promise<InjectContextResult> {
    const sections: string[] = [];
    const injectedIds: string[] = [];

    // 1. rule — full content injection (constraints must be followed)
    const rules = await this.query.queryEntries({ consumptionModes: ['rule'], agentType, status: 'published' });
    const filteredRules = (rules || []).filter((r: any) => r.sourceReference && r.status !== 'stale');
    if (filteredRules.length) {
      const lines = filteredRules.map((r: any) => `- ${stripFormat(r.content)}`);
      sections.push(`## 系统约束\n${lines.join('\n')}`);
      injectedIds.push(...filteredRules.map((r: any) => r.id));
    }

    // 2. context — full content injection (preferences + environment)
    const context = await this.query.queryEntries({ consumptionModes: ['context'], status: 'published' });
    const filteredContext = (context || []).filter((c: any) => c.sourceReference && c.status !== 'stale');
    if (filteredContext.length) {
      const lines = filteredContext.map((c: any) => `- ${stripFormat(c.content)}`);
      sections.push(`## 上下文\n${lines.join('\n')}`);
      injectedIds.push(...filteredContext.map((c: any) => c.id));
    }

    // 3. signal — index injection (informational)
    const signals = this.query.getIndexes({ consumptionModes: ['signal'], limit: 5 });
    const filteredSignals = (signals || []).filter((s: any) => s.status !== 'stale');
    if (filteredSignals.length) {
      const lines = filteredSignals.map((s: any) => `- [${s.id}] ${s.summary}`);
      sections.push(`## 近期信号\n${lines.join('\n')}`);
      injectedIds.push(...filteredSignals.map((s: any) => s.id));
    }

    // 4. reference — hint only
    const refCount = await this.query.count({ consumptionModes: ['reference'] });
    if (refCount > 0) {
      sections.push(`[知识库: ${refCount} 条参考，遇到问题时用 search()]`);
    }

    // 5. recordReference — close maturity loop
    if (injectedIds.length > 0) {
      for (const id of injectedIds) {
        try { this.lifecycle.recordReference(id, 'prompt-inject'); } catch { /* non-blocking */ }
      }
    }

    return { prompt: sections.join('\n\n'), injectedIds };
  }

  /**
   * Semantic search via mcp-local-rag CLI.
   * Calls `mcp-local-rag query <text>` and parses JSON output.
   * Maps filePath back to knowledge entry ID via YAML frontmatter.
   */
  async semanticSearch(query: string, opts?: { limit?: number }): Promise<SemanticSearchResult[]> {
    try {
      const limit = opts?.limit || 5;
      const raw = await this.execMcpQuery(query);
      const results: SemanticSearchResult[] = JSON.parse(raw);

      // Map filePath → entry ID
      const mapped: SemanticSearchResult[] = [];
      for (const r of results.slice(0, limit)) {
        const entryId = await this.resolveEntryId(r.filePath);
        mapped.push({ ...r, entryId });
      }

      // Record references for matched entries
      for (const r of mapped) {
        if (r.entryId) {
          try { this.lifecycle.recordReference(r.entryId, 'semantic-search'); } catch { /* non-blocking */ }
        }
      }

      return mapped;
    } catch (e) {
      logger.warn('[KnowledgeService] semanticSearch failed', { error: String(e) });
      return [];
    }
  }

  /**
   * Execute mcp-local-rag query CLI and return stdout JSON.
   */
  private execMcpQuery(query: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = [
        '--db-path', join(process.env.HOME || '/root', '.cache', 'mcp-local-rag', 'lancedb'),
        '--cache-dir', join(process.env.HOME || '/root', '.cache', 'huggingface', 'hub'),
        '--model-name', join(process.env.HOME || '/root', '.cache', 'huggingface', 'hub', 'models--onnx-community--bge-small-zh-v1.5-ONNX', 'snapshots', 'main'),
        'query', query,
      ];
      execFile('mcp-local-rag', args, { timeout: 30_000 }, (err, stdout, stderr) => {
        if (err) {
          // mcp-local-rag logs to stderr, stdout has JSON result even on partial error
          if (stdout && stdout.trim().startsWith('[')) {
            resolve(stdout);
          } else {
            reject(err);
          }
        } else {
          resolve(stdout);
        }
      });
    });
  }

  /**
   * Resolve knowledge entry ID from a filePath.
   * Reads YAML frontmatter `id:` field; falls back to filename parsing.
   */
  private async resolveEntryId(filePath: string): Promise<string> {
    try {
      const content = await readFile(filePath, 'utf-8');
      const match = content.match(/^---[\s\S]*?^id:\s*(.+)$/m);
      if (match) return match[1].trim();
    } catch { /* file not readable */ }

    // Fallback: parse filename pattern "{type}-{id}.md"
    const name = basename(filePath, '.md');
    const dashIdx = name.indexOf('-');
    return dashIdx > 0 ? name.slice(dashIdx + 1) : name;
  }

  async search(query: string, opts?: SearchOpts): Promise<SearchResult[]> {
    const mode = opts?.mode || 'keyword';
    const limit = opts?.limit || 5;

    if (mode === 'semantic') {
      return this.searchSemantic(query, limit);
    }
    if (mode === 'hybrid') {
      return this.searchHybrid(query, limit);
    }
    return this.searchKeyword(query, opts);
  }

  /**
   * Keyword search (original behavior).
   */
  private searchKeyword(query: string, opts?: SearchOpts): SearchResult[] {
    try {
      const limit = opts?.limit || 5;
      const all = this.store.list({});
      if (all.length === 0) return [];

      const keywords = extractKeywords(query);
      if (keywords.length === 0) return [];

      const now = Date.now();
      const scored = all
        .filter((e: any) => e.maturity !== 'archived')
        .filter((e: any) => !opts?.type || e.tags?.includes(opts.type))
        .map((e: any) => {
          const titleLower = (e.title || '').toLowerCase();
          const contentLower = (e.content || '').toLowerCase();
          let keywordScore = 0;
          let bestMatchPos = -1;
          for (const kw of keywords) {
            if (titleLower.includes(kw)) keywordScore += 3;
            const pos = contentLower.indexOf(kw);
            if (pos !== -1) {
              keywordScore += 1;
              if (bestMatchPos === -1 || pos < bestMatchPos) bestMatchPos = pos;
            }
          }
          if (keywordScore === 0) return null;

          const typeWeight = TYPE_WEIGHT[e.tags?.[0] || ''] || 1;
          const daysAgo = e.lastReferenced
            ? (now - new Date(e.lastReferenced).getTime()) / 86400000
            : 30;
          const freshness = daysAgo < 7 ? 1.0 : Math.max(0.2, 1 - (daysAgo - 7) / 30);
          const maturityWeight: Record<string, number> = { proven: 1.5, verified: 1.0, draft: 0.5 };
          const mWeight = maturityWeight[e.maturity] || 0.5;
          const qualityPenalty = e.tags?.includes('low_quality') ? 0.3 : 1.0;

          const score = keywordScore * typeWeight * freshness * mWeight * qualityPenalty;
          const matchContext = bestMatchPos >= 0
            ? e.content.slice(Math.max(0, bestMatchPos - 40), bestMatchPos + 160)
            : e.content.slice(0, 200);

          return {
            entry: e,
            score,
            highlights: [matchContext],
          };
        })
        .filter((r: any): r is NonNullable<typeof r> => r !== null)
        .sort((a: any, b: any) => b.score - a.score)
        .slice(0, limit);

      // Record references for returned entries
      for (const r of scored) {
        try { this.lifecycle.recordReference(r.entry.id, 'search'); } catch { /* non-blocking */ }
      }

      return scored;
    } catch {
      return [];
    }
  }

  /**
   * Semantic-only search via mcp-local-rag.
   */
  private async searchSemantic(query: string, limit: number): Promise<SearchResult[]> {
    const semanticResults = await this.semanticSearch(query, { limit });
    const results: SearchResult[] = [];
    for (const sr of semanticResults) {
      if (!sr.entryId) continue;
      const entry = this.store.get(sr.entryId);
      if (!entry) continue;
      results.push({
        entry,
        score: sr.score,
        highlights: [sr.text.slice(0, 200)],
      });
    }
    return results;
  }

  /**
   * Hybrid search: keyword + semantic, merged and deduplicated.
   * Keyword results take priority; semantic supplements.
   */
  private async searchHybrid(query: string, limit: number): Promise<SearchResult[]> {
    const keywordResults = this.searchKeyword(query, { limit });
    const seenIds = new Set(keywordResults.map(r => r.entry.id));

    const semanticResults = await this.semanticSearch(query, { limit });
    for (const sr of semanticResults) {
      if (!sr.entryId || seenIds.has(sr.entryId)) continue;
      seenIds.add(sr.entryId);
      const entry = this.store.get(sr.entryId);
      if (!entry) continue;
      keywordResults.push({
        entry,
        score: sr.score,
        highlights: [sr.text.slice(0, 200)],
      });
    }

    return keywordResults
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  async matchResolutions(problem: string): Promise<MatchResolutionResult> {
    try {
      const candidates = await this.prisma.resolution.findMany({
        where: { status: { in: ['verified', 'canonical'] } },
        orderBy: { verifyCount: 'desc' },
      });

      const matched: Resolution[] = [];
      const lowerMsg = problem.toLowerCase();

      for (const row of candidates) {
        const pattern = row.pattern;
        let isMatch = false;

        // Try regex first
        try {
          const re = new RegExp(pattern, 'i');
          if (re.test(problem)) isMatch = true;
        } catch {
          // Not valid regex, fall back to substring
          if (lowerMsg.includes(pattern.toLowerCase())) isMatch = true;
        }

        if (isMatch) {
          matched.push({
            id: row.id,
            pattern: row.pattern,
            errorClass: row.errorClass || '',
            layer: row.layer || 'L5_error_fix',
            title: row.title || pattern,
            fix: row.fix || '',
            status: row.status,
            verifyCount: row.verifyCount || 0,
            tags: row.tags ? (typeof row.tags === 'string' ? JSON.parse(row.tags) : row.tags) : [],
            createdAt: row.createdAt?.toISOString?.() || '',
            updatedAt: row.updatedAt?.toISOString?.() || '',
          });
        }
      }

      const promptSnippet = matched.length > 0
        ? matched.map(r => `[Known Fix] ${r.title}: ${r.fix}`).join('\n')
        : '';

      return { matched: matched.length > 0, resolutions: matched, promptSnippet };
    } catch {
      return { matched: false, resolutions: [], promptSnippet: '' };
    }
  }

  async list(filter?: QueryFilter): Promise<KnowledgeEntry[]> {
    return this.query.listEntries(filter || {});
  }

  async get(id: string): Promise<KnowledgeEntry | null> {
    return this.store.get(id);
  }

  async create(entry: KnowledgeEntry): Promise<void> {
    this.store.save(entry);
  }

  async update(id: string, partial: Partial<KnowledgeEntry>): Promise<KnowledgeEntry | undefined> {
    return this.store.update(id, partial);
  }

  async delete(id: string): Promise<boolean> {
    return this.store.delete(id);
  }

  // ═══════════ Track (consumption + outcome tracking) ════════════

  recordConsumption(entryIds: string[], context: string): void {
    for (const id of entryIds) {
      try { this.lifecycle.recordReference(id, context); } catch { /* non-blocking */ }
    }

    // O2-KR1: 发射 consumption 事件供 OKR metric 采集
    if (entryIds.length > 0) {
      fileStore.appendJsonl(STUDIO_EVENTS_JSONL, {
        type: 'knowledge:consumption',
        source: context,
        payload: JSON.stringify({ entryIds, count: entryIds.length }),
        createdAt: new Date().toISOString(),
      }).catch(() => {});
    }
  }

  async recordOutcome(outcome: ExecutionOutcome): Promise<void> {
    // Close the feedback loop: record execution outcome as StudioEvent
    try {
      await fileStore.appendJsonl(STUDIO_EVENTS_JSONL, {
        type: `knowledge:outcome:${outcome.success ? 'success' : 'failure'}`,
        source: outcome.agentType,
        payload: JSON.stringify({
          executionId: outcome.executionId,
          agentType: outcome.agentType,
          success: outcome.success,
          details: outcome.details?.slice(0, 500),
          consumedKnowledge: outcome.consumedKnowledge,
          mode: outcome.mode,
        }),
        createdAt: new Date().toISOString(),
      });
    } catch { /* non-blocking */ }

    // Update referencedBy for consumed knowledge entries
    for (const entryId of outcome.consumedKnowledge) {
      try {
        const entry = this.store.get(entryId);
        if (entry) {
          entry.referencedBy = entry.referencedBy || [];
          if (!entry.referencedBy.includes(outcome.executionId)) {
            entry.referencedBy.push(outcome.executionId);
            this.store.save(entry);
          }
        }
      } catch { /* non-blocking */ }
    }

    this.eventEmitter.emit('knowledge', { type: 'recordOutcome', data: { executionId: outcome.executionId, success: outcome.success } });
  }

  /**
   * AC-8c: Record Skill execution outcome back to source KnowledgeEntry.
   * Finds the KnowledgeEntry that produced the Skill, records execution result.
   * If successRate drops below 50%, revokes skillCandidate tag.
   */
  async recordSkillExecution(skillId: string, success: boolean, agentType: string): Promise<void> {
    try {
      // Find KnowledgeEntry by skillId
      const entries = this.store.list({});
      const sourceEntry = entries.find(e => e.skillId === skillId);
      if (!sourceEntry) return;

      // Record reference with execution result
      this.lifecycle.recordReference(sourceEntry.id, `skill:${agentType}`, success, 'auto');

      // Check if skillCandidate tag should be revoked
      if (this.lifecycle.checkSkillCandidateRevocation) {
        this.lifecycle.checkSkillCandidateRevocation(sourceEntry.id);
      }
    } catch { /* non-blocking */ }
  }

  // ═══════════ Lifecycle ════════════

  async promote(entryId: string): Promise<void> {
    const entry = this.store.get(entryId);
    if (!entry) return;
    const next: Record<string, MaturityLevel> = { draft: 'verified', verified: 'proven' };
    const target = next[entry.maturity];
    if (target) {
      this.store.update(entryId, { maturity: target });
    }
  }

  async decay(entryId: string): Promise<void> {
    const entry = this.store.get(entryId);
    if (!entry) return;
    const prev: Record<string, MaturityLevel> = { proven: 'verified', verified: 'draft' };
    const target = prev[entry.maturity];
    if (!target) return;
    // Only decay if stale (unreferenced for threshold)
    const daysSinceRef = entry.lastReferenced
      ? (Date.now() - new Date(entry.lastReferenced).getTime()) / 86400000
      : 999;
    const threshold: Record<string, number> = { proven: 365, verified: 180, draft: 90 };
    if (daysSinceRef >= (threshold[entry.maturity] || 90)) {
      this.store.update(entryId, { maturity: target });
    }
  }

  async merge(sourceId: string, targetId: string): Promise<void> {
    const source = this.store.get(sourceId);
    const target = this.store.get(targetId);
    if (!source || !target) return;
    this.store.save({
      ...target,
      content: `${target.content}\n\n---\nMerged from ${sourceId}: ${source.content}`,
      contributors: [...(target.contributors || []), ...(source.contributors || [])],
    });
    this.store.delete(sourceId);
  }

  async graduateConstraint(_id: string): Promise<void> {
    // Phase 7: constraint → knowledge
  }

  // ═══════════ Resolve (known solutions) ════════════

  async createResolution(input: CreateResolutionInput): Promise<void> {
    try {
      const existing = await this.prisma.resolution.findFirst({ where: { pattern: input.pattern } });
      if (existing) return;
      await this.prisma.resolution.create({
        data: {
          pattern: input.pattern,
          errorClass: input.errorClass || 'unknown',
          layer: input.layer || 'L5_error_fix',
          title: input.title || input.pattern.slice(0, 100),
          fix: input.fix,
          status: 'pending',
          tags: input.tags ? JSON.stringify(input.tags) : '[]',
        },
      });
    } catch {
      // best-effort
    }
  }

  // ═══════════ Measure (metrics + audit) ════════════

  async getFlywheelMetrics(): Promise<FlywheelMetrics> {
    try {
      const entries = this.store.list({});
      const total = entries.length;
      if (total === 0) return { quality: 0, hitRate: 0, improvement: 0, freshness: 0, timestamp: new Date().toISOString() };

      // Quality: weighted maturity score (proven=3, verified=2, draft=1)
      const maturityWeight: Record<string, number> = { proven: 3, verified: 2, active: 1.5, draft: 1, deprecated: 0, archived: 0 };
      const qualitySum = entries.reduce((s: number, e: any) => s + (maturityWeight[e.maturity] || 0), 0);
      const quality = Math.min(100, Math.round((qualitySum / (total * 3)) * 100));

      // Freshness: % referenced in last 30 days
      const now = Date.now();
      const recentCount = entries.filter((e: any) =>
        e.lastReferenced && (now - new Date(e.lastReferenced).getTime()) < 30 * 86400000
      ).length;
      const freshness = Math.round((recentCount / total) * 100);

      return { quality, hitRate: 0, improvement: 0, freshness, timestamp: new Date().toISOString() };
    } catch {
      return { quality: 0, hitRate: 0, improvement: 0, freshness: 0, timestamp: new Date().toISOString() };
    }
  }

  async getHealthReport(): Promise<HealthReport> {
    try {
      const entries = this.store.list({});
      const total = entries.length;
      const now = Date.now();
      const staleThreshold = 30 * 86400000; // 30 days
      const staleEntries = entries.filter((e: any) =>
        !e.lastReferenced || (now - new Date(e.lastReferenced).getTime()) > staleThreshold
      ).length;
      const score = total === 0 ? 0 : Math.round(((total - staleEntries) / total) * 100);
      return {
        score,
        totalEntries: total,
        staleEntries,
        orphanEntries: 0,
        duplicateEntries: 0,
        timestamp: new Date().toISOString(),
      };
    } catch {
      return { score: 0, totalEntries: 0, staleEntries: 0, orphanEntries: 0, duplicateEntries: 0, timestamp: new Date().toISOString() };
    }
  }

  async getAuditReport(): Promise<AuditReport> {
    return { findings: [], trend: 'stable', timestamp: new Date().toISOString() };
  }

  async getAnalystAccuracy(): Promise<AccuracyReport> {
    return { overallAccuracy: 0, byAnalyst: {}, recentPredictions: [], timestamp: new Date().toISOString() };
  }

  // ═══════════ Additional methods (absorbed from KnowledgeBus / ResolutionService) ════════════

  /**
   * 知识统计概览 — absorbed from KnowledgeBus.getStats()
   */
  getStats(): Record<string, number> {
    try {
      const entries = this.store.list({});
      const byType: Record<string, number> = {};
      for (const e of entries) {
        const cat = (e as any).tags?.[0] || 'other';
        byType[cat] = (byType[cat] || 0) + 1;
      }
      byType.total = entries.length;
      return byType;
    } catch {
      return { total: 0 };
    }
  }

  /**
   * 验证 Resolution — verifyCount++，累积 3 次 → canonical
   * Absorbed from ResolutionService.verifyResolution()
   */
  async verifyResolution(id: string): Promise<void> {
    try {
      const row = await this.prisma.resolution.findUnique({ where: { id } });
      if (!row) return;

      const newCount = row.verifyCount + 1;
      const newStatus = newCount >= 3 ? 'canonical' : (newCount >= 1 ? 'verified' : 'pending');

      await this.prisma.resolution.update({
        where: { id },
        data: {
          verifyCount: newCount,
          status: newStatus,
          lastVerifiedAt: new Date(),
        },
      });
    } catch {
      // best-effort
    }
  }
}

// ── Utilities (absorbed from KnowledgeBus / prompt-builder) ──

function extractKeywords(prompt: string): string[] {
  return prompt
    .toLowerCase()
    .split(/[\s,，。！？、；：""''（）\(\)\[\]{}<>\/\\|@#$%^&*+=~`!\-_]+/)
    .filter(w => w.length >= 2 && !STOP_WORDS.has(w))
    .slice(0, 8);
}

function stripFormat(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^>\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '- ')
    .trim();
}

// ── Singleton ────────────────────────────────────────────────

import { EventEmitter } from 'events';
import { prisma } from '@dommaker/studio-prisma';
import {
  sharedStore,
  sharedLifecycle,
  sharedIngest,
  sharedQuery,
  sharedLinter,
} from './knowledge-bus.service';

export const knowledgeService = new KnowledgeService({
  store: sharedStore,
  lifecycle: sharedLifecycle,
  ingest: sharedIngest,
  linter: sharedLinter,
  prisma,
  query: sharedQuery,
  eventEmitter: new EventEmitter(),
});
