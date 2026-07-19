/**
 * F6: AgentLoop 工程绑定执行 cwd + 空闲心跳修复
 *
 * - 绑定了 workspaceId 的 WorkUnit → executeLightweight 收到 parameters.workspaceRoot
 * - 未绑定 / workspace 记录缺失 → 不传 workspaceRoot（行为不变）
 * - runLoop 空闲分支（updateIdleState）刷新 lastHeartbeat，且按 45s 节流
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FileStore, type AgentProfileData, type RuntimeStateData } from '@dommaker/studio-shared';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const { mockExecSync } = vi.hoisted(() => ({
  mockExecSync: vi.fn().mockReturnValue('Claude Code CLI version 1.0.0'),
}));

vi.mock('child_process', () => ({
  execSync: mockExecSync,
}));

const { mockExecuteLightweight } = vi.hoisted(() => ({
  mockExecuteLightweight: vi.fn(),
}));

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const orig = await importOriginal() as Record<string, unknown>;
  return {
    ...orig,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
});

vi.mock('@dommaker/studio-agent', () => ({
  agentRunner: {
    executeLightweight: mockExecuteLightweight,
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

vi.mock('../../knowledge/knowledge-service', () => ({
  knowledgeService: {
    injectContext: vi.fn().mockResolvedValue({ prompt: '', injectedIds: [] }),
    recordOutcome: vi.fn().mockResolvedValue(undefined),
    extractFromExecution: vi.fn().mockResolvedValue(undefined),
  },
}));

import { AgentLoop } from '../agent-loop';
import { WorkUnitService } from '../../workunit/workunit.service';

const WORKSPACES_DIR = path.join(os.homedir(), '.studio', 'workspaces');

function makeRole(): AgentProfileData {
  const now = new Date().toISOString();
  return {
    id: `role-f6-${Date.now()}`,
    name: 'f6-agent',
    description: 'task executor',
    channels: '[]',
    status: 'active',
    provider: 'claude',
    createdAt: now,
    updatedAt: now,
  };
}

describe('F6: AgentLoop workspace binding + idle heartbeat', () => {
  let testDir: string;
  let fileStore: FileStore;
  let workUnitService: WorkUnitService;
  let wsId: string;
  let wsRoot: string;

  beforeEach(() => {
    vi.clearAllMocks();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loop-f6-'));
    fileStore = new FileStore(testDir);
    workUnitService = new WorkUnitService(fileStore);
    // 真实 workspace 记录（workspace-store 读 ~/.studio/workspaces，与模块约定一致）
    wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'f6-ws-root-'));
    wsId = `ws-f6-loop-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    fs.mkdirSync(WORKSPACES_DIR, { recursive: true });
    fs.writeFileSync(path.join(WORKSPACES_DIR, `${wsId}.json`), JSON.stringify({
      id: wsId, name: 'f6-loop-test', workspaceRoot: wsRoot,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }));
    mockExecuteLightweight.mockResolvedValue({ success: true, outputText: 'ACTION: COMPLETE:done' });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
    fs.rmSync(wsRoot, { recursive: true, force: true });
    try { fs.unlinkSync(path.join(WORKSPACES_DIR, `${wsId}.json`)); } catch { /* already gone */ }
  });

  /** 直接调用私有 agentStep，返回 executeLightweight 收到的 task */
  async function runStep(loop: AgentLoop, wuId: string) {
    const wu = await workUnitService.getById(wuId);
    expect(wu).toBeTruthy();
    await (loop as any).agentStep({ workUnit: wu });
    expect(mockExecuteLightweight).toHaveBeenCalledTimes(1);
    return mockExecuteLightweight.mock.calls[0][0];
  }

  it('bound WorkUnit → executeLightweight receives parameters.workspaceRoot', async () => {
    const loop = new AgentLoop(makeRole(), fileStore);
    const wu = await workUnitService.create({ scope: 'bound task', channelId: null, workspaceId: wsId });

    const task = await runStep(loop, wu.id);

    expect(task.parameters.workspaceRoot).toBe(wsRoot);
  });

  it('unbound WorkUnit → no workspaceRoot passed (unchanged behavior)', async () => {
    const loop = new AgentLoop(makeRole(), fileStore);
    const wu = await workUnitService.create({ scope: 'unbound task', channelId: null });

    const task = await runStep(loop, wu.id);

    expect(task.parameters.workspaceRoot).toBeUndefined();
  });

  it('bound to missing workspace record → no workspaceRoot (fallback, no crash)', async () => {
    const loop = new AgentLoop(makeRole(), fileStore);
    const wu = await workUnitService.create({ scope: 'stale binding', channelId: null, workspaceId: 'ws-f6-missing' });

    const task = await runStep(loop, wu.id);

    expect(task.parameters.workspaceRoot).toBeUndefined();
  });

  describe('idle heartbeat (F6-fix)', () => {
    async function setupLoopWithInstance(): Promise<{ loop: AgentLoop; instanceId: string }> {
      const loop = new AgentLoop(makeRole(), fileStore);
      const instanceId = `inst-f6-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const now = new Date().toISOString();
      const state: RuntimeStateData = {
        id: instanceId, roleId: 'role-f6', sessionId: null, status: 'idle',
        currentWorkUnitId: null, startedAt: now, terminatedAt: null,
        lastHeartbeat: null, metadata: null, pid: process.pid,
      };
      await fileStore.createState(instanceId, state);
      (loop as any).instance = state;
      return { loop, instanceId };
    }

    it('idle branch updates lastHeartbeat (agent-timeout-scan keeps it alive)', async () => {
      const { loop, instanceId } = await setupLoopWithInstance();

      await (loop as any).updateIdleState();

      const state = await fileStore.getState(instanceId);
      expect(state!.status).toBe('idle');
      expect(state!.lastHeartbeat).toBeTruthy();
    });

    it('heartbeat is throttled — second idle tick within 45s does not rewrite it', async () => {
      const { loop, instanceId } = await setupLoopWithInstance();

      await (loop as any).updateIdleState();
      const hb1 = (await fileStore.getState(instanceId))!.lastHeartbeat;

      await (loop as any).updateIdleState();
      const state = await fileStore.getState(instanceId);
      // status 仍更新，但心跳被节流（同一时间戳）
      expect(state!.status).toBe('idle');
      expect(state!.lastHeartbeat).toBe(hb1);
    });

    it('heartbeat refreshes again after the throttle interval', async () => {
      const { loop, instanceId } = await setupLoopWithInstance();

      await (loop as any).updateIdleState();
      // 把已存心跳回拨到 60s 前，并模拟上次心跳发生在 46s 前（超过 45s 节流窗口）
      await fileStore.updateState(instanceId, { lastHeartbeat: new Date(Date.now() - 60_000).toISOString() });
      (loop as any).lastIdleHeartbeatAt = Date.now() - 46_000;

      await (loop as any).updateIdleState();

      const hb = (await fileStore.getState(instanceId))!.lastHeartbeat!;
      expect(new Date(hb).getTime()).toBeGreaterThan(Date.now() - 10_000);
    });
  });
});
