// #523 P0-3 人闸催办与认领滞留（#516 决议③④，2026-09-12 定案）——gate-escalation 分层催办扫描测试
// 约定与 waiting-input.test.ts 一致：真实 FileStore（tmpdir）+ 真实 WorkUnitService。
// 通知面走 setup-isolated-data 的隔离根（NotificationService 落 studioPath('logs')，
// users 清单读 studioPath('data/users')），每用例现造 user-a；tier2 的 notifyAlert 用间谍替身。
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore, eventBus } from '@dommaker/studio-shared';
import { NotificationService } from '@dommaker/studio-notification';
import { WorkUnitService, type WorkUnitMetadata } from '../workunit.service.js';
import { scanGateEscalationReminders } from '../gate-escalation.js';

const { mockNotifyAlert } = vi.hoisted(() => ({ mockNotifyAlert: vi.fn() }));

// tier2 外推通道（企微 webhook + 告警频道 + 行动中心）在 notifier.ts 自有测试覆盖，
// 此处只验证委托（级别/文案/wuId 直链），替身隔断对真实 FileStore/网络的 fan-out
vi.mock('../../../utils/notifier.js', () => ({ notifyAlert: mockNotifyAlert }));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-escalation-test-'));
let fileStore: FileStore;
let wuService: WorkUnitService;

/** setup-isolated-data 隔离根下的 notifications.jsonl（NotificationService 模块级常量路径） */
const notificationsJsonl = () => path.join(process.env.STUDIO_HOME!, 'logs', 'notifications.jsonl');
const usersDir = () => path.join(process.env.STUDIO_DATA_DIR!, 'users');

/** tier1 通知回读（隔离根内真实 NotificationService） */
async function readNotifications(userId = 'user-a') {
  return new NotificationService(new FileStore()).getUserNotifications(userId);
}

function metaOf(snapshot: { metadata: string | null }): WorkUnitMetadata {
  return snapshot.metadata ? JSON.parse(snapshot.metadata) : {};
}

async function findWu(id: string) {
  const [snapshot] = await fileStore.getIndex({ id });
  return snapshot!;
}

/** 建单（显式 status 直落，updatedAt 锚 = 建单时刻；老化靠 scan 的 now 参数前推） */
async function createWu(opts: { status: string; type?: string; title?: string }) {
  const title = opts.title ?? '测试任务';
  return wuService.create({
    scope: title,
    type: opts.type ?? 'analysis',
    status: opts.status,
    metadata: { title },
  });
}

/** notification.created SSE 信封捕获（eventBus 'events' topic 直收） */
let sseEnvelopes: Array<{ event_type: string; data: Record<string, unknown> }>;
const sseHandler = (envelope: { event_type?: string; data?: Record<string, unknown> }) => {
  if (envelope?.event_type === 'notification.created') {
    sseEnvelopes.push(envelope as { event_type: string; data: Record<string, unknown> });
  }
};

const MIN = 60_000;
const HOUR = 60 * MIN;
const futureNow = (ms: number) => new Date(Date.now() + ms);

beforeEach(async () => {
  mockNotifyAlert.mockClear();
  mockNotifyAlert.mockResolvedValue(undefined);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  fileStore = new FileStore(tmpDir);
  wuService = new WorkUnitService(fileStore);
  // 通知面清场 + 全用户清单造一个 user-a（createForAllUsers 遍历 data/users/*.json）
  fs.rmSync(notificationsJsonl(), { force: true });
  fs.rmSync(usersDir(), { recursive: true, force: true });
  fs.mkdirSync(usersDir(), { recursive: true });
  fs.writeFileSync(path.join(usersDir(), 'user-a.json'), '{}');
  sseEnvelopes = [];
  eventBus.subscribe('events', sseHandler);
});

