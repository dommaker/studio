import type { KnowledgeEntry, KnowledgeStore } from '@dommaker/harness';
import { getLearningMetadata, type LearningMetadata } from './learning-metadata.js';

export type TerminalLearningOutcomeKind = 'pmo-review-rejected' | 'delivery-failed';

export interface TerminalLearningOutcomeInput {
  eventId: string;
  kind: TerminalLearningOutcomeKind;
  workUnitIds: string[];
}

interface LearningSourceReference extends Record<string, unknown> {
  entryId?: string;
  timestamp: string;
  outcomeEventId?: string;
}

function sourceReferences(entry: KnowledgeEntry): LearningSourceReference[] {
  return entry.sourceReferences as LearningSourceReference[];
}

function inheritedLearning(
  entry: KnowledgeEntry,
  byId: Map<string, KnowledgeEntry>,
  workUnitIds: Set<string>,
  visited = new Set<string>(),
): LearningMetadata | undefined {
  for (const ref of [...sourceReferences(entry)].reverse()) {
    const learning = (ref as { learning?: LearningMetadata }).learning;
    if (learning?.workUnitId && workUnitIds.has(learning.workUnitId)) return learning;
  }
  if (visited.has(entry.id)) return undefined;
  visited.add(entry.id);
  for (const ref of [...sourceReferences(entry)].reverse()) {
    if (!ref.entryId) continue;
    const source = byId.get(ref.entryId);
    const learning = source && inheritedLearning(source, byId, workUnitIds, visited);
    if (learning) return learning;
  }
  return undefined;
}

function affectedEntries(entries: KnowledgeEntry[], workUnitIds: Set<string>): Set<string> {
  const affected = new Set(entries
    .filter(entry => sourceReferences(entry).some(ref => {
      const workUnitId = (ref as { learning?: LearningMetadata }).learning?.workUnitId;
      return workUnitId !== undefined && workUnitIds.has(workUnitId);
    }))
    .map(entry => entry.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of entries) {
      if (affected.has(entry.id)) continue;
      if (sourceReferences(entry).some(ref => ref.entryId !== undefined && affected.has(ref.entryId))) {
        affected.add(entry.id);
        changed = true;
      }
    }
  }
  return affected;
}

/** 终局结果只追加 learning revision；eventId 让条目写入与 Effect Receipt 可分别恢复。 */
export function applyTerminalLearningOutcome(
  store: KnowledgeStore,
  input: TerminalLearningOutcomeInput,
): { matched: number; updated: number } {
  const entries = store.list({ excludeArchived: false });
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const workUnitIds = new Set(input.workUnitIds);
  const affected = affectedEntries(entries, workUnitIds);
  let updated = 0;

  for (const entry of entries) {
    if (!affected.has(entry.id)) continue;
    const refs = sourceReferences(entry);
    const latest = [...refs].reverse().find(ref => (ref as { learning?: LearningMetadata }).learning);
    const latestOutcome = (latest as { learning?: LearningMetadata } | undefined)?.learning?.outcome;
    const terminalSatisfied = latest?.outcomeEventId && latestOutcome?.delivery === 'unmerged'
      && (input.kind === 'delivery-failed' || latestOutcome.verification === 'failed');
    if (entry.maturity !== 'proven' && terminalSatisfied
      && refs.some(ref => ref.outcomeEventId === input.eventId)) continue;
    const previous = inheritedLearning(entry, byId, workUnitIds);
    if (!previous) continue;
    const outcome = input.kind === 'pmo-review-rejected'
      ? { ...previous.outcome, verification: 'failed' as const, delivery: 'unmerged' as const }
      : { ...previous.outcome, delivery: 'unmerged' as const };
    const learning: LearningMetadata = {
      ...previous,
      revision: Math.max(getLearningMetadata(entry)?.revision ?? 0, previous.revision) + 1,
      outcome,
    };
    store.update(entry.id, {
      maturity: entry.maturity === 'proven' ? 'verified' : entry.maturity,
      tags: [...new Set([...entry.tags, 'failed', input.kind])],
      sourceReferences: [...refs, {
        timestamp: new Date().toISOString(),
        outcomeEventId: input.eventId,
        learning,
      }],
    });
    updated++;
  }
  return { matched: affected.size, updated };
}
