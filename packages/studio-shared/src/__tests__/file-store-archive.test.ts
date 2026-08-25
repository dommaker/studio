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

describe('queryMessagesPage 分页穿透冷热（#327 阶段4）', () => {
  let tmpDir: string;
  let store: FileStore;
  const CH = 'ch-page-archive';

  const archiveDir = () => path.join(tmpDir, 'channels', CH, 'archive');

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'filestore-page-test-'));
    store = new FileStore(tmpDir, { messageArchive: { maxAgeDays: 30, now: () => NOW } });
    await store.createChannel(makeChannel(CH));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** m1(2026-06,70d) m2(2026-07,40d) m3(2026-07,39d) m4(2026-07,38d) 归档；m5(3d) m6(2d) m7(1d) 留热 */
  async function seedHotCold() {
    const msgs = [
      makeMessage('m1', CH, { createdAt: daysAgo(70) }),
      makeMessage('m2', CH, { createdAt: daysAgo(40) }),
      makeMessage('m3', CH, { createdAt: daysAgo(39) }),
      makeMessage('m4', CH, { createdAt: daysAgo(38) }),
      makeMessage('m5', CH, { createdAt: daysAgo(3) }),
      makeMessage('m6', CH, { createdAt: daysAgo(2) }),
      makeMessage('m7', CH, { createdAt: daysAgo(1) }),
    ];
    for (const m of msgs) await store.appendMessage(CH, m);
    await store.archiveChannelMessages();
  }

  it('无 before：热页不足 limit 从冷补满（新→旧），hasMore 计入全链余量（code-review 修复）', async () => {
    await seedHotCold();
    // 热 3 条（m5,m6,m7）+ 冷最新 2 条（m4,m3）补满 limit=5，升序返回
    const page = await store.queryMessagesPage(CH, { limit: 5 });
    expect(page.messages.map(m => m.id)).toEqual(['m3', 'm4', 'm5', 'm6', 'm7']);
    expect(page.hasMore).toBe(true); // 冷还剩 m1, m2
    expect(page.total).toBe(7);
    // 续翻（前端锚 = 页内最老 id）：锚 m3 在冷 → [m1, m2]，全链不漏不重
    const p2 = await store.queryMessagesPage(CH, { before: 'm3', limit: 5 });
    expect(p2.messages.map(m => m.id)).toEqual(['m1', 'm2']);
    expect(p2.hasMore).toBe(false);
  });

  it('热层全空（全部已归档）：首页直接从冷出——滚动穿透、历史永远在', async () => {
    // e1(31d)…e6(36d) 全部超龄归档，热层 0 条
    for (let i = 1; i <= 6; i++) {
      await store.appendMessage(CH, makeMessage(`e${i}`, CH, { createdAt: daysAgo(30 + i) }));
    }
    await store.archiveChannelMessages();

    // 首页：冷新→旧取 4 条（e1..e4），升序返回；不再是 [] + hasMore=true 的死页
    const p1 = await store.queryMessagesPage(CH, { limit: 4 });
    expect(p1.messages.map(m => m.id)).toEqual(['e4', 'e3', 'e2', 'e1']);
    expect(p1.hasMore).toBe(true);
    expect(p1.total).toBe(6);
    // 续翻到底
    const p2 = await store.queryMessagesPage(CH, { before: 'e4', limit: 4 });
    expect(p2.messages.map(m => m.id)).toEqual(['e6', 'e5']);
    expect(p2.hasMore).toBe(false);
  });

  it('锚在热且热侧不足 limit：余量从冷续（新→旧跨月），全链翻完不重不漏', async () => {
    await seedHotCold();
    // 第一页（最新）：热 3 条
    const p1 = await store.queryMessagesPage(CH, { limit: 2 });
    expect(p1.messages.map(m => m.id)).toEqual(['m6', 'm7']);
    expect(p1.hasMore).toBe(true);
    // 第二页：锚 m6 在热，热侧余 1 条（m5），余量从冷续 1 条（最新冷 m4）
    const p2 = await store.queryMessagesPage(CH, { before: 'm6', limit: 2 });
    expect(p2.messages.map(m => m.id)).toEqual(['m4', 'm5']);
    expect(p2.hasMore).toBe(true);
    // 第三页：锚 m4 在冷，整页从冷出
    const p3 = await store.queryMessagesPage(CH, { before: 'm4', limit: 2 });
    expect(p3.messages.map(m => m.id)).toEqual(['m2', 'm3']);
    expect(p3.hasMore).toBe(true);
    // 第四页：冷见底
    const p4 = await store.queryMessagesPage(CH, { before: 'm2', limit: 2 });
    expect(p4.messages.map(m => m.id)).toEqual(['m1']);
    expect(p4.hasMore).toBe(false);
    // 全链恰好覆盖 7 条，无重复
    const all = [...p1.messages, ...p2.messages, ...p3.messages, ...p4.messages].map(m => m.id);
    expect(new Set(all).size).toBe(7);
  });

  it('锚在冷：total = 链上锚点之前的可见总数', async () => {
    await seedHotCold();
    const page = await store.queryMessagesPage(CH, { before: 'm3', limit: 10 });
    expect(page.messages.map(m => m.id)).toEqual(['m1', 'm2']);
    expect(page.total).toBe(2);
    expect(page.hasMore).toBe(false);
  });

  it('锚不存在（冷热都没有）→ 空页 + hasMore=false（#319 契约不动）', async () => {
    await seedHotCold();
    const page = await store.queryMessagesPage(CH, { before: 'm-ghost', limit: 2 });
    expect(page.messages).toEqual([]);
    expect(page.hasMore).toBe(false);
  });

  it('跨冷热同毫秒不漏不重：同刻消息分属冷热两侧，同页返回各出现一次', async () => {
    await store.upsertSnapshot(makeWuSnapshot('wu-old', CH, { status: 'closed', closedAt: daysAgo(40), updatedAt: daysAgo(40) }));
    const sameTs = daysAgo(5);
    // 同 createdAt：m-cold 按 WU closedAt 规则归档，m-hot 按 createdAt 规则留热
    await store.appendMessage(CH, makeMessage('m-cold', CH, { workUnitId: 'wu-old', createdAt: sameTs }));
    await store.appendMessage(CH, makeMessage('m-hot', CH, { createdAt: sameTs }));
    await store.archiveChannelMessages();

    // 热 1 条不足 limit → 冷补满：同刻两条同页各出现一次（冷侧在前），total 计 2
    const p1 = await store.queryMessagesPage(CH, { limit: 10 });
    expect(p1.messages.map(m => m.id)).toEqual(['m-cold', 'm-hot']);
    expect(p1.total).toBe(2);
    expect(p1.hasMore).toBe(false);
  });

  it('thaw/崩溃残留同 id（冷热都有）：新→旧先见为准，不重复返回、不计入 total', async () => {
    // 热文件有 m-x；冷文件手工造同 id 残留 + 另一条 m-y
    await store.appendMessage(CH, makeMessage('m-x', CH, { createdAt: daysAgo(1), content: 'hot version' }));
    fs.mkdirSync(archiveDir(), { recursive: true });
    fs.writeFileSync(
      path.join(archiveDir(), 'messages-2026-06.jsonl'),
      [makeMessage('m-x', CH, { createdAt: daysAgo(60), content: 'cold residual' }),
        makeMessage('m-y', CH, { createdAt: daysAgo(61) })]
        .map(m => JSON.stringify(m)).join('\n') + '\n',
    );

    // 热 1 条不足 limit → 冷补满：m-y（冷有效）+ m-x（热版本）；冷侧 m-x 残留被遮蔽
    const p1 = await store.queryMessagesPage(CH, { limit: 10 });
    expect(p1.messages.map(m => m.id)).toEqual(['m-y', 'm-x']);
    expect(p1.messages.find(m => m.id === 'm-x')?.content).toBe('hot version');
    expect(p1.total).toBe(2); // m-x（热）+ m-y（冷有效）
    expect(p1.hasMore).toBe(false);
    // 锚在冷（m-y 是链上最老）→ 空页
    const p2 = await store.queryMessagesPage(CH, { before: 'm-y', limit: 10 });
    expect(p2.messages).toEqual([]);
    expect(p2.hasMore).toBe(false);
  });

  it('无冷数据（无 archive 目录）时行为与 #319 现状一致', async () => {
    const ts = daysAgo(1);
    for (const id of ['p1', 'p2', 'p3', 'p4', 'p5']) {
      await store.appendMessage(CH, { ...makeMessage(id, CH), createdAt: ts });
    }
    const page = await store.queryMessagesPage(CH, { before: 'p4', limit: 2 });
    expect(page.messages.map(m => m.id)).toEqual(['p2', 'p3']);
    expect(page.total).toBe(3);
    expect(page.hasMore).toBe(true);

    const missing = await store.queryMessagesPage(CH, { before: 'p-gone', limit: 2 });
    expect(missing.messages).toEqual([]);
    expect(missing.total).toBe(5);
    expect(missing.hasMore).toBe(false);
  });
});

