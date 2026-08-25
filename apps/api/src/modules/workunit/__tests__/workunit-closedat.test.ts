// #327 阶段1：WorkUnitSnapshot.closedAt —— WU 关闭时刻落快照，作为频道消息归档的计龄锚点
// （有 workUnitId 的消息按所属 WU closedAt + 30 天判超龄）。
// 约定与 wu-closure.test.ts 一致：真实 FileStore（tmpdir）+ 真实 WorkUnitService。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore, type WorkUnitSnapshot } from '@dommaker/studio-shared';
import { WorkUnitService } from '../workunit.service.js';
import { closeWorkUnitWithNotice } from '../wu-closure.js';

let tmpDir: string;
let fileStore: FileStore;
let wuService: WorkUnitService;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wu-closedat-test-'));
  process.env.STUDIO_EVENTS_FILE = path.join(tmpDir, 'studio-events.jsonl');
  fileStore = new FileStore(tmpDir);
  wuService = new WorkUnitService(fileStore);
});

afterEach(() => {
  delete process.env.STUDIO_EVENTS_FILE;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function snapshotOf(id: string): Promise<WorkUnitSnapshot> {
  return (await fileStore.getIndex()).find(s => s.id === id)!;
}

describe('WorkUnit closedAt（#327 归档计龄锚点）', () => {
  it('transitionStatus → closed：快照写 closedAt，返回 DTO 同步暴露', async () => {
    const wu = await wuService.create({ scope: '关闭计龄任务', type: 'task', status: 'active', assigneeId: 'inst-1' });

    const closed = await wuService.transitionStatus(wu.id, 'closed');

    const snap = await snapshotOf(wu.id);
    expect(snap.status).toBe('closed');
    expect(typeof snap.closedAt).toBe('string');
    expect(Number.isNaN(Date.parse(snap.closedAt!))).toBe(false);
    expect(closed.closedAt).toBeInstanceOf(Date);
    expect(closed.closedAt!.toISOString()).toBe(snap.closedAt);
  });

  it('迁移到非 closed 状态不写 closedAt', async () => {
    const wu = await wuService.create({ scope: '挂起任务', type: 'task', status: 'active', assigneeId: 'inst-1' });

    await wuService.transitionStatus(wu.id, 'blocked');

    expect((await snapshotOf(wu.id)).closedAt ?? null).toBeNull();
  });

  it('reopen（closed → unassigned）清除 closedAt（计龄锚点不再成立）', async () => {
    const wu = await wuService.create({ scope: '重开任务', type: 'task', status: 'active', assigneeId: 'inst-1' });
    await wuService.transitionStatus(wu.id, 'closed');
    expect((await snapshotOf(wu.id)).closedAt).toBeTruthy();

    await wuService.transitionStatus(wu.id, 'unassigned');

    const snap = await snapshotOf(wu.id);
    expect(snap.status).toBe('unassigned');
    expect(snap.closedAt).toBeNull();
  });

  it('closeWorkUnitWithNotice 统一关闭出口写 closedAt（= completedAt）', async () => {
    const wu = await wuService.create({ scope: '死信任务', type: 'task', status: 'active', assigneeId: 'inst-1' });
    await wuService.transitionStatus(wu.id, 'blocked');
    const snapshot = await snapshotOf(wu.id);

    const ok = await closeWorkUnitWithNotice(fileStore, snapshot, {
      reason: 'blocked 超 24h 无人工介入，自动关闭',
      closedBy: 'auto-abandon-stale-blocked',
    });

    expect(ok).toBe(true);
    const snap = await snapshotOf(wu.id);
    expect(snap.status).toBe('closed');
    expect(snap.closedAt).toBe(snap.completedAt);
  });

  it('reopen（closed → unassigned）自动解冻：已归档消息搬回热文件，查询面可见', async () => {
    const channelId = 'ch-reopen-thaw';
    await fileStore.createChannel({
      id: channelId, name: '#reopen-thaw', type: 'rnd',
      defaultWorkspaceId: null, defaultPath: null,
      discordChannelId: null, discordWebhookUrl: null, members: '[]',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    const wu = await wuService.create({ scope: '解冻任务', channelId, type: 'task', status: 'active', assigneeId: 'inst-1' });
    await fileStore.appendMessage(channelId, {
      id: 'thaw-m1', channelId, workUnitId: wu.id, authorType: 'human', agentName: null,
      content: 'm1', replyToId: null, meta: '{}', createdAt: new Date().toISOString(),
    });
    await wuService.transitionStatus(wu.id, 'closed');

    // 用「未来 now」的 FileStore 跑 sweep：同一 baseDir，closedAt + 30d 已超龄 → 归档
    const futureStore = new FileStore(tmpDir, {
      messageArchive: { now: () => new Date(Date.now() + 40 * 86_400_000) },
    });
    const swept = await futureStore.archiveChannelMessages();
    expect(swept.archivedMessages).toBe(1);
    // 归档后热只读查询面失明
    expect(await fileStore.queryMessages(channelId, { workUnitId: wu.id })).toEqual([]);

    await wuService.transitionStatus(wu.id, 'unassigned');

    // 解冻后查询面（热层）恢复可见，原始 id/createdAt 保留
    const visible = await fileStore.queryMessages(channelId, { workUnitId: wu.id });
    expect(visible.map(m => m.id)).toEqual(['thaw-m1']);
  });
});
