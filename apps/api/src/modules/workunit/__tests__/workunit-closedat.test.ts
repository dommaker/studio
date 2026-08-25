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
});
