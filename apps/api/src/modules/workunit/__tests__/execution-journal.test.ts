import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileStore, WorkUnitMetadataRepository, type WorkUnitSnapshot } from '@dommaker/studio-shared';
import { ExecutionJournal } from '../execution-journal.js';
import { TraceLink } from '../trace-link.js';
import { snapshotToData } from '../workunit-crud.js';

let tmpDir: string;
let store: FileStore;
let repository: WorkUnitMetadataRepository;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'execution-journal-'));
  store = new FileStore(tmpDir);
  repository = new WorkUnitMetadataRepository(store);
});

afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

async function createWu(metadata: Record<string, unknown> = {}): Promise<WorkUnitSnapshot> {
  const now = new Date().toISOString();
  const snapshot: WorkUnitSnapshot = {
    id: 'wu-1', parentId: null, type: 'task', scope: 'test', assigneeId: 'agent-1',
    status: 'active', failureType: null, retryCount: 0, timeoutAt: null, channelId: null,
    projectPath: null, metadata: JSON.stringify(metadata), createdAt: now, updatedAt: now,
    claimedAt: now, completedAt: null,
  };
  await store.commitSnapshot({ type: 'created', wuId: snapshot.id, timestamp: now, data: snapshot as unknown as Record<string, unknown> }, snapshot);
  return snapshot;
}

function recordInput(snapshot: WorkUnitSnapshot) {
  const wu = snapshotToData(snapshot);
  const metadata = { stepCount: 1, pendingReplies: ['old'] };
  return {
    wu,
    metadata,
    action: 'progress' as const,
    result: { action: 'progress' as const, summary: 'done', metadataUpdates: { pendingReplies: undefined } },
    guardUpdates: {},
    freshnessUpdates: {},
    bookkeeping: { stepCount: 2, consecutiveStuck: 0, waitingUpdates: {}, blockReasonUpdates: {} },
  };
}

describe('ExecutionJournal.recordStepResult', () => {
  it('在锁内重计步数并合并非本步字段，不丢并发 TraceLink 写入', async () => {
    const snapshot = await createWu({ stepCount: 1, pendingReplies: ['old'], keep: true });
    const journal = new ExecutionJournal(repository);
    const trace = new TraceLink(repository);

    await Promise.all([
      journal.recordStepResult(recordInput(snapshot)),
      trace.attach(snapshot.id, 'trace-new'),
    ]);

    const [current] = await store.getIndex({ id: snapshot.id });
    const metadata = JSON.parse(current.metadata!);
    expect(metadata.stepCount).toBe(2);
    expect(metadata.traceId).toBe('trace-new');
    expect(metadata.keep).toBe(true);
    expect(metadata.pendingReplies).toBeUndefined();
    expect(metadata.progressLog).toHaveLength(1);
  });

  it('WU 不存在时返回 null 且不追加执行事件', async () => {
    const snapshot = await createWu();
    const before = fs.readFileSync(path.join(tmpDir, 'workunits/events.jsonl'), 'utf8');
    const result = await new ExecutionJournal(repository).recordStepResult({
      ...recordInput(snapshot),
      wu: { ...snapshotToData(snapshot), id: 'missing' },
    });
    expect(result).toBeNull();
    expect(fs.readFileSync(path.join(tmpDir, 'workunits/events.jsonl'), 'utf8')).toBe(before);
  });
});
