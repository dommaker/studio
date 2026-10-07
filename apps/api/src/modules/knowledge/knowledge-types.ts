/**
 * knowledge-types — KnowledgeService 的 Studio 侧类型与类型映射（类型正本，#669 归位）
 *
 * 自 knowledge-service.ts 整块抽出（纯代码移动）：Studio-side 接口类型、
 * KnowledgeServiceDeps 依赖接口、ENTRY_TYPE_MAP 类型映射。
 * knowledge-service.ts 以 re-export 保持既有导出面不变。
 * Measure 类型（FlywheelMetrics/HealthReport/AuditReport/AccuracyReport 等）
 * 正本在 knowledge-metrics.ts，本文件不再重复定义。
 */

import type {
  KnowledgeEntry,
  KnowledgeStore,
  KnowledgeIngest,
  KnowledgeLifecycle,
  KnowledgeLinter,
  MaturityLevel,
  KnowledgeSubsystem,
  KnowledgeOrigin,
} from '@dommaker/harness';

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

// ── Studio-side types ──

export interface PatternEntry {
  type: string;
  title: string;
  content: string;
  tags: string[];
  maturity?: MaturityLevel;
  /**
   * 条目来源（#371）：缺省 'system'。蒸馏 topic 信号只认 agent/human（#366），
   * 机器流（monitor/knowledge-sync/auditor/triage/模板兜底）落默认即可；
   * 真会话沉淀（session-summary）必须显式 origin:'agent' 才计入信号。
   */
  origin?: KnowledgeOrigin;
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

/** R3: extractFromConversation 的可选上下文（来源追溯 / 事件归因） */
export interface ConversationExtractionCtx {
  workUnitId?: string;
  source?: string;
}

export interface ExecutionOutcome {
  executionId: string;
  agentType: string;
  consumedKnowledge: string[];
  success: boolean;
  details: string;
  timestamp: string;
  mode?: 'external_agent' | 'channel';
  /** #90: 失败步的错误类型（execution_failed 等） */
  errorType?: string;
}

export interface InjectContextResult {
  prompt: string;
  injectedIds: string[];
  /** #91: 注入尺寸（originalTokens > keptTokens 即发生了段内截断），供调用方落 prompt:section_trimmed 事件 */
  usage?: { originalTokens: number; keptTokens: number };
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

// ── Dependencies interface ──

export interface KnowledgeServiceDeps {
  store: KnowledgeStore;
  lifecycle: KnowledgeLifecycle;
  ingest: KnowledgeIngest;
  linter: KnowledgeLinter;
  query: any;  // UnifiedQuery
  eventEmitter: any; // EventEmitter
}

export { ENTRY_TYPE_MAP };
