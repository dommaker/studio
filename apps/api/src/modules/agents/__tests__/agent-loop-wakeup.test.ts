// #330: AgentLoop 事件驱动唤醒 + observe 扫描裁剪（channelIds 预过滤）
// 真实 FileStore（tmpdir）+ 真实 WorkUnitService + 真实 eventBus；
// child_process（健康探针）/ studio-agent（CLI 执行）/ knowledge-service / trigger-registry mock
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore, eventBus } from '@dommaker/studio-shared';
import { WorkUnitService } from '../../workunit/workunit.service.js';

const { mockExecSync } = vi.hoisted(() => ({
  mockExecSync: vi.fn().mockReturnValue('Claude Code CLI version 1.0.0'),
}));

vi.mock('child_process', () => ({
  execSync: mockExecSync,
}));

vi.mock('@dommaker/studio-agent', () => ({
  agentRunner: {
    executeLightweight: vi.fn(),
  },
}));

vi.mock('../../knowledge/knowledge-service', () => ({
  knowledgeService: {
    injectContext: vi.fn().mockResolvedValue({ prompt: '', injectedIds: [] }),
    recordOutcome: vi.fn().mockResolvedValue(undefined),
    extractFromExecution: vi.fn().mockResolvedValue(undefined),
  },
}));

const { mockTriggerScheduler } = vi.hoisted(() => ({
  mockTriggerScheduler: {
    registerTrigger: vi.fn(),
    unregisterTrigger: vi.fn(),
    registerExecuteHandler: vi.fn(),
    getStates: vi.fn().mockReturnValue([]),
  },
}));

vi.mock('../../triggers/trigger-registry', () => ({
  getTriggerScheduler: () => mockTriggerScheduler,
}));

import { AgentLoop } from '../loop/agent-loop';

const mockRole = {
  id: 'role-wakeup',
  name: 'wakeup-agent',
  description: '#330 test agent',
  channels: '[]',
  status: 'active',
  createdAt: new Date(),
  updatedAt: new Date(),
};

/** 私有 seam 访问（TS private 仅编译期） */
interface LoopSeam {
  instance: { id: string } | null;
}

