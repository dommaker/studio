import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileKnowledgeStore, type KnowledgeEntry } from '@dommaker/harness';
import { getLearningMetadata, isProvenEligible, type LearningMetadata } from '../learning-metadata.js';
import { applyTerminalLearningOutcome } from '../learning-outcomes.js';

function learning(workUnitId: string): LearningMetadata {
  return {
    scope: { kind: 'project', id: 'proj-1' },
    workUnitId,
    assignmentId: `assignment-${workUnitId}`,
    stepRecordId: `step-${workUnitId}`,
    repo: '/repo/one',
    commit: 'a'.repeat(40),
    transcriptRefs: [`transcript:${workUnitId}`],
    evidenceRefs: [`evidence:${workUnitId}`],
    extractionVersion: 'conversation-1',
    revision: 1,
    outcome: { execution: 'succeeded', verification: 'passed', delivery: 'merged' },
  };
}

function entry(id: string, overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    id,
    type: 'guideline',
    title: id,
    content: `content-${id}`,
    maturity: 'proven',
    layer: 'project',
    created: '2026-11-10T00:00:00.000Z',
    lastReferenced: '',
    contributors: [],
    projects: [],
    tags: ['execution'],
    applicablePhases: [],
    sourceReferences: [],
    referencedBy: [],
    consumptionMode: 'reference',
    origin: 'agent',
    ...overrides,
  } as KnowledgeEntry;
}

describe('terminal learning outcomes', () => {
  let dir: string;
  let store: FileKnowledgeStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'learning-outcomes-'));
    store = new FileKnowledgeStore({ baseDir: dir });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('整体评审拒绝沿派生链追加失败结果、降级 proven，重复事件不重复修订', () => {
    store.save(entry('source', {
      maturity: 'archived',
      sourceReferences: [{ timestamp: '2026-11-10T00:00:00.000Z', learning: learning('wu-1') }],
    }));
    store.save(entry('direct', {
      sourceReferences: [{ timestamp: '2026-11-10T00:00:00.000Z', learning: learning('wu-1') }],
    }));
    store.save(entry('derived', {
      sourceReferences: [{ entryId: 'source', timestamp: '2026-11-11T00:00:00.000Z' }],
    }));
    store.save(entry('unrelated', {
      sourceReferences: [{ timestamp: '2026-11-10T00:00:00.000Z', learning: learning('wu-other') }],
    }));

    const input = { eventId: 'review:proj-1:candidate-1', kind: 'pmo-review-rejected' as const, workUnitIds: ['wu-1'] };
    const first = applyTerminalLearningOutcome(store, input);

    expect(first).toMatchObject({ matched: 3, updated: 3 });
    for (const id of ['source', 'direct', 'derived']) {
      const updated = store.get(id)!;
      expect(updated.maturity).toBe(id === 'source' ? 'archived' : 'verified');
      expect(updated.tags).toEqual(expect.arrayContaining(['execution', 'failed', 'pmo-review-rejected']));
      expect(updated.sourceReferences).toHaveLength(2);
      expect(getLearningMetadata(updated)).toMatchObject({
        workUnitId: 'wu-1', revision: 2,
        outcome: { execution: 'succeeded', verification: 'failed', delivery: 'unmerged' },
      });
      expect(updated.sourceReferences[1]).toMatchObject({ outcomeEventId: input.eventId });
    }
    expect(getLearningMetadata(store.get('derived')!)).toMatchObject({
      assignmentId: 'assignment-wu-1', stepRecordId: 'step-wu-1', repo: '/repo/one',
    });
    expect(store.get('unrelated')).toMatchObject({ maturity: 'proven', tags: ['execution'] });

    const before = ['source', 'direct', 'derived'].map(id => store.get(id)!.sourceReferences);
    expect(applyTerminalLearningOutcome(store, input)).toMatchObject({ matched: 3, updated: 0 });
    expect(['source', 'direct', 'derived'].map(id => store.get(id)!.sourceReferences)).toEqual(before);
  });

  it('多来源条目按任一受影响 WU 定位，并继承该 WU 而非无关最新来源', () => {
    store.save(entry('merged', {
      sourceReferences: [
        { timestamp: '2026-11-10T00:00:00.000Z', learning: learning('wu-1') },
        { timestamp: '2026-11-11T00:00:00.000Z', learning: { ...learning('wu-2'), revision: 2 } },
      ],
    }));

    expect(applyTerminalLearningOutcome(store, {
      eventId: 'review:proj-1:candidate-multi', kind: 'pmo-review-rejected', workUnitIds: ['wu-1'],
    })).toMatchObject({ matched: 1, updated: 1 });
    expect(getLearningMetadata(store.get('merged')!)).toMatchObject({
      workUnitId: 'wu-1', assignmentId: 'assignment-wu-1', revision: 3,
      outcome: { execution: 'succeeded', verification: 'failed', delivery: 'unmerged' },
    });
  });

  it('迟到 WU 成功来源不能覆盖终局失败，重放会恢复最新失败 revision', () => {
    store.save(entry('late', {
      sourceReferences: [{ timestamp: '2026-11-10T00:00:00.000Z', learning: learning('wu-1') }],
    }));
    const input = { eventId: 'review:proj-1:candidate-late', kind: 'pmo-review-rejected' as const, workUnitIds: ['wu-1'] };
    applyTerminalLearningOutcome(store, input);
    const terminal = store.get('late')!;
    store.update('late', {
      maturity: 'proven',
      sourceReferences: [...terminal.sourceReferences, {
        timestamp: '2026-11-12T00:00:00.000Z',
        learning: { ...learning('wu-1'), revision: 3 },
      }],
    });

    expect(isProvenEligible(store.get('late')!)).toBe(false);
    expect(applyTerminalLearningOutcome(store, input)).toMatchObject({ matched: 1, updated: 1 });
    const recovered = store.get('late')!;
    expect(recovered.maturity).toBe('verified');
    expect(recovered.sourceReferences).toHaveLength(4);
    expect(recovered.sourceReferences.at(-1)).toMatchObject({ outcomeEventId: input.eventId });
    expect(getLearningMetadata(recovered)).toMatchObject({ revision: 4, outcome: { verification: 'failed', delivery: 'unmerged' } });
  });

  it('多个终局事件按任意顺序重放都不会交替追加 revision', () => {
    store.save(entry('two-events', {
      sourceReferences: [{ timestamp: '2026-11-10T00:00:00.000Z', learning: learning('wu-1') }],
    }));
    const review = { eventId: 'review:proj-1:candidate-two', kind: 'pmo-review-rejected' as const, workUnitIds: ['wu-1'] };
    const delivery = { eventId: 'delivery:proj-1:conflict-two', kind: 'delivery-failed' as const, workUnitIds: ['wu-1'] };
    applyTerminalLearningOutcome(store, review);
    applyTerminalLearningOutcome(store, delivery);
    store.update('two-events', {
      sourceReferences: [...store.get('two-events')!.sourceReferences, { timestamp: '2026-11-13T00:00:00.000Z', workflow: 'distill' }],
    });
    const before = store.get('two-events')!.sourceReferences;

    expect(applyTerminalLearningOutcome(store, review)).toMatchObject({ updated: 0 });
    expect(applyTerminalLearningOutcome(store, delivery)).toMatchObject({ updated: 0 });
    expect(store.get('two-events')!.sourceReferences).toEqual(before);
  });
});
