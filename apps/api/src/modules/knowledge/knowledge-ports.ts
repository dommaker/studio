/**
 * ARCH-06 Knowledge 六能力窄端口。
 *
 * KnowledgeService 兼容 facade 仍短期保留；新消费者按实际能力依赖下列接口，
 * 不再被迫接收完整 33 方法门面。六个端口当前指向同一实例，后续可独立拆分实现。
 */
import type { KnowledgeEntry } from '@dommaker/harness';
import type { CreateResolutionInput } from '@dommaker/studio-shared';
import type { UnifiedQueryFilter } from './engine/unified-query.js';
import type {
  AnalystAccuracyInput,
  ConversationExtractionCtx,
  ExecutionOutcome,
  ExtractionResult,
  IncidentEntry,
  InjectContextResult,
  InjectOpts,
  PatternEntry,
  SearchOpts,
  SearchResult,
  SemanticSearchResult,
  TrendEntry,
} from './knowledge-types.js';
import type { AccuracyReport, AuditReport, FlywheelMetrics, HealthReport } from './knowledge-metrics.js';

export interface KnowledgeProducePort {
  extractFromExecution(result: ExtractionResult): Promise<void>;
  extractFromConversation(messages: { role: string; content: string }[], ctx?: ConversationExtractionCtx): Promise<void>;
  recordPattern(entry: PatternEntry): Promise<void>;
  recordIncident(entry: IncidentEntry): Promise<void>;
  recordTrend(entry: TrendEntry): Promise<void>;
  recordAnalystAccuracy(data: AnalystAccuracyInput): Promise<void>;
}

export interface KnowledgeConsumePort {
  injectContext(agentType: string, opts?: InjectOpts): Promise<InjectContextResult>;
  semanticSearch(query: string, opts?: { limit?: number }): Promise<SemanticSearchResult[]>;
  search(query: string, opts?: SearchOpts): Promise<SearchResult[]>;
  list(filter?: UnifiedQueryFilter): Promise<KnowledgeEntry[]>;
  get(id: string): Promise<KnowledgeEntry | null>;
  create(entry: KnowledgeEntry): Promise<void>;
  update(id: string, partial: Partial<KnowledgeEntry>): Promise<KnowledgeEntry | undefined>;
  delete(id: string): Promise<boolean>;
}

export interface KnowledgeTrackPort {
  recordConsumption(entryIds: string[], context: string): void;
  recordOutcome(outcome: ExecutionOutcome): Promise<void>;
  recordSkillExecution(skillId: string, success: boolean, agentType: string): Promise<void>;
}

export interface KnowledgeLifecyclePort {
  promote(entryId: string): Promise<void>;
  demote(entryId: string): Promise<void>;
  decay(entryId: string): Promise<void>;
  merge(sourceId: string, targetId: string): Promise<void>;
  graduateConstraint(id: string): Promise<void>;
}

export interface KnowledgeResolvePort {
  createResolution(input: CreateResolutionInput): Promise<void>;
}

export interface KnowledgeMeasurePort {
  getFlywheelMetrics(opts?: { eventsFile?: string; windowDays?: number }): Promise<FlywheelMetrics>;
  getHealthReport(): Promise<HealthReport>;
  getAuditReport(opts?: { eventsFile?: string; windowDays?: number }): Promise<AuditReport>;
  getAnalystAccuracy(): Promise<AccuracyReport>;
  getStats(): Record<string, number>;
}

export type KnowledgeServiceFacade = KnowledgeProducePort & KnowledgeConsumePort & KnowledgeTrackPort &
  KnowledgeLifecyclePort & KnowledgeResolvePort & KnowledgeMeasurePort;

export interface KnowledgePorts {
  produce: KnowledgeProducePort;
  consume: KnowledgeConsumePort;
  track: KnowledgeTrackPort;
  lifecycle: KnowledgeLifecyclePort;
  resolve: KnowledgeResolvePort;
  measure: KnowledgeMeasurePort;
}

export function createKnowledgePorts(service: KnowledgeServiceFacade): KnowledgePorts {
  return {
    produce: service,
    consume: service,
    track: service,
    lifecycle: service,
    resolve: service,
    measure: service,
  };
}
