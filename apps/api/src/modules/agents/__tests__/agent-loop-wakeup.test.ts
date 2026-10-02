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

vi.mock('child_process', () => ({ exec: vi.fn(),
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

  it('observe 回复检测只读 myActive 频道（#330 扫描裁剪；B5 起走增量水位线读口）', async () => {
    const instanceId = await startAndWaitFirstObserve();
    await createBlockedWu(instanceId, channelId);
    // 与活跃 WU 无关的另一频道（目录存在 = 在枚举面内，但应被频道过滤排除）
    const now = new Date().toISOString();
    await fileStore.createChannel({
      id: 'ch-other', name: '#other', type: 'rnd',
      defaultWorkspaceId: null, defaultPath: null,
      discordChannelId: null, discordWebhookUrl: null, members: '[]',
      createdAt: now, updatedAt: now,
    });
    const deltaSpy = vi.spyOn(fileStore, 'readChannelMessagesDelta');

    await refreshObserve();

    expect(deltaSpy.mock.calls.some(c => c[0] === channelId)).toBe(true);
    expect(deltaSpy.mock.calls.every(c => c[0] !== 'ch-other')).toBe(true);
  });

  it('活跃 WU 无 channelId 时退全扫（不做频道过滤）', async () => {
    const instanceId = await startAndWaitFirstObserve();
    await createBlockedWu(instanceId, null); // channelId=null → 退全扫
    const deltaSpy = vi.spyOn(fileStore, 'readChannelMessagesDelta');

    await refreshObserve();

    // channelId 与本 WU 无关仍被读 = 全频道扫描（无 channelIds 过滤）
    expect(deltaSpy.mock.calls.some(c => c[0] === channelId)).toBe(true);
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

// B5（channel-flow-audit-fix）：observe 回复检测增量水位线——queryAllMessages 全扫改
// readChannelMessagesDelta 字节水位增量读。钉死三条等价语义：①未消费回复跨轮重复投递；
// ②水位失效（压实/重写）当轮回退全量重建不漏；③边界锚覆盖 slice(0,20) 外的在跑 WU，
// 其未消费回复不被水位吞掉（该 WU 经排序挤入视野时必须检出）。seam 直驱 observe，无竞态。
describe('B5: observe 回复检测增量水位线', () => {
  let testDir: string;
  let fileStore: FileStore;
  let wuService: WorkUnitService;
  let channelId: string;

  interface SeamB5 {
    observe(): Promise<{ myActive: { id: string }[]; newReplies: { id: string }[] }>;
    replyScanWatermarks: Map<string, number>;
  }
  const seamOf = (loop: AgentLoop) => loop as unknown as SeamB5;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loop-b5-'));
    fileStore = new FileStore(testDir);
    wuService = new WorkUnitService(fileStore);
    channelId = `ch-b5-${Date.now()}`;
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  const humanMsg = (id: string, workUnitId: string, createdAt: string) => ({
    id, channelId, authorType: 'human' as const, agentName: null,
    content: `回复-${id}`, replyToId: null, meta: '{}', workUnitId, createdAt,
  });

  const createBlockedWu = (scope: string, assigneeId = 'some-instance') =>
    wuService.create({
      scope, channelId, type: 'task',
      status: 'blocked', assigneeId,
      metadata: { waitingForInput: true },
    });

  it('增量等价：新追加回复被检出；未消费回复跨轮重复投递；过期回复中途落盘也不检出', async () => {
    const loop = new AgentLoop(mockRole, fileStore);
    const wu = await createBlockedWu('等回复');
    const seam = seamOf(loop);

    // 第一轮：无回复，扫描面为空
    let obs = await seam.observe();
    expect(obs.newReplies).toEqual([]);

    // 追加新回复（createdAt > wu.updatedAt）→ 增量窗口检出
    await fileStore.appendMessage(channelId, humanMsg('m-new', wu.id, new Date(wu.updatedAt.getTime() + 1000).toISOString()));
    obs = await seam.observe();
    expect(obs.newReplies.map(m => m.id)).toEqual(['m-new']);

    // 未消费（recordResult 未推进 updatedAt）→ 下一轮仍检出（与全扫重复投递口径逐条一致）
    obs = await seam.observe();
    expect(obs.newReplies.map(m => m.id)).toEqual(['m-new']);

    // 过期回复（createdAt < wu.updatedAt）中途落盘 → 不检出
    await fileStore.appendMessage(channelId, humanMsg('m-stale', wu.id, new Date(wu.updatedAt.getTime() - 1000).toISOString()));
    obs = await seam.observe();
    expect(obs.newReplies.map(m => m.id)).toEqual(['m-new']);
  });

  it('水位失效（压实/重写作废偏移）→ 当轮回退 0 偏移全读重建，回复不漏', async () => {
    const loop = new AgentLoop(mockRole, fileStore);
    const wu = await createBlockedWu('等回复');
    const seam = seamOf(loop);

    await fileStore.appendMessage(channelId, humanMsg('m-1', wu.id, new Date(wu.updatedAt.getTime() + 1000).toISOString()));
    const obs1 = await seam.observe();
    expect(obs1.newReplies.map(m => m.id)).toEqual(['m-1']);
    expect(seam.replyScanWatermarks.has(channelId)).toBe(true);

    // 模拟压实原子重写使水位作废（偏移越界触发原语 valid=false）
    seam.replyScanWatermarks.set(channelId, Number.MAX_SAFE_INTEGER);
    const obs2 = await seam.observe();
    expect(obs2.newReplies.map(m => m.id)).toEqual(['m-1']); // 回退全读，不漏
    // 水位已重建为合法值
    const rebuilt = seam.replyScanWatermarks.get(channelId);
    expect(rebuilt).toBeDefined();
    expect(rebuilt).not.toBe(Number.MAX_SAFE_INTEGER);
  });

  it('边界锚覆盖 slice(0,20) 外的在跑 WU：经排序挤入视野后其未消费回复必须检出', async () => {
    const loop = new AgentLoop(mockRole, fileStore);
    const seam = seamOf(loop);

    // wuOld：updatedAt 旧（1 小时前），createdAt 最旧 → 被 slice(0,20) 挤出 myActive
    const wuOld = await createBlockedWu('老 blocked 单');
    const oldSnap = (await fileStore.getIndex()).find(s => s.id === wuOld.id)!;
    await fileStore.upsertSnapshot({
      ...oldSnap,
      createdAt: new Date(Date.now() - 3_600_000).toISOString(),
      updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
    });
    // 20 个更新的在跑 WU 占满 slice
    for (let i = 0; i < 20; i++) await createBlockedWu(`新单-${i}`);
    // wuOld 的未消费回复：createdAt ∈ (wuOld.updatedAt, 其他 WU 的 updatedAt)
    // ——边界锚若漏算 slice 外的 wuOld，水位会越过这条回复造成永久漏检
    await fileStore.appendMessage(channelId, humanMsg('m-old-wu', wuOld.id, new Date(Date.now() - 1_800_000).toISOString()));

    // 第一轮：wuOld 不在 myActive → 不投递（与全扫一致）；但水位不得越过 m-old-wu
    const obs1 = await seam.observe();
    expect(obs1.myActive.some(w => w.id === wuOld.id)).toBe(false);
    expect(obs1.newReplies.some(m => m.id === 'm-old-wu')).toBe(false);

    // wuOld 经 createdAt 排序挤入 slice（不改 updatedAt——纯排序进入视野，无任何簿记事件）
    const snap = (await fileStore.getIndex()).find(s => s.id === wuOld.id)!;
    await fileStore.upsertSnapshot({ ...snap, createdAt: new Date().toISOString() });

    const obs2 = await seam.observe();
    expect(obs2.myActive.some(w => w.id === wuOld.id)).toBe(true);
    expect(obs2.newReplies.some(m => m.id === 'm-old-wu')).toBe(true);
  });
});
