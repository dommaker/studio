import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileStore, WorkUnitMetadataRepository, type WorkUnitSnapshot } from '@dommaker/studio-shared';
import { DerivationLedger } from '../derivation-ledger.js';

let tmpDir: string;
let store: FileStore;
let ledger: DerivationLedger;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'derivation-ledger-'));
  store = new FileStore(tmpDir);
  ledger = new DerivationLedger(new WorkUnitMetadataRepository(store));
});
afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

async function createWu(metadata: Record<string, unknown> = {}): Promise<void> {
  const now = new Date().toISOString();
  const snapshot: WorkUnitSnapshot = {
    id: 'wu-1', parentId: null, type: 'analysis', scope: 'test', assigneeId: null,
    status: 'done', failureType: null, retryCount: 0, timeoutAt: null, channelId: null,
    projectPath: null, metadata: JSON.stringify(metadata), createdAt: now, updatedAt: now,
    claimedAt: null, completedAt: now,
  };
  await store.commitSnapshot({ type: 'created', wuId: snapshot.id, timestamp: now, data: snapshot as unknown as Record<string, unknown> }, snapshot);
}

describe('DerivationLedger.claim/mark', () => {
  it('并发 claim 只有一个调用拿到自己的 stamp，且不覆盖其他 metadata', async () => {
    await createWu({ keep: true });
    const [first, second] = await Promise.all([
      ledger.claim('wu-1', 'stamp-a'),
      ledger.claim('wu-1', 'stamp-b'),
    ]);
    const claims = [
      { stamp: 'stamp-a', result: first },
      { stamp: 'stamp-b', result: second },
    ];
    const winners = claims.filter(({ stamp, result }) => JSON.parse(result!.metadata!).analysisTasksSpawnedAt === stamp);
    expect(winners).toHaveLength(1);
    const [current] = await store.getIndex({ id: 'wu-1' });
    const metadata = JSON.parse(current.metadata!);
    expect(metadata.keep).toBe(true);
    expect(metadata.analysisTasksSpawned).toEqual([]);
  });

  it('mark 幂等追加子单 id，重复 mark 不产生重复派生记录', async () => {
    await createWu({ analysisTasksSpawnedAt: 'stamp-a', analysisTasksSpawned: [], keep: true });
    await Promise.all([ledger.mark('wu-1', 'child-1'), ledger.mark('wu-1', 'child-1')]);
    await ledger.mark('wu-1', 'child-2');
    const [current] = await store.getIndex({ id: 'wu-1' });
    expect(JSON.parse(current.metadata!)).toMatchObject({
      analysisTasksSpawned: ['child-1', 'child-2'], keep: true,
    });
  });
});
