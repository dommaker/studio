import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileStore, type WorkUnitSnapshot } from '@dommaker/studio-shared';
import { workUnitSchema } from '@dommaker/studio-contract';
import { EffectService } from '../effects.js';
import { toWorkUnitWire } from '../workunit-crud.js';
import { WorkUnitService } from '../workunit-review.js';

let tmpDir: string;
let store: FileStore;
let service: WorkUnitService;
let effects: EffectService;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workunit-effects-'));
  store = new FileStore(tmpDir);
  service = new WorkUnitService(store);
  effects = new EffectService(store, { retryDelayMs: 0 });
});

afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

async function createReviewable(): Promise<WorkUnitSnapshot> {
  const created = await service.create({
    scope: '待评审任务', type: 'task', status: 'active', channelId: 'channel-1',
  });
  await service.transitionStatus(created.id, 'in_review');
  return (await store.getIndex({ id: created.id }))[0]!;
}

describe('EffectService', () => {
  it('WU 状态与 Effect 同事务落盘，提交后执行且幂等写 Receipt', async () => {
    const parent = await createReviewable();
    const queued = (await effects.getProjection(parent.id)).effects[0]!;
    expect(queued).toMatchObject({
      workUnitId: parent.id,
      kind: 'review-dispatch',
      status: 'queued',
      attempts: 0,
      maxAttempts: 3,
    });
    expect(queued.idempotencyKey).toContain(parent.id);

    let calls = 0;
    const executed = await effects.execute(parent.id, queued.id, async () => {
      calls++;
      return { reviewWorkUnitId: 'review-1' };
    });
    expect(executed).toMatchObject({ status: 'succeeded', attempts: 1 });
    await effects.execute(parent.id, queued.id, async () => {
      calls++;
      return { reviewWorkUnitId: 'review-duplicate' };
    });
    expect(calls).toBe(1);

    await store.rebuildIndex();
    const projection = await effects.getProjection(parent.id);
    expect(projection.effects[0]).toMatchObject({ status: 'succeeded', attempts: 1 });
    expect(projection.receipts).toHaveLength(1);
    expect(projection.receipts[0]).toMatchObject({
      effectId: queued.id,
      idempotencyKey: queued.idempotencyKey,
      outcome: 'succeeded',
      result: { reviewWorkUnitId: 'review-1' },
    });
    const readModel = await service.getById(parent.id);
    expect(readModel?.effects?.[0]).toMatchObject({ id: queued.id, status: 'succeeded' });
    expect(readModel?.effectReceipts).toEqual(projection.receipts);
    expect(workUnitSchema.parse(toWorkUnitWire(readModel!)).effects?.[0]?.id).toBe(queued.id);
  });

  it('瞬时失败有限重试，达到上限后永久失败且不再执行', async () => {
    const parent = await createReviewable();
    const effect = (await effects.getProjection(parent.id)).effects[0]!;
    let calls = 0;
    const fail = async () => {
      calls++;
      throw new Error('temporary store failure');
    };

    for (let attempt = 0; attempt < 3; attempt++) {
      await effects.execute(parent.id, effect.id, fail);
    }
    await effects.execute(parent.id, effect.id, fail);

    expect(calls).toBe(3);
    const projection = await effects.getProjection(parent.id);
    expect(projection.effects[0]).toMatchObject({
      status: 'failed', attempts: 3, lastError: 'Error: temporary store failure',
    });
    expect(projection.receipts.map(receipt => receipt.outcome)).toEqual(['retrying', 'retrying', 'failed']);
  });

  it('进程重启后恢复排队与 running 意图，并记录恢复核查', async () => {
    const parent = await createReviewable();
    const effect = (await effects.getProjection(parent.id)).effects[0]!;
    const running: WorkUnitSnapshot = {
      ...parent,
      effects: (parent.effects ?? []).map(item => item.id === effect.id
        ? { ...item, status: 'running' as const, attempts: 1, startedAt: new Date().toISOString() }
        : item),
    };
    await store.commitSnapshot({
      type: 'updated', wuId: parent.id, timestamp: running.updatedAt,
      data: running as unknown as Record<string, unknown>,
    }, running);

    const restarted = new EffectService(new FileStore(tmpDir), { retryDelayMs: 0 });
    let calls = 0;
    const result = await restarted.recover(async ({ recovery }) => {
      calls++;
      expect(recovery).toBe(true);
      return { reviewWorkUnitId: 'review-recovered' };
    });

    expect(result).toMatchObject({ attempted: 1, succeeded: 1 });
    expect(calls).toBe(1);
    const projection = await restarted.getProjection(parent.id);
    expect(projection.effects[0]).toMatchObject({ status: 'succeeded', attempts: 2 });
    expect(projection.receipts.at(-1)).toMatchObject({
      outcome: 'succeeded', recovery: 'running-reconciled',
    });
  });

});
