import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FileStore } from '../file-store';
import type { WorkUnitEvent, WorkUnitSnapshot } from '../file-store/file-store-types';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const TSX_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const FILE_STORE_TS = pathToFileURL(path.resolve(__dirname, '..', 'file-store', 'index.ts')).href;

function snapshot(id: string): WorkUnitSnapshot {
  const now = new Date().toISOString();
  return {
    id, parentId: null, type: 'task', scope: id, assigneeId: null, status: 'unassigned',
    failureType: null, retryCount: 0, timeoutAt: null, channelId: null, projectPath: null,
    metadata: '{"count":0,"writers":[]}', createdAt: now, updatedAt: now, claimedAt: null, completedAt: null,
  };
}

describe('PERF-02 跨进程当前态', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wu-current-process-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('两个进程交替崩溃恢复与正常写：旧 projection 不覆盖新状态', async () => {
    const store = new FileStore(root);
    const initial = snapshot('wu-1');
    const created: WorkUnitEvent = { type: 'created', wuId: initial.id, timestamp: initial.createdAt, data: initial as unknown as Record<string, unknown> };
    await store.commitSnapshot(created, initial);
    const worker = path.join(root, 'writer.ts');
    fs.writeFileSync(worker, `
import { FileStore } from ${JSON.stringify(FILE_STORE_TS)};
const [root, writer, mode] = process.argv.slice(2);
const store = new FileStore(root);
async function main() {
  if (mode === 'crash') {
    const current = (await store.getIndex({ id: 'wu-1' }))[0];
    if (!current) throw new Error('missing wu-1');
    const metadata = JSON.parse(current.metadata || '{}');
    const next = {
      ...current,
      metadata: JSON.stringify({
        ...metadata,
        count: metadata.count + 1,
        writers: [...metadata.writers, writer],
      }),
      updatedAt: new Date().toISOString(),
    };
    await store.appendEvent({ type: 'updated', wuId: 'wu-1', timestamp: next.updatedAt, data: next });
    return; // 模拟 events 已写、index/projection/manifest 未写即进程退出
  }
  const updated = await store.updateMetadata('wu-1', current => ({
    ...current,
    count: (current.count as number) + 1,
    writers: [...(current.writers as string[]), writer],
  }));
  if (!updated) throw new Error('missing wu-1');
}
main().catch(error => { console.error(error); process.exit(1); });
`);
    const run = async (writer: string, mode: 'crash' | 'normal') => {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(TSX_BIN, [worker, root, writer, mode], { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', chunk => { stderr += String(chunk); });
        child.on('error', reject);
        child.on('exit', code => code === 0 ? resolve() : reject(new Error(stderr || `writer exited ${code}`)));
      });
    };
    for (let round = 0; round < 6; round++) {
      await run('A', 'crash');
      await run('B', 'normal');
    }

    const current = (await store.getIndex({ id: 'wu-1' }))[0];
    const metadata = JSON.parse(current.metadata!);
    expect(metadata.count).toBe(12);
    expect(metadata.writers).toEqual(Array.from({ length: 12 }, (_, i) => i % 2 === 0 ? 'A' : 'B'));
    expect((await store.rebuildIndex())[0].metadata).toBe(current.metadata);
  }, 60_000);
});
