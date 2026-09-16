// 2026-09-16 真接线集成测试：不 mock trigger-registry——
// AgentLoop.start → TriggerScheduler.registerTrigger → eventBus 订阅 → EXECUTE handler → 唤醒 全链验证。
// 背景：agent-loop-wakeup.test.ts 直驱 seam（手喂 payload），遮住了接线层；
// perf 实测（outputs/studio-perf-20260916）中 PMO publish 建单后 loop 睡满两个 15s idle 周期才认领，
// 疑似接线洞。本测试锁定真实接线，防回归。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore, eventBus } from '@dommaker/studio-shared';

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

// 注意：不 mock ../../triggers/trigger-registry——本文件的全部意义就是用真身

import { AgentLoop } from '../loop/agent-loop';

const mockRole = {
  id: 'role-wiring',
  name: 'wiring-agent',
  description: '真接线测试 agent',
  channels: '[]',
  status: 'active',
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('真接线：workunit.created 经 TriggerScheduler 唤醒 loop', () => {
  let testDir: string;
  let fileStore: FileStore;
  let agentLoop: AgentLoop;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecSync.mockReturnValue('Claude Code CLI version 1.0.0');
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loop-wiring-'));
    fileStore = new FileStore(testDir);
  });

  afterEach(async () => {
    if (agentLoop) {
      agentLoop.stop(); // 内部 unregisterTrigger（退订 eventBus）+ 中断 sleep
      await Promise.race([
        agentLoop.waitForStop(),
        new Promise(resolve => setTimeout(resolve, 2000)),
      ]);
    }
    fs.rmSync(testDir, { recursive: true, force: true });
  }, 5000);

  it('loop 进入 idle 后，eventBus 发 workunit.created（claimable=true）→ 2s 内跑新 observe（不等 15s 地板）', async () => {
    agentLoop = new AgentLoop(mockRole, fileStore);
    const indexSpy = vi.spyOn(fileStore, 'getIndex');
    await agentLoop.start();
    // 等首轮 observe 完成并进入 idleSleep
    await vi.waitFor(() => {
      expect(indexSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    }, { timeout: 3000, interval: 20 });
    await new Promise(resolve => setTimeout(resolve, 100)); // 让 loop 落定到 idleSleep

    const before = indexSpy.mock.calls.length;
    eventBus.publish('workunit.created', { workunit: { id: 'wu-wiring', status: 'unassigned', claimable: true } });

    await vi.waitFor(() => {
      expect(indexSpy.mock.calls.length).toBeGreaterThan(before);
    }, { timeout: 2000, interval: 20 });
  });
});
