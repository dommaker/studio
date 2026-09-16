/**
 * FileStore 热层倒扫快径测试（2026-09-16 channel 性能体检 B4/B5）
 *
 * B4：queryMessagesPage 的 before 锚点在热层时，不再全量 resolveActiveMessages + sort +
 *     findIndex（每页 O(N)），改走 iterateJsonlLinesBackward 倒扫到锚即停；
 *     窗口 createdAt 非严格递减（等 ts 撞车/病态副本交织）回退全量路径保精确。
 * B5：queryMessages 带过滤（workUnitId/authorType/since）+ limit 时走 readMessagesTail
 *     谓词倒扫早停，不再全量读。
 *
 * 断言两个维度：① 结果与旧全量语义逐条等价；② 扫描行数有上界（证明倒扫早停，
 * 而非全量读）——扫描行数经 vi.mock 包装 iterateJsonlLinesBackward 计数。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const scanCounter = vi.hoisted(() => ({ lines: 0 }));
vi.mock('../jsonl-tail', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../jsonl-tail')>();
  return {
    ...mod,
    iterateJsonlLinesBackward: async function* (...args: Parameters<typeof mod.iterateJsonlLinesBackward>) {
      for await (const item of mod.iterateJsonlLinesBackward(...args)) {
        scanCounter.lines++;
        yield item;
      }
    },
  };
});

import { FileStore, type ChannelData, type ChannelMessageData } from '../file-store';

const CH = 'ch-hot';
const BASE_MS = Date.UTC(2026, 0, 1);

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'filestore-hotscan-'));
}

function makeChannel(id: string): ChannelData {
  const now = new Date().toISOString();
  return {
    id,
    name: `channel-${id}`,
    type: 'rnd',
    defaultWorkspaceId: null,
    defaultPath: null,
    discordChannelId: null,
    discordWebhookUrl: null,
    members: '[]',
    createdAt: now,
    updatedAt: now,
  };
}

function makeRow(id: string, createdAtMs: number, opts?: { workUnitId?: string; authorType?: string }): ChannelMessageData {
  return {
    id,
    channelId: CH,
    workUnitId: opts?.workUnitId ?? null,
    authorType: opts?.authorType ?? 'human',
    agentName: null,
    content: `message ${id} content`,
    replyToId: null,
    meta: '{}',
    createdAt: new Date(createdAtMs).toISOString(),
  };
}

/** 直写热文件（绕 appendMessage 的锁/压实计数，数千行种子一次落盘） */
function seedHotFile(tmpDir: string, rows: ChannelMessageData[]): void {
  const file = path.join(tmpDir, 'channels', CH, 'messages.jsonl');
  fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}

/** 3000 行大热文件：m1..m3000，createdAt 严格递增（文件序 = 时间序） */
function seedBigHotFile(tmpDir: string, overrides?: (row: ChannelMessageData, i: number) => ChannelMessageData): ChannelMessageData[] {
  const rows: ChannelMessageData[] = [];
  for (let i = 1; i <= 3000; i++) {
    let row = makeRow(`m${i}`, BASE_MS + i * 1000);
    if (overrides) row = overrides(row, i);
    rows.push(row);
  }
  seedHotFile(tmpDir, rows);
  return rows;
}

