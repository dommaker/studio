import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileStore, WorkUnitMetadataRepository, type WorkUnitSnapshot } from '@dommaker/studio-shared';
import { WaitingGate } from '../waiting-gate.js';

let tmpDir: string;
let store: FileStore;
let gate: WaitingGate;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'waiting-gate-'));
  store = new FileStore(tmpDir);
  gate = new WaitingGate(new WorkUnitMetadataRepository(store));
});
afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

async function createWu(metadata: Record<string, unknown>): Promise<void> {
  const now = new Date().toISOString();
  const snapshot: WorkUnitSnapshot = {
    id: 'wu-1', parentId: null, type: 'plan', scope: 'test', assigneeId: 'agent-1',
    status: 'blocked', failureType: null, retryCount: 0, timeoutAt: null, channelId: null,
    projectPath: null, metadata: JSON.stringify(metadata), createdAt: now, updatedAt: now,
    claimedAt: now, completedAt: null,
  };
  await store.commitSnapshot({ type: 'created', wuId: snapshot.id, timestamp: now, data: snapshot as unknown as Record<string, unknown> }, snapshot);
}

describe('WaitingGate.apply/renew', () => {
  it('apply(resume) 清挂起并追加回复，保留终身超时计数和 trace', async () => {
    await createWu({ waitingForInput: true, waitingReminded: true, blockReason: 'wait', consecutiveStuck: 3, resumeCount: 2, timeoutReleaseCount: 4 });
    await gate.apply('wu-1', { kind: 'resume', replyText: '继续', traceId: 'trace-1' });
    const [current] = await store.getIndex({ id: 'wu-1' });
    expect(JSON.parse(current.metadata!)).toMatchObject({
      waitingForInput: false, waitingReminded: false, consecutiveStuck: 0,
      resumeCount: 3, timeoutReleaseCount: 4, pendingReplies: ['继续'], traceId: 'trace-1',
    });
    expect(JSON.parse(current.metadata!)).not.toHaveProperty('blockReason');
  });

  it('renew 基于锁内最新额度续期，并发回复不丢', async () => {
    await createWu({ planStepAllowance: 60, pendingReplies: [] });
    await Promise.all([
      gate.renew('wu-1'),
      gate.apply('wu-1', { kind: 'buffer-reply', replyText: '新约束' }),
    ]);
    const [current] = await store.getIndex({ id: 'wu-1' });
    expect(JSON.parse(current.metadata!)).toMatchObject({ planStepAllowance: 120, pendingReplies: ['新约束'] });
  });
});
