/**
 * FileStoreWorkUnitBase 直接单元测试（不经门面 file-store.ts）
 *
 * 覆盖：events.jsonl 事件溯源（appendEvent → rebuildIndex → getIndex 一致）、
 * readIndexFile 损坏语义、claimWorkUnit（flock 互斥 + timeoutAt 语义）、
 * upsertSnapshot/removeSnapshot 与索引同步。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStoreWorkUnitBase } from '../file-store-workunit';
import type { WorkUnitEvent, WorkUnitSnapshot } from '../file-store-types';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'filestore-wu-test-'));
}

function makeWuSnapshot(id: string, overrides?: Partial<WorkUnitSnapshot>): WorkUnitSnapshot {
  const now = new Date().toISOString();
  return {
    id,
    parentId: null,
    type: 'task',
    scope: `scope-${id}`,
    assigneeId: null,
    status: 'unassigned',
    failureType: null,
    retryCount: 0,
    timeoutAt: null,
    channelId: null,
    projectPath: null,
    metadata: null,
    createdAt: now,
    updatedAt: now,
    claimedAt: null,
    completedAt: null,
    ...overrides,
  };
}

function createdEvent(snap: WorkUnitSnapshot): WorkUnitEvent {
  return {
    type: 'created',
    wuId: snap.id,
    timestamp: new Date().toISOString(),
    data: snap as unknown as Record<string, unknown>,
  };
}

describe('FileStoreWorkUnitBase（直接单元测试）', () => {
  let tmpDir: string;
  let store: FileStoreWorkUnitBase;

  beforeEach(() => {
    tmpDir = createTempDir();
    store = new FileStoreWorkUnitBase(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const eventsPath = () => path.join(tmpDir, 'workunits', 'events.jsonl');
  const indexPath = () => path.join(tmpDir, 'workunits', 'index.json');

  function writeTornIndex(content = '[{"id":"wu1",'): string {
    fs.mkdirSync(path.dirname(indexPath()), { recursive: true });
    fs.writeFileSync(indexPath(), content);
    return content;
  }

  /** 标准建单元路径：append created 事件 + 重建索引（与 service 层流程一致） */
  async function seedWu(snap: WorkUnitSnapshot): Promise<void> {
    await store.appendEvent(createdEvent(snap));
    await store.rebuildIndex();
  }

  // ═══ appendEvent / getIndex ═══

  describe('appendEvent / getIndex', () => {
    it('appendEvent 以 JSONL 追加事件（每行一个 JSON）', async () => {
      await store.appendEvent(createdEvent(makeWuSnapshot('wu1')));
      await store.appendEvent(createdEvent(makeWuSnapshot('wu2')));
      const lines = fs.readFileSync(eventsPath(), 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]).type).toBe('created');
      expect(JSON.parse(lines[0]).wuId).toBe('wu1');
      expect(JSON.parse(lines[1]).wuId).toBe('wu2');
    });

    it('getIndex 只读 index.json：仅 append 事件未重建时返回空数组', async () => {
      await store.appendEvent(createdEvent(makeWuSnapshot('wu1')));
      expect(await store.getIndex()).toEqual([]);
    });

    it('appendEvent + rebuildIndex 后 getIndex 与事件一致', async () => {
      const wu1 = makeWuSnapshot('wu1');
      const wu2 = makeWuSnapshot('wu2', { type: 'bug' });
      await store.appendEvent(createdEvent(wu1));
      await store.appendEvent(createdEvent(wu2));
      await store.rebuildIndex();

      const index = await store.getIndex();
      expect(index).toHaveLength(2);
      expect(index.find(s => s.id === 'wu1')).toEqual(wu1);
      expect(index.find(s => s.id === 'wu2')?.type).toBe('bug');
    });

    it('getIndex 支持 status/type/assigneeId/channelId 过滤', async () => {
      await store.upsertSnapshot(makeWuSnapshot('wu1', { status: 'active', assigneeId: 'a1', channelId: 'ch1' }));
      await store.upsertSnapshot(makeWuSnapshot('wu2', { status: 'unassigned', type: 'bug' }));

      expect((await store.getIndex({ status: 'active' })).map(s => s.id)).toEqual(['wu1']);
      expect((await store.getIndex({ type: 'bug' })).map(s => s.id)).toEqual(['wu2']);
      expect((await store.getIndex({ assigneeId: 'a1' })).map(s => s.id)).toEqual(['wu1']);
      expect((await store.getIndex({ channelId: 'ch1' })).map(s => s.id)).toEqual(['wu1']);
      expect(await store.getIndex({ status: 'active', channelId: 'ch2' })).toEqual([]);
    });

    it('index.json 撕裂 → getIndex 抛出带路径的错误（不静默当空）', async () => {
      writeTornIndex();
      await expect(store.getIndex()).rejects.toThrow(indexPath());
    });

    it('index.json 内容不是数组 → getIndex 同样抛错', async () => {
      writeTornIndex('{"not":"an array"}');
      await expect(store.getIndex()).rejects.toThrow(indexPath());
    });
  });

  // ═══ rebuildIndex ═══

  describe('rebuildIndex', () => {
    it('从事件重建并写回 index.json（文件内容与返回值一致）', async () => {
      await store.appendEvent(createdEvent(makeWuSnapshot('wu1')));
      await store.appendEvent(createdEvent(makeWuSnapshot('wu2')));

      const rebuilt = await store.rebuildIndex();
      expect(rebuilt).toHaveLength(2);
      const onDisk = JSON.parse(fs.readFileSync(indexPath(), 'utf-8'));
      expect(onDisk).toEqual(rebuilt);
    });

    it('按事件顺序合并部分更新，保留未触及字段（timeoutAt/scope）', async () => {
      const timeoutAt = new Date(Date.now() + 3600_000).toISOString();
      await store.appendEvent(createdEvent(makeWuSnapshot('wu1', { timeoutAt, retryCount: 1 })));
      await store.appendEvent({
        type: 'claimed',
        wuId: 'wu1',
        timestamp: new Date().toISOString(),
        data: { assigneeId: 'a1', status: 'active' },
      });
      await store.appendEvent({
        type: 'updated',
        wuId: 'wu1',
        timestamp: new Date().toISOString(),
        data: { retryCount: 5 },
      });

      const [snap] = await store.rebuildIndex();
      expect(snap.assigneeId).toBe('a1');
      expect(snap.status).toBe('active');
      expect(snap.retryCount).toBe(5); // 后事件覆盖先事件
      expect(snap.timeoutAt).toBe(timeoutAt); // 事件未携带的字段保留
      expect(snap.scope).toBe('scope-wu1');
    });

    it('无 created 的孤儿事件不产生幻影快照', async () => {
      await store.appendEvent({
        type: 'claimed',
        wuId: 'ghost',
        timestamp: new Date().toISOString(),
        data: { assigneeId: 'a1', status: 'active' },
      });
      expect(await store.rebuildIndex()).toEqual([]);
    });

    it('index.json 内容陈旧时以事件流为准重建', async () => {
      await store.appendEvent(createdEvent(makeWuSnapshot('wu1')));
      // 人为写入陈旧 index（合法 JSON 数组但内容错误）
      fs.mkdirSync(path.dirname(indexPath()), { recursive: true });
      fs.writeFileSync(indexPath(), JSON.stringify([makeWuSnapshot('stale', { status: 'closed' })]));

      const rebuilt = await store.rebuildIndex();
      expect(rebuilt.map(s => s.id)).toEqual(['wu1']);
      expect((await store.getIndex()).map(s => s.id)).toEqual(['wu1']);
    });

    it('rebuildIndex 支持过滤返回，但写回完整索引', async () => {
      await store.appendEvent(createdEvent(makeWuSnapshot('wu1', { status: 'active' })));
      await store.appendEvent(createdEvent(makeWuSnapshot('wu2', { status: 'unassigned' })));

      const filtered = await store.rebuildIndex({ status: 'active' });
      expect(filtered.map(s => s.id)).toEqual(['wu1']);
      const onDisk = JSON.parse(fs.readFileSync(indexPath(), 'utf-8')) as WorkUnitSnapshot[];
      expect(onDisk).toHaveLength(2); // 过滤只影响返回值，不影响落盘
    });

    it('无事件时重建为空索引', async () => {
      expect(await store.rebuildIndex()).toEqual([]);
      expect(JSON.parse(fs.readFileSync(indexPath(), 'utf-8'))).toEqual([]);
    });
  });

  // ═══ claimWorkUnit ═══

  describe('claimWorkUnit', () => {
    it('claim unassigned 成功并同步索引快照', async () => {
      const original = makeWuSnapshot('wu1');
      await seedWu(original);

      const ok = await store.claimWorkUnit('wu1', 'agent1');
      expect(ok).toBe(true);

      const [wu] = await store.getIndex();
      expect(wu.status).toBe('active');
      expect(wu.assigneeId).toBe('agent1');
      expect(wu.claimedAt).not.toBeNull();
      expect(wu.updatedAt).toBe(wu.claimedAt); // claim 写入同一 timestamp
      expect(wu.createdAt).toBe(original.createdAt); // claim 不动 createdAt
    });

    it('claim 成功追加 claimed 事件，rebuild 后与索引一致', async () => {
      await seedWu(makeWuSnapshot('wu1'));
      await store.claimWorkUnit('wu1', 'agent1');

      const events = await store.readJsonl<WorkUnitEvent>(eventsPath());
      const claimed = events.filter(e => e.type === 'claimed');
      expect(claimed).toHaveLength(1);
      expect(claimed[0].wuId).toBe('wu1');
      expect(claimed[0].data).toMatchObject({ assigneeId: 'agent1', status: 'active' });

      // 事件流重建结论与索引相同 → 事件与索引同步
      const rebuilt = await store.rebuildIndex();
      expect(rebuilt).toHaveLength(1);
      expect(rebuilt[0].status).toBe('active');
      expect(rebuilt[0].assigneeId).toBe('agent1');
    });

    it('重复 claim 返回 false（已被认领）', async () => {
      await seedWu(makeWuSnapshot('wu1'));
      expect(await store.claimWorkUnit('wu1', 'agent1')).toBe(true);
      expect(await store.claimWorkUnit('wu1', 'agent2')).toBe(false);

      // 第二次 claim 未产生多余事件、未改写归属
      const events = await store.readJsonl<WorkUnitEvent>(eventsPath());
      expect(events.filter(e => e.type === 'claimed')).toHaveLength(1);
      const [wu] = await store.getIndex();
      expect(wu.assigneeId).toBe('agent1');
    });

    it('claim 不存在的 wuId 返回 false', async () => {
      expect(await store.claimWorkUnit('nonexistent', 'agent1')).toBe(false);
    });

    it('并发 claim 同一 WU 仅一个成功（flock 互斥）', async () => {
      await seedWu(makeWuSnapshot('wu1'));
      const results = await Promise.all([
        store.claimWorkUnit('wu1', 'agent1'),
        store.claimWorkUnit('wu1', 'agent2'),
      ]);
      expect(results.filter(r => r)).toHaveLength(1);

      const [wu] = await store.getIndex();
      expect(wu.status).toBe('active');
      expect(['agent1', 'agent2']).toContain(wu.assigneeId);
    });

    it('timeoutAt 语义：store 层只按 status 门禁，claim 保留原 timeoutAt', async () => {
      // 超时拦截在 service 层（timeout-release 释放回 unassigned 后清 timeoutAt）；
      // store 层 claimWorkUnit 不读 timeoutAt，且不改写它。
      const timeoutAt = new Date(Date.now() - 60_000).toISOString(); // 已过期
      await seedWu(makeWuSnapshot('wu1', { timeoutAt }));

      const ok = await store.claimWorkUnit('wu1', 'agent1');
      expect(ok).toBe(true); // 过期 timeoutAt 不阻断 claim（status=unassigned 即可）

      const [wu] = await store.getIndex();
      expect(wu.status).toBe('active');
      expect(wu.timeoutAt).toBe(timeoutAt); // claim 不重写 timeoutAt（由 service 层负责）
    });

    it('撕裂 index → claim 抛错而非幻影 false', async () => {
      writeTornIndex();
      await expect(store.claimWorkUnit('wu1', 'agent1')).rejects.toThrow(indexPath());
    });
  });

  // ═══ upsertSnapshot / removeSnapshot ═══

  describe('upsertSnapshot / removeSnapshot', () => {
    it('upsert 插入新快照并立即对 getIndex 可见（索引同步）', async () => {
      await store.upsertSnapshot(makeWuSnapshot('wu1'));
      const index = await store.getIndex();
      expect(index).toHaveLength(1);
      expect(index[0].id).toBe('wu1');
    });

    it('upsert 同 id 整体替换既有快照', async () => {
      await store.upsertSnapshot(makeWuSnapshot('wu1', { scope: 'old' }));
      await store.upsertSnapshot(makeWuSnapshot('wu1', { scope: 'new', status: 'active' }));

      const index = await store.getIndex();
      expect(index).toHaveLength(1);
      expect(index[0].scope).toBe('new');
      expect(index[0].status).toBe('active');
    });

    it('upsert 只写 index.json，不产生事件', async () => {
      await store.upsertSnapshot(makeWuSnapshot('wu1'));
      expect(fs.existsSync(eventsPath())).toBe(false);
    });

    it('remove 删除既有快照并同步索引', async () => {
      await store.upsertSnapshot(makeWuSnapshot('wu1'));
      await store.upsertSnapshot(makeWuSnapshot('wu2'));
      await store.removeSnapshot('wu1');
      expect((await store.getIndex()).map(s => s.id)).toEqual(['wu2']);
    });

    it('remove 不存在的 id 为 no-op（不抛错、不动其他快照）', async () => {
      await store.upsertSnapshot(makeWuSnapshot('wu1'));
      await store.removeSnapshot('nope');
      expect(await store.getIndex()).toHaveLength(1);
    });

    it('index 不存在时 remove 为 no-op 且不创建文件', async () => {
      await store.removeSnapshot('wu1');
      expect(fs.existsSync(indexPath())).toBe(false);
    });

    it('并发 upsert 30 个不同 id 全部保留（flock 不丢更新）', async () => {
      await Promise.all(Array.from({ length: 30 }, (_, i) =>
        store.upsertSnapshot(makeWuSnapshot(`c-${i}`))));
      const ids = (await store.getIndex()).map(s => s.id);
      expect(ids).toHaveLength(30);
      expect(new Set(ids).size).toBe(30);
    });

    it('并发 upsert 与 remove 混合不丢数据', async () => {
      for (let i = 0; i < 10; i++) await store.upsertSnapshot(makeWuSnapshot(`keep-${i}`));
      await Promise.all([
        ...Array.from({ length: 10 }, (_, i) => store.upsertSnapshot(makeWuSnapshot(`new-${i}`))),
        ...Array.from({ length: 5 }, (_, i) => store.removeSnapshot(`keep-${i}`)),
      ]);
      const ids = (await store.getIndex()).map(s => s.id);
      expect(ids).toHaveLength(15);
      for (let i = 5; i < 10; i++) expect(ids).toContain(`keep-${i}`);
      for (let i = 0; i < 10; i++) expect(ids).toContain(`new-${i}`);
    });

    it('撕裂 index → upsert 抛错且不覆盖原文件', async () => {
      const torn = writeTornIndex();
      await expect(store.upsertSnapshot(makeWuSnapshot('wu-x'))).rejects.toThrow('index.json');
      // 不允许基于空数组回写把撕裂文件"洗白"
      expect(fs.readFileSync(indexPath(), 'utf-8')).toBe(torn);
    });

    it('撕裂 index → remove 抛错', async () => {
      writeTornIndex();
      await expect(store.removeSnapshot('wu1')).rejects.toThrow('index.json');
    });
  });

  // ═══ updateMetadata（#170 / 决策 #65-1：锁内字段级合并写）═══

  describe('updateMetadata', () => {
    it('锁内读最新 metadata → 应用 mutator → appendEvent + upsertSnapshot 一次落盘', async () => {
      await seedWu(makeWuSnapshot('wu1', { metadata: JSON.stringify({ stepCount: 1 }) }));

      const updated = await store.updateMetadata('wu1', cur => ({
        ...cur,
        stepCount: (cur.stepCount as number) + 1,
        tag: 'x',
      }));

      expect(updated).not.toBeNull();
      expect(JSON.parse(updated!.metadata!)).toMatchObject({ stepCount: 2, tag: 'x' });

      // 成对写：事件流与索引同步（rebuild 结论与 index 一致）
      const events = await store.readJsonl<WorkUnitEvent>(eventsPath());
      expect(events.filter(e => e.type === 'updated' && e.wuId === 'wu1')).toHaveLength(1);
      const rebuilt = await store.rebuildIndex();
      expect(JSON.parse(rebuilt[0].metadata!).stepCount).toBe(2);
    });

    it('不存在的 wuId 返回 null（不抛错、不产生事件）', async () => {
      await seedWu(makeWuSnapshot('wu1'));
      const result = await store.updateMetadata('nope', cur => cur);
      expect(result).toBeNull();
      const events = await store.readJsonl<WorkUnitEvent>(eventsPath());
      expect(events.filter(e => e.wuId === 'nope')).toHaveLength(0);
    });

    it('metadata 为 null / 损坏 JSON 时按 {} 起评（与 parseWuMetadata 同口径）', async () => {
      await seedWu(makeWuSnapshot('wu1', { metadata: '{broken' }));
      const updated = await store.updateMetadata('wu1', cur => ({ ...cur, a: 1 }));
      expect(JSON.parse(updated!.metadata!)).toEqual({ a: 1 });
    });

    it('mutator 返回的 undefined 值键在序列化时丢弃（清除语义）', async () => {
      await seedWu(makeWuSnapshot('wu1', { metadata: JSON.stringify({ blockReason: 'stuck', keep: 1 }) }));
      const updated = await store.updateMetadata('wu1', cur => ({ ...cur, blockReason: undefined }));
      const meta = JSON.parse(updated!.metadata!);
      expect('blockReason' in meta).toBe(false);
      expect(meta.keep).toBe(1);
    });

    it('并发 30 个增量 mutator 不丢更新（计数 + 数组尾部追加）', async () => {
      await seedWu(makeWuSnapshot('wu1', { metadata: JSON.stringify({ count: 0, log: [] as string[] }) }));

      await Promise.all(Array.from({ length: 30 }, (_, i) =>
        store.updateMetadata('wu1', cur => ({
          ...cur,
          count: (cur.count as number) + 1,
          log: [...(cur.log as string[]), `r${i}`],
        })),
      ));

      const [wu] = await store.getIndex();
      const meta = JSON.parse(wu.metadata!);
      expect(meta.count).toBe(30);
      expect(meta.log).toHaveLength(30);
      expect(new Set(meta.log as string[]).size).toBe(30);
    });

    it('并发 updateMetadata 与 upsertSnapshot 混合不丢数据（同一把 flock）', async () => {
      await seedWu(makeWuSnapshot('wu1', { metadata: JSON.stringify({ count: 0 }) }));
      await Promise.all([
        ...Array.from({ length: 10 }, () =>
          store.updateMetadata('wu1', cur => ({ ...cur, count: (cur.count as number) + 1 }))),
        ...Array.from({ length: 5 }, (_, i) => store.upsertSnapshot(makeWuSnapshot(`other-${i}`))),
      ]);
      const index = await store.getIndex();
      const wu1 = index.find(s => s.id === 'wu1')!;
      expect(JSON.parse(wu1.metadata!).count).toBe(10);
      expect(index.filter(s => s.id.startsWith('other-'))).toHaveLength(5);
    });

    it('缺省 bump updatedAt（既有语义不变）', async () => {
      const staleIso = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
      await seedWu(makeWuSnapshot('wu1', { updatedAt: staleIso }));

      const updated = await store.updateMetadata('wu1', cur => ({ ...cur, tag: 'x' }));

      expect(updated!.updatedAt).not.toBe(staleIso);
      const [wu] = await store.getIndex();
      expect(wu.updatedAt).not.toBe(staleIso);
    });

    // #221（#214 决议）：认领陈旧守卫的标记写不能刷新 updatedAt——否则守卫自己复活僵尸
    it('touchUpdatedAt:false 保留 updatedAt（标记写不复活沉睡 WU）', async () => {
      const staleIso = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
      await seedWu(makeWuSnapshot('wu1', { updatedAt: staleIso }));

      const updated = await store.updateMetadata(
        'wu1',
        cur => ({ ...cur, staleGuardBlockedAt: staleIso }),
        { touchUpdatedAt: false },
      );

      expect(updated!.updatedAt).toBe(staleIso);
      expect(JSON.parse(updated!.metadata!).staleGuardBlockedAt).toBe(staleIso);
      // 索引落盘值同样保留
      const [wu] = await store.getIndex();
      expect(wu.updatedAt).toBe(staleIso);
      expect(JSON.parse(wu.metadata!).staleGuardBlockedAt).toBe(staleIso);
    });
  });

  // ═══ commitSnapshot / commitRemoval（#170 / 决策 #65-3：锁内成对写）═══

  describe('commitSnapshot / commitRemoval', () => {
    it('commitSnapshot 同锁成对：事件流与索引同步可见', async () => {
      const snap = makeWuSnapshot('wu1');
      await store.commitSnapshot(createdEvent(snap), snap);

      const events = await store.readJsonl<WorkUnitEvent>(eventsPath());
      expect(events).toHaveLength(1);
      expect((await store.getIndex()).map(s => s.id)).toEqual(['wu1']);
      // 对账口径一致（无需重建）
      const recon = await store.reconcileIndex();
      expect(recon.consistent).toBe(true);
    });

    it('并发 commitSnapshot 20 个不同 id 全部保留', async () => {
      await Promise.all(Array.from({ length: 20 }, (_, i) => {
        const snap = makeWuSnapshot(`p-${i}`);
        return store.commitSnapshot(createdEvent(snap), snap);
      }));
      expect(await store.getIndex()).toHaveLength(20);
      expect(await store.readJsonl<WorkUnitEvent>(eventsPath())).toHaveLength(20);
    });

    it('commitRemoval 同锁成对：墓碑事件 + 索引移除，rebuild 不复活', async () => {
      await seedWu(makeWuSnapshot('wu1'));
      await store.commitRemoval({
        type: 'closed',
        wuId: 'wu1',
        timestamp: new Date().toISOString(),
        data: { deleted: true },
      }, 'wu1');

      expect(await store.getIndex()).toEqual([]);
      // 墓碑事件落盘，rebuild 尊重墓碑（deleted 标记）不复活已删 WU
      const rebuilt = await store.rebuildIndex();
      expect(rebuilt).toEqual([]);
      const recon = await store.reconcileIndex();
      expect(recon.consistent).toBe(true);
    });

    it('commitRemoval 不存在的 id 仍落墓碑事件（幂等，索引无变化）', async () => {
      await seedWu(makeWuSnapshot('wu1'));
      await store.commitRemoval({
        type: 'closed',
        wuId: 'ghost',
        timestamp: new Date().toISOString(),
        data: { deleted: true },
      }, 'ghost');
      expect((await store.getIndex()).map(s => s.id)).toEqual(['wu1']);
      expect(await store.reconcileIndex()).toMatchObject({ consistent: true });
    });
  });

  // ═══ createSnapshotGuarded（#170 / 决策 #65-2：锁内 check-then-create）═══

  describe('createSnapshotGuarded', () => {
    const noChildGuard = (parentId: string) => (snapshots: WorkUnitSnapshot[]) =>
      !snapshots.some(s => s.parentId === parentId && s.status !== 'done' && s.status !== 'closed');

    it('guard 通过 → 建单（事件 + 索引成对），返回 true', async () => {
      const snap = makeWuSnapshot('child-1', { parentId: 'p1', type: 'review' });
      const ok = await store.createSnapshotGuarded(snap, noChildGuard('p1'));
      expect(ok).toBe(true);
      expect((await store.getIndex()).map(s => s.id)).toEqual(['child-1']);
      const events = await store.readJsonl<WorkUnitEvent>(eventsPath());
      expect(events.filter(e => e.type === 'created' && e.wuId === 'child-1')).toHaveLength(1);
    });

    it('guard 拒绝 → 返回 false，不落事件也不落索引', async () => {
      await seedWu(makeWuSnapshot('existing', { parentId: 'p1', type: 'review' }));
      const snap = makeWuSnapshot('child-2', { parentId: 'p1', type: 'review' });
      const ok = await store.createSnapshotGuarded(snap, noChildGuard('p1'));
      expect(ok).toBe(false);
      expect((await store.getIndex()).map(s => s.id)).toEqual(['existing']);
      const events = await store.readJsonl<WorkUnitEvent>(eventsPath());
      expect(events.filter(e => e.wuId === 'child-2')).toHaveLength(0);
    });

    it('并发 guarded create 同一守卫仅一个成功（flock 互斥 check-then-create）', async () => {
      const results = await Promise.all(Array.from({ length: 8 }, (_, i) =>
        store.createSnapshotGuarded(makeWuSnapshot(`child-${i}`, { parentId: 'p1', type: 'review' }), noChildGuard('p1')),
      ));
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await store.getIndex()).toHaveLength(1);
    });
  });

  // ═══ reconcileIndex（#170 / 决策 #65-3：启动对账）═══

  describe('reconcileIndex', () => {
    it('事件与索引一致 → consistent: true，不重建（index.json 内容不变）', async () => {
      await seedWu(makeWuSnapshot('wu1'));
      await store.claimWorkUnit('wu1', 'agent1');
      const before = fs.readFileSync(indexPath(), 'utf-8');

      const recon = await store.reconcileIndex();
      expect(recon).toMatchObject({ consistent: true, rebuilt: false, missingInIndex: 0, staleInIndex: 0, diverged: 0 });
      expect(fs.readFileSync(indexPath(), 'utf-8')).toBe(before);
    });

    it('索引缺条目（崩溃分叉）→ 重建补回并报告 missingInIndex', async () => {
      await seedWu(makeWuSnapshot('wu1'));
      await seedWu(makeWuSnapshot('wu2'));
      // 人为制造分叉：index 抹掉 wu2（模拟 upsert 前崩溃）
      await store.writeJson(indexPath(), [makeWuSnapshot('wu1')]);

      const recon = await store.reconcileIndex();
      expect(recon).toMatchObject({ consistent: false, rebuilt: true, missingInIndex: 1 });
      expect((await store.getIndex()).map(s => s.id).sort()).toEqual(['wu1', 'wu2']);
    });

    it('索引内容陈旧（同 id 字段不一致）→ 以事件流为准重建', async () => {
      await seedWu(makeWuSnapshot('wu1', { scope: 'real' }));
      await store.writeJson(indexPath(), [makeWuSnapshot('wu1', { scope: 'stale' })]);

      const recon = await store.reconcileIndex();
      expect(recon).toMatchObject({ consistent: false, rebuilt: true, diverged: 1 });
      expect((await store.getIndex())[0].scope).toBe('real');
    });

    it('索引多出条目（事件流无）→ 重建清除并报告 staleInIndex', async () => {
      await seedWu(makeWuSnapshot('wu1'));
      await store.writeJson(indexPath(), [makeWuSnapshot('wu1'), makeWuSnapshot('phantom')]);

      const recon = await store.reconcileIndex();
      expect(recon).toMatchObject({ consistent: false, rebuilt: true, staleInIndex: 1 });
      expect((await store.getIndex()).map(s => s.id)).toEqual(['wu1']);
    });

    it('空数据区（无事件无索引）→ consistent: true', async () => {
      const recon = await store.reconcileIndex();
      expect(recon).toMatchObject({ consistent: true, rebuilt: false });
    });
  });

  // ═══ rebuildIndex 墓碑语义（#170：deleted 标记的 closed 事件 = 删除）═══

  describe('rebuildIndex 墓碑', () => {
    it('data.deleted=true 的 closed 事件使快照从重建结果中移除', async () => {
      await store.appendEvent(createdEvent(makeWuSnapshot('wu1')));
      await store.appendEvent({
        type: 'closed',
        wuId: 'wu1',
        timestamp: new Date().toISOString(),
        data: { deleted: true },
      });
      expect(await store.rebuildIndex()).toEqual([]);
    });

    it('无 deleted 标记的 closed 事件维持原合并语义（不删快照）', async () => {
      await store.appendEvent(createdEvent(makeWuSnapshot('wu1')));
      await store.appendEvent({
        type: 'closed',
        wuId: 'wu1',
        timestamp: new Date().toISOString(),
        data: { status: 'closed' },
      });
      const rebuilt = await store.rebuildIndex();
      expect(rebuilt).toHaveLength(1);
      expect(rebuilt[0].status).toBe('closed');
    });
  });

  // ═══ #314（D2）：租约心跳缓冲 + 定期合并落盘 ═══

  describe('租约心跳缓冲与合并落盘（#314）', () => {
    const claimedAt = new Date().toISOString();
    const initialTimeout = new Date(Date.now() + 5 * 60_000).toISOString();

    /** 建一个 active 持有中 WU（直接 upsert，绕过 claim 流程） */
    async function seedClaimed(id = 'wu1'): Promise<WorkUnitSnapshot> {
      const snap = makeWuSnapshot(id, {
        status: 'active', assigneeId: 'inst-1', claimedAt, timeoutAt: initialTimeout,
      });
      await store.upsertSnapshot(snap);
      return snap;
    }

    function readDiskIndex(): WorkUnitSnapshot[] {
      return JSON.parse(fs.readFileSync(indexPath(), 'utf-8')) as WorkUnitSnapshot[];
    }

    function readEvents(): WorkUnitEvent[] {
      if (!fs.existsSync(eventsPath())) return [];
      return fs.readFileSync(eventsPath(), 'utf-8').trim().split('\n')
        .filter(l => l.length > 0)
        .map(l => JSON.parse(l) as WorkUnitEvent);
    }

    it('refresh 返回 ok 但只写内存：flush 前磁盘 timeoutAt/updatedAt 不变', async () => {
      const seeded = await seedClaimed();
      const next = new Date(Date.now() + 5 * 60_000);

      const result = await store.refreshWorkUnitLease('wu1', 'inst-1', claimedAt, next);

      expect(result).toBe('ok');
      const disk = readDiskIndex()[0];
      expect(disk.timeoutAt).toBe(initialTimeout); // 未落盘
      expect(disk.updatedAt).toBe(seeded.updatedAt);

      await store.flushWorkUnitLeases();
      const after = readDiskIndex()[0];
      expect(after.timeoutAt).toBe(next.toISOString());
      expect(after.assigneeId).toBe('inst-1'); // 其余字段不动
      expect(after.claimedAt).toBe(claimedAt);
    });

    it('落盘窗口内多跳只落一次盘、只记一条增量 updated 事件', async () => {
      await seedClaimed();
      const t1 = new Date(Date.now() + 5 * 60_000);
      const t2 = new Date(Date.now() + 5 * 60_000 + 30_000);

      await store.refreshWorkUnitLease('wu1', 'inst-1', claimedAt, t1);
      await store.refreshWorkUnitLease('wu1', 'inst-1', claimedAt, t2);
      await store.flushWorkUnitLeases();

      const leaseEvents = readEvents().filter(e => e.type === 'updated' && e.wuId === 'wu1');
      expect(leaseEvents).toHaveLength(1);
      expect(leaseEvents[0].data).toEqual({ timeoutAt: t2.toISOString(), updatedAt: expect.any(String) });
      expect(readDiskIndex()[0].timeoutAt).toBe(t2.toISOString());
    });

    it('flush 复核 fencing：落盘前易主 → 丢弃 dirty，新 holder 租约不被覆盖', async () => {
      await seedClaimed();
      await store.refreshWorkUnitLease('wu1', 'inst-1', claimedAt, new Date(Date.now() + 999_000));

      // 模拟另一进程：超时释放 → inst-2 重新认领（claimedAt 换代 + 新租约）
      const newClaimedAt = new Date().toISOString();
      const newTimeout = new Date(Date.now() + 5 * 60_000).toISOString();
      await store.upsertSnapshot(makeWuSnapshot('wu1', {
        status: 'active', assigneeId: 'inst-2', claimedAt: newClaimedAt, timeoutAt: newTimeout,
      }));

      const result = await store.flushWorkUnitLeases();

      expect(result).toEqual({ flushed: 0, dropped: 1 });
      const disk = readDiskIndex()[0];
      expect(disk.assigneeId).toBe('inst-2');
      expect(disk.timeoutAt).toBe(newTimeout); // zombie 推前不生效
    });

    it('flush 跳过非 active WU：已完成 WU 的 updatedAt/timeoutAt 不被刷新', async () => {
      const seeded = await seedClaimed();
      await store.refreshWorkUnitLease('wu1', 'inst-1', claimedAt, new Date(Date.now() + 999_000));

      // 持有方完成 WU（fencing 令牌未变，但状态已离开 active）
      await store.upsertSnapshot({ ...seeded, status: 'completed' });

      const result = await store.flushWorkUnitLeases();

      expect(result).toEqual({ flushed: 0, dropped: 1 });
      const disk = readDiskIndex()[0];
      expect(disk.timeoutAt).toBe(initialTimeout);
      expect(disk.updatedAt).toBe(seeded.updatedAt); // 不复活
    });

    it('WU 已删 → flush 丢弃，不复活条目', async () => {
      await seedClaimed();
      await store.refreshWorkUnitLease('wu1', 'inst-1', claimedAt, new Date(Date.now() + 999_000));
      await store.removeSnapshot('wu1');

      const result = await store.flushWorkUnitLeases();

      expect(result).toEqual({ flushed: 0, dropped: 1 });
      expect(readDiskIndex()).toEqual([]);
    });

    it('无 dirty 项时 flush 是 no-op（不写盘）', async () => {
      await seedClaimed();
      const before = fs.readFileSync(indexPath(), 'utf-8');
      const result = await store.flushWorkUnitLeases();
      expect(result).toEqual({ flushed: 0, dropped: 0 });
      expect(fs.readFileSync(indexPath(), 'utf-8')).toBe(before);
    });

    it('leaseFlushIntervalMs: 0 → refresh 当跳即落盘（即时持久化契约）', async () => {
      const immediate = new FileStoreWorkUnitBase(tmpDir, { leaseFlushIntervalMs: 0 });
      await seedClaimed();
      const next = new Date(Date.now() + 5 * 60_000);

      const result = await immediate.refreshWorkUnitLease('wu1', 'inst-1', claimedAt, next);

      expect(result).toBe('ok');
      expect(readDiskIndex()[0].timeoutAt).toBe(next.toISOString()); // 无需显式 flush
    });

    it('快速路 fencing 契约不变：令牌不匹配 lost 一字不写，WU 不存在 missing', async () => {
      await seedClaimed();

      await expect(store.refreshWorkUnitLease(
        'wu1', 'inst-1', '2000-01-01T00:00:00.000Z', new Date(),
      )).resolves.toBe('lost');
      await expect(store.refreshWorkUnitLease(
        'wu1', 'inst-2', claimedAt, new Date(),
      )).resolves.toBe('lost');
      await expect(store.refreshWorkUnitLease(
        'wu-gone', 'inst-1', claimedAt, new Date(),
      )).resolves.toBe('missing');

      await store.flushWorkUnitLeases(); // lost/missing 不产生 dirty 项
      const disk = readDiskIndex()[0];
      expect(disk.timeoutAt).toBe(initialTimeout);
      expect(readEvents().filter(e => e.type === 'updated')).toEqual([]);
    });
  });
});
