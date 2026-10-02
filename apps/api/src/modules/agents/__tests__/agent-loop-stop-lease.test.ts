/**
 * #635：AgentLoop.stop() 语义收窄为「置退出意图」——租约心跳与 fencing 活到 runLoop 主循环退出。
 * 在飞 step 全程处于租约保护之下：
 *   - stop() 后、loop 退出前，租约心跳继续续期（timeoutAt 推前，WU 不被 timeout-release 回收）；
 *   - 窗口内 WU 被外部 unclaim（REST terminate 路径）→ 心跳下一跳 fencing 检出易主，
 *     复用 handleLost 既有语义杀掉在飞 CLI 进程组；
 *   - step 完成时的结果回写 = 真持有租约下的合法通过（非「无轨道恒真」放行）；
 *   - runLoop 退出点统一停心跳，此后租约按既有 5min TTL 到期回收。
 * 「无租约轨道 fencing 不拦」契约不动（既有锁定在 agent-loop-lease.test.ts / wu-lease.test.ts）。
 * 真实 FileStore（tmpdir，leaseFlushIntervalMs=0 每跳落盘）+ 真实 WorkUnitService；
 * 健康探针 / CLI 执行 / trigger-registry / knowledge-service mock；心跳间隔经 deps seam 注入 50ms。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore, eventBus } from '@dommaker/studio-shared';
import { WorkUnitService, type WorkUnitMetadata } from '../../workunit/workunit.service.js';

const { mockExecSync } = vi.hoisted(() => ({
  mockExecSync: vi.fn().mockReturnValue('Claude Code CLI version 1.0.0'),
}));

vi.mock('child_process', () => ({ exec: vi.fn(),
  execSync: mockExecSync,
}));

const { mockExecuteLightweight, mockStopProcessGroup } = vi.hoisted(() => ({
  mockExecuteLightweight: vi.fn(),
  mockStopProcessGroup: vi.fn(),
}));

vi.mock('@dommaker/studio-agent', () => ({
  agentRunner: {
    executeLightweight: mockExecuteLightweight,
    stopProcessGroup: mockStopProcessGroup,
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
  id: 'role-stop-lease',
  name: 'stop-lease-agent',
  description: '#635 test agent',
  channels: '[]',
  status: 'active',
  createdAt: new Date(),
  updatedAt: new Date(),
};

/** 测试注入的租约心跳间隔（生产缺省 30s，50ms 让续期/易主检出可等待） */
const HEARTBEAT_MS = 50;

/** 直探 AgentLoop/WuLeaseTracker 私有 seam（既有 agent-loop-lease.test.ts 同款 cast 约定） */
interface StopLeaseInternals {
  instance: { id: string } | null;
  wuLease: {
    deps: { heartbeatIntervalMs?: number };
    lease: { wuId: string; claimedAt: string; stop: () => void } | null;
  };
  currentExecutionId: string | null;
}

let tmpDir: string;
let fileStore: FileStore;
let wuService: WorkUnitService;
let channelId: string;
let agentLoop: AgentLoop;
let internals: StopLeaseInternals;

