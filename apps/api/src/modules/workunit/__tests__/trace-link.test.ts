import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileStore, WorkUnitMetadataRepository, type WorkUnitSnapshot } from '@dommaker/studio-shared';
import { TraceLink } from '../trace-link.js';

let tmpDir: string;
let store: FileStore;
let trace: TraceLink;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-link-'));
  store = new FileStore(tmpDir);
  trace = new TraceLink(new WorkUnitMetadataRepository(store));
});
afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

async function createWu(): Promise<void> {
  const now = new Date().toISOString();
  const snapshot: WorkUnitSnapshot = {
    id: 'wu-1', parentId: null, type: 'task', scope: 'test', assigneeId: null,
    status: 'active', failureType: null, retryCount: 0, timeoutAt: null, channelId: null,
    projectPath: null, metadata: JSON.stringify({ keep: true, pendingReplies: ['first'] }),
    createdAt: now, updatedAt: now, claimedAt: null, completedAt: null,
  };
  await store.commitSnapshot({ type: 'created', wuId: snapshot.id, timestamp: now, data: snapshot as unknown as Record<string, unknown> }, snapshot);
}

describe('TraceLink.attach', () => {
  it('把 trace 与可选回复原子附加到最新 metadata，不改其他字段', async () => {
    await createWu();
    await trace.attach('wu-1', 'trace-2', { pendingReply: 'second' });
    const [current] = await store.getIndex({ id: 'wu-1' });
    expect(JSON.parse(current.metadata!)).toEqual({
      keep: true, pendingReplies: ['first', 'second'], traceId: 'trace-2',
    });
  });

  it('缺失 WU 不写事件', async () => {
    await createWu();
    const events = path.join(tmpDir, 'workunits/events.jsonl');
    const before = fs.readFileSync(events, 'utf8');
    expect(await trace.attach('missing', 'trace-x')).toBeNull();
    expect(fs.readFileSync(events, 'utf8')).toBe(before);
  });
});
