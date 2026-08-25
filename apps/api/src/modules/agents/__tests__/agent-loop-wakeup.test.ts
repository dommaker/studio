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

  it('非 human 或 workUnitId 不在 myActive 的事件不唤醒', async () => {
    const instanceId = await startAndWaitFirstObserve();
    const wu = await createBlockedWu(instanceId, channelId);
    await refreshObserve();

    const indexSpy = vi.spyOn(fileStore, 'getIndex');
    const before = indexSpy.mock.calls.length;

    eventBus.publish('channel.message_sent', {
      channelId, message: { authorType: 'agent', workUnitId: wu.id },
    });
    eventBus.publish('channel.message_sent', {
      channelId, message: { authorType: 'human', workUnitId: 'wu-stranger' },
    });
    eventBus.publish('channel.message_sent', {
      channelId, message: { authorType: 'human', workUnitId: null },
    });

    await new Promise(resolve => setTimeout(resolve, 400));
    expect(indexSpy.mock.calls.length).toBe(before);
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
