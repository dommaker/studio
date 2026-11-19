import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileStore } from '../file-store';
import type { WorkUnitEvent, WorkUnitSnapshot } from '../file-store/file-store-types';

function snapshot(id: string): WorkUnitSnapshot {
  const now = new Date().toISOString();
  return {
    id, parentId: null, type: 'task', scope: `scope-${id}`, assigneeId: null,
    status: 'unassigned', failureType: null, retryCount: 0, timeoutAt: null,
    channelId: null, projectPath: null, metadata: null, createdAt: now, updatedAt: now,
    claimedAt: null, completedAt: null,
  };
}

function createdEvent(wu: WorkUnitSnapshot): WorkUnitEvent {
  return {
    type: 'created', wuId: wu.id, timestamp: new Date().toISOString(),
    data: wu as unknown as Record<string, unknown>,
  };
}

describe('PERF-03 FileStore index 本进程写版本', () => {
  let testDir: string;
  let store: FileStore;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-store-index-version-'));
    store = new FileStore(testDir);
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('公共 commit 与 append-only upsert 写 index 后递增，只读不推进', async () => {
    const wu = snapshot('wu-1');
    expect(store.getIndexVersion()).toBe(0);

    await store.commitSnapshot(createdEvent(wu), wu);
    expect(store.getIndexVersion()).toBe(1);
    await store.getIndex();
    expect(store.getIndexVersion()).toBe(1);

    await store.upsertSnapshot({ ...wu, scope: 'updated' });
    expect(store.getIndexVersion()).toBe(2);
  });

  it('appendEvent 不改 index 因而不推进；公共 rebuildIndex 写回后递增', async () => {
    const wu = snapshot('wu-1');
    await store.appendEvent(createdEvent(wu));
    expect(store.getIndexVersion()).toBe(0);

    await store.rebuildIndex();
    expect(store.getIndexVersion()).toBe(1);
    expect((await store.getIndex()).map(row => row.id)).toEqual(['wu-1']);
  });
});
