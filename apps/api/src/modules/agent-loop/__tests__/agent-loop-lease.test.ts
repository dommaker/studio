/**
 * #178：claimedAt fencing。测试只使用 AgentLoop 的 StepContext/StepResult、
 * ensureLease/hasLease/currentExecutionId 公共接口，不触达 WuLeaseTracker 内部轨道。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';
import type { ExecutionResult } from '@dommaker/studio-agent';
import { WorkUnitService } from '../../workunit/workunit-review.js';
import type { WorkUnitMetadata } from '../../workunit/workunit.types.js';

const { mockExecuteLightweight, mockStopProcessGroup } = vi.hoisted(() => ({
  mockExecuteLightweight: vi.fn(), mockStopProcessGroup: vi.fn(),
}));

vi.mock('@dommaker/studio-agent', () => ({
  agentRunner: { executeLightweight: mockExecuteLightweight, stopProcessGroup: mockStopProcessGroup },
}));

vi.mock('../../knowledge/knowledge-service', () => ({
  knowledgeService: {
    injectContext: vi.fn().mockResolvedValue({ prompt: '', injectedIds: [] }),
    recordOutcome: vi.fn().mockResolvedValue(undefined),
    extractFromExecution: vi.fn().mockResolvedValue(undefined),
  },
}));

import { AgentLoop } from '../agent-loop';
import type { Executor } from '../executor';

const mockRole = {
  id: 'role-lease', name: 'lease-agent', description: 'lease test agent', channels: '[]',
  status: 'active', createdAt: new Date(), updatedAt: new Date(),
};

let tmpDir: string;
let fileStore: FileStore;
let wuService: WorkUnitService;
let channelId: string;
let agentLoop: AgentLoop;
let finishExecution: ((result: ExecutionResult) => void) | null;
let inFlight: Promise<unknown> | null;

const STEP_RESULT: ExecutionResult = {
  success: true, outputText: 'ACTION: PROGRESS:推进中', rawOutput: '', totalDurationMs: 1,
};

beforeEach(async () => {
  vi.clearAllMocks();
  finishExecution = null;
  inFlight = null;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loop-lease-'));
  fileStore = new FileStore(tmpDir);
  wuService = new WorkUnitService(fileStore);
  channelId = `ch-lease-${Date.now()}`;
  await fileStore.createChannel({
    id: channelId, name: '#lease-test', type: 'rnd', defaultWorkspaceId: null, defaultPath: null,
    discordChannelId: null, discordWebhookUrl: null, members: '[]',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  const executor: Executor = {
    execute: vi.fn(() => new Promise<ExecutionResult>(resolve => { finishExecution = resolve; })),
    stopProcessGroup: mockStopProcessGroup,
  };
  agentLoop = new AgentLoop(mockRole, fileStore, {
    instance: {
      id: 'inst-1', roleId: mockRole.id, sessionId: null, status: 'active',
      currentWorkUnitId: null, startedAt: new Date().toISOString(), terminatedAt: null,
      lastHeartbeat: null, metadata: null,
    },
    executor,
  });
});

afterEach(async () => {
  agentLoop.stopLease();
  finishExecution?.(STEP_RESULT);
  await inFlight;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function createClaimed(assigneeId: string) {
  const wu = await wuService.create({
    scope: '租约任务', type: 'task', channelId, status: 'unassigned',
  });
  return wuService.claim(wu.id, assigneeId);
}

describe('#178: recordResult fencing（易主即放弃回写 + 杀自身 CLI 进程组）', () => {
  it('易主 → 不回写、不迁移、杀自身 CLI 进程组、停止心跳', async () => {
    const claimed = await createClaimed('inst-1');
    agentLoop.ensureLease(claimed);
    inFlight = agentLoop.agentStep({ workUnit: claimed });
    await vi.waitFor(() => expect(agentLoop.currentExecutionId).toBeTruthy());
    const executionId = agentLoop.currentExecutionId;

    await wuService.unclaim(claimed.id);
    const reclaimed = await wuService.claim(claimed.id, 'inst-2');
    await agentLoop.recordResult({ workUnit: reclaimed }, { action: 'complete', summary: '做完了' });

    const after = (await wuService.getById(claimed.id))!;
    expect(after.status).toBe('active');
    expect(after.assigneeId).toBe('inst-2');
    const meta: WorkUnitMetadata = JSON.parse(after.metadata ?? '{}');
    expect(meta.stepCount).toBeUndefined();
    expect(mockStopProcessGroup).toHaveBeenCalledWith(executionId);
    expect(agentLoop.hasLease(claimed.id)).toBe(false);
  });

  it('易主发生在状态迁移前（回写时仍持有）→ 迁移被拦截', async () => {
    const claimed = await createClaimed('inst-1');
    agentLoop.ensureLease(claimed);

    await wuService.unclaim(claimed.id);
    await wuService.claim(claimed.id, 'inst-2');
    await agentLoop.recordResult({ workUnit: claimed }, { action: 'need_input', summary: '等输入' });

    const after = (await wuService.getById(claimed.id))!;
    expect(after.status).toBe('active');
    expect(after.assigneeId).toBe('inst-2');
  });

  it('持有有效 → 回写与迁移照常（fencing 不误伤正常路径）', async () => {
    const claimed = await createClaimed('inst-1');
    agentLoop.ensureLease(claimed);

    await agentLoop.recordResult({ workUnit: claimed }, { action: 'progress', summary: '推进中' });

    const after = (await wuService.getById(claimed.id))!;
    expect(after.status).toBe('active');
    const meta: WorkUnitMetadata = JSON.parse(after.metadata ?? '{}');
    expect(meta.stepCount).toBe(1);
    expect(mockStopProcessGroup).not.toHaveBeenCalled();
  });

  it('无租约轨道（未 start 的测试直调）→ fencing 不拦（既有行为不变）', async () => {
    const claimed = await createClaimed('inst-1');

    await agentLoop.recordResult({ workUnit: claimed }, { action: 'progress', summary: '推进中' });

    const meta: WorkUnitMetadata = JSON.parse((await wuService.getById(claimed.id))!.metadata ?? '{}');
    expect(meta.stepCount).toBe(1);
  });
});
