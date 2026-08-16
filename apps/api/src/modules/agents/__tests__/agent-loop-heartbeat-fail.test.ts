/**
 * #179（#66 决议 3 loop 侧）：实例心跳写不再静默吞错 —— 连续 3 次（≈90s）失败判定
 * FileStore 故障，loop 自我了断：杀自身 CLI 进程组（经 Executor.stopProcessGroup）+
 * 停租约心跳 + 停 loop（静默退出，不写状态）；成功一次即重置连败计数。
 * 真实 FileStore（tmpdir）+ updateState 注错模拟故障；CLI 执行与 knowledge-service mock。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';

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
  id: 'role-hb',
  name: 'hb-agent',
  description: 'heartbeat fail test agent',
  channels: '[]',
  status: 'active',
  createdAt: new Date(),
  updatedAt: new Date(),
};

/** 直探 AgentLoop 私有字段（既有 agent-loop-lease.test.ts 同款 cast 约定） */
interface HbInternals {
  instance: { id: string } | null;
  alive: boolean;
  lease: { wuId: string; claimedAt: string; stop: () => void } | null;
  currentExecutionId: string | null;
  consecutiveHeartbeatFailures: number;
  updateIdleState(): Promise<void>;
}

let tmpDir: string;
let fileStore: FileStore;
let agentLoop: AgentLoop;
let internals: HbInternals;
let leaseStop: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loop-hb-'));
  fileStore = new FileStore(tmpDir);
  agentLoop = new AgentLoop(mockRole, fileStore);
  internals = agentLoop as unknown as HbInternals;
  // 模拟运行中的 loop：活实例 + 租约轨道 + 在飞 step
  internals.instance = { id: 'inst-hb' };
  internals.alive = true;
  leaseStop = vi.fn();
  internals.lease = { wuId: 'wu-hb', claimedAt: new Date().toISOString(), stop: leaseStop };
  internals.currentExecutionId = 'exec-hb';
  await fileStore.createState('inst-hb', {
    id: 'inst-hb', roleId: 'role-hb', sessionId: null, status: 'idle',
    currentWorkUnitId: null, startedAt: new Date().toISOString(),
    terminatedAt: null, lastHeartbeat: null, metadata: null,
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function breakFileStore(): void {
  fileStore.updateState = vi.fn().mockRejectedValue(new Error('EIO: FileStore broken'));
}

describe('#179: loop 心跳写连败自我了断', () => {
  it('连续 3 次心跳写失败 → 杀自身 CLI 进程组 + 停租约 + 停 loop（静默退出）', async () => {
    breakFileStore();

    await internals.updateIdleState();
    expect(internals.alive).toBe(true); // 第 1 次失败不自裁
    await internals.updateIdleState();
    expect(internals.alive).toBe(true); // 第 2 次失败不自裁
    await internals.updateIdleState();

    // 第 3 次（≈90s）→ 自我了断
    expect(internals.alive).toBe(false);
    expect(mockStopProcessGroup).toHaveBeenCalledWith('exec-hb');
    expect(leaseStop).toHaveBeenCalled();
    expect(internals.lease).toBeNull();
  });

  it('连败中途成功一次 → 计数重置，不达 3 连败不自裁', async () => {
    breakFileStore();
    await internals.updateIdleState();
    await internals.updateIdleState();
    expect(internals.consecutiveHeartbeatFailures).toBe(2);

    vi.mocked(fileStore.updateState).mockResolvedValueOnce(undefined as never);
    await internals.updateIdleState();
    expect(internals.consecutiveHeartbeatFailures).toBe(0);

    await internals.updateIdleState();
    await internals.updateIdleState();
    expect(internals.consecutiveHeartbeatFailures).toBe(2);
    expect(internals.alive).toBe(true); // 未达 3 连败
    expect(mockStopProcessGroup).not.toHaveBeenCalled();
  });
});
