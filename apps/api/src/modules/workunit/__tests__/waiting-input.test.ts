// F5 双向沟通：waiting-input（挂起恢复 + 超时提醒）测试
// 约定与 message-routing.test.ts 一致：真实 FileStore（tmpdir）+ 真实 WorkUnitService
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { v4 as uuidv4 } from 'uuid';
import { FileStore, type ChannelMessageData } from '@dommaker/studio-shared';
import { WorkUnitService, type WorkUnitMetadata } from '../workunit.service.js';
import {
  resumeWaitingWorkUnit,
  scanWaitingForInputReminders,
  getReminderThresholdMs,
} from '../waiting-input.js';

const { mockPostWuSystemMessage } = vi.hoisted(() => ({ mockPostWuSystemMessage: vi.fn() }));

// wu-messenger 间谍包装：真实发送保留（消息断言不受影响），另断言委托参数（milestone 等）
vi.mock('../wu-messenger.js', async (importOriginal) => {
  const orig = await importOriginal() as { postWuSystemMessage: (...args: unknown[]) => Promise<unknown> };
  mockPostWuSystemMessage.mockImplementation(orig.postWuSystemMessage);
  return { ...orig, postWuSystemMessage: mockPostWuSystemMessage };
});

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'waiting-input-test-'));
let fileStore: FileStore;
let wuService: WorkUnitService;
let channelId: string;

function metaOf(snapshot: { metadata: string | null }): WorkUnitMetadata {
  return snapshot.metadata ? JSON.parse(snapshot.metadata) : {};
}

async function findWu(id: string) {
  const snapshots = await fileStore.getIndex();
  return snapshots.find(s => s.id === id)!;
}

/** 创建挂起中的 WorkUnit（blocked + waitingForInput）并写一条 anchor 消息 */
async function createParkedWorkUnit(overrides?: Partial<WorkUnitMetadata>, waitingSince?: string) {
  const wu = await wuService.create({
    scope: '实现登录功能',
    channelId,
    type: 'task',
    status: 'active',
    assigneeId: 'instance-1',
    metadata: { title: '登录功能' },
  });
  await wuService.transitionStatus(wu.id, 'blocked');
  const parkedMeta: WorkUnitMetadata = {
    title: '登录功能',
    waitingForInput: true,
    waitingQuestion: '使用 OAuth 还是账号密码？',
    waitingSince: waitingSince ?? new Date().toISOString(),
    waitingReminded: false,
    ...overrides,
  };
  await wuService.update(wu.id, { metadata: parkedMeta });

  const anchor: ChannelMessageData = {
    id: uuidv4(), channelId, authorType: 'human', agentName: null,
    content: '@agent 实现登录功能', replyToId: null, meta: '{}',
    workUnitId: wu.id, createdAt: new Date().toISOString(),
  };
  await fileStore.appendMessage(channelId, anchor);
  return { wu, anchor };
}

