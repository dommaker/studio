/**
 * #179：LoopLifecycle 自己持有 alive/instance/连败状态；测试只跨其公共接口与窄 Deps。
 * 连续 3 次心跳写失败自裁；中途成功会重置连败。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore, eventBus } from '@dommaker/studio-shared';

vi.mock('child_process', () => ({
  exec: vi.fn((cmd: unknown, opts: unknown, cb: unknown) => {
    const callback = typeof opts === 'function' ? opts : cb;
    if (typeof callback === 'function') (callback as (err: null, out: string, errOut: string) => void)(null, '', '');
  }),
  execSync: vi.fn(),
}));

const { mockTriggerScheduler } = vi.hoisted(() => ({
  mockTriggerScheduler: {
    registerTrigger: vi.fn(), unregisterTrigger: vi.fn(), registerExecuteHandler: vi.fn(),
    getStates: vi.fn().mockReturnValue([]),
  },
}));

vi.mock('../../triggers/trigger-registry', () => ({
  getTriggerScheduler: () => mockTriggerScheduler,
}));

import { LoopLifecycle } from '../loop/loop-lifecycle';
import type { LifecycleDeps } from '../loop/loop-deps';

const mockRole = {
  id: 'role-hb', name: 'hb-agent', description: 'heartbeat fail test agent',
  channels: '[]', status: 'active', createdAt: new Date(), updatedAt: new Date(),
};

let tmpDir: string;
let fileStore: FileStore;
let lifecycle: LoopLifecycle;
let stopLease: ReturnType<typeof vi.fn>;
let stopProcessGroup: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loop-hb-'));
  fileStore = new FileStore(tmpDir);
  stopLease = vi.fn();
  stopProcessGroup = vi.fn().mockResolvedValue(undefined);
  const deps: LifecycleDeps = {
    role: mockRole,
    fileStore,
    executor: { execute: vi.fn(), stopProcessGroup },
    runLoop: () => new Promise<void>(() => {}),
    onChannelMessageSent: vi.fn(),
    onWorkUnitClaimable: vi.fn(),
    wakeIdle: vi.fn(),
    stopLease,
    getCurrentExecutionId: () => 'exec-hb',
  };
  lifecycle = new LoopLifecycle(deps);
  expect(await lifecycle.start()).toBe(true);
});

afterEach(() => {
  lifecycle.stop();
  eventBus.unsubscribeAll('channel.message_sent');
  eventBus.unsubscribeAll('workunit.status_changed');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function breakFileStore(): void {
  fileStore.updateState = vi.fn().mockRejectedValue(new Error('EIO: FileStore broken'));
}

describe('#179: loop 心跳写连败自我了断', () => {
  it('连续 3 次心跳写失败 → 杀自身 CLI 进程组 + 停租约 + 停 loop（静默退出）', async () => {
    breakFileStore();

    await lifecycle.updateIdleState();
    expect(lifecycle.isAlive()).toBe(true);
    await lifecycle.updateIdleState();
    expect(lifecycle.isAlive()).toBe(true);
    await lifecycle.updateIdleState();

    expect(lifecycle.isAlive()).toBe(false);
    expect(stopProcessGroup).toHaveBeenCalledWith('exec-hb');
    expect(stopLease).toHaveBeenCalledOnce();
  });

  it('连败中途成功一次 → 计数重置，重新累计到 3 次才自裁', async () => {
    breakFileStore();
    await lifecycle.updateIdleState();
    await lifecycle.updateIdleState();

    vi.mocked(fileStore.updateState).mockResolvedValueOnce(undefined as never);
    await lifecycle.updateIdleState();

    await lifecycle.updateIdleState();
    await lifecycle.updateIdleState();
    expect(lifecycle.isAlive()).toBe(true);
    expect(stopProcessGroup).not.toHaveBeenCalled();

    await lifecycle.updateIdleState();
    expect(lifecycle.isAlive()).toBe(false);
    expect(stopProcessGroup).toHaveBeenCalledWith('exec-hb');
  });
});