describe('FileStore 热层倒扫（2026-09-16 channel 体检 B4/B5）', () => {
  let tmpDir: string;
  let store: FileStore;

  beforeEach(async () => {
    tmpDir = createTempDir();
    store = new FileStore(tmpDir);
    await store.createChannel(makeChannel(CH));
    scanCounter.lines = 0;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('B4：queryMessagesPage before 锚在热层', () => {
    it('锚在热层中部：结果与全量语义逐条一致，倒扫到锚即停（扫描行数有界，不走 readJsonl 全量）', async () => {
      seedBigHotFile(tmpDir);
      const readJsonlSpy = vi.spyOn(store, 'readJsonl');
      scanCounter.lines = 0;

      const page = await store.queryMessagesPage(CH, { before: 'm2501', limit: 50 });

      // 全量语义：升序数组锚点之前 limit 条 = m2451..m2500
      const expected = Array.from({ length: 50 }, (_, k) => `m${2451 + k}`);
      expect(page.messages.map(m => m.id)).toEqual(expected);
      expect(page.hasMore).toBe(true);
      // 倒扫早停：尾部到锚 500 行 + 锚后 limit+1 条，远小于全量 3000 行
      expect(scanCounter.lines).toBeGreaterThan(0);
      expect(scanCounter.lines).toBeLessThanOrEqual(600);
      // 未走全量读口
      expect(readJsonlSpy).not.toHaveBeenCalled();
    });

    it('锚在热层头部（锚前不足一页）：无冷数据时 hasMore=false，结果与全量语义一致', async () => {
      seedBigHotFile(tmpDir);
      const page = await store.queryMessagesPage(CH, { before: 'm20', limit: 50 });
      expect(page.messages.map(m => m.id)).toEqual(Array.from({ length: 19 }, (_, k) => `m${1 + k}`));
      expect(page.hasMore).toBe(false);
    });

    it('锚前不足一页且有冷数据：余量从冷链续（冷热穿透语义不变）', async () => {
      // 热层 m1..m100；冷层 c1..c5（2025-12，更旧）
      const hotRows: ChannelMessageData[] = [];
      for (let i = 1; i <= 100; i++) hotRows.push(makeRow(`m${i}`, BASE_MS + i * 1000));
      seedHotFile(tmpDir, hotRows);
      const archiveDir = path.join(tmpDir, 'channels', CH, 'archive');
      fs.mkdirSync(archiveDir, { recursive: true });
      const coldRows: ChannelMessageData[] = [];
      for (let i = 1; i <= 5; i++) coldRows.push(makeRow(`c${i}`, Date.UTC(2025, 11, 1) + i * 1000));
      fs.writeFileSync(path.join(archiveDir, 'messages-2025-12.jsonl'), coldRows.map(r => JSON.stringify(r)).join('\n') + '\n');

      const page = await store.queryMessagesPage(CH, { before: 'm10', limit: 50 });
      // 全量语义：链上锚点之前 = 热 m1..m9 接整条冷链；页 = 末尾 50 条 = c1..c5 + m1..m9（升序）
      expect(page.messages.map(m => m.id)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5',
        ...Array.from({ length: 9 }, (_, k) => `m${1 + k}`)]);
      expect(page.hasMore).toBe(false);
    });

    it('窗口 createdAt 非严格递减（等 ts 撞车）→ 回退全量路径，结果与旧语义逐条一致', async () => {
      const sameTs = BASE_MS;
      const rows: ChannelMessageData[] = [];
      for (let i = 1; i <= 100; i++) rows.push(makeRow(`m${i}`, sameTs));
      seedHotFile(tmpDir, rows);
      const readJsonlSpy = vi.spyOn(store, 'readJsonl');

      const page = await store.queryMessagesPage(CH, { before: 'm51', limit: 10 });
      // 全量语义：等 ts 稳定排序 = 文件序，锚点 index 50，页 = m41..m50
      expect(page.messages.map(m => m.id)).toEqual(Array.from({ length: 10 }, (_, k) => `m${41 + k}`));
      expect(page.hasMore).toBe(true);
      expect(readJsonlSpy).toHaveBeenCalled(); // 证明走了回退
    });

    it('页内消息的更新副本落在尾部（createdAt ≤ 锚点）→ 回退全量路径，页不错位', async () => {
      // m1..m100 递增；页内 m45 的更新副本追加在文件尾（createdAt 不变）。
      // 无「锚前活跃消息 createdAt 全 > 锚点」判据时，倒扫会把 m45 原行按 seen 跳过，
      // 页错成 m40..m44 + m46..m50——本测试钉住该病态序必须回退。
      const rows: ChannelMessageData[] = [];
      for (let i = 1; i <= 100; i++) rows.push(makeRow(`m${i}`, BASE_MS + i * 1000));
      rows.push({ ...makeRow('m45', BASE_MS + 45 * 1000), content: 'm45 v2' });
      seedHotFile(tmpDir, rows);
      const readJsonlSpy = vi.spyOn(store, 'readJsonl');

      const page = await store.queryMessagesPage(CH, { before: 'm51', limit: 10 });
      expect(page.messages.map(m => m.id)).toEqual(Array.from({ length: 10 }, (_, k) => `m${41 + k}`));
      expect(page.messages.find(m => m.id === 'm45')?.content).toBe('m45 v2');
      expect(page.hasMore).toBe(true);
      expect(readJsonlSpy).toHaveBeenCalled(); // 证明走了回退
    });

    it('锚点 id 不存在（热层穷举未命中、无冷数据）→ 空页 + hasMore=false，不走 readJsonl 全量', async () => {
      seedBigHotFile(tmpDir);
      const readJsonlSpy = vi.spyOn(store, 'readJsonl');

      const page = await store.queryMessagesPage(CH, { before: 'm-gone', limit: 50, includeTotal: true });
      expect(page.messages).toEqual([]);
      expect(page.hasMore).toBe(false);
      expect(page.total).toBe(3000);
      expect(readJsonlSpy).not.toHaveBeenCalled();
    });
  });

  describe('B5：queryMessages 带过滤谓词倒扫', () => {
    it('workUnitId 过滤 + limit：结果与全量语义一致，谓词倒扫早停（扫描行数有界，不走 readJsonl）', async () => {
      seedBigHotFile(tmpDir, (row, i) => {
        if (i <= 20) return { ...row, workUnitId: 'wu-old' };
        if (i > 2970) return { ...row, workUnitId: 'wu-hot' };
        return row;
      });
      const readJsonlSpy = vi.spyOn(store, 'readJsonl');
      scanCounter.lines = 0;

      const r = await store.queryMessages(CH, { workUnitId: 'wu-hot', limit: 10 });

      // 全量语义：过滤 wu-hot（30 条）→ 升序 → 末尾 10 条 = m2991..m3000
      expect(r.map(m => m.id)).toEqual(Array.from({ length: 10 }, (_, k) => `m${2991 + k}`));
      // 尾部 30 行连续匹配：收满 limit=10 即停
      expect(scanCounter.lines).toBeGreaterThan(0);
      expect(scanCounter.lines).toBeLessThanOrEqual(50);
      expect(readJsonlSpy).not.toHaveBeenCalled();
    });

    it('authorType 过滤 + limit：谓词泛化（非 workUnitId 专属）', async () => {
      seedBigHotFile(tmpDir, (row, i) => (i > 2990 ? { ...row, authorType: 'agent' } : row));
      scanCounter.lines = 0;

      const r = await store.queryMessages(CH, { authorType: 'agent', limit: 3 });
      expect(r.map(m => m.id)).toEqual(['m2998', 'm2999', 'm3000']);
      expect(scanCounter.lines).toBeLessThanOrEqual(20);
    });

    it('匹配不足 limit → 扫到文件头返回全部匹配（升序），与全量语义一致', async () => {
      seedBigHotFile(tmpDir, (row, i) => ([5, 1000, 2000, 2500, 2999].includes(i) ? { ...row, workUnitId: 'wu-rare' } : row));

      const r = await store.queryMessages(CH, { workUnitId: 'wu-rare', limit: 10 });
      expect(r.map(m => m.id)).toEqual(['m5', 'm1000', 'm2000', 'm2500', 'm2999']);
    });

    it('匹配窗口等 ts 撞车 → 回退全量路径，结果与旧语义逐条一致', async () => {
      const sameTs = BASE_MS;
      const rows: ChannelMessageData[] = [];
      for (let i = 1; i <= 50; i++) rows.push(makeRow(`m${i}`, sameTs, i > 40 ? { workUnitId: 'wu-x' } : undefined));
      seedHotFile(tmpDir, rows);
      const readJsonlSpy = vi.spyOn(store, 'readJsonl');

      const r = await store.queryMessages(CH, { workUnitId: 'wu-x', limit: 3 });
      // 全量语义：wu-x = m41..m50，升序（等 ts 稳定 = 文件序），末尾 3 条
      expect(r.map(m => m.id)).toEqual(['m48', 'm49', 'm50']);
      expect(readJsonlSpy).toHaveBeenCalled(); // 证明走了回退
    });

    it('过滤无 limit → 保持全量路径（倒扫无早停收益，结果不变）', async () => {
      seedBigHotFile(tmpDir, (row, i) => (i > 2990 ? { ...row, workUnitId: 'wu-hot' } : row));
      const r = await store.queryMessages(CH, { workUnitId: 'wu-hot' });
      expect(r.map(m => m.id)).toEqual(Array.from({ length: 10 }, (_, k) => `m${2991 + k}`));
    });
  });
});