beforeEach(async () => {
  mockPostWuSystemMessage.mockClear(); // 清调用记录（保留间谍包装的实现）
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  fileStore = new FileStore(tmpDir);
  wuService = new WorkUnitService(fileStore);
  channelId = `ch-waiting-${Date.now()}`;
  await fileStore.createChannel({
    id: channelId, name: '#waiting-test', type: 'rnd',
    defaultWorkspaceId: null, defaultPath: null,
    discordChannelId: null, discordWebhookUrl: null, members: '[]',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('resumeWaitingWorkUnit', () => {
  it('人类回复 → 解除挂起（blocked → active），回复写入 pendingReplies（无挂载 loop 也生效）', async () => {
    const { wu } = await createParkedWorkUnit();

    // 注意：此处没有任何 AgentLoop 挂载 —— 恢复只依赖 WorkUnit 状态
    const resumed = await resumeWaitingWorkUnit(wu.id, '用 OAuth', fileStore);

    expect(resumed).toBe(true);
    const after = await findWu(wu.id);
    expect(after.status).toBe('active');
    const meta = metaOf(after);
    expect(meta.waitingForInput).toBe(false);
    expect(meta.waitingReminded).toBe(false);
    expect(meta.pendingReplies).toEqual(['用 OAuth']);
  });

  it('恢复前多条回复 → 追加拼接', async () => {
    const { wu } = await createParkedWorkUnit();

    await resumeWaitingWorkUnit(wu.id, '用 OAuth', fileStore);
    // 第二条回复到达时 loop 尚未消费 pendingReplies（仍 active）
    const again = await resumeWaitingWorkUnit(wu.id, '只接 Google', fileStore);

    expect(again).toBe(true);
    const meta = metaOf(await findWu(wu.id));
    expect(meta.pendingReplies).toEqual(['用 OAuth', '只接 Google']);
  });

  it('卡住型 blocked（无 waitingForInput）不恢复', async () => {
    const { wu } = await createParkedWorkUnit({ waitingForInput: false });

    const resumed = await resumeWaitingWorkUnit(wu.id, 'hello', fileStore);

    expect(resumed).toBe(false);
    expect((await findWu(wu.id)).status).toBe('blocked');
  });

  it('active WorkUnit（无 pendingReplies）不处理', async () => {
    const wu = await wuService.create({ scope: 't', channelId, type: 'task', status: 'active', assigneeId: 'i-1' });

    const resumed = await resumeWaitingWorkUnit(wu.id, 'hello', fileStore);

    expect(resumed).toBe(false);
    expect((await findWu(wu.id)).status).toBe('active');
  });

  it('WorkUnit 不存在 → false，不抛错', async () => {
    await expect(resumeWaitingWorkUnit('no-such-wu', 'hi', fileStore)).resolves.toBe(false);
  });

  it('#170（决策 #65-1）: 并发人类回复经锁内合并写不丢（pendingReplies 全部保留）', async () => {
    const { wu } = await createParkedWorkUnit();

    // 第一条回复解除挂起（→ active + pendingReplies=['回复1']）
    await resumeWaitingWorkUnit(wu.id, '回复1', fileStore);
    // 已恢复但 loop 尚未消费 pendingReplies 的窗口内，两条回复并发到达
    await Promise.all([
      resumeWaitingWorkUnit(wu.id, '回复2', fileStore),
      resumeWaitingWorkUnit(wu.id, '回复3', fileStore),
    ]);

    const meta = metaOf(await findWu(wu.id));
    expect(meta.pendingReplies).toHaveLength(3);
    expect(meta.pendingReplies).toEqual(expect.arrayContaining(['回复1', '回复2', '回复3']));
  });
});

describe('scanWaitingForInputReminders', () => {
  it('挂起超过阈值 → 发一条提醒（含标题与问题摘要），并标记 waitingReminded', async () => {
    const old = new Date(Date.now() - 31 * 60_000).toISOString();
    const { wu, anchor } = await createParkedWorkUnit({}, old);

    const count = await scanWaitingForInputReminders(fileStore);

    expect(count).toBe(1);
    const messages = await fileStore.queryMessages(channelId, { workUnitId: wu.id });
    const reminders = messages.filter(m => m.content.includes('正在等待你的回复'));
    expect(reminders).toHaveLength(1);
    expect(reminders[0].content).toContain('登录功能');
    expect(reminders[0].content).toContain('使用 OAuth 还是账号密码？');
    expect(reminders[0].authorType).toBe('agent');
    expect(reminders[0].replyToId).toBe(anchor.id); // 挂在同一线程
    // 2026-07 PMO-flow UX §10：超时提醒 → 以里程碑消息委托 wu-messenger
    expect(mockPostWuSystemMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: wu.id }),
      expect.stringContaining('正在等待你的回复'),
      expect.objectContaining({ milestone: true, fileStore }),
    );
    expect(metaOf(await findWu(wu.id)).waitingReminded).toBe(true);
  });

  it('同一挂起只提醒一次（重复扫描不再发）', async () => {
    const old = new Date(Date.now() - 31 * 60_000).toISOString();
    await createParkedWorkUnit({}, old);

    expect(await scanWaitingForInputReminders(fileStore)).toBe(1);
    expect(await scanWaitingForInputReminders(fileStore)).toBe(0);
    expect(await scanWaitingForInputReminders(fileStore)).toBe(0);
  });

  it('未超阈值的挂起不提醒', async () => {
    await createParkedWorkUnit(); // waitingSince = now

    expect(await scanWaitingForInputReminders(fileStore)).toBe(0);
  });

  it('恢复后重置提醒标记 → 下次挂起可再提醒', async () => {
    const old = new Date(Date.now() - 31 * 60_000).toISOString();
    const { wu } = await createParkedWorkUnit({}, old);
    await scanWaitingForInputReminders(fileStore);

    // 人类回复恢复（waitingReminded 重置）
    await resumeWaitingWorkUnit(wu.id, '用 OAuth', fileStore);
    expect(metaOf(await findWu(wu.id)).waitingReminded).toBe(false);

    // 恢复后不再提醒（已不再挂起）
    expect(await scanWaitingForInputReminders(fileStore)).toBe(0);
  });
});

describe('getReminderThresholdMs', () => {
  it('默认 30 分钟', () => {
    expect(getReminderThresholdMs({})).toBe(30 * 60_000);
  });

  it('STUDIO_INPUT_REMINDER_MINUTES 覆盖', () => {
    expect(getReminderThresholdMs({ STUDIO_INPUT_REMINDER_MINUTES: '5' })).toBe(5 * 60_000);
  });

  it('非法值回落默认', () => {
    expect(getReminderThresholdMs({ STUDIO_INPUT_REMINDER_MINUTES: 'abc' })).toBe(30 * 60_000);
    expect(getReminderThresholdMs({ STUDIO_INPUT_REMINDER_MINUTES: '-3' })).toBe(30 * 60_000);
  });
});
