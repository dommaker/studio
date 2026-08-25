/**
 * 频道消息按 WU 生命周期归档（#327 阶段2）—— FileStore.archiveChannelMessages 归档 sweep。
 *
 * 断言面（plan seam A，文件系统状态）：
 * - 超龄分区：有 workUnitId → WU closedAt + 30 天；无 → createdAt + 30 天；
 *   遗产 WU closedAt 缺失回退 updatedAt；workUnitId 悬空回退 createdAt 规则；WU 非 closed 一律保留
 * - 热+冷 == 归档前全量（逐条一致，含顺序）；冷文件按月落 `archive/messages-YYYY-MM.jsonl`，纯 ChannelMessageData 行
 * - 幂等（连跑两次不重复）；空操作不重写热文件；与并发 append 互斥（复用 messages.lock）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore, type ChannelData, type ChannelMessageData, type WorkUnitSnapshot } from '../file-store';

const NOW = new Date('2026-08-25T00:00:00.000Z');
const DAY_MS = 86_400_000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY_MS).toISOString();

function makeChannel(id: string): ChannelData {
  const now = NOW.toISOString();
  return {
    id, name: `channel-${id}`, type: 'rnd',
    defaultWorkspaceId: null, defaultPath: null,
    discordChannelId: null, discordWebhookUrl: null, members: '[]',
    createdAt: now, updatedAt: now,
  };
}

function makeMessage(id: string, channelId: string, opts?: { workUnitId?: string | null; createdAt?: string; content?: string }): ChannelMessageData {
  return {
    id,
    channelId,
    workUnitId: opts?.workUnitId ?? null,
    authorType: 'human',
    agentName: null,
    content: opts?.content ?? `message ${id} content`,
    replyToId: null,
    meta: '{}',
    createdAt: opts?.createdAt ?? NOW.toISOString(),
  };
}

function makeWuSnapshot(id: string, channelId: string, opts: { status: string; closedAt?: string | null; updatedAt?: string }): WorkUnitSnapshot {
  return {
    id, parentId: null, type: 'task', scope: `scope-${id}`, assigneeId: null,
    status: opts.status, failureType: null, retryCount: 0, timeoutAt: null,
    channelId, projectPath: null, metadata: null,
    createdAt: daysAgo(60), updatedAt: opts.updatedAt ?? NOW.toISOString(),
    claimedAt: null, completedAt: null,
    // closedAt 缺省不写字段 = 遗产快照形态
    ...(opts.closedAt !== undefined ? { closedAt: opts.closedAt } : {}),
  };
}

describe('频道消息归档 sweep（#327）', () => {
  let tmpDir: string;
  let store: FileStore;
  const CH = 'ch-archive';

  const hotPath = () => path.join(tmpDir, 'channels', CH, 'messages.jsonl');
  const archiveDir = () => path.join(tmpDir, 'channels', CH, 'archive');
  const coldPath = (month: string) => path.join(archiveDir(), `messages-${month}.jsonl`);
  const rawLines = (fp: string): Array<Record<string, unknown>> =>
    fs.readFileSync(fp, 'utf-8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'filestore-archive-test-'));
    store = new FileStore(tmpDir, { messageArchive: { maxAgeDays: 30, now: () => NOW } });
    await store.createChannel(makeChannel(CH));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('超龄分区：closedAt/createdAt/悬空回退/活 WU 保留；热+冷 == 归档前全量逐条一致', async () => {
    await store.upsertSnapshot(makeWuSnapshot('wu-old', CH, { status: 'closed', closedAt: daysAgo(40), updatedAt: daysAgo(40) }));
    await store.upsertSnapshot(makeWuSnapshot('wu-new', CH, { status: 'closed', closedAt: daysAgo(10), updatedAt: daysAgo(10) }));
    await store.upsertSnapshot(makeWuSnapshot('wu-active', CH, { status: 'active', updatedAt: daysAgo(100) }));

    const originals = [
      makeMessage('m1', CH, { workUnitId: 'wu-old', createdAt: daysAgo(41) }),   // 超龄（WU closedAt 40d）
      makeMessage('m2', CH, { workUnitId: 'wu-new', createdAt: daysAgo(11) }),   // 未超龄（WU closedAt 10d）
      makeMessage('m3', CH, { createdAt: daysAgo(40) }),                          // 闲聊超龄（createdAt 40d）
      makeMessage('m4', CH, { createdAt: daysAgo(1) }),                           // 闲聊未超龄
      makeMessage('m5', CH, { workUnitId: 'wu-active', createdAt: daysAgo(100) }),// 活 WU 一律保留
      makeMessage('m6', CH, { workUnitId: 'wu-ghost', createdAt: daysAgo(39) }),  // WU 悬空 → createdAt 规则超龄
    ];
    for (const m of originals) await store.appendMessage(CH, m);

    const result = await store.archiveChannelMessages();

    expect(result.archivedMessages).toBe(3);
    // 热文件只剩未超龄，保持原首现顺序
    expect(rawLines(hotPath()).map(r => r.id)).toEqual(['m2', 'm4', 'm5']);
    // 冷文件按消息 createdAt 归月（三条都在 2026-07），文件内 createdAt 升序
    expect(fs.readdirSync(archiveDir())).toEqual(['messages-2026-07.jsonl']);
    const coldRows = rawLines(coldPath('2026-07'));
    expect(coldRows.map(r => r.id)).toEqual(['m1', 'm3', 'm6']);
    expect(coldRows.every(r => !('deleted' in r))).toBe(true);
    // 热+冷 == 归档前全量：每 id 恰出现一次，字段逐条一致
    const merged = new Map<string, Record<string, unknown>>();
    for (const r of [...rawLines(hotPath()), ...coldRows]) {
      expect(merged.has(r.id as string)).toBe(false);
      merged.set(r.id as string, r);
    }
    expect(merged.size).toBe(originals.length);
    for (const orig of originals) {
      expect(merged.get(orig.id)).toMatchObject({
        channelId: CH, workUnitId: orig.workUnitId, content: orig.content, createdAt: orig.createdAt,
      });
    }
  });

  it('遗产 closed WU 无 closedAt → 回退 updatedAt 计龄', async () => {
    await store.upsertSnapshot(makeWuSnapshot('wu-legacy-old', CH, { status: 'closed', updatedAt: daysAgo(40) }));
    await store.upsertSnapshot(makeWuSnapshot('wu-legacy-new', CH, { status: 'closed', updatedAt: daysAgo(5) }));
    await store.appendMessage(CH, makeMessage('m1', CH, { workUnitId: 'wu-legacy-old', createdAt: daysAgo(50) }));
    await store.appendMessage(CH, makeMessage('m2', CH, { workUnitId: 'wu-legacy-new', createdAt: daysAgo(50) }));

    const result = await store.archiveChannelMessages();

    expect(result.archivedMessages).toBe(1);
    expect(rawLines(hotPath()).map(r => r.id)).toEqual(['m2']);
  });

  it('幂等：连跑两次不重复归档（冷文件不增行、热文件不再重写）', async () => {
    await store.appendMessage(CH, makeMessage('m1', CH, { createdAt: daysAgo(40) }));
    await store.appendMessage(CH, makeMessage('m2', CH, { createdAt: daysAgo(1) }));

    const first = await store.archiveChannelMessages();
    expect(first.archivedMessages).toBe(1);
    const coldLinesAfterFirst = rawLines(coldPath('2026-07')).length;
    const hotMtimeAfterFirst = fs.statSync(hotPath()).mtimeMs;

    const second = await store.archiveChannelMessages();
    expect(second.archivedMessages).toBe(0);
    expect(rawLines(coldPath('2026-07')).length).toBe(coldLinesAfterFirst);
    expect(fs.statSync(hotPath()).mtimeMs).toBe(hotMtimeAfterFirst);
  });

  it('空操作纪律：无超龄消息不重写热文件、不建 archive 目录', async () => {
    await store.appendMessage(CH, makeMessage('m1', CH, { createdAt: daysAgo(1) }));
    await store.appendMessage(CH, makeMessage('m2', CH, { createdAt: daysAgo(2) }));
    const mtimeBefore = fs.statSync(hotPath()).mtimeMs;

    const result = await store.archiveChannelMessages();

    expect(result.archivedMessages).toBe(0);
    expect(fs.statSync(hotPath()).mtimeMs).toBe(mtimeBefore);
    expect(fs.existsSync(archiveDir())).toBe(false);
  });

  it('顺带压实同口径：被覆盖旧版与 tombstone 不进冷热文件', async () => {
    await store.appendMessage(CH, makeMessage('m1', CH, { createdAt: daysAgo(1) }));
    await store.appendMessage(CH, makeMessage('m2', CH, { createdAt: daysAgo(1), content: 'm2 v1' }));
    await store.appendMessage(CH, makeMessage('m2', CH, { createdAt: daysAgo(1), content: 'm2 v2' }));
    await store.appendMessage(CH, makeMessage('m3', CH, { createdAt: daysAgo(1) }));
    await store.softDeleteMessage(CH, 'm3');
    await store.appendMessage(CH, makeMessage('m4', CH, { createdAt: daysAgo(40) }));

    const result = await store.archiveChannelMessages();

    expect(result.archivedMessages).toBe(1);
    const hotRows = rawLines(hotPath());
    expect(hotRows.map(r => r.id)).toEqual(['m1', 'm2']);
    expect(hotRows.every(r => !('deleted' in r))).toBe(true);
    expect(hotRows.find(r => r.id === 'm2')?.content).toBe('m2 v2');
    // m3（含 tombstone）彻底消失——死行不进冷文件
    const allIds = [...hotRows, ...rawLines(coldPath('2026-07'))].map(r => r.id);
    expect(allIds).not.toContain('m3');
  });

  it('sweep 与并发 append 互斥：不丢消息、新消息全部留在热文件', async () => {
    await store.appendMessage(CH, makeMessage('old-1', CH, { createdAt: daysAgo(40) }));
    await store.appendMessage(CH, makeMessage('old-2', CH, { createdAt: daysAgo(41) }));
    const freshIds = Array.from({ length: 10 }, (_, i) => `fresh-${i}`);

    await Promise.all([
      store.archiveChannelMessages(),
      ...freshIds.map(id => store.appendMessage(CH, makeMessage(id, CH))),
    ]);

    const hotIds = rawLines(hotPath()).map(r => r.id as string);
    const coldIds = rawLines(coldPath('2026-07')).map(r => r.id as string);
    expect(coldIds).toEqual(['old-2', 'old-1']);
    for (const id of freshIds) expect(hotIds).toContain(id);
    // 全局无重复
    expect(new Set([...hotIds, ...coldIds]).size).toBe(hotIds.length + coldIds.length);
  });

  it('channels 目录不存在 → no-op（archivedMessages=0，不抛错）', async () => {
    const emptyStore = new FileStore(fs.mkdtempSync(path.join(os.tmpdir(), 'filestore-archive-empty-')));
    await expect(emptyStore.archiveChannelMessages()).resolves.toEqual({ archivedMessages: 0 });
  });
});
