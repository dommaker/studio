import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileKnowledgeStore, type KnowledgeEntry } from '@dommaker/harness';
import { FileStore } from '@dommaker/studio-shared';
import { WorkUnitService } from '../../workunit/index.js';
import type { LearningMetadata } from '../learning-metadata.js';
import { applyTerminalLearningOutcome } from '../learning-outcomes.js';

vi.mock('../knowledge-singletons.js', () => ({ sharedStore: null }));

import { KnowledgeOutcomeEffects, knowledgeOutcomeIdempotencyKey } from '../knowledge-outcome-effects.js';

function makeEntry(id: string, workUnitId: string): KnowledgeEntry {
  const learning: LearningMetadata = {
    scope: { kind: 'project', id: 'proj-1' }, workUnitId,
    extractionVersion: 'conversation-1', revision: 1,
    outcome: { execution: 'succeeded', verification: 'passed', delivery: 'merged' },
  };
  return {
    id, type: 'guideline', title: id, content: id, maturity: 'proven', layer: 'project',
    created: '2026-11-10T00:00:00.000Z', lastReferenced: '', contributors: [], projects: [],
    tags: [], applicablePhases: [], sourceReferences: [{ timestamp: '2026-11-10T00:00:00.000Z', learning }],
    referencedBy: [], consumptionMode: 'reference', origin: 'agent',
  } as KnowledgeEntry;
}

describe('KnowledgeOutcomeEffects', () => {
  let dir: string;
  let fileStore: FileStore;
  let knowledgeStore: FileKnowledgeStore;
  let workUnits: WorkUnitService;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-outcome-effects-'));
    fileStore = new FileStore(path.join(dir, 'data'));
    knowledgeStore = new FileKnowledgeStore({ baseDir: path.join(dir, 'knowledge') });
    workUnits = new WorkUnitService(fileStore);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('同键触发与重启恢复只写一个终局 revision 和成功 Receipt', async () => {
    const anchor = await workUnits.create({ scope: '规划', type: 'plan', status: 'done' });
    knowledgeStore.save(makeEntry('entry-1', 'wu-1'));
    const input = { eventId: 'review:proj-1:candidate-1', kind: 'pmo-review-rejected' as const, workUnitIds: ['wu-1'] };
    const service = new KnowledgeOutcomeEffects(fileStore, knowledgeStore);

    const first = await service.trigger(anchor.id, input);
    const duplicate = await service.trigger(anchor.id, input);
    await service.waitForSettled();

    expect(duplicate.id).toBe(first.id);
    expect(knowledgeStore.get('entry-1')!.sourceReferences).toHaveLength(2);
    let snapshot = (await fileStore.getIndex({ id: anchor.id }))[0];
    expect(snapshot.effects?.filter(effect => effect.idempotencyKey === knowledgeOutcomeIdempotencyKey(input.eventId))).toHaveLength(1);
    expect(snapshot.effectReceipts?.filter(receipt => receipt.outcome === 'succeeded')).toHaveLength(1);

    const recovered = new KnowledgeOutcomeEffects(fileStore, knowledgeStore);
    await recovered.recoverPending();
    await recovered.recoverPending();
    await recovered.waitForSettled();

    expect(knowledgeStore.get('entry-1')!.sourceReferences).toHaveLength(2);
    snapshot = (await fileStore.getIndex({ id: anchor.id }))[0];
    expect(snapshot.effectReceipts?.filter(receipt => receipt.outcome === 'succeeded')).toHaveLength(1);
  });

  it('知识已部分写入但 Effect 未完成时，恢复只补缺失条目', async () => {
    const anchor = await workUnits.create({ scope: '规划', type: 'plan', status: 'done' });
    knowledgeStore.save(makeEntry('entry-1', 'wu-1'));
    knowledgeStore.save(makeEntry('entry-2', 'wu-2'));
    const input = { eventId: 'delivery:proj-1:conflict', kind: 'delivery-failed' as const, workUnitIds: ['wu-1', 'wu-2'] };
    applyTerminalLearningOutcome(knowledgeStore, { ...input, workUnitIds: ['wu-1'] });
    const firstSourceReferences = knowledgeStore.get('entry-1')!.sourceReferences;

    const service = new KnowledgeOutcomeEffects(fileStore, knowledgeStore);
    await service.trigger(anchor.id, input);
    await service.waitForSettled();

    expect(knowledgeStore.get('entry-1')!.sourceReferences).toEqual(firstSourceReferences);
    expect(knowledgeStore.get('entry-2')!.sourceReferences).toHaveLength(2);
    expect(knowledgeStore.get('entry-2')!.maturity).toBe('verified');
    const snapshot = (await fileStore.getIndex({ id: anchor.id }))[0];
    expect(snapshot.effects?.find(effect => effect.kind === 'knowledge-outcome')?.status).toBe('succeeded');
    expect(snapshot.effectReceipts?.at(-1)?.result).toMatchObject({ matched: 2, updated: 1 });
  });

  it('终局事件后才首次提取的条目也会被成功 Effect 对账标记失败', async () => {
    const anchor = await workUnits.create({ scope: '规划', type: 'plan', status: 'done' });
    const input = { eventId: 'review:proj-1:before-extraction', kind: 'pmo-review-rejected' as const, workUnitIds: ['wu-late'] };
    const service = new KnowledgeOutcomeEffects(fileStore, knowledgeStore);
    await service.trigger(anchor.id, input);
    await service.waitForSettled();
    knowledgeStore.save(makeEntry('late-entry', 'wu-late'));

    await service.reconcileCompleted();

    expect(knowledgeStore.get('late-entry')!.sourceReferences).toHaveLength(2);
    expect(knowledgeStore.get('late-entry')!.maturity).toBe('verified');
  });

  it('提取对账早于 Effect Receipt 时，成功后的再次对账仍覆盖竞态新条目', async () => {
    const anchor = await workUnits.create({ scope: '规划', type: 'plan', status: 'done' });
    const input = { eventId: 'review:proj-1:receipt-race', kind: 'pmo-review-rejected' as const, workUnitIds: ['wu-race'] };
    const list = knowledgeStore.list.bind(knowledgeStore);
    let listCalls = 0;
    const listSpy = vi.spyOn(knowledgeStore, 'list').mockImplementation(filter => {
      listCalls++;
      if (listCalls === 2) knowledgeStore.save(makeEntry('race-entry', 'wu-race'));
      return list(filter);
    });

    const service = new KnowledgeOutcomeEffects(fileStore, knowledgeStore);
    await service.trigger(anchor.id, input);
    await service.waitForSettled();

    expect(listCalls).toBeGreaterThanOrEqual(2);
    expect(knowledgeStore.get('race-entry')!.sourceReferences).toHaveLength(2);
    expect(knowledgeStore.get('race-entry')!.maturity).toBe('verified');
    listSpy.mockRestore();
  });
});
