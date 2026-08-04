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
});
