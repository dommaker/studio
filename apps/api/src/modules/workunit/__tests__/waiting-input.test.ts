// F5 双向沟通：waiting-input（挂起恢复 + 超时提醒）测试
// #176（决策 #57 D2/D3）：复活扩全 blocked + 「关闭」指令 + CTA 统一 + 提醒扫描扩面
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
  resumeBlockedWorkUnitFromWeb,
  closeBlockedWorkUnitFromWeb,
  WEB_RESUME_PLACEHOLDER,
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
let studioEventsFile: string;

/** 读测试隔离的 studio-events.jsonl（STUDIO_EVENTS_FILE 指向），返回解析后的事件行 */
function readStudioEvents(): Array<{ type: string; payload: string; level?: string }> {
  if (!fs.existsSync(studioEventsFile)) return [];
  return fs.readFileSync(studioEventsFile, 'utf8')
    .split('\n').filter(Boolean)
    .map(line => JSON.parse(line));
}

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
  studioEventsFile = path.join(tmpDir, 'studio-events.jsonl');
  process.env.STUDIO_EVENTS_FILE = studioEventsFile; // 事件落盘隔离到 tmpdir
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
  delete process.env.STUDIO_EVENTS_FILE;
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

  it('#176（决策 #57 D2）：卡住型 blocked（无 waitingForInput）回复即复活 —— 重置 consecutiveStuck/blockReason、记 resumeCount、timeoutReleaseCount 终身保留', async () => {
    const { wu } = await createParkedWorkUnit({
      waitingForInput: false,
      consecutiveStuck: 3,
      blockReason: 'stuck: 连续 3 步无进展',
      timeoutReleaseCount: 3,
    });

    const resumed = await resumeWaitingWorkUnit(wu.id, '重试，换方案 B', fileStore);

    expect(resumed).toBe(true);
    const after = await findWu(wu.id);
    expect(after.status).toBe('active');
    const meta = metaOf(after);
    expect(meta.consecutiveStuck).toBe(0);
    expect(meta.blockReason).toBeUndefined();
    expect(meta.resumeCount).toBe(1);
    expect(meta.timeoutReleaseCount).toBe(3); // 终身保留（#63 的 3 次上限不可被复活绕过）
    expect(meta.pendingReplies).toEqual(['重试，换方案 B']);
  });

  it('#176（决策 #57 D5）：复活不限次，resumeCount 在既有值上累加（观测钩子）', async () => {
    const { wu } = await createParkedWorkUnit({ waitingForInput: false, resumeCount: 2 });

    await resumeWaitingWorkUnit(wu.id, '继续', fileStore);

    expect(metaOf(await findWu(wu.id)).resumeCount).toBe(3);
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

describe('#176（决策 #57 D2）：「关闭」显式关闭指令', () => {
  it('blocked 线程回复「关闭」→ closed + 频道确认 + workunit:closed 结构化事件（双出声）', async () => {
    const { wu } = await createParkedWorkUnit({
      waitingForInput: false,
      blockReason: 'stuck: 连续 3 步无进展',
      blockedAt: new Date().toISOString(),
    });

    const handled = await resumeWaitingWorkUnit(wu.id, '关闭', fileStore);

    expect(handled).toBe(true);
    const after = await findWu(wu.id);
    expect(after.status).toBe('closed');
    // 关闭指令不进入 pendingReplies（不复活、无下一步可注入）
    expect(metaOf(after).pendingReplies ?? []).toEqual([]);
    // 频道出声
    const messages = await fileStore.queryMessages(channelId, { workUnitId: wu.id });
    expect(messages.some(m => m.content.includes('已按你的要求关闭'))).toBe(true);
    // 结构化事件出声（含原因与关闭来源）
    const closedEvents = readStudioEvents()
      .filter(e => e.type === 'workunit:closed')
      .map(e => ({ ...e, payload: JSON.parse(e.payload) }));
    expect(closedEvents).toHaveLength(1);
    expect(closedEvents[0].payload).toMatchObject({
      workUnitId: wu.id,
      closedBy: 'human-command',
    });
  });

  it('「关闭」容忍首尾空白（「  关闭  」同样生效）', async () => {
    const { wu } = await createParkedWorkUnit({ waitingForInput: false });

    const handled = await resumeWaitingWorkUnit(wu.id, '  关闭\n', fileStore);

    expect(handled).toBe(true);
    expect((await findWu(wu.id)).status).toBe('closed');
  });

  it('decision/spec 裁剪状态机无 closed → 关闭被拒，频道说明，状态不变', async () => {
    const wu = await wuService.create({
      scope: '决策单', channelId, type: 'decision', status: 'unassigned',
      metadata: { title: '决策单' },
    });
    await wuService.transitionStatus(wu.id, 'active');
    await wuService.transitionStatus(wu.id, 'blocked');

    const handled = await resumeWaitingWorkUnit(wu.id, '关闭', fileStore);

    expect(handled).toBe(true); // 指令已被消费（拒绝也是一种处理）
    expect((await findWu(wu.id)).status).toBe('blocked');
    const messages = await fileStore.queryMessages(channelId, { workUnitId: wu.id });
    expect(messages.some(m => m.content.includes('不支持'))).toBe(true);
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
    // #176（决策 #57 D3-1）：提醒携带统一 CTA（回复继续 / 回复「关闭」/ 24h 死信预告）
    expect(reminders[0].content).toContain('回复本线程即可继续执行');
    expect(reminders[0].content).toContain('回复「关闭」即可');
    expect(reminders[0].content).toContain('24 小时无介入将自动关闭');
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

  it('#176（决策 #57 D3-2）：扫描扩面 —— 非 waitingForInput 的卡住型 blocked 同样提醒（含原因摘要 + 统一 CTA）', async () => {
    const blockedAt = new Date(Date.now() - 31 * 60_000).toISOString();
    const wu = await wuService.create({
      scope: '卡住的任务', channelId, type: 'task', status: 'active', assigneeId: 'instance-1',
      metadata: { title: '卡住的任务' },
    });
    await wuService.transitionStatus(wu.id, 'blocked');
    await wuService.update(wu.id, {
      metadata: { title: '卡住的任务', blockReason: 'stuck: 连续 3 步无进展', blockedAt },
    });
    const anchor: ChannelMessageData = {
      id: uuidv4(), channelId, authorType: 'human', agentName: null,
      content: '@agent 卡住的任务', replyToId: null, meta: '{}',
      workUnitId: wu.id, createdAt: new Date().toISOString(),
    };
    await fileStore.appendMessage(channelId, anchor);

    const count = await scanWaitingForInputReminders(fileStore);

    expect(count).toBe(1);
    const messages = await fileStore.queryMessages(channelId, { workUnitId: wu.id });
    const reminders = messages.filter(m => m.content.includes('回复本线程即可继续执行'));
    expect(reminders).toHaveLength(1);
    expect(reminders[0].content).toContain('卡住的任务');
    expect(reminders[0].content).toContain('stuck: 连续 3 步无进展'); // blockReason 摘要
    expect(metaOf(await findWu(wu.id)).waitingReminded).toBe(true);
    // 一次性标记：复扫不再发
    expect(await scanWaitingForInputReminders(fileStore)).toBe(0);
  });

  it('#176（决策 #57 D3-2）：提醒计时基准取 blockedAt（刚 blocked 的老 WU 不被秒提醒）', async () => {
    const wu = await wuService.create({
      scope: '老任务刚卡住', channelId, type: 'task', status: 'active', assigneeId: 'instance-1',
      metadata: { title: '老任务刚卡住' },
    });
    await wuService.transitionStatus(wu.id, 'blocked');
    // blockedAt 仅 10 分钟前（< 30min 阈值），即使 updatedAt 更老也不提醒
    await wuService.update(wu.id, {
      metadata: { title: '老任务刚卡住', blockReason: 'stuck: x', blockedAt: new Date(Date.now() - 10 * 60_000).toISOString() },
    });

    expect(await scanWaitingForInputReminders(fileStore)).toBe(0);
  });
});

describe('#185（决策 #87 D2）：Web 按钮通道（纯授权复活 + 关闭原语）', () => {
  it('卡住型 blocked → resumeBlockedWorkUnitFromWeb：共享复活原语（重置计数 + 固定占位文案注入 pendingReplies）+ Studio 里程碑消息（#62 双出声）', async () => {
    const { wu } = await createParkedWorkUnit({
      waitingForInput: false,
      consecutiveStuck: 3,
      blockReason: 'stuck: 连续 3 步无进展',
      timeoutReleaseCount: 2,
      resumeCount: 1,
    });

    const resumed = await resumeBlockedWorkUnitFromWeb(wu.id, fileStore);

    expect(resumed).toBe(true);
    const after = await findWu(wu.id);
    expect(after.status).toBe('active');
    const meta = metaOf(after);
    expect(meta.consecutiveStuck).toBe(0);
    expect(meta.blockReason).toBeUndefined();
    expect(meta.resumeCount).toBe(2); // 既有值上累加
    expect(meta.timeoutReleaseCount).toBe(2); // 终身保留
    expect(meta.pendingReplies).toEqual([WEB_RESUME_PLACEHOLDER]);
    expect(WEB_RESUME_PLACEHOLDER).toBe('（人类在 Web 端授权继续执行）');
    // #62 双出声：按钮动作在频道不可见 → 补 Studio 系统消息里程碑
    expect(mockPostWuSystemMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: wu.id }),
      expect.stringContaining('继续执行'),
      expect.objectContaining({ milestone: true, fileStore }),
    );
  });

  it('NEED_INPUT 型 blocked 同样可复活（端点不设类型门槛，分类型显示是 UI 层决策 D3）', async () => {
    const { wu } = await createParkedWorkUnit(); // waitingForInput: true

    const resumed = await resumeBlockedWorkUnitFromWeb(wu.id, fileStore);

    expect(resumed).toBe(true);
    expect((await findWu(wu.id)).status).toBe('active');
  });

  it('active WorkUnit（无 pendingReplies）→ false，不动状态', async () => {
    const wu = await wuService.create({ scope: 't', channelId, type: 'task', status: 'active', assigneeId: 'i-1' });

    await expect(resumeBlockedWorkUnitFromWeb(wu.id, fileStore)).resolves.toBe(false);
    expect((await findWu(wu.id)).status).toBe('active');
  });

  it('WorkUnit 不存在 → false，不抛错', async () => {
    await expect(resumeBlockedWorkUnitFromWeb('no-such-wu', fileStore)).resolves.toBe(false);
  });

  it('blocked task → closeBlockedWorkUnitFromWeb：closed + 频道确认 + workunit:closed 事件（human-command，死信关闭路径）', async () => {
    const { wu } = await createParkedWorkUnit({
      waitingForInput: false,
      blockReason: 'stuck: 连续 3 步无进展',
      blockedAt: new Date().toISOString(),
    });

    const outcome = await closeBlockedWorkUnitFromWeb(wu.id, fileStore);

    expect(outcome).toBe('closed');
    expect((await findWu(wu.id)).status).toBe('closed');
    const messages = await fileStore.queryMessages(channelId, { workUnitId: wu.id });
    expect(messages.some(m => m.content.includes('已按你的要求关闭'))).toBe(true);
    const closedEvents = readStudioEvents()
      .filter(e => e.type === 'workunit:closed')
      .map(e => ({ ...e, payload: JSON.parse(e.payload) }));
    expect(closedEvents).toHaveLength(1);
    expect(closedEvents[0].payload).toMatchObject({
      workUnitId: wu.id,
      closedBy: 'human-command',
    });
  });

  it('decision 类型（裁剪状态机无 closed）→ rejected-no-closed-state + 频道说明，状态不变', async () => {
    const wu = await wuService.create({
      scope: '决策单', channelId, type: 'decision', status: 'unassigned',
      metadata: { title: '决策单' },
    });
    await wuService.transitionStatus(wu.id, 'active');
    await wuService.transitionStatus(wu.id, 'blocked');

    const outcome = await closeBlockedWorkUnitFromWeb(wu.id, fileStore);

    expect(outcome).toBe('rejected-no-closed-state');
    expect((await findWu(wu.id)).status).toBe('blocked');
    const messages = await fileStore.queryMessages(channelId, { workUnitId: wu.id });
    expect(messages.some(m => m.content.includes('不支持'))).toBe(true);
  });

  it('非 blocked / 不存在 → not-found-or-not-blocked', async () => {
    const wu = await wuService.create({ scope: 't', channelId, type: 'task', status: 'active', assigneeId: 'i-1' });

    await expect(closeBlockedWorkUnitFromWeb(wu.id, fileStore)).resolves.toBe('not-found-or-not-blocked');
    await expect(closeBlockedWorkUnitFromWeb('no-such-wu', fileStore)).resolves.toBe('not-found-or-not-blocked');
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
