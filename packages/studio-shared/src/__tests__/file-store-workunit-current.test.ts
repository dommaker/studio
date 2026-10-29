import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkUnitStore, parseWorkUnitIndexContent } from '../file-store/file-store-workunit';
import { createFileStoreCore } from '../file-store/file-store-core';
import type { WorkUnitEvent, WorkUnitSnapshot } from '../file-store/file-store-types';
import { workUnitProjectionFileName } from '../file-store/workunit-current-projection';

function snapshot(id: string, overrides: Partial<WorkUnitSnapshot> = {}): WorkUnitSnapshot {
  const now = new Date().toISOString();
  return {
    id, parentId: null, type: 'task', scope: `scope-${id}`, assigneeId: null,
    status: 'unassigned', failureType: null, retryCount: 0, timeoutAt: null,
    channelId: null, projectPath: null, metadata: '{}', createdAt: now, updatedAt: now,
    claimedAt: null, completedAt: null, ...overrides,
  };
}

function event(type: WorkUnitEvent['type'], snap: WorkUnitSnapshot): WorkUnitEvent {
  return { type, wuId: snap.id, timestamp: new Date().toISOString(), data: snap as unknown as Record<string, unknown> };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

describe('PERF-02 WorkUnit 当前态投影', () => {
  let root: string;
  let store: WorkUnitStore;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wu-current-'));
    store = new WorkUnitStore(createFileStoreCore(root));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('updateMetadata 锁内点查不读取历史 index，并落 per-WU 当前投影', async () => {
    const initial = snapshot('wu-1', { metadata: JSON.stringify({ count: 0 }) });
    await store.commitSnapshot(event('created', initial), initial);
    const indexPath = path.join(root, 'workunits', 'index.json');
    const readSpy = vi.spyOn(fs.promises, 'readFile');

    const updated = await store.updateMetadata('wu-1', current => ({ ...current, count: 1 }));

    expect(updated?.metadata).toBe(JSON.stringify({ count: 1 }));
    expect(readSpy.mock.calls.some(([file]) => path.resolve(String(file)) === indexPath)).toBe(false);
    const projectionPath = path.join(root, 'workunits', 'current', workUnitProjectionFileName('wu-1'));
    expect(JSON.parse(fs.readFileSync(projectionPath, 'utf8')).snapshot.metadata).toBe(JSON.stringify({ count: 1 }));
  });

  it('事件已写但 projection 未提交：下一锁内写从 log 恢复，不丢不重', async () => {
    const core = createFileStoreCore(root);
    store = new WorkUnitStore(core);
    const initial = snapshot('wu-1', { metadata: JSON.stringify({ count: 0 }) });
    await store.commitSnapshot(event('created', initial), initial);
    const projectionPath = path.join(root, 'workunits', 'current', workUnitProjectionFileName('wu-1'));
    const writeJson = core.io.writeJson.bind(core.io);
    vi.spyOn(core.io, 'writeJson').mockImplementation(async (file, data) => {
      if (path.resolve(String(file)) === projectionPath) throw new Error('crash before projection');
      return writeJson(file, data);
    });

    await expect(store.updateMetadata('wu-1', current => ({ ...current, count: 1 }))).rejects.toThrow('crash before projection');
    vi.restoreAllMocks();
    store = new WorkUnitStore(createFileStoreCore(root));
    const updated = await store.updateMetadata('wu-1', current => ({
      ...current, count: (current.count as number) + 1,
    }));

    expect(updated?.metadata).toBe(JSON.stringify({ count: 2 }));
    const events = fs.readFileSync(path.join(root, 'workunits', 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as WorkUnitEvent);
    expect(events.filter(row => row.type === 'updated')).toHaveLength(2);
    expect((await store.rebuildIndex())[0].metadata).toBe(JSON.stringify({ count: 2 }));
  });

  it('index 写失败：事件保留，下一次写从 log 恢复且不重复投影副作用', async () => {
    const core = createFileStoreCore(root);
    store = new WorkUnitStore(core);
    const initial = snapshot('wu-1', { metadata: JSON.stringify({ count: 0 }) });
    await store.commitSnapshot(event('created', initial), initial);
    const indexPath = path.join(root, 'workunits', 'index.json');
    const appendJsonl = core.io.appendJsonl.bind(core.io);
    vi.spyOn(core.io, 'appendJsonl').mockImplementation(async (file, data) => {
      if (path.resolve(String(file)) === indexPath) throw new Error('crash before index');
      return appendJsonl(file, data);
    });
    await expect(store.updateMetadata('wu-1', current => ({ ...current, count: 1 }))).rejects.toThrow('crash before index');

    vi.restoreAllMocks();
    store = new WorkUnitStore(createFileStoreCore(root));
    const updated = await store.updateMetadata('wu-1', current => ({ ...current, count: (current.count as number) + 1 }));
    expect(updated?.metadata).toBe(JSON.stringify({ count: 2 }));
    expect((await store.rebuildIndex())[0].metadata).toBe(JSON.stringify({ count: 2 }));
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'workunits', 'current', 'manifest.json'), 'utf8'));
    const projection = JSON.parse(fs.readFileSync(path.join(root, 'workunits', 'current', workUnitProjectionFileName('wu-1')), 'utf8'));
    expect(projection.log).toEqual(manifest.log);
  });

  it('manifest 写失败：新 projection 不是提交点，下一进程/实例按 log 重建', async () => {
    const core = createFileStoreCore(root);
    store = new WorkUnitStore(core);
    const initial = snapshot('wu-1', { metadata: JSON.stringify({ count: 0 }) });
    await store.commitSnapshot(event('created', initial), initial);
    const manifestPath = path.join(root, 'workunits', 'current', 'manifest.json');
    const writeJson = core.io.writeJson.bind(core.io);
    vi.spyOn(core.io, 'writeJson').mockImplementation(async (file, data) => {
      if (path.resolve(String(file)) === manifestPath) throw new Error('crash before manifest');
      return writeJson(file, data);
    });
    await expect(store.updateMetadata('wu-1', current => ({ ...current, count: 1 }))).rejects.toThrow('crash before manifest');

    vi.restoreAllMocks();
    store = new WorkUnitStore(createFileStoreCore(root));
    const updated = await store.updateMetadata('wu-1', current => ({ ...current, count: (current.count as number) + 1 }));
    expect(updated?.metadata).toBe(JSON.stringify({ count: 2 }));
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const projection = JSON.parse(fs.readFileSync(path.join(root, 'workunits', 'current', workUnitProjectionFileName('wu-1')), 'utf8'));
    expect(projection.log).toEqual(manifest.log);
    expect((await store.rebuildIndex())[0].metadata).toBe(JSON.stringify({ count: 2 }));
  });

  it('projection 损坏自动重建，metadata 增量基于事件真源', async () => {
    const initial = snapshot('wu-1', { metadata: JSON.stringify({ count: 4 }) });
    await store.commitSnapshot(event('created', initial), initial);
    const projectionPath = path.join(root, 'workunits', 'current', workUnitProjectionFileName('wu-1'));
    fs.writeFileSync(projectionPath, '{broken');

    const updated = await store.updateMetadata('wu-1', current => ({ ...current, count: (current.count as number) + 1 }));

    expect(updated?.metadata).toBe(JSON.stringify({ count: 5 }));
    expect(JSON.parse(fs.readFileSync(projectionPath, 'utf8')).snapshot.metadata).toBe(JSON.stringify({ count: 5 }));
  });

  it('manifest 新鲜但已有事件的 projection 缺失：重建后恢复，不当作 WU 不存在', async () => {
    const initial = snapshot('wu-1', { metadata: JSON.stringify({ count: 7 }) });
    await store.commitSnapshot(event('created', initial), initial);
    const projectionPath = path.join(root, 'workunits', 'current', workUnitProjectionFileName('wu-1'));
    fs.unlinkSync(projectionPath);

    const updated = await store.updateMetadata('wu-1', current => ({ ...current, count: (current.count as number) + 1 }));

    expect(updated?.metadata).toBe(JSON.stringify({ count: 8 }));
    expect(JSON.parse(fs.readFileSync(projectionPath, 'utf8')).snapshot.metadata).toBe(JSON.stringify({ count: 8 }));
  });

  it('同 dev:ino 但 offset 落后的 projection 必须重建，不能 RMW 旧快照', async () => {
    const initial = snapshot('wu-1', { metadata: JSON.stringify({ count: 0 }) });
    await store.commitSnapshot(event('created', initial), initial);
    const projectionPath = path.join(root, 'workunits', 'current', workUnitProjectionFileName('wu-1'));
    const stale = fs.readFileSync(projectionPath, 'utf8');
    await store.updateMetadata('wu-1', current => ({ ...current, count: 1 }));
    const manifestPath = path.join(root, 'workunits', 'current', 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    expect(JSON.parse(stale).log.dev).toBe(manifest.log.dev);
    expect(JSON.parse(stale).log.ino).toBe(manifest.log.ino);
    expect(JSON.parse(stale).log.offset).toBeLessThan(manifest.log.offset);
    fs.writeFileSync(projectionPath, stale);

    const updated = await store.updateMetadata('wu-1', current => ({ ...current, count: (current.count as number) + 1 }));

    expect(updated?.metadata).toBe(JSON.stringify({ count: 2 }));
    expect(JSON.parse(fs.readFileSync(projectionPath, 'utf8')).log).toEqual(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).log);
  });

  it('events 半行 fail-closed：读写零副作用，截断未提交半行后可恢复且不粘连', async () => {
    const core = createFileStoreCore(root);
    store = new WorkUnitStore(core);
    const initial = snapshot('wu-1', { metadata: JSON.stringify({ count: 0 }) });
    await store.commitSnapshot(event('created', initial), initial);
    const eventsPath = path.join(root, 'workunits', 'events.jsonl');
    const manifestPath = path.join(root, 'workunits', 'current', 'manifest.json');
    const complete = fs.readFileSync(eventsPath, 'utf8');
    const manifestBefore = fs.readFileSync(manifestPath, 'utf8');
    const partial = '{"type":"updated","wuId":"wu-1"';
    fs.appendFileSync(eventsPath, partial);

    await expect(store.updateMetadata('wu-1', current => ({ ...current, count: 1 }))).rejects.toThrow('incomplete trailing line');
    await expect(store.appendEvent({
      type: 'updated', wuId: 'wu-1', timestamp: new Date().toISOString(), data: { metadata: '{"count":1}' },
    })).rejects.toThrow('incomplete trailing line');
    expect(fs.readFileSync(eventsPath, 'utf8')).toBe(complete + partial);
    expect(fs.readFileSync(manifestPath, 'utf8')).toBe(manifestBefore);
    const indexPath = path.join(root, 'workunits', 'index.json');
    const indexBefore = fs.readFileSync(indexPath, 'utf8');
    const writeJsonl = vi.spyOn(core.io, 'writeJsonl');
    await expect(store.rebuildIndex()).rejects.toThrow('incomplete trailing line');
    expect(writeJsonl).not.toHaveBeenCalled();
    expect(fs.readFileSync(indexPath, 'utf8')).toBe(indexBefore);
    expect(fs.readFileSync(manifestPath, 'utf8')).toBe(manifestBefore);
    vi.restoreAllMocks();

    fs.truncateSync(eventsPath, Buffer.byteLength(complete));
    const updated = await store.updateMetadata('wu-1', current => ({ ...current, count: 1 }));
    expect(updated?.metadata).toBe(JSON.stringify({ count: 1 }));
    const lines = fs.readFileSync(eventsPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    expect((await store.rebuildIndex())[0].metadata).toBe(JSON.stringify({ count: 1 }));
  });

  it('events 代际变化及单 WU 旧代际 projection 都触发恢复', async () => {
    const initial = snapshot('wu-1', { metadata: JSON.stringify({ count: 0 }) });
    await store.commitSnapshot(event('created', initial), initial);
    const eventsPath = path.join(root, 'workunits', 'events.jsonl');
    const rotated = `${eventsPath}.rotated`;
    fs.renameSync(eventsPath, rotated);
    fs.copyFileSync(rotated, eventsPath);
    fs.unlinkSync(rotated);
    await store.updateMetadata('wu-1', current => ({ ...current, count: 1 }));

    const projectionPath = path.join(root, 'workunits', 'current', workUnitProjectionFileName('wu-1'));
    const projection = JSON.parse(fs.readFileSync(projectionPath, 'utf8'));
    fs.writeFileSync(projectionPath, JSON.stringify({ ...projection, log: { ...projection.log, ino: projection.log.ino + 1 } }));
    const updated = await store.updateMetadata('wu-1', current => ({ ...current, count: 2 }));

    expect(updated?.metadata).toBe(JSON.stringify({ count: 2 }));
    expect(JSON.parse(fs.readFileSync(projectionPath, 'utf8')).log.ino).not.toBe(projection.log.ino + 1);
  });

  it('全量重建以 append log fold 为准并清除 projection/index 幻影', async () => {
    const first = snapshot('wu-1');
    const second = snapshot('wu-2', { status: 'active', assigneeId: 'agent-1' });
    await store.commitSnapshot(event('created', first), first);
    await store.commitSnapshot(event('created', second), second);
    const phantom = snapshot('phantom');
    fs.writeFileSync(path.join(root, 'workunits', 'index.json'), `${JSON.stringify(phantom)}\n`);
    const projectionDir = path.join(root, 'workunits', 'current');
    fs.writeFileSync(path.join(projectionDir, workUnitProjectionFileName('phantom')), JSON.stringify({
      version: 1, log: { dev: 0, ino: 0, offset: 0 }, snapshot: phantom,
    }));

    const rebuilt = await store.rebuildIndex();

    expect(rebuilt.map(row => row.id)).toEqual(['wu-1', 'wu-2']);
    expect(fs.existsSync(path.join(projectionDir, workUnitProjectionFileName('phantom')))).toBe(false);
    expect((await store.getIndex()).map(row => row.id)).toEqual(['wu-1', 'wu-2']);
  });

  it('legacy pending 后先 rebuildIndex：只提交 index-fold 恢复，不丢直写也不复活删除项', async () => {
    await store.upsertSnapshot(snapshot('wu-1'));
    await store.upsertSnapshot(snapshot('wu-2'));
    await store.removeSnapshot('wu-1');
    const pendingPath = path.join(root, 'workunits', 'current', 'legacy-pending.json');
    fs.writeFileSync(pendingPath, '{"version":1}');

    const rebuilt = await store.rebuildIndex();

    expect(rebuilt.map(row => row.id)).toEqual(['wu-2']);
    expect(parseWorkUnitIndexContent(fs.readFileSync(path.join(root, 'workunits', 'index.json'), 'utf8')).map(row => row.id)).toEqual(['wu-2']);
    expect(fs.existsSync(path.join(root, 'workunits', 'current', workUnitProjectionFileName('wu-1')))).toBe(false);
    expect(fs.existsSync(path.join(root, 'workunits', 'current', workUnitProjectionFileName('wu-2')))).toBe(true);
    expect(fs.existsSync(pendingPath)).toBe(false);
    expect(fs.existsSync(path.join(root, 'workunits', 'events.jsonl'))).toBe(false);
  });

  it('legacy pending 后先 reconcileIndex：安全返回恢复结果，不按空 events 清掉直写', async () => {
    await store.upsertSnapshot(snapshot('wu-2'));
    const pendingPath = path.join(root, 'workunits', 'current', 'legacy-pending.json');
    fs.writeFileSync(pendingPath, '{"version":1}');

    const result = await store.reconcileIndex();

    expect(result).toMatchObject({ consistent: true, rebuilt: true, eventCount: 0, indexCount: 1, staleInIndex: 0 });
    expect((await store.getIndex()).map(row => row.id)).toEqual(['wu-2']);
    expect(fs.existsSync(pendingPath)).toBe(false);
    expect(fs.existsSync(path.join(root, 'workunits', 'events.jsonl'))).toBe(false);
  });

  it('legacy pending 后先 appendEvent：恢复后 fail-closed 零事件，可改走 commit 不丢数据', async () => {
    await store.upsertSnapshot(snapshot('wu-2'));
    fs.writeFileSync(path.join(root, 'workunits', 'current', 'legacy-pending.json'), '{"version":1}');
    const wu3 = snapshot('wu-3');

    await expect(store.appendEvent(event('created', wu3))).rejects.toThrow('legacy pending recovered');
    expect(fs.existsSync(path.join(root, 'workunits', 'events.jsonl'))).toBe(false);
    expect((await store.getIndex()).map(row => row.id)).toEqual(['wu-2']);

    await store.commitSnapshot(event('created', wu3), wu3);
    expect((await store.getIndex()).map(row => row.id)).toEqual(['wu-2', 'wu-3']);
    expect(fs.existsSync(path.join(root, 'workunits', 'current', workUnitProjectionFileName('wu-2')))).toBe(true);
    expect(fs.existsSync(path.join(root, 'workunits', 'current', workUnitProjectionFileName('wu-3')))).toBe(true);
    const events = fs.readFileSync(path.join(root, 'workunits', 'events.jsonl'), 'utf8').trim().split('\n');
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]).wuId).toBe('wu-3');
  });

  it('legacy upsert 在 index 后/projection 前崩溃：pending 驱动从 index 恢复且零 events', async () => {
    const core = createFileStoreCore(root);
    store = new WorkUnitStore(core);
    await store.upsertSnapshot(snapshot('wu-1', { metadata: '{"count":0}' }));
    const projectionPath = path.join(root, 'workunits', 'current', workUnitProjectionFileName('wu-1'));
    const writeJson = core.io.writeJson.bind(core.io);
    vi.spyOn(core.io, 'writeJson').mockImplementation(async (file, data) => {
      if (path.resolve(String(file)) === projectionPath) throw new Error('crash after legacy index');
      return writeJson(file, data);
    });
    await expect(store.upsertSnapshot(snapshot('wu-1', { metadata: '{"count":1}' }))).rejects.toThrow('crash after legacy index');

    vi.restoreAllMocks();
    const recoveryCore = createFileStoreCore(root);
    store = new WorkUnitStore(recoveryCore);
    const recoveryWriteJson = recoveryCore.io.writeJson.bind(recoveryCore.io);
    vi.spyOn(recoveryCore.io, 'writeJson').mockImplementation(async (file, data) => {
      if (path.resolve(String(file)) === projectionPath) throw new Error('crash during legacy recovery');
      return recoveryWriteJson(file, data);
    });
    await expect(store.createSnapshotGuarded(snapshot('never'), () => false)).rejects.toThrow('crash during legacy recovery');
    expect(fs.existsSync(path.join(root, 'workunits', 'current', 'legacy-pending.json'))).toBe(true);

    vi.restoreAllMocks();
    store = new WorkUnitStore(createFileStoreCore(root));
    expect(await store.createSnapshotGuarded(snapshot('never'), () => false)).toBe(false);
    expect(fs.existsSync(path.join(root, 'workunits', 'current', 'legacy-pending.json'))).toBe(false);
    const folded = parseWorkUnitIndexContent(fs.readFileSync(path.join(root, 'workunits', 'index.json'), 'utf8'));
    const recovered = JSON.parse(fs.readFileSync(projectionPath, 'utf8'));
    expect(recovered.snapshot).toEqual(folded[0]);
    expect(recovered.snapshot.metadata).toBe('{"count":1}');
    expect(fs.existsSync(path.join(root, 'workunits', 'events.jsonl'))).toBe(false);
  });

  it('legacy remove 在 index 后/projection 前崩溃：pending 驱动清除投影且不复活、零 events', async () => {
    const core = createFileStoreCore(root);
    store = new WorkUnitStore(core);
    await store.upsertSnapshot(snapshot('wu-1'));
    await store.upsertSnapshot(snapshot('wu-2'));
    const projectionPath = path.join(root, 'workunits', 'current', workUnitProjectionFileName('wu-1'));
    const unlink = fs.promises.unlink.bind(fs.promises);
    vi.spyOn(fs.promises, 'unlink').mockImplementation(async file => {
      if (path.resolve(String(file)) === projectionPath) throw new Error('crash after legacy tombstone');
      return unlink(file);
    });
    await expect(store.removeSnapshot('wu-1')).rejects.toThrow('crash after legacy tombstone');

    vi.restoreAllMocks();
    store = new WorkUnitStore(createFileStoreCore(root));
    expect(await store.createSnapshotGuarded(snapshot('never'), () => false)).toBe(false);
    const folded = parseWorkUnitIndexContent(fs.readFileSync(path.join(root, 'workunits', 'index.json'), 'utf8'));
    expect(folded.map(row => row.id)).toEqual(['wu-2']);
    expect(fs.existsSync(projectionPath)).toBe(false);
    const remaining = JSON.parse(fs.readFileSync(path.join(root, 'workunits', 'current', workUnitProjectionFileName('wu-2')), 'utf8'));
    expect(remaining.snapshot).toEqual(folded[0]);
    expect(fs.existsSync(path.join(root, 'workunits', 'events.jsonl'))).toBe(false);
  });

  it('guarded create 遇到缺失 projection 先重建，guard 不把缺失误判为可创建', async () => {
    const existing = snapshot('child-1', { parentId: 'p1', type: 'review' });
    await store.commitSnapshot(event('created', existing), existing);
    fs.unlinkSync(path.join(root, 'workunits', 'current', workUnitProjectionFileName(existing.id)));
    const candidate = snapshot('child-2', { parentId: 'p1', type: 'review' });

    const created = await store.createSnapshotGuarded(candidate, snapshots =>
      !snapshots.some(row => row.parentId === 'p1' && row.status !== 'done' && row.status !== 'closed'));

    expect(created).toBe(false);
    const events = fs.readFileSync(path.join(root, 'workunits', 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as WorkUnitEvent);
    expect(events.filter(row => row.wuId === candidate.id)).toEqual([]);
    expect((await store.getIndex()).map(row => row.id)).toEqual(['child-1']);
  });

  it.each(['legacy', 'event'] as const)('%s finalize 并行写：reject 前等待另一写完成，之后无锁外晚写', async mode => {
    const core = createFileStoreCore(root);
    store = new WorkUnitStore(core);
    const initial = snapshot('wu-1', { metadata: '{"count":0}' });
    if (mode === 'legacy') await store.upsertSnapshot(initial);
    else await store.commitSnapshot(event('created', initial), initial);
    const projectionPath = path.join(root, 'workunits', 'current', workUnitProjectionFileName('wu-1'));
    const headPath = path.join(root, 'workunits', 'current', 'heads', workUnitProjectionFileName('wu-1'));
    const gate = deferred();
    const headStarted = deferred();
    const completed = new Set<string>();
    const writeJson = core.io.writeJson.bind(core.io);
    vi.spyOn(core.io, 'writeJson').mockImplementation(async (file, data, sync) => {
      const resolved = path.resolve(String(file));
      if (resolved === projectionPath) throw new Error('projection failed');
      if (resolved === headPath) {
        headStarted.resolve();
        await gate.promise;
        const result = await writeJson(file, data, sync);
        completed.add(resolved);
        return result;
      }
      return writeJson(file, data, sync);
    });
    const next = snapshot('wu-1', { metadata: '{"count":1}' });
    const operation = mode === 'legacy'
      ? store.upsertSnapshot(next)
      : store.commitSnapshot(event('updated', next), next);
    let outcome: string | null = null;
    void operation.catch(error => { outcome = error instanceof Error ? error.message : String(error); });

    await headStarted.promise;
    await delay(20);
    expect(outcome).toBeNull();
    gate.resolve();
    await expect(operation).rejects.toThrow('projection failed');
    expect(completed).toContain(headPath);
    const completedAtReject = new Set(completed);
    await delay(20);
    expect(completed).toEqual(completedAtReject);
  });

  it('pending replace 并行写：一批中一写失败也等待其余写 settled 后放锁', async () => {
    await store.upsertSnapshot(snapshot('wu-1'));
    await store.upsertSnapshot(snapshot('wu-2'));
    fs.writeFileSync(path.join(root, 'workunits', 'current', 'legacy-pending.json'), '{"version":1}');
    const core = createFileStoreCore(root);
    store = new WorkUnitStore(core);
    const failedProjection = path.join(root, 'workunits', 'current', workUnitProjectionFileName('wu-1'));
    const delayedProjection = path.join(root, 'workunits', 'current', workUnitProjectionFileName('wu-2'));
    const delayedHead = path.join(root, 'workunits', 'current', 'heads', workUnitProjectionFileName('wu-2'));
    const gate = deferred();
    const delayedStarted = deferred();
    const completed = new Set<string>();
    const writeJson = core.io.writeJson.bind(core.io);
    vi.spyOn(core.io, 'writeJson').mockImplementation(async (file, data, sync) => {
      const resolved = path.resolve(String(file));
      if (resolved === failedProjection) throw new Error('replace projection failed');
      if (resolved === delayedProjection) {
        delayedStarted.resolve();
        await gate.promise;
      }
      const result = await writeJson(file, data, sync);
      if (resolved === delayedProjection || resolved === delayedHead) completed.add(resolved);
      return result;
    });
    const operation = store.rebuildIndex();
    let outcome: string | null = null;
    void operation.catch(error => { outcome = error instanceof Error ? error.message : String(error); });

    await delayedStarted.promise;
    await delay(20);
    expect(outcome).toBeNull();
    gate.resolve();
    await expect(operation).rejects.toThrow('replace projection failed');
    expect(completed).toEqual(new Set([delayedProjection, delayedHead]));
    const completedAtReject = new Set(completed);
    await delay(20);
    expect(completed).toEqual(completedAtReject);
  });

  it('guard 拒绝零事件，delete 后 projection 不复活', async () => {
    const initial = snapshot('wu-1');
    await store.commitSnapshot(event('created', initial), initial);
    const eventsPath = path.join(root, 'workunits', 'events.jsonl');
    const before = fs.readFileSync(eventsPath, 'utf8');
    const rejected = await store.createSnapshotGuarded(snapshot('wu-2'), () => false);
    expect(rejected).toBe(false);
    expect(fs.readFileSync(eventsPath, 'utf8')).toBe(before);

    await store.commitRemoval({ type: 'closed', wuId: 'wu-1', timestamp: new Date().toISOString(), data: { deleted: true } }, 'wu-1');
    expect(await store.updateMetadata('wu-1', current => current)).toBeNull();
    expect(await store.rebuildIndex()).toEqual([]);
    expect(fs.existsSync(path.join(root, 'workunits', 'current', workUnitProjectionFileName('wu-1')))).toBe(false);
  });
});