describe('#330: observe 扫描裁剪 + 事件驱动唤醒', () => {
  let testDir: string;
  let fileStore: FileStore;
  let wuService: WorkUnitService;
  let agentLoop: AgentLoop;
  let channelId: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockExecSync.mockReturnValue('Claude Code CLI version 1.0.0');
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loop-wakeup-'));
    fileStore = new FileStore(testDir);
    wuService = new WorkUnitService(fileStore);
    channelId = `ch-wakeup-${Date.now()}`;
    await fileStore.createChannel({
      id: channelId, name: '#wakeup-test', type: 'rnd',
      defaultWorkspaceId: null, defaultPath: null,
      discordChannelId: null, discordWebhookUrl: null, members: '[]',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
  });

  afterEach(async () => {
    if (agentLoop) {
      agentLoop.stop();
      await Promise.race([
        agentLoop.waitForStop(),
        new Promise(resolve => setTimeout(resolve, 2000)),
      ]);
    }
    eventBus.unsubscribeAll('channel.message_sent');
    fs.rmSync(testDir, { recursive: true, force: true });
  }, 5000);

  /** 启动 loop 并等首轮 observe 完成（getIndex 被调 = observe 跑过） */
  async function startAndWaitFirstObserve(): Promise<string> {
    agentLoop = new AgentLoop(mockRole, fileStore);
    const indexSpy = vi.spyOn(fileStore, 'getIndex');
    await agentLoop.start();
    await vi.waitFor(() => {
      expect(indexSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    }, { timeout: 3000, interval: 20 });
    const seam = agentLoop as unknown as LoopSeam;
    expect(seam.instance).toBeTruthy();
    return seam.instance!.id;
  }

  /** 建一个 blocked（挂起等人类回复）的 WU 挂到本实例——loop 保持空闲但 myActive 非空 */
  async function createBlockedWu(instanceId: string, ch: string | null) {
    return wuService.create({
      scope: '挂起等回复的任务', channelId: ch, type: 'task',
      status: 'blocked', assigneeId: instanceId,
      metadata: { waitingForInput: true, waitingSince: new Date().toISOString() },
    });
  }

  /** 触发一轮 observe 刷新 myActive 缓存（直接 await seam observe；
   *  workunit.created 的 EXECUTE handler 只校验已注册——其内部 fire-and-forget 不可 await） */
  async function refreshObserve() {
    const handler = mockTriggerScheduler.registerExecuteHandler.mock.calls
      .find(c => c[0] === `agent-loop-${mockRole.id}-observe`)?.[1] as (() => Promise<void>) | undefined;
    expect(handler).toBeTruthy();
    await (agentLoop as unknown as { observe(): Promise<unknown> }).observe();
  }

  it('observe 调 queryAllMessages 时传 myActive 频道集合（channelIds 预过滤）', async () => {
    const instanceId = await startAndWaitFirstObserve();
    const wu = await createBlockedWu(instanceId, channelId);
    const querySpy = vi.spyOn(fileStore, 'queryAllMessages');

    await refreshObserve();

    expect(querySpy).toHaveBeenCalledWith(expect.objectContaining({
      workUnitIds: [wu.id],
      authorType: 'human',
      channelIds: [channelId],
    }));
  });

  it('活跃 WU 无 channelId 时退全扫（不传 channelIds）', async () => {
    const instanceId = await startAndWaitFirstObserve();
    await createBlockedWu(instanceId, null);
    const querySpy = vi.spyOn(fileStore, 'queryAllMessages');

    await refreshObserve();

    expect(querySpy).toHaveBeenCalled();
    const arg = querySpy.mock.calls[0][0] as { channelIds?: string[] };
    expect(arg.channelIds).toBeUndefined();
  });

  it('human + myActive WU 的 channel.message_sent 事件打断空闲 sleep，立即跑一轮 observe', async () => {
    const instanceId = await startAndWaitFirstObserve();
    const wu = await createBlockedWu(instanceId, channelId);
    await refreshObserve(); // 刷新 lastActiveWuIds

    const indexSpy = vi.spyOn(fileStore, 'getIndex');
    const before = indexSpy.mock.calls.length;

    eventBus.publish('channel.message_sent', {
      channelId,
      message: { authorType: 'human', workUnitId: wu.id },
    });

    // 空闲 sleep 是 15s——2s 内 observe 再跑即证明事件唤醒
    await vi.waitFor(() => {
      expect(indexSpy.mock.calls.length).toBeGreaterThan(before);
    }, { timeout: 2000, interval: 20 });
  });

  it('非 human / 无 workUnitId 的事件不唤醒', async () => {
    const instanceId = await startAndWaitFirstObserve();
    const wu = await createBlockedWu(instanceId, channelId);
    await refreshObserve();

    const indexSpy = vi.spyOn(fileStore, 'getIndex');
    const before = indexSpy.mock.calls.length;

    eventBus.publish('channel.message_sent', {
      channelId, message: { authorType: 'agent', workUnitId: wu.id },
    });
    eventBus.publish('channel.message_sent', {
      channelId, message: { authorType: 'human', workUnitId: null },
    });

    await new Promise(resolve => setTimeout(resolve, 400));
    expect(indexSpy.mock.calls.length).toBe(before);
  });

  // 2026-09-16 唤醒放宽（只放行不裁决）：归属不再用 lastActiveWuIds 派生缓存否决——
  // 缓存在认领后首个 sleep 窗口必 stale，回复唤醒 100% 被滤掉（实测白等 30s）。
  // 人类消息带 workUnitId 即醒，是否归我由 observe 裁决（幂等廉价）。
  it('陌生 workUnitId 的人类消息同样唤醒（只放行不裁决）', async () => {
    await startAndWaitFirstObserve(); // 不建任何 WU——myActive 为空

    const indexSpy = vi.spyOn(fileStore, 'getIndex');
    const before = indexSpy.mock.calls.length;

    eventBus.publish('channel.message_sent', {
      channelId, message: { authorType: 'human', workUnitId: 'wu-stranger' },
    });

    await vi.waitFor(() => {
      expect(indexSpy.mock.calls.length).toBeGreaterThan(before);
    }, { timeout: 2000, interval: 20 });
  });

  it('stop() 退订 channel.message_sent', async () => {
    const subscribeSpy = vi.spyOn(eventBus, 'subscribe');
    const unsubscribeSpy = vi.spyOn(eventBus, 'unsubscribe');

    await startAndWaitFirstObserve();
    const subscribed = subscribeSpy.mock.calls.find(c => c[0] === 'channel.message_sent');
    expect(subscribed).toBeTruthy();

    agentLoop.stop();
    expect(unsubscribeSpy).toHaveBeenCalledWith('channel.message_sent', subscribed![1]);
    await agentLoop.waitForStop();
  });
});

// #493: 新回复检测同毫秒边界（>=）+ 唤醒闩锁（事件到达时不在 idleSleep 不丢唤醒）
// 均不 start()——纯 seam 直驱（observe / onChannelMessageSent / idleSleep），确定性无竞态
describe('#493: 新回复同毫秒边界 + 唤醒闩锁', () => {
  let testDir: string;
  let fileStore: FileStore;
  let wuService: WorkUnitService;
  let channelId: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loop-493-'));
    fileStore = new FileStore(testDir);
    wuService = new WorkUnitService(fileStore);
    channelId = `ch-493-${Date.now()}`;
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  /** seam：私有成员访问（TS private 仅编译期） */
  interface Seam493 {
    alive: boolean;
    pendingWake: boolean;
    onChannelMessageSent(payload: { message?: { authorType?: string; workUnitId?: string | null } }): void;
    idleSleep(ms: number): Promise<void>;
    observe(): Promise<{ newReplies: { id: string }[] }>;
  }
  const seamOf = (loop: AgentLoop) => loop as unknown as Seam493;

  const humanMsg = (id: string, workUnitId: string, createdAt: string) => ({
    id, channelId, authorType: 'human' as const, agentName: null,
    content: `回复-${id}`, replyToId: null, meta: '{}', workUnitId, createdAt,
  });

  it('同毫秒边界：msg.createdAt == wu.updatedAt 的回复被检为新回复（>=）', async () => {
    const loop = new AgentLoop(mockRole, fileStore);
    const wu = await wuService.create({
      scope: '挂起等回复', channelId, type: 'task',
      status: 'blocked', assigneeId: 'some-instance',
      metadata: { waitingForInput: true },
    });
    const sameMs = wu.updatedAt.toISOString();
    const olderMs = new Date(wu.updatedAt.getTime() - 1).toISOString();
    await fileStore.appendMessage(channelId, humanMsg('m-same-ms', wu.id, sameMs));
    await fileStore.appendMessage(channelId, humanMsg('m-older', wu.id, olderMs));

    const obs = await seamOf(loop).observe();

    expect(obs.newReplies.some(m => m.id === 'm-same-ms')).toBe(true);
    expect(obs.newReplies.some(m => m.id === 'm-older')).toBe(false);
  });

  it('唤醒闩锁：事件到达时不在 idleSleep → 置闩，下一次 idleSleep 立即放行并消费', async () => {
    const loop = new AgentLoop(mockRole, fileStore);
    const seam = seamOf(loop);
    seam.alive = true;

    seam.onChannelMessageSent({ message: { authorType: 'human', workUnitId: 'wu-1' } });
    expect(seam.pendingWake).toBe(true);

    const t0 = Date.now();
    await seam.idleSleep(15_000); // 闩锁命中 → 不睡满 15s
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(seam.pendingWake).toBe(false); // 已消费，不残留
  });

  it('闩锁不误置：非 human / 无 workUnitId / 空负载不置闩', () => {
    const loop = new AgentLoop(mockRole, fileStore);
    const seam = seamOf(loop);
    seam.alive = true;

    seam.onChannelMessageSent({ message: { authorType: 'agent', workUnitId: 'wu-1' } });
    seam.onChannelMessageSent({ message: { authorType: 'human', workUnitId: null } });
    seam.onChannelMessageSent({});
    expect(seam.pendingWake).toBe(false);
  });

  // 2026-09-16 唤醒放宽：陌生 workUnitId 也置闩（归属裁决归 observe，见 #330 段同名测试）
  it('陌生 workUnitId 的人类消息置闩（只放行不裁决）', () => {
    const loop = new AgentLoop(mockRole, fileStore);
    const seam = seamOf(loop);
    seam.alive = true;

    seam.onChannelMessageSent({ message: { authorType: 'human', workUnitId: 'wu-stranger' } });
    expect(seam.pendingWake).toBe(true);
  });

  it('无闩时 idleSleep 正常睡足（闩锁不改变无事件时的空闲调度）', async () => {
    const loop = new AgentLoop(mockRole, fileStore);
    const seam = seamOf(loop);
    seam.alive = true;

    const t0 = Date.now();
    await seam.idleSleep(60);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(50);
    expect(seam.pendingWake).toBe(false);
  });
});

// #523（#515 决议 P0-1）：认领真唤醒——workunit.created 的 EVENT handler 不再白跑
// 一次 observe 丢弃，改走 channel.message_sent 同款机制（pendingWake 闩锁 + wakeIdle）
// 叫醒 runLoop 自己跑 observe→认领；派生可认领路径（status_changed）同口径补唤醒。
// 过滤口径 = 负载现成的 claimable === true（pending 人闸单/有依赖单不空唤醒）。
describe('#523: workunit 认领真唤醒（created + status_changed）', () => {
  let testDir: string;
  let fileStore: FileStore;
  let agentLoop: AgentLoop;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecSync.mockReturnValue('Claude Code CLI version 1.0.0');
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loop-523-'));
    fileStore = new FileStore(testDir);
  });

  afterEach(async () => {
    if (agentLoop) {
      agentLoop.stop();
      await Promise.race([
        agentLoop.waitForStop(),
        new Promise(resolve => setTimeout(resolve, 2000)),
      ]);
    }
    eventBus.unsubscribeAll('workunit.status_changed');
    fs.rmSync(testDir, { recursive: true, force: true });
  }, 5000);

  /** 启动 loop 并等首轮 observe 完成；返回本实例 id（assigneeId 口径） */
  async function startAndWaitFirstObserve(): Promise<string> {
    agentLoop = new AgentLoop(mockRole, fileStore);
    const indexSpy = vi.spyOn(fileStore, 'getIndex');
    await agentLoop.start();
    await vi.waitFor(() => {
      expect(indexSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    }, { timeout: 3000, interval: 20 });
    indexSpy.mockRestore();
    const seam = agentLoop as unknown as { instance: { id: string } | null };
    expect(seam.instance).toBeTruthy();
    return seam.instance!.id;
  }

  /** workunit.created 的 EVENT EXECUTE handler（trigger scheduler 会把事件 payload 传进来） */
  function createdHandler(): (payload: unknown) => Promise<void> {
    const handler = mockTriggerScheduler.registerExecuteHandler.mock.calls
      .find(c => c[0] === `agent-loop-${mockRole.id}-observe`)?.[1] as ((payload: unknown) => Promise<void>) | undefined;
    expect(handler).toBeTruthy();
    return handler!;
  }

  it('workunit.created（claimable=true）→ 叫醒 loop 立即跑一轮 observe（不等 15s 地板）', async () => {
    await startAndWaitFirstObserve();

    const indexSpy = vi.spyOn(fileStore, 'getIndex');
    const before = indexSpy.mock.calls.length;

    await createdHandler()({ workunit: { id: 'wu-new', claimable: true } });

    // idle 地板 15s——2s 内 observe 再跑即证明真唤醒（不是白跑丢弃）
    await vi.waitFor(() => {
      expect(indexSpy.mock.calls.length).toBeGreaterThan(before);
    }, { timeout: 2000, interval: 20 });
  });

  it('workunit.created claimable=false / 缺字段 → 不唤醒', async () => {
    await startAndWaitFirstObserve();

    const indexSpy = vi.spyOn(fileStore, 'getIndex');
    const before = indexSpy.mock.calls.length;

    const handler = createdHandler();
    await handler({ workunit: { id: 'wu-pending', claimable: false } }); // pending 人闸单
    await handler({ workunit: { id: 'wu-no-field' } });                    // 缺 claimable 字段
    await handler({});                                                     // 空负载
    eventBus.publish('workunit.status_changed', { workunit: { id: 'wu-x', claimable: false } });

    await new Promise(resolve => setTimeout(resolve, 400));
    expect(indexSpy.mock.calls.length).toBe(before);
  });

  it('workunit.status_changed（claimable=true）→ 同样唤醒（人闸确认/unclaim/reopen 同口径）', async () => {
    await startAndWaitFirstObserve();

    const indexSpy = vi.spyOn(fileStore, 'getIndex');
    const before = indexSpy.mock.calls.length;

    eventBus.publish('workunit.status_changed', { workunit: { id: 'wu-confirmed', claimable: true } });

    await vi.waitFor(() => {
      expect(indexSpy.mock.calls.length).toBeGreaterThan(before);
    }, { timeout: 2000, interval: 20 });
  });

  // 2026-09-16 唤醒放宽（只放行不裁决）：复活路径 blocked→active 的 claimable 恒 false，
  // 旧过滤把它排除 → 人类回复后 loop 白等满 30s dynamicInterval（perf 实测实锤）。
  // 新口径：claimable===true 或 assigneeId===本实例 即醒，归属裁决归 observe。
  it('status_changed：claimable=false 但 assigneeId=本实例（NEED_INPUT 复活）→ 唤醒', async () => {
    const instanceId = await startAndWaitFirstObserve();

    const indexSpy = vi.spyOn(fileStore, 'getIndex');
    const before = indexSpy.mock.calls.length;

    eventBus.publish('workunit.status_changed', {
      workunit: { id: 'wu-mine-resumed', status: 'active', claimable: false, assigneeId: instanceId },
    });

    await vi.waitFor(() => {
      expect(indexSpy.mock.calls.length).toBeGreaterThan(before);
    }, { timeout: 2000, interval: 20 });
  });

  it('status_changed：assigneeId 是别人的 WU → 不唤醒', async () => {
    await startAndWaitFirstObserve();

    const indexSpy = vi.spyOn(fileStore, 'getIndex');
    const before = indexSpy.mock.calls.length;

    eventBus.publish('workunit.status_changed', {
      workunit: { id: 'wu-other', status: 'active', claimable: false, assigneeId: 'inst-someone-else' },
    });

    await new Promise(resolve => setTimeout(resolve, 400));
    expect(indexSpy.mock.calls.length).toBe(before);
  });

  it('stop() 退订 workunit.status_changed', async () => {
    const unsubscribeSpy = vi.spyOn(eventBus, 'unsubscribe');
    await startAndWaitFirstObserve();

    agentLoop.stop();
    expect(unsubscribeSpy).toHaveBeenCalledWith('workunit.status_changed', expect.any(Function));
    await agentLoop.waitForStop();
  });
});

