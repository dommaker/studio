/**
 * #178（#63 决议 2，2026-08-16）AgentLoop 侧 claimedAt fencing：
 * - recordResult 步结果回写前比对 claimedAt 代际令牌，易主即放弃回写/状态迁移、
 *   杀自身 CLI 进程组（经 Executor.stopProcessGroup）、停止心跳、静默退出
 * - 持有有效 / 无租约轨道（未 start 的测试直调）时 fencing 不拦（既有行为不变）
 * 心跳本体（startLeaseHeartbeat）单测在 loop/__tests__/lease-heartbeat.test.ts。
 * 真实 FileStore（tmpdir）+ 真实 WorkUnitService；CLI 执行与 knowledge-service mock。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';
import { WorkUnitService, type WorkUnitMetadata } from '../../workunit/workunit.service.js';

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

import { AgentLoop } from '../loop/agent-loop';

const mockRole = {
  id: 'role-lease',
  name: 'lease-agent',
  description: 'lease test agent',
  channels: '[]',
  status: 'active',
  createdAt: new Date(),
  updatedAt: new Date(),
};

/** 直探 AgentLoop 私有租约/执行字段（既有测试同款 cast 约定）；
 * #209 smell 4 起租约轨道本体在 WuLeaseTracker（wu-lease.ts），经 wuLease 直探 */
interface LeaseInternals {
  instance: { id: string } | null;
  wuLease: { lease: { wuId: string; claimedAt: string; stop: () => void } | null };
  currentExecutionId: string | null;
  recordResult(target: unknown, result: unknown): Promise<void>;
}

let tmpDir: string;
let fileStore: FileStore;
let wuService: WorkUnitService;
let channelId: string;
let agentLoop: AgentLoop;

beforeEach(async () => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loop-lease-'));
  fileStore = new FileStore(tmpDir);
  wuService = new WorkUnitService(fileStore);
  channelId = `ch-lease-${Date.now()}`;
  await fileStore.createChannel({
    id: channelId, name: '#lease-test', type: 'rnd',
    defaultWorkspaceId: null, defaultPath: null,
    discordChannelId: null, discordWebhookUrl: null, members: '[]',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  agentLoop = new AgentLoop(mockRole, fileStore);
});

afterEach(() => {
  (agentLoop as unknown as LeaseInternals).wuLease.lease?.stop();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function createClaimed(assigneeId: string) {
  const wu = await wuService.create({
    scope: '租约任务', type: 'task', channelId,
    status: 'unassigned', // #126：task 默认落 pending（不可认领），显式置 unassigned
  });
  return wuService.claim(wu.id, assigneeId);
}

describe('#178: recordResult fencing（易主即放弃回写 + 杀自身 CLI 进程组）', () => {
  function armLease(claimedAt: string, wuId: string) {
    const loop = agentLoop as unknown as LeaseInternals;
    loop.instance = { id: 'inst-1' };
    loop.wuLease.lease = { wuId, claimedAt, stop: vi.fn() };
    return loop;
  }

  it('易主 → 不回写、不迁移、杀自身 CLI 进程组、停止心跳', async () => {
    const claimed = await createClaimed('inst-1');
    const loop = armLease(claimed.claimedAt!.toISOString(), claimed.id);
    loop.currentExecutionId = 'exec-x';

    // 步执行期间 WU 易主：释放回池 → 另一实例认领（claimedAt 换代）
    await wuService.unclaim(claimed.id);
    const reclaimed = await wuService.claim(claimed.id, 'inst-2');

    await loop.recordResult({ workUnit: reclaimed }, { action: 'complete', summary: '做完了' });

    // 旧 holder 一字未写：状态/认领/步数全部保持新 holder 视角
    const after = (await wuService.getById(claimed.id))!;
    expect(after.status).toBe('active');
    expect(after.assigneeId).toBe('inst-2');
    const meta: WorkUnitMetadata = JSON.parse(after.metadata ?? '{}');
    expect(meta.stepCount).toBeUndefined();
    // 杀自身 CLI 进程组 + 停止心跳
    expect(mockStopProcessGroup).toHaveBeenCalledWith('exec-x');
    expect(loop.wuLease.lease).toBeNull(); // 心跳已停
  });

  it('易主发生在状态迁移前（回写时仍持有）→ 迁移被拦截', async () => {
    const claimed = await createClaimed('inst-1');
    // 回写时仍持有的场景由「回写前校验」覆盖（上一条用例）；本条覆盖迁移前校验：
    // 租约令牌在 recordResult 入口处有效、迁移前失效 —— 用 need_input 迁移路径验证
    const loop = armLease(claimed.claimedAt!.toISOString(), claimed.id);

    // 先制造「回写时仍持有」：入口校验通过需快照 claimedAt 与租约一致 —— 这里直接
    // 在回写后、迁移前易主不可注入，改用入口即易主 + 断言无 blocked 迁移的等价口径
    await wuService.unclaim(claimed.id);
    await wuService.claim(claimed.id, 'inst-2');

    await loop.recordResult({ workUnit: claimed }, { action: 'need_input', summary: '等输入' });

    const after = (await wuService.getById(claimed.id))!;
    expect(after.status).toBe('active'); // 未被旧 holder 迁到 blocked
    expect(after.assigneeId).toBe('inst-2');
  });

  it('持有有效 → 回写与迁移照常（fencing 不误伤正常路径）', async () => {
    const claimed = await createClaimed('inst-1');
    const loop = armLease(claimed.claimedAt!.toISOString(), claimed.id);

    await loop.recordResult({ workUnit: claimed }, { action: 'progress', summary: '推进中' });

    const after = (await wuService.getById(claimed.id))!;
    expect(after.status).toBe('active');
    const meta: WorkUnitMetadata = JSON.parse(after.metadata ?? '{}');
    expect(meta.stepCount).toBe(1);
    expect(mockStopProcessGroup).not.toHaveBeenCalled();
  });

  it('无租约轨道（未 start 的测试直调）→ fencing 不拦（既有行为不变）', async () => {
    const claimed = await createClaimed('inst-1');
    const loop = agentLoop as unknown as LeaseInternals; // instance/lease 均未设置

    await loop.recordResult({ workUnit: claimed }, { action: 'progress', summary: '推进中' });

    const meta: WorkUnitMetadata = JSON.parse((await wuService.getById(claimed.id))!.metadata ?? '{}');
    expect(meta.stepCount).toBe(1);
  });
});
