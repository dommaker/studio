// loop 段接线结构测试（#668 agent-loop.ts 按职责切深模块）：
// 钉住拆分契约——AgentLoop 门面保留的全部对外/测试 seam 委托到对应段模块，
// 段实例在构造期接线完成。段行为本身的覆盖率由既有 agent-loop-* 测试网承担（纯结构移动）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';

const { mockExecuteLightweight } = vi.hoisted(() => ({
  mockExecuteLightweight: vi.fn(),
}));

vi.mock('@dommaker/studio-agent', () => ({
  agentRunner: {
    executeLightweight: mockExecuteLightweight,
  },
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

const mockRole = {
  id: 'role-seg',
  name: 'seg-agent',
  description: 'segment wiring test agent',
  channels: '[]',
  status: 'active',
  provider: 'claude',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

/** 测试触达 internal 成员的结构接口（as unknown as 转换，同 agent-loop-instance-status 模式） */
interface SegmentWired {
  lifecycle: LoopLifecycle;
  observer: LoopObserver;
  claim: LoopClaim;
  stepRunner: StepRunner;
  recorder: ResultRecorder;
  observe(): Promise<unknown>;
  idleSleep(ms: number): Promise<void>;
  claimAndAnnounce(wu: unknown): Promise<boolean>;
  ensureClaimFit(wu: unknown): Promise<boolean>;
  updateIdleState(): Promise<void>;
  publishInstanceStatus(status: string, wuId: string | null): Promise<void>;
  recordStartupFailure(message: string): Promise<void>;
  agentStep(target: unknown): Promise<unknown>;
  recordResult(target: unknown, result: unknown): Promise<void>;
  postToDiscussionSpace(wuId: string, content: string): Promise<void>;
  transitionIfHeld(wuId: string, status: string): Promise<boolean>;
}

describe('AgentLoop 段模块接线（#668）', () => {
  let testDir: string;
  let fileStore: FileStore;
  let loop: AgentLoop;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loop-segments-'));
    fileStore = new FileStore(testDir);
    loop = new AgentLoop(mockRole, fileStore);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('构造期完成五段模块实例接线', () => {
    const wired = loop as unknown as SegmentWired;
    expect(wired.lifecycle).toBeInstanceOf(LoopLifecycle);
    expect(wired.observer).toBeInstanceOf(LoopObserver);
    expect(wired.claim).toBeInstanceOf(LoopClaim);
    expect(wired.stepRunner).toBeInstanceOf(StepRunner);
    expect(wired.recorder).toBeInstanceOf(ResultRecorder);
  });

  it('观察段：observe/idleSleep 委托 LoopObserver', async () => {
    const observations = { myActive: [], unassigned: [], newReplies: [] };
    const observeSpy = vi.spyOn(LoopObserver.prototype, 'observe').mockResolvedValue(observations);
    const sleepSpy = vi.spyOn(LoopObserver.prototype, 'idleSleep').mockResolvedValue(undefined);
    const wired = loop as unknown as SegmentWired;
    expect(await wired.observe()).toBe(observations);
    await wired.idleSleep(1);
    expect(observeSpy).toHaveBeenCalledOnce();
    expect(sleepSpy).toHaveBeenCalledOnce();
  });

  it('唤醒段：onChannelMessageSent/onWorkUnitClaimable 委托 LoopObserver', () => {
    const msgSpy = vi.spyOn(LoopObserver.prototype, 'onChannelMessageSent').mockReturnValue(undefined);
    const claimableSpy = vi.spyOn(LoopObserver.prototype, 'onWorkUnitClaimable').mockReturnValue(undefined);
    loop.onChannelMessageSent({ message: { authorType: 'human', workUnitId: 'wu-1' } });
    loop.onWorkUnitClaimable({ workunit: { claimable: true } });
    expect(msgSpy).toHaveBeenCalledOnce();
    expect(claimableSpy).toHaveBeenCalledOnce();
  });

  it('认领段：claimAndAnnounce/ensureClaimFit 委托 LoopClaim', async () => {
    const announceSpy = vi.spyOn(LoopClaim.prototype, 'claimAndAnnounce').mockResolvedValue(true);
    const fitSpy = vi.spyOn(LoopClaim.prototype, 'ensureClaimFit').mockResolvedValue(true);
    const wired = loop as unknown as SegmentWired;
    expect(await wired.claimAndAnnounce({})).toBe(true);
    expect(await wired.ensureClaimFit({})).toBe(true);
    expect(announceSpy).toHaveBeenCalledOnce();
    expect(fitSpy).toHaveBeenCalledOnce();
  });

  it('生命周期段：start/stop/waitForStop + 实例状态三件套委托 LoopLifecycle', async () => {
    const startSpy = vi.spyOn(LoopLifecycle.prototype, 'start').mockResolvedValue(true);
    const stopSpy = vi.spyOn(LoopLifecycle.prototype, 'stop').mockReturnValue(undefined);
    const waitSpy = vi.spyOn(LoopLifecycle.prototype, 'waitForStop').mockResolvedValue(undefined);
    const idleSpy = vi.spyOn(LoopLifecycle.prototype, 'updateIdleState').mockResolvedValue(undefined);
    const publishSpy = vi.spyOn(LoopLifecycle.prototype, 'publishInstanceStatus').mockResolvedValue(undefined);
    const failureSpy = vi.spyOn(LoopLifecycle.prototype, 'recordStartupFailure').mockResolvedValue(undefined);
    const wired = loop as unknown as SegmentWired;
    expect(await loop.start()).toBe(true);
    loop.stop();
    await loop.waitForStop();
    await wired.updateIdleState();
    await wired.publishInstanceStatus('idle', null);
    await wired.recordStartupFailure('boom');
    for (const spy of [startSpy, stopSpy, waitSpy, idleSpy, publishSpy, failureSpy]) {
      expect(spy).toHaveBeenCalledOnce();
    }
  });

  it('步执行段：agentStep 委托 StepRunner', async () => {
    const stepResult = { action: 'progress', summary: 'ok' };
    const stepSpy = vi.spyOn(StepRunner.prototype, 'agentStep').mockResolvedValue(stepResult as never);
    const wired = loop as unknown as SegmentWired;
    expect(await wired.agentStep({ workUnit: {} })).toBe(stepResult);
    expect(stepSpy).toHaveBeenCalledOnce();
  });

  it('结果记录段：recordResult/postToDiscussionSpace 委托 ResultRecorder', async () => {
    const recordSpy = vi.spyOn(ResultRecorder.prototype, 'recordResult').mockResolvedValue(undefined);
    const postSpy = vi.spyOn(ResultRecorder.prototype, 'postToDiscussionSpace').mockResolvedValue(undefined);
    const wired = loop as unknown as SegmentWired;
    await wired.recordResult({ workUnit: {} }, { action: 'progress', summary: 'ok' });
    await wired.postToDiscussionSpace('wu-1', 'hello');
    expect(recordSpy).toHaveBeenCalledOnce();
    expect(postSpy).toHaveBeenCalledOnce();
  });

  it('fencing seam：transitionIfHeld 委托 WuLeaseTracker', async () => {
    const heldSpy = vi.spyOn(WuLeaseTracker.prototype, 'transitionIfHeld').mockResolvedValue(true);
    expect(await (loop as unknown as SegmentWired).transitionIfHeld('wu-1', 'blocked')).toBe(true);
    expect(heldSpy).toHaveBeenCalledOnce();
  });
});