// #523 seam 直驱（不 start，确定性无竞态）：步间 sleep 复用 wakeIdle 可中断原语——
// 认领事件到达时 loop 不在 idleSleep 则置闩，在 idleSleep（含步间 dynamicInterval sleep）则打断
describe('#523: 步间 sleep 可中断（seam 直驱）', () => {
  let testDir: string;
  let fileStore: FileStore;

  interface Seam523 {
    alive: boolean;
    pendingWake: boolean;
    onWorkUnitClaimable(payload: unknown): void;
    idleSleep(ms: number): Promise<void>;
  }
  const seamOf = (loop: AgentLoop) => loop as unknown as Seam523;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loop-523-seam-'));
    fileStore = new FileStore(testDir);
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('认领事件打断在睡的 idleSleep（步间 sleep 同款原语，不睡满）', async () => {
    const loop = new AgentLoop(mockRole, fileStore);
    const seam = seamOf(loop);
    seam.alive = true;

    const t0 = Date.now();
    const sleeping = seam.idleSleep(30_000); // 步间 dynamicInterval 上限档
    seam.onWorkUnitClaimable({ workunit: { id: 'wu-1', claimable: true } });
    await sleeping;
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('不在 sleep 时认领事件置闩，下一次 idleSleep 入口消费立即放行', async () => {
    const loop = new AgentLoop(mockRole, fileStore);
    const seam = seamOf(loop);
    seam.alive = true;

    seam.onWorkUnitClaimable({ workunit: { id: 'wu-1', claimable: true } });
    expect(seam.pendingWake).toBe(true);

    const t0 = Date.now();
    await seam.idleSleep(15_000);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(seam.pendingWake).toBe(false);
  });

  it('闩锁不误置：claimable=false / 缺字段 / 空负载不置闩', () => {
    const loop = new AgentLoop(mockRole, fileStore);
    const seam = seamOf(loop);
    seam.alive = true;

    seam.onWorkUnitClaimable({ workunit: { id: 'wu-1', claimable: false } });
    seam.onWorkUnitClaimable({ workunit: { id: 'wu-1' } });
    seam.onWorkUnitClaimable({});
    seam.onWorkUnitClaimable(null);
    expect(seam.pendingWake).toBe(false);
  });
});
