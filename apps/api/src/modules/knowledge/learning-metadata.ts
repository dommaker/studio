/**
 * #715：学习产物的适用范围、来源、版本和结果模型。
 *
 * 元数据住在既有 sourceReferences[].learning 中：harness 会原样持久化来源对象，
 * 因而不需要第二份存储，也不会把未知 legacy 条目误当成 global。
 */

import type { KnowledgeEntry, KnowledgeStore } from '@dommaker/harness';

export type KnowledgeScopeKind = 'global' | 'company' | 'project' | 'repo' | 'role';

export type KnowledgeScope =
  | { kind: 'global' }
  | { kind: Exclude<KnowledgeScopeKind, 'global'>; id: string };

export interface KnowledgeScopeContext {
  companyId?: string;
  projectId?: string;
  repo?: string;
  roleId?: string;
}

export interface LearningOutcome {
  execution: 'succeeded' | 'failed' | 'unknown';
  verification: 'passed' | 'failed' | 'not-run' | 'unknown';
  delivery: 'merged' | 'unmerged' | 'not-required' | 'unknown';
}

export interface LearningMetadata {
  scope: KnowledgeScope;
  workUnitId?: string;
  assignmentId?: string;
  stepRecordId?: string;
  repo?: string;
  commit?: string;
  transcriptRefs?: string[];
  evidenceRefs?: string[];
  extractionVersion: string;
  revision: number;
  supersedes?: string;
  outcome: LearningOutcome;
}

export interface LearningSourceRef extends Record<string, unknown> {
  timestamp: string;
  learning?: LearningMetadata;
}

type LearningEntry = { sourceReferences?: unknown };

export function getLearningMetadata(entry: LearningEntry): LearningMetadata | undefined {
  if (!Array.isArray(entry.sourceReferences)) return undefined;
  // 合并/修订会追加新来源；最新学习结果优先，旧来源仍保留用于审计。
  for (const ref of [...entry.sourceReferences].reverse()) {
    const learning = (ref as LearningSourceRef | null)?.learning;
    if (learning && typeof learning === 'object') return learning;
  }
  return undefined;
}

export function withLearningMetadata<T extends object>(
  ref: T,
  learning: LearningMetadata,
): T & { learning: LearningMetadata } {
  return { ...ref, learning };
}

/** 自动召回的保守匹配：缺元数据、缺当前维度或 id 不同均不可注入。 */
export function matchesKnowledgeScope(entry: LearningEntry, context: KnowledgeScopeContext): boolean {
  const scope = getLearningMetadata(entry)?.scope;
  if (!scope) return false;
  if (scope.kind === 'global') return true;
  const current = scope.kind === 'company' ? context.companyId
    : scope.kind === 'project' ? context.projectId
      : scope.kind === 'repo' ? context.repo
        : context.roleId;
  return typeof current === 'string' && current === scope.id;
}

/** Agent 产出本身不是 proven 证据；必须有成功执行、通过验证和真实交付结果。 */
export function isProvenEligible(entry: LearningEntry): boolean {
  const outcome = getLearningMetadata(entry)?.outcome;
  return outcome?.execution === 'succeeded'
    && outcome.verification === 'passed'
    && (outcome.delivery === 'merged' || outcome.delivery === 'not-required');
}

export function collectSupersededIds(entries: LearningEntry[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    const supersedes = getLearningMetadata(entry)?.supersedes;
    if (supersedes) ids.add(supersedes);
  }
  return ids;
}

export function manualLearningMetadata(scope: KnowledgeScope = { kind: 'global' }): LearningMetadata {
  return {
    scope,
    extractionVersion: 'manual-1',
    revision: 1,
    outcome: { execution: 'unknown', verification: 'unknown', delivery: 'unknown' },
  };
}

export type CompleteScopeResult =
  | { status: 'updated'; entry: KnowledgeEntry }
  | { status: 'not-found' }
  | { status: 'already-scoped' };

/** 人工只能补全未知作用域，不能覆盖已有可靠归属。 */
export function completeKnowledgeScope(
  store: KnowledgeStore,
  entryId: string,
  scope: KnowledgeScope,
): CompleteScopeResult {
  const entry = store.get(entryId);
  if (!entry) return { status: 'not-found' };
  if (getLearningMetadata(entry)) return { status: 'already-scoped' };
  const learning: LearningMetadata = { ...manualLearningMetadata(scope), extractionVersion: 'legacy-manual-1' };
  const first = entry.sourceReferences[0] ?? { workflow: 'legacy', timestamp: new Date().toISOString() };
  store.update(entry.id, {
    sourceReferences: [withLearningMetadata({ ...first }, learning), ...entry.sourceReferences.slice(1)],
  });
  return { status: 'updated', entry: store.get(entryId)! };
}
