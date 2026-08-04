/**
 * WorkUnitCrudService（workunit-crud.ts）直接单测 —— 拆分后不经门面，直接打基类。
 *
 * 覆盖：snapshotToData/inputToSnapshot/patchSnapshot 转换边界、create 的
 * workunit.created 事件发布与默认值、createFromMessage、update/delete 路径、
 * claim/unclaim 与 resolveClaimTimeoutAt 的 timeout 解析。
 *
 * 约定与 workunit-status-events.test.ts / waiting-input.test.ts 一致：
 * 真实 FileStore（tmpdir）+ 真实 Service 实例，不 mock。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  FileStore,
  eventBus,
  type ChannelMessageData,
  type WorkUnitEvent,
  type WorkUnitSnapshot,
} from '@dommaker/studio-shared';
import {
  WorkUnitCrudService,
  snapshotToData,
  WU_TIMEOUT_MINUTES,
  WU_DEFAULT_TIMEOUT_MINUTES,
  type WorkUnitData,
} from '../workunit-crud.js';
import type { WorkUnitMetadata } from '../workunit.service.js';

let tmpDir: string;
let fileStore: FileStore;
let service: WorkUnitCrudService;
let statusEvents: WorkUnitData[];
let statusHandler: (payload: { workunit: WorkUnitData }) => void;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workunit-crud-test-'));
  fileStore = new FileStore(tmpDir);
  service = new WorkUnitCrudService(fileStore);
  statusEvents = [];
  statusHandler = (payload) => { statusEvents.push(payload.workunit); };
  eventBus.subscribe('workunit.status_changed', statusHandler);
});

afterEach(() => {
  eventBus.unsubscribe('workunit.status_changed', statusHandler);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 读取 workunits/events.jsonl 事件流 */
