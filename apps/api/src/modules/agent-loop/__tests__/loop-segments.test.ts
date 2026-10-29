// ARCH-05：测试与生产调用方使用同一 AgentLoop interface；StepRunner 只接收
// 显式 StepContext，不能通过 God Host 回读可变实例状态。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';

const { mockExecuteLightweight } = vi.hoisted(() => ({
  mockExecuteLightweight: vi.fn(),
}));

vi.mock('@dommaker/studio-agent', () => ({
  agentRunner: { executeLightweight: mockExecuteLightweight },
}));

vi.mock('../../knowledge/knowledge-service', () => ({
  knowledgeService: {
    injectContext: vi.fn().mockResolvedValue({ prompt: '', injectedIds: [] }),
    recordOutcome: vi.fn().mockResolvedValue(undefined),
    extractFromExecution: vi.fn().mockResolvedValue(undefined),
  },
}));

import { AgentLoop } from '../agent-loop';
import { LoopLifecycle } from '../loop/loop-lifecycle';
import { LoopObserver } from '../loop/loop-observe';
import { LoopClaim } from '../loop/loop-claim';
import { StepRunner } from '../loop/loop-step';
import { ResultRecorder } from '../loop/loop-record-result';
import { WuLeaseTracker } from '../wu-lease';
import type { WorkUnitData } from '../../workunit/index.js';
import type { RuntimeInstanceRow } from '../agent-loop.types.js';

const mockRole = {
  id: 'role-seg', name: 'seg-agent', description: 'segment wiring test agent',
  channels: '[]', status: 'active', provider: 'claude',
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
};

const instance: RuntimeInstanceRow = {
  id: 'instance-seg', roleId: mockRole.id, sessionId: null, status: 'active',
  currentWorkUnitId: 'wu-1', startedAt: new Date().toISOString(), terminatedAt: null,
  metadata: null, lastHeartbeat: null,
};

const workUnit: WorkUnitData = {
  id: 'wu-1', parentId: null, type: 'task', scope: 'step context', assigneeId: instance.id,
  status: 'active', failureType: null, retryCount: 0, timeoutAt: null, channelId: null,
  projectPath: null, workspaceId: null, reqId: null, metadata: null,
  createdAt: new Date(), updatedAt: new Date(), claimedAt: new Date(), completedAt: null,
};

describe('AgentLoop 窄段接口与 StepContext（ARCH-05）', () => {
  let testDir: string;
  let fileStore: FileStore;
  let loop: AgentLoop;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loop-segments-'));
    fileStore = new FileStore(testDir);
    loop = new AgentLoop(mockRole, fileStore, { instance });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('构造输入与 currentInstance 返回均为防御快照，外部改写不穿透 owner', () => {
    const input = { ...instance };
    const isolated = new AgentLoop(mockRole, fileStore, { instance: input });
    input.id = 'mutated-input';
    expect(isolated.currentInstance).toEqual(instance);
    expect(isolated.currentInstance).not.toBe(input);

    const returned = isolated.currentInstance!;
    returned.id = 'mutated-output';
    expect(isolated.currentInstance).toEqual(instance);
    expect(isolated.currentInstance).not.toBe(returned);
  });

  it('观察段：observe/idleSleep 使用公共接口', async () => {
    const observations = { myActive: [], unassigned: [], newReplies: [] };
    const observeSpy = vi.spyOn(LoopObserver.prototype, 'observe').mockResolvedValue(observations);
    const sleepSpy = vi.spyOn(LoopObserver.prototype, 'idleSleep').mockResolvedValue(undefined);
    expect(await loop.observe()).toBe(observations);
    await loop.idleSleep(1);
    expect(observeSpy).toHaveBeenCalledOnce();
    expect(sleepSpy).toHaveBeenCalledOnce();
  });

  it('唤醒与认领段保留公共行为', async () => {
    const msgSpy = vi.spyOn(LoopObserver.prototype, 'onChannelMessageSent').mockReturnValue(undefined);
    const claimableSpy = vi.spyOn(LoopObserver.prototype, 'onWorkUnitClaimable').mockReturnValue(undefined);
    loop.onChannelMessageSent({ message: { authorType: 'human', workUnitId: 'wu-1' } });
    loop.onWorkUnitClaimable({ workunit: { claimable: true } });
    const announceSpy = vi.spyOn(LoopClaim.prototype, 'claimAndAnnounce').mockResolvedValue(true);
    const fitSpy = vi.spyOn(LoopClaim.prototype, 'ensureClaimFit').mockResolvedValue(true);
    expect(await loop.claimAndAnnounce(workUnit)).toBe(true);
    expect(await loop.ensureClaimFit(workUnit)).toBe(true);
    for (const spy of [msgSpy, claimableSpy, announceSpy, fitSpy]) expect(spy).toHaveBeenCalledOnce();
  });

  it('生命周期段保留 start/stop 与实例状态行为', async () => {
    const spies = [
      vi.spyOn(LoopLifecycle.prototype, 'start').mockResolvedValue(true),
      vi.spyOn(LoopLifecycle.prototype, 'stop').mockReturnValue(undefined),
      vi.spyOn(LoopLifecycle.prototype, 'waitForStop').mockResolvedValue(undefined),
      vi.spyOn(LoopLifecycle.prototype, 'updateIdleState').mockResolvedValue(undefined),
      vi.spyOn(LoopLifecycle.prototype, 'publishInstanceStatus').mockResolvedValue(undefined),
      vi.spyOn(LoopLifecycle.prototype, 'recordStartupFailure').mockResolvedValue(undefined),
    ];
    expect(await loop.start()).toBe(true);
    loop.stop();
    await loop.waitForStop();
    await loop.updateIdleState();
    await loop.publishInstanceStatus('idle', null);
    await loop.recordStartupFailure('boom');
    for (const spy of spies) expect(spy).toHaveBeenCalledOnce();
  });

  it('agentStep 传显式 StepContext，recordResult 沿用 StepResult', async () => {
    const stepResult = { action: 'progress', summary: 'ok' } as const;
    const stepSpy = vi.spyOn(StepRunner.prototype, 'agentStep').mockResolvedValue(stepResult);
    expect(await loop.agentStep({ workUnit })).toBe(stepResult);
    expect(stepSpy).toHaveBeenCalledWith(expect.objectContaining({ workUnit, instance }));
    const context = stepSpy.mock.calls[0][0];
    expect(context.instance).not.toBe(loop.currentInstance);
    context.instance!.id = 'mutated-step-context';
    expect(loop.currentInstance).toEqual(instance);

    const recordSpy = vi.spyOn(ResultRecorder.prototype, 'recordResult').mockResolvedValue(undefined);
    const postSpy = vi.spyOn(ResultRecorder.prototype, 'postToDiscussionSpace').mockResolvedValue(undefined);
    await loop.recordResult({ workUnit }, stepResult);
    await loop.postToDiscussionSpace('wu-1', 'hello');
    expect(recordSpy).toHaveBeenCalledOnce();
    expect(postSpy).toHaveBeenCalledOnce();
  });

  it('fencing 仍由 WuLeaseTracker 独占', async () => {
    const heldSpy = vi.spyOn(WuLeaseTracker.prototype, 'transitionIfHeld').mockResolvedValue(true);
    expect(await loop.transitionIfHeld('wu-1', 'blocked')).toBe(true);
    expect(heldSpy).toHaveBeenCalledOnce();
  });
});