afterEach(() => {
  eventBus.unsubscribe('events', sseHandler);
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('scanGateEscalationReminders — in_review 人闸催办', () => {
  it('闸门类 in_review 超 30min → tier1：全用户通知 + SSE notification.created + 一次性标记，复扫不重发', async () => {
    const wu = await createWu({ status: 'in_review', title: '登录方案决策' });
    const before = await findWu(wu.id);

    const result = await scanGateEscalationReminders(fileStore, futureNow(31 * MIN));

    expect(result).toEqual({ tier1: 1, tier2: 0 });
    // Web 铃铛：持久通知一条（gate_reminder，带 wuId 直链）
    const notifications = await readNotifications();
    expect(notifications).toHaveLength(1);
    expect(notifications[0].type).toBe('gate_reminder');
    expect(notifications[0].title).toContain('登录方案决策');
    expect(notifications[0].title).toContain('30');
    expect(notifications[0].wuId).toBe(wu.id);
    expect(notifications[0].link).toBe(`/workunits/${wu.id}`);
    // SSE 信封：前端铃铛即时失效 + 浏览器原生通知的数据源
    expect(sseEnvelopes).toHaveLength(1);
    expect(sseEnvelopes[0].data).toMatchObject({ wuId: wu.id, link: `/workunits/${wu.id}` });
    expect(String(sseEnvelopes[0].data.title)).toContain('登录方案决策');
    // 一次性标记写入；tier2 未触发
    const after = metaOf(await findWu(wu.id));
    expect(typeof after.gateReminderTier1At).toBe('string');
    expect(after.gateReminderTier2At).toBeUndefined();
    expect(mockNotifyAlert).not.toHaveBeenCalled();
    // 标记写是簿记，不得推进 updatedAt（锚 = 转入 in_review 时刻，动了会让 tier2 永远迟到）
    expect((await findWu(wu.id)).updatedAt).toBe(before.updatedAt);

    // 复扫不重发（每层一次性）
    const again = await scanGateEscalationReminders(fileStore, futureNow(35 * MIN));
    expect(again).toEqual({ tier1: 0, tier2: 0 });
    expect(await readNotifications()).toHaveLength(1);
    expect(sseEnvelopes).toHaveLength(1);
  });

  it('未超龄（29min）不催', async () => {
    await createWu({ status: 'in_review' });

    const result = await scanGateEscalationReminders(fileStore, futureNow(29 * MIN));

    expect(result).toEqual({ tier1: 0, tier2: 0 });
    expect(await readNotifications()).toHaveLength(0);
    expect(sseEnvelopes).toHaveLength(0);
  });

  it('非闸门类 in_review（task）超龄不催；其他状态（active 闸门类）不在扫描面', async () => {
    await createWu({ status: 'in_review', type: 'task', title: '代码任务' });
    await createWu({ status: 'active', title: '执行中的分析' });

    const result = await scanGateEscalationReminders(fileStore, futureNow(5 * HOUR));

    expect(result).toEqual({ tier1: 0, tier2: 0 });
    expect(await readNotifications()).toHaveLength(0);
    expect(mockNotifyAlert).not.toHaveBeenCalled();
  });

  it('超 4h → tier2 走 notifyAlert(warning) 且标记独立：tier1 同扫补发一次，复扫两层都不重发', async () => {
    const wu = await createWu({ status: 'in_review', title: '验收单' });

    const result = await scanGateEscalationReminders(fileStore, futureNow(4 * HOUR + 1 * MIN));

    expect(result).toEqual({ tier1: 1, tier2: 1 });
    // tier2 到点即发，不要求 tier1 前置状态；走既有告警通路（wuId 直链）
    expect(mockNotifyAlert).toHaveBeenCalledTimes(1);
    const [level, title, , opts] = mockNotifyAlert.mock.calls[0];
    expect(level).toBe('warning');
    expect(String(title)).toContain('验收单');
    expect(opts).toEqual({ wuId: wu.id });
    // 两层标记各自独立
    const after = metaOf(await findWu(wu.id));
    expect(typeof after.gateReminderTier1At).toBe('string');
    expect(typeof after.gateReminderTier2At).toBe('string');

    const again = await scanGateEscalationReminders(fileStore, futureNow(5 * HOUR));
    expect(again).toEqual({ tier1: 0, tier2: 0 });
    expect(mockNotifyAlert).toHaveBeenCalledTimes(1);
  });
});

describe('scanGateEscalationReminders — unassigned 认领滞留', () => {
  it('unassigned 超 15min → tier1：通知 + SSE + 标记，复扫不重发', async () => {
    const wu = await createWu({ status: 'unassigned', type: 'task', title: '派发无人接' });

    const result = await scanGateEscalationReminders(fileStore, futureNow(16 * MIN));

    expect(result).toEqual({ tier1: 1, tier2: 0 });
    const notifications = await readNotifications();
    expect(notifications).toHaveLength(1);
    expect(notifications[0].title).toContain('派发无人接');
    expect(notifications[0].title).toContain('15');
    expect(notifications[0].wuId).toBe(wu.id);
    expect(sseEnvelopes).toHaveLength(1);
    expect(metaOf(await findWu(wu.id)).gateReminderTier1At).toBeDefined();

    expect(await scanGateEscalationReminders(fileStore, futureNow(20 * MIN))).toEqual({ tier1: 0, tier2: 0 });
    expect(await readNotifications()).toHaveLength(1);
  });

  it('未超龄（14min）不催；unassigned 超 4h 同样升 tier2', async () => {
    const fresh = await createWu({ status: 'unassigned', type: 'task', title: '刚派发' });
    expect(await scanGateEscalationReminders(fileStore, futureNow(14 * MIN))).toEqual({ tier1: 0, tier2: 0 });
    expect(metaOf(await findWu(fresh.id)).gateReminderTier1At).toBeUndefined();

    const stale = await createWu({ status: 'unassigned', type: 'task', title: '滞留单' });
    const result = await scanGateEscalationReminders(fileStore, futureNow(4 * HOUR + 1 * MIN));
    // fresh 也随时间前推超龄：tier1 两张 + tier2 两张（fresh 的 tier2 同样到点）
    expect(result.tier2).toBe(2);
    expect(mockNotifyAlert).toHaveBeenCalledTimes(2);
    expect(metaOf(await findWu(stale.id)).gateReminderTier2At).toBeDefined();
  });
});