beforeEach(async () => {
  vi.clearAllMocks();
  mockExecSync.mockReturnValue('Claude Code CLI version 1.0.0');
  // #579：fake/无凭证环境豁免认领前适任判断（不起真实 CLI）
  vi.stubEnv('STUDIO_CLAIM_FITNESS', 'false');
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loop-stop-lease-'));
  // leaseFlushIntervalMs=0：每跳即落盘（即时持久化契约），续期断言可直接读 timeoutAt
  fileStore = new FileStore(tmpDir, { leaseFlushIntervalMs: 0 });
  wuService = new WorkUnitService(fileStore);
  channelId = `ch-stop-lease-${Date.now()}`;
  await fileStore.createChannel({
    id: channelId, name: '#stop-lease-test', type: 'rnd',
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
  eventBus.unsubscribeAll('workunit.status_changed');
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}, 10000);

/** 启动 loop 并等到在飞 step：WU 已被认领、租约轨道在跑、executor 被调（step 挂起待手动放行） */
async function startLoopWithInFlightStep() {
  let resolveStep!: (result: unknown) => void;
  mockExecuteLightweight.mockImplementation(() => new Promise(resolve => { resolveStep = resolve; }));
  const wu = await wuService.create({
    scope: 'stop 租约守护任务', type: 'task', channelId,
    status: 'unassigned', // #126：task 默认落 pending（不可认领），显式置 unassigned
  });
  agentLoop = new AgentLoop(mockRole, fileStore);
  internals = agentLoop as unknown as StopLeaseInternals;
  internals.wuLease.deps.heartbeatIntervalMs = HEARTBEAT_MS;
  await agentLoop.start();
  await vi.waitFor(() => {
    expect(mockExecuteLightweight).toHaveBeenCalled();
    expect(internals.wuLease.lease?.wuId).toBe(wu.id);
  }, { timeout: 5000, interval: 20 });
  return { wu, resolveStep };
}

const STEP_RESULT = { success: true, outputText: 'ACTION: PROGRESS: 推进中', rawOutput: '', totalDurationMs: 1 };

describe('#635: stop() 后租约心跳与 fencing 活到 runLoop 退出', () => {
  it('stop() 后在飞 step 期间心跳继续续期（WU 不被回收）；step 完成合法回写；loop 退出后心跳停止', async () => {
    const { wu, resolveStep } = await startLoopWithInFlightStep();
    const timeoutAtBeforeStop = new Date((await wuService.getById(wu.id))!.timeoutAt!).getTime();

    agentLoop.stop();

    // stop 只置退出意图：租约轨道仍在，心跳未停
    expect(internals.wuLease.lease?.wuId).toBe(wu.id);

    // 心跳继续把 timeoutAt 推前（flush 间隔 0，每跳落盘）——续期命中即不会被 timeout-release 回收
    await vi.waitFor(async () => {
      const cur = (await wuService.getById(wu.id))!;
      expect(new Date(cur.timeoutAt!).getTime()).toBeGreaterThan(timeoutAtBeforeStop);
    }, { timeout: 3000, interval: 30 });

    // 在飞 step 完成：真持有租约下的合法回写（stepCount 推进），不触发易主善后
    resolveStep(STEP_RESULT);
    await agentLoop.waitForStop();
    const meta: WorkUnitMetadata = JSON.parse((await wuService.getById(wu.id))!.metadata ?? '{}');
    expect(meta.stepCount).toBe(1);
    expect(mockStopProcessGroup).not.toHaveBeenCalled();

    // loop 主循环已退出：心跳停止，timeoutAt 不再推前（此后按既有 5min TTL 到期回收）
    expect(internals.wuLease.lease).toBeNull();
    // 退出瞬间可能恰有一跳在飞（ticking 写盘竞态），先等其落定再锁定「不再推前」
    await new Promise(resolve => setTimeout(resolve, HEARTBEAT_MS * 3));
    const settled = new Date((await wuService.getById(wu.id))!.timeoutAt!).getTime();
    await new Promise(resolve => setTimeout(resolve, HEARTBEAT_MS * 4));
    const afterExit = new Date((await wuService.getById(wu.id))!.timeoutAt!).getTime();
    expect(afterExit).toBe(settled);
  });

  it('stop() 后窗口内 WU 被外部 unclaim → 心跳下一跳检出易主，handleLost 杀掉在飞 CLI 进程组', async () => {
    const { wu, resolveStep } = await startLoopWithInFlightStep();
    agentLoop.stop();
    const executionId = internals.currentExecutionId;
    expect(executionId).toBeTruthy();

    // 模拟 REST terminate 路径外部收单：assigneeId/claimedAt 清空
    await wuService.unclaim(wu.id);

    // 心跳下一跳 fencing 检出易主 → handleLost：杀在飞 CLI 进程组 + 停租约轨道
    await vi.waitFor(() => {
      expect(mockStopProcessGroup).toHaveBeenCalledWith(executionId);
    }, { timeout: 3000, interval: 30 });
    expect(internals.wuLease.lease).toBeNull();

    // 放行残余 step 让 loop 退出（进程组已被杀，结果回写走既有「无轨道不拦」契约，不在本票范围）
    resolveStep(STEP_RESULT);
    await agentLoop.waitForStop();
  });
});