function readEvents(): WorkUnitEvent[] {
  const file = path.join(tmpDir, 'workunits', 'events.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l) as WorkUnitEvent);
}

async function findSnapshot(id: string): Promise<WorkUnitSnapshot | undefined> {
  const snapshots = await fileStore.getIndex();
  return snapshots.find(s => s.id === id);
}

function makeSnapshot(overrides: Partial<WorkUnitSnapshot> = {}): WorkUnitSnapshot {
  return {
    id: 'wu-snap-1',
    parentId: null,
    type: 'task',
    scope: '快照转换',
    assigneeId: null,
    status: 'unassigned',
    failureType: null,
    retryCount: 0,
    timeoutAt: null,
    channelId: null,
    projectPath: null,
    workspaceId: null,
    reqId: null,
    metadata: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T01:00:00.000Z',
    claimedAt: null,
    completedAt: null,
    ...overrides,
  };
}

// ── snapshotToData ──

describe('snapshotToData 转换边界', () => {
  it('完整快照 → 字符串日期转 Date，字段逐一保留', () => {
    const snap = makeSnapshot({
      parentId: 'wu-parent',
      assigneeId: 'inst-1',
      status: 'active',
      failureType: 'timeout',
      retryCount: 2,
      timeoutAt: '2026-08-01T02:00:00.000Z',
      channelId: 'ch-1',
      projectPath: '/tmp/proj',
      workspaceId: 'ws-1',
      reqId: 'REQ-0001',
      metadata: '{"priority":"high"}',
      claimedAt: '2026-08-01T01:30:00.000Z',
      completedAt: '2026-08-01T03:00:00.000Z',
    });

    const data = snapshotToData(snap);

    expect(data.id).toBe('wu-snap-1');
    expect(data.parentId).toBe('wu-parent');
    expect(data.type).toBe('task');
    expect(data.scope).toBe('快照转换');
    expect(data.assigneeId).toBe('inst-1');
    expect(data.status).toBe('active');
    expect(data.failureType).toBe('timeout');
    expect(data.retryCount).toBe(2);
    expect(data.channelId).toBe('ch-1');
    expect(data.projectPath).toBe('/tmp/proj');
    expect(data.workspaceId).toBe('ws-1');
    expect(data.reqId).toBe('REQ-0001');
    // metadata 原样透传（不解析）
    expect(data.metadata).toBe('{"priority":"high"}');
    // 日期字段 → Date 实例且值正确
    for (const key of ['timeoutAt', 'createdAt', 'updatedAt', 'claimedAt', 'completedAt'] as const) {
      expect(data[key]).toBeInstanceOf(Date);
    }
    expect(data.timeoutAt!.toISOString()).toBe('2026-08-01T02:00:00.000Z');
    expect(data.createdAt.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(data.updatedAt.toISOString()).toBe('2026-08-01T01:00:00.000Z');
    expect(data.claimedAt!.toISOString()).toBe('2026-08-01T01:30:00.000Z');
    expect(data.completedAt!.toISOString()).toBe('2026-08-01T03:00:00.000Z');
  });

  it('空值边界：可空日期 null → null；缺省 workspaceId/reqId（旧快照）→ null', () => {
    const snap = makeSnapshot();
    delete (snap as Record<string, unknown>).workspaceId;
    delete (snap as Record<string, unknown>).reqId;

    const data = snapshotToData(snap);

    expect(data.timeoutAt).toBeNull();
    expect(data.claimedAt).toBeNull();
    expect(data.completedAt).toBeNull();
    expect(data.workspaceId).toBeNull();
    expect(data.reqId).toBeNull();
    expect(data.metadata).toBeNull();
  });
});

// ── create（inputToSnapshot 边界 + 事件发布）──

describe('create', () => {
  it('仅传 scope → 默认值：type=task、status=unassigned、retryCount=0、可空字段全 null', async () => {
    const wu = await service.create({ scope: '最小输入' });

    expect(wu.id).toBeTruthy();
    expect(wu.type).toBe('task');
    expect(wu.scope).toBe('最小输入');
    expect(wu.status).toBe('unassigned');
    expect(wu.retryCount).toBe(0);
    expect(wu.assigneeId).toBeNull();
    expect(wu.parentId).toBeNull();
    expect(wu.channelId).toBeNull();
    expect(wu.projectPath).toBeNull();
    expect(wu.workspaceId).toBeNull();
    expect(wu.reqId).toBeNull();
    expect(wu.failureType).toBeNull();
    expect(wu.timeoutAt).toBeNull();
    expect(wu.claimedAt).toBeNull();
    expect(wu.completedAt).toBeNull();
    expect(wu.metadata).toBeNull();
    expect(wu.createdAt).toBeInstanceOf(Date);
    expect(wu.updatedAt).toBeInstanceOf(Date);
    expect(wu.createdAt.getTime()).toBe(wu.updatedAt.getTime());
  });

  it('全字段输入 → 落盘为 ISO 字符串快照，返回 Date 字段与 JSON metadata', async () => {
    const timeoutAt = new Date('2026-08-10T00:00:00.000Z');
    const completedAt = new Date('2026-08-11T00:00:00.000Z');
    const wu = await service.create({
      type: 'bug',
      scope: '修复崩溃',
      assigneeId: 'inst-1',
      status: 'active',
      channelId: 'ch-1',
      parentId: 'wu-parent',
      projectPath: '/tmp/proj',
      workspaceId: 'ws-1',
      reqId: 'REQ-0042',
      failureType: 'crash',
      retryCount: 3,
      timeoutAt,
      completedAt,
      metadata: { priority: 'critical' },
    });

    expect(wu.type).toBe('bug');
    expect(wu.status).toBe('active');
    expect(wu.assigneeId).toBe('inst-1');
    expect(wu.parentId).toBe('wu-parent');
    expect(wu.workspaceId).toBe('ws-1');
    expect(wu.reqId).toBe('REQ-0042');
    expect(wu.failureType).toBe('crash');
    expect(wu.retryCount).toBe(3);
    expect(wu.timeoutAt!.toISOString()).toBe(timeoutAt.toISOString());
    expect(wu.completedAt!.toISOString()).toBe(completedAt.toISOString());
    expect(JSON.parse(wu.metadata!)).toEqual({ priority: 'critical' });

    // 落盘快照是 WorkUnitSnapshot（字符串日期）
    const snap = (await findSnapshot(wu.id))!;
    expect(snap.timeoutAt).toBe(timeoutAt.toISOString());
    expect(snap.completedAt).toBe(completedAt.toISOString());
    expect(snap.claimedAt).toBeNull();
    expect(snap.metadata).toBe('{"priority":"critical"}');
  });

  it('追加 created 事件到事件流 + 写 index 快照 + 发布 workunit.created（payload 为 Date 化数据）', async () => {
    const created: WorkUnitData[] = [];
    const handler = (payload: { workunit: WorkUnitData }) => { created.push(payload.workunit); };
    eventBus.subscribe('workunit.created', handler);
    try {
      const wu = await service.create({ scope: '事件验证', type: 'task', channelId: 'ch-1' });

      // 事件流
      const events = readEvents();
      const createdEvt = events.find(e => e.type === 'created' && e.wuId === wu.id);
      expect(createdEvt).toBeDefined();
      expect((createdEvt!.data as Record<string, unknown>).scope).toBe('事件验证');

      // index 快照
      const snap = await findSnapshot(wu.id);
      expect(snap).toBeDefined();
      expect(snap!.status).toBe('unassigned');

      // eventBus 发布
      expect(created).toHaveLength(1);
      expect(created[0].id).toBe(wu.id);
      expect(created[0].createdAt).toBeInstanceOf(Date);
    } finally {
      eventBus.unsubscribe('workunit.created', handler);
    }
  });

  it('workunit.created 订阅者抛错不阻断 create（best-effort 发布）', async () => {
    const throwing = () => { throw new Error('subscriber boom'); };
    eventBus.subscribe('workunit.created', throwing);
    try {
      const wu = await service.create({ scope: '订阅者爆炸' });
      expect(wu.id).toBeTruthy();
      expect(await findSnapshot(wu.id)).toBeDefined();
    } finally {
      eventBus.unsubscribe('workunit.created', throwing);
    }
  });

  it('type=feature + 频道无 defaultPipeline → 不展开子 WU', async () => {
    const now = new Date().toISOString();
    await fileStore.createChannel({
      id: 'ch-no-pipeline', name: '#no-pipeline', type: 'rnd',
      defaultWorkspaceId: null, defaultPath: null,
      discordChannelId: null, discordWebhookUrl: null, members: '[]',
      createdAt: now, updatedAt: now,
    });

    await service.create({ type: 'feature', scope: '特性', channelId: 'ch-no-pipeline' });

    const all = await fileStore.getIndex();
    expect(all).toHaveLength(1);
    expect(all[0].type).toBe('feature');
  });
});

// ── createFromMessage ──

describe('createFromMessage', () => {
  async function seedMessage(content: string, workUnitId: string | null = null): Promise<ChannelMessageData> {
    const msg: ChannelMessageData = {
      id: randomUUID(), channelId: 'ch-msg', workUnitId,
      authorType: 'human', agentName: null,
      content, replyToId: null, meta: '{}',
      createdAt: new Date().toISOString(),
    };
    await fileStore.appendMessage('ch-msg', msg);
    return msg;
  }

  it('消息不存在 → 抛 Message not found', async () => {
    await expect(service.createFromMessage('msg-missing')).rejects.toThrow('Message msg-missing not found');
  });

  it('消息已关联 WorkUnit → 抛 already linked', async () => {
    const msg = await seedMessage('已转换', 'wu-existing');
    await expect(service.createFromMessage(msg.id)).rejects.toThrow(
      'Message already linked to WorkUnit wu-existing',
    );
  });

  it('成功：scope=消息内容、metadata 落 sourceMessageId/creationMode、消息回写 workUnitId', async () => {
    const msg = await seedMessage('修一下登录页样式');

    const wu = await service.createFromMessage(msg.id, { type: 'bug', metadata: { priority: 'low' } });

    expect(wu.scope).toBe('修一下登录页样式');
    expect(wu.type).toBe('bug');
    expect(wu.channelId).toBe('ch-msg');
    const meta = JSON.parse(wu.metadata!) as WorkUnitMetadata;
    expect(meta.sourceMessageId).toBe(msg.id);
    expect(meta.creationMode).toBe('from-message');
    expect(meta.priority).toBe('low');

    const found = await fileStore.getMessageById(msg.id);
    expect(found!.message.workUnitId).toBe(wu.id);
  });

  it('超长消息内容截断到 500 字符作为 scope', async () => {
    const msg = await seedMessage('x'.repeat(600));

    const wu = await service.createFromMessage(msg.id);

    expect(wu.scope).toHaveLength(500);
    expect(wu.scope).toBe('x'.repeat(500));
  });
});

// ── update（patchSnapshot 边界）──

describe('update', () => {
  it('WorkUnit 不存在 → 抛 WorkUnit not found', async () => {
    await expect(service.update('wu-missing', { scope: 'x' })).rejects.toThrow('WorkUnit not found: wu-missing');
  });

  it('部分更新：只改传入字段，其余保持不变，updatedAt 前进', async () => {
    const wu = await service.create({
      scope: '旧 scope', type: 'bug', assigneeId: 'inst-1', channelId: 'ch-1',
      retryCount: 2, metadata: { priority: 'low' },
    });
    await new Promise(r => setTimeout(r, 10));

    const updated = await service.update(wu.id, { scope: '新 scope' });

    expect(updated.scope).toBe('新 scope');
    expect(updated.type).toBe('bug');
    expect(updated.assigneeId).toBe('inst-1');
    expect(updated.channelId).toBe('ch-1');
    expect(updated.retryCount).toBe(2);
    expect(JSON.parse(updated.metadata!)).toEqual({ priority: 'low' });
    expect(updated.updatedAt.getTime()).toBeGreaterThan(wu.createdAt.getTime());

    // 事件流追加了 updated 事件
    const events = readEvents();
    expect(events.some(e => e.type === 'updated' && e.wuId === wu.id)).toBe(true);
  });

  it('显式 null 清空可空字段；undefined 不动既有值', async () => {
    const timeoutAt = new Date('2026-08-10T00:00:00.000Z');
    const wu = await service.create({
      scope: '清空验证', assigneeId: 'inst-1', channelId: 'ch-1', timeoutAt,
    });

    // undefined：不动
    const untouched = await service.update(wu.id, {});
    expect(untouched.assigneeId).toBe('inst-1');
    expect(untouched.channelId).toBe('ch-1');
    expect(untouched.timeoutAt!.toISOString()).toBe(timeoutAt.toISOString());

    // 显式 null：清空
    const cleared = await service.update(wu.id, { assigneeId: null, channelId: null, timeoutAt: null });
    expect(cleared.assigneeId).toBeNull();
    expect(cleared.channelId).toBeNull();
    expect(cleared.timeoutAt).toBeNull();
  });

  it('metadata 整体替换为 JSON 字符串', async () => {
    const wu = await service.create({ scope: 'metadata 替换', metadata: { priority: 'low', files: ['a.ts'] } });

    const updated = await service.update(wu.id, { metadata: { priority: 'high' } });

    expect(JSON.parse(updated.metadata!)).toEqual({ priority: 'high' });
    const snap = (await findSnapshot(wu.id))!;
    expect(snap.metadata).toBe('{"priority":"high"}');
  });
});

// ── delete ──

describe('delete', () => {
  it('WorkUnit 不存在 → 抛 WorkUnit not found', async () => {
    await expect(service.delete('wu-missing')).rejects.toThrow('WorkUnit not found: wu-missing');
  });

  it('成功：index 移除快照 + 事件流追加 closed 事件', async () => {
    const wu = await service.create({ scope: '待删除' });

    await service.delete(wu.id);

    expect(await findSnapshot(wu.id)).toBeUndefined();
    const events = readEvents();
    const closedEvt = events.find(e => e.type === 'closed' && e.wuId === wu.id);
    expect(closedEvt).toBeDefined();
  });
});

// ── claim / unclaim（resolveClaimTimeoutAt）──

describe('claim', () => {
  it('WorkUnit 不存在 → 抛 WorkUnit not found', async () => {
    await expect(service.claim('wu-missing', 'inst-1')).rejects.toThrow('WorkUnit not found');
  });

  it('非 unassigned 状态 → 抛 Claim failed', async () => {
    const wu = await service.create({ scope: '已被认领', status: 'active', assigneeId: 'inst-1' });
    await expect(service.claim(wu.id, 'inst-2')).rejects.toThrow('Claim failed');
  });

  it('成功：active + assigneeId + claimedAt，按 type 写默认 timeoutAt，发 status_changed', async () => {
    const before = Date.now();
    const wu = await service.create({ scope: '认领任务', type: 'review', channelId: 'ch-1' });

    const claimed = await service.claim(wu.id, 'inst-1');

    expect(claimed.status).toBe('active');
    expect(claimed.assigneeId).toBe('inst-1');
    expect(claimed.claimedAt).toBeInstanceOf(Date);
    // review → 30 分钟
    const minutes = WU_TIMEOUT_MINUTES.review;
    const deltaMs = claimed.timeoutAt!.getTime() - before;
    expect(deltaMs).toBeGreaterThanOrEqual(minutes * 60_000);
    expect(deltaMs).toBeLessThanOrEqual(minutes * 60_000 + 60_000);

    const evt = statusEvents.find(e => e.id === wu.id && e.status === 'active');
    expect(evt).toBeDefined();
    expect(evt!.assigneeId).toBe('inst-1');
  });

  it('未知 type → 回落 WU_DEFAULT_TIMEOUT_MINUTES', async () => {
    const before = Date.now();
    const wu = await service.create({ scope: '未知类型', type: 'spike', channelId: 'ch-1' });

    const claimed = await service.claim(wu.id, 'inst-1');

    const deltaMs = claimed.timeoutAt!.getTime() - before;
    expect(deltaMs).toBeGreaterThanOrEqual(WU_DEFAULT_TIMEOUT_MINUTES * 60_000);
    expect(deltaMs).toBeLessThanOrEqual(WU_DEFAULT_TIMEOUT_MINUTES * 60_000 + 60_000);
  });

  it('metadata.timeoutAt 显式有效值优先于默认时长', async () => {
    const explicit = '2026-09-01T00:00:00.000Z';
    const wu = await service.create({
      scope: '显式超时', type: 'task', channelId: 'ch-1',
      metadata: { timeoutAt: explicit },
    });

    const claimed = await service.claim(wu.id, 'inst-1');

    expect(claimed.timeoutAt!.toISOString()).toBe(explicit);
  });

  it('metadata.timeoutAt 为非法日期字符串 → 回落默认时长', async () => {
    const before = Date.now();
    const wu = await service.create({
      scope: '非法显式超时', type: 'task', channelId: 'ch-1',
      metadata: { timeoutAt: 'not-a-date' },
    });

    const claimed = await service.claim(wu.id, 'inst-1');

    const deltaMs = claimed.timeoutAt!.getTime() - before;
    expect(deltaMs).toBeGreaterThanOrEqual(WU_DEFAULT_TIMEOUT_MINUTES * 60_000);
    expect(deltaMs).toBeLessThanOrEqual(WU_DEFAULT_TIMEOUT_MINUTES * 60_000 + 60_000);
  });

  it('metadata 损坏（非法 JSON）→ 不阻断 claim，回落默认 timeout', async () => {
    const before = Date.now();
    const wu = await service.create({ scope: '损坏元数据', type: 'task', channelId: 'ch-1' });
    // 绕过 create 的 JSON.stringify，直接把损坏 metadata 写进索引
    const snapshot = await findSnapshot(wu.id);
    await fileStore.upsertSnapshot({ ...snapshot!, metadata: '{broken json' });

    const claimed = await service.claim(wu.id, 'inst-1');

    expect(claimed.status).toBe('active');
    const deltaMs = claimed.timeoutAt!.getTime() - before;
    expect(deltaMs).toBeGreaterThanOrEqual(WU_TIMEOUT_MINUTES.task * 60_000);
    expect(deltaMs).toBeLessThanOrEqual(WU_TIMEOUT_MINUTES.task * 60_000 + 60_000);
  });

  it('已有 timeoutAt 列值时 claim 不覆盖', async () => {
    const preset = new Date(Date.now() + 5 * 60_000);
    const wu = await service.create({
      scope: '预设超时', type: 'task', channelId: 'ch-1', timeoutAt: preset,
    });

    const claimed = await service.claim(wu.id, 'inst-1');

    expect(claimed.timeoutAt!.toISOString()).toBe(preset.toISOString());
  });

  it('与 active/in_review WU 的 metadata.files 重叠 → 抛 File conflict', async () => {
    await service.create({
      scope: '占用文件', type: 'task', channelId: 'ch-1',
      status: 'active', assigneeId: 'inst-1',
      metadata: { files: ['src/a.ts'] },
    });
    const contender = await service.create({
      scope: '争抢文件', type: 'task', channelId: 'ch-1',
      metadata: { files: ['src/a.ts', 'src/b.ts'] },
    });

    await expect(service.claim(contender.id, 'inst-2')).rejects.toThrow(/File conflict with WorkUnit\(s\):/);
  });

  it('文件无重叠 → claim 正常成功', async () => {
    await service.create({
      scope: '占用文件', type: 'task', channelId: 'ch-1',
      status: 'active', assigneeId: 'inst-1',
      metadata: { files: ['src/a.ts'] },
    });
    const other = await service.create({
      scope: '无关文件', type: 'task', channelId: 'ch-1',
      metadata: { files: ['src/c.ts'] },
    });

    const claimed = await service.claim(other.id, 'inst-2');
    expect(claimed.status).toBe('active');
  });
});

describe('unclaim', () => {
  it('WorkUnit 不存在 → 抛 WorkUnit not found', async () => {
    await expect(service.unclaim('wu-missing')).rejects.toThrow('WorkUnit not found: wu-missing');
  });

  it('成功：回到 unassigned、清 assigneeId/claimedAt，发 status_changed', async () => {
    const wu = await service.create({ scope: '释放任务', type: 'task', channelId: 'ch-1' });
    await service.claim(wu.id, 'inst-1');
    statusEvents.length = 0;

    const released = await service.unclaim(wu.id);

    expect(released.status).toBe('unassigned');
    expect(released.assigneeId).toBeNull();
    expect(released.claimedAt).toBeNull();

    const evt = statusEvents.find(e => e.id === wu.id && e.status === 'unassigned');
    expect(evt).toBeDefined();
    expect(evt!.assigneeId).toBeNull();

    // 事件流追加了 updated 事件
    const events = readEvents();
    expect(events.some(e => e.type === 'updated' && e.wuId === wu.id)).toBe(true);
  });
});
