/**
 * knowledge-types — KnowledgeService 的 Studio 侧类型与类型映射
 *
 * 自 knowledge-service.ts 整块抽出（纯代码移动）：Studio-side 接口类型、
 * KnowledgeServiceDeps 依赖接口、ENTRY_TYPE_MAP 类型映射。
 * knowledge-service.ts 以 re-export 保持既有导出面不变。
 */

import type {
  KnowledgeEntry,
  KnowledgeStore,
  KnowledgeIngest,
  KnowledgeLifecycle,
  KnowledgeLinter,
  MaturityLevel,
  KnowledgeSubsystem,
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
  /**
   * R1: 事件衍生指标（hitRate/improvement）的数据来源标记。
   * 'events' = 滚动窗口内有 outcome 事件，指标为实算；
   * 'insufficient-data' = 窗口内无 outcome 事件（或读取失败），hitRate/improvement 为 0 占位而非编造。
   * quality/freshness 始终由 KnowledgeStore 实算，不受此标记影响。
   */
  source?: 'events' | 'insufficient-data';
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
  /** M1: 事件流计数（滚动窗口，默认 30 天）。窗口内无任何相关事件 → 计数为显式 0 且 source='insufficient-data'（不编造）。 */
  eventCounts: {
    windowDays: number;
    /** knowledge:consumption 事件数（lifecycle recordReference 驱动的消费记录） */
    consumption: number;
    /** knowledge:outcome:success 事件数 */
    outcomeSuccess: number;
    /** knowledge:outcome:failure 事件数 */
    outcomeFailure: number;
    /** knowledge:extraction 事件数（R3 LLM 提取） */
    extraction: number;
    source: 'events' | 'insufficient-data';
  };
  /** M1: 知识库条目按成熟度分布（store 实算，数据源恒为 store） */
  entries: {
    total: number;
    byMaturity: Record<string, number>;
    source: 'store';
  };
  /**
   * M1: 引用次数最多的条目（top 5）。
   * 数据源 = store 条目的 referencedBy 计数（harness KnowledgeLifecycle.recordReference 维护；
   * 注意 recordReference 并不维护 ~/.studio/knowledge/.consumption-stats.json —— 该文件是
   * monitor.service 写的每日聚合摘要 {date,dailyEvents,searchHits}，不含条目级数据）。
   */
  topReferenced: Array<{ id: string; title: string; references: number }>;
  /** M1: 近 30 天 LLM 提取活动（knowledge:extraction 事件实算） */
  extractionActivity: {
    count: number;
    totalTokens: number;
    lastAt: string | null;
    source: 'events' | 'insufficient-data';
  };
}

export interface AuditFinding {
  type: string;
  severity: 'low' | 'medium' | 'high';
  description: string;
  entryId?: string;
}

/**
 * M1 诚实契约：系统中不存在 analyst 预测 vs 实际结果的结构化数据源
 * （recordAnalystAccuracy 仅被知识总线旧壳/测试引用，生产无调用方），
 * 因此 getAnalystAccuracy 返回 available:false + reason，而不是假空 stub。
 * 若未来接入真实数据源，返回 available:true 并填充度量字段。
 */
export interface AccuracyReport {
  available: boolean;
  reason?: string;
  overallAccuracy?: number;
  byAnalyst?: Record<string, number>;
  recentPredictions?: AccuracyData[];
  timestamp: string;
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