describe('thawWorkUnitMessages reopen 解冻（#327 阶段5）', () => {
  let tmpDir: string;
  let store: FileStore;
  const CH = 'ch-thaw';

  const hotPath = () => path.join(tmpDir, 'channels', CH, 'messages.jsonl');
  const coldPath = (month: string) => path.join(tmpDir, 'channels', CH, 'archive', `messages-${month}.jsonl`);
  const rawLines = (fp: string): Array<Record<string, unknown>> =>
    fs.readFileSync(fp, 'utf-8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'filestore-thaw-test-'));
    store = new FileStore(tmpDir, { messageArchive: { maxAgeDays: 30, now: () => NOW } });
    await store.createChannel(makeChannel(CH));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('该 WU 的归档消息搬回热文件（保留 id/createdAt），冷文件剔除；查询面恢复可见', async () => {
    await store.upsertSnapshot(makeWuSnapshot('wu-1', CH, { status: 'closed', closedAt: daysAgo(40), updatedAt: daysAgo(40) }));
    await store.appendMessage(CH, makeMessage('m1', CH, { workUnitId: 'wu-1', createdAt: daysAgo(41) }));
    await store.appendMessage(CH, makeMessage('m2', CH, { workUnitId: 'wu-1', createdAt: daysAgo(40) }));
    await store.appendMessage(CH, makeMessage('m3', CH, { workUnitId: 'wu-other', createdAt: daysAgo(40) })); // 悬空 WU，同批归档
    await store.appendMessage(CH, makeMessage('m4', CH, { createdAt: daysAgo(1) })); // 留热
    await store.archiveChannelMessages();
    expect(rawLines(hotPath()).map(r => r.id)).toEqual(['m4']);

    const result = await store.thawWorkUnitMessages('wu-1');

    expect(result.thawedMessages).toBe(2);
    // 热文件：m4 + thaw 回流的 m1/m2（保留原 id/createdAt，升序追加）
    expect(rawLines(hotPath()).map(r => r.id)).toEqual(['m4', 'm1', 'm2']);
    // 冷文件只剩 wu-other 的 m3
    expect(rawLines(coldPath('2026-07')).map(r => r.id)).toEqual(['m3']);
    // 查询面（热只读）恢复可见
    const visible = await store.queryMessages(CH, { workUnitId: 'wu-1' });
    expect(visible.map(m => m.id)).toEqual(['m1', 'm2']);
    expect((await store.queryAllMessages({ workUnitId: 'wu-1' })).map(m => m.id).sort()).toEqual(['m1', 'm2']);
  });

  it('重复 thaw（热文件已含同 id）→ 不重复追加', async () => {
    await store.upsertSnapshot(makeWuSnapshot('wu-1', CH, { status: 'closed', closedAt: daysAgo(40), updatedAt: daysAgo(40) }));
    await store.appendMessage(CH, makeMessage('m1', CH, { workUnitId: 'wu-1', createdAt: daysAgo(40) }));
    await store.archiveChannelMessages();

    const first = await store.thawWorkUnitMessages('wu-1');
    expect(first.thawedMessages).toBe(1);
    // 手工把同一行塞回冷文件模拟崩溃残留，再 thaw：热侧已有 m1 → 不重复
    fs.writeFileSync(coldPath('2026-07'), JSON.stringify(makeMessage('m1', CH, { workUnitId: 'wu-1', createdAt: daysAgo(40) })) + '\n');
    const second = await store.thawWorkUnitMessages('wu-1');
    expect(second.thawedMessages).toBe(0);
    expect(rawLines(hotPath()).map(r => r.id)).toEqual(['m1']);
  });

  it('无 archive 目录 → 零成本短路（thawed=0，不抛错）', async () => {
    await store.appendMessage(CH, makeMessage('m1', CH, { createdAt: daysAgo(1) }));
    await expect(store.thawWorkUnitMessages('wu-1')).resolves.toEqual({ thawedMessages: 0 });
  });

  it('有归档但无该 WU 的行 → no-op（热文件不重写）', async () => {
    await store.appendMessage(CH, makeMessage('m1', CH, { workUnitId: 'wu-other', createdAt: daysAgo(40) }));
    await store.appendMessage(CH, makeMessage('m2', CH, { createdAt: daysAgo(1) }));
    await store.archiveChannelMessages();
    const mtimeBefore = fs.statSync(hotPath()).mtimeMs;

    const result = await store.thawWorkUnitMessages('wu-1');

    expect(result.thawedMessages).toBe(0);
    expect(fs.statSync(hotPath()).mtimeMs).toBe(mtimeBefore);
  });

  it('channels 目录不存在 → no-op（thawed=0，不抛错）', async () => {
    const emptyStore = new FileStore(fs.mkdtempSync(path.join(os.tmpdir(), 'filestore-thaw-empty-')));
    await expect(emptyStore.thawWorkUnitMessages('wu-1')).resolves.toEqual({ thawedMessages: 0 });
  });
});
