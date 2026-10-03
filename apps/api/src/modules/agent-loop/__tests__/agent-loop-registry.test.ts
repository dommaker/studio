// F1: AgentLoopRegistry unit tests
// - mount/unmount/get/list
// - mount idempotency
// - start-failure isolation (one profile's failure doesn't affect others, F2 error state recorded)
// - lifecycle events (agent-profile.created/updated/deleted) → mount/unmount
// CLI health probe is mocked — tests do not require claude installed.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FileStore, eventBus, type AgentProfileData } from '@dommaker/studio-shared';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const { mockExecSync } = vi.hoisted(() => ({
  mockExecSync: vi.fn().mockReturnValue('Claude Code CLI version 1.0.0'),
}));

vi.mock('child_process', () => ({ exec: vi.fn(),
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

vi.mock('../../workunit/workunit.service', () => ({
  WorkUnitService: vi.fn().mockImplementation(function () { return {
    claim: vi.fn(),
    unclaim: vi.fn(),
    transitionStatus: vi.fn(),
    list: vi.fn().mockResolvedValue({ data: [] }),
    getById: vi.fn().mockResolvedValue(null),
    update: vi.fn(),
  }; }),
  snapshotToData: (s: unknown) => s,
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

import { AgentLoopRegistry } from '../agent-loop-registry';

function makeProfile(id: string, overrides: Partial<AgentProfileData> = {}): AgentProfileData {
  return {
    id,
    name: `agent-${id}`,
    description: null,
    channels: '[]',
    status: 'active',
    provider: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('AgentLoopRegistry', () => {
  let testDir: string;
  let fileStore: FileStore;
  let registry: AgentLoopRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecSync.mockReturnValue('Claude Code CLI version 1.0.0');
    testDir = path.join(os.tmpdir(), `agent-loop-registry-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    fileStore = new FileStore(testDir);
    registry = new AgentLoopRegistry(fileStore);
  });

  afterEach(async () => {
    registry.unmountAll();
    eventBus.clear();
    await new Promise(resolve => setTimeout(resolve, 50));
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  describe('mount()', () => {
    it('starts a loop for the profile and records it as running', async () => {
      const entry = await registry.mount(makeProfile('p1'));

      expect(entry.status).toBe('running');
      expect(registry.get('p1')).toBe(entry);
      expect(registry.list()).toHaveLength(1);
      expect(mockTriggerScheduler.registerTrigger).toHaveBeenCalledWith(
        expect.objectContaining({
          condition: { type: 'EVENT', event: 'workunit.created' },
        })
      );
      // Runtime instance created
      const states = await fileStore.listStates();
      expect(states.find(s => s.roleId === 'p1' && s.status === 'idle')).toBeDefined();
    });

    it('is idempotent — second mount returns the same entry without re-starting', async () => {
      const first = await registry.mount(makeProfile('p1'));
      const second = await registry.mount(makeProfile('p1'));

      expect(second).toBe(first);
      expect(mockTriggerScheduler.registerTrigger).toHaveBeenCalledTimes(1);
      expect(registry.list()).toHaveLength(1);
    });

    it('studio 系统角色正常挂载 loop（2026-09-10 设计修正：AC-1.3 跳过已废除——系统维护 WU 指名 studio，无 loop 即死单）', async () => {
      const studioProfile = makeProfile('studio-id');
      studioProfile.name = 'studio';
      const entry = await registry.mount(studioProfile);

      expect(entry.status).toBe('running');
      expect(entry.loop).not.toBeNull();
      // 与其他角色同待遇：注册 EVENT trigger + 建运行时实例
      expect(mockTriggerScheduler.registerTrigger).toHaveBeenCalledWith(
        expect.objectContaining({
          condition: { type: 'EVENT', event: 'workunit.created' },
        })
      );
      const states = await fileStore.listStates();
      expect(states.find(s => s.roleId === 'studio-id' && s.status === 'idle')).toBeDefined();
    });
  });

  describe('start-failure isolation', () => {
    it('marks the failed profile without throwing; other profiles still mount (F2 error state recorded)', async () => {
      // Health probe fails only for the first mount
      mockExecSync.mockImplementationOnce(() => { throw new Error('ENOENT: claude not found'); });

      const healthEvents: unknown[] = [];
      eventBus.subscribe('agent.health.failed', (payload: unknown) => healthEvents.push(payload));

      const bad = await registry.mount(makeProfile('bad'));
      expect(bad.status).toBe('failed');
      expect(bad.error).toBeTruthy();

      // F2: failure recorded in runtime state
      const states = await fileStore.listStates();
      const errState = states.find(s => s.roleId === 'bad');
      expect(errState).toBeDefined();
      expect(errState!.status).toBe('error');
      expect(errState!.lastError).toBeTruthy();
      expect(errState!.lastErrorAt).toBeTruthy();

      // F2: agent.health.failed published
      expect(healthEvents).toHaveLength(1);
      expect(healthEvents[0]).toMatchObject({ profileId: 'bad', name: 'agent-bad' });

      // Other profiles are unaffected
      const good = await registry.mount(makeProfile('good'));
      expect(good.status).toBe('running');
      expect(registry.list()).toHaveLength(2);
    });

    it('does not register an EVENT trigger for a failed loop', async () => {
      mockExecSync.mockImplementationOnce(() => { throw new Error('ENOENT'); });

      await registry.mount(makeProfile('bad'));
      expect(mockTriggerScheduler.registerTrigger).not.toHaveBeenCalled();
    });
  });

  describe('unmount()', () => {
    it('stops the loop and removes the entry', async () => {
      await registry.mount(makeProfile('p1'));
      registry.unmount('p1');

      expect(registry.get('p1')).toBeUndefined();
      expect(registry.list()).toHaveLength(0);
      expect(mockTriggerScheduler.unregisterTrigger).toHaveBeenCalledWith(
        expect.stringContaining('p1')
      );
    });

    it('is idempotent — unmounting an unknown profile is a no-op', () => {
      expect(() => registry.unmount('nope')).not.toThrow();
    });
  });

  describe('unmountAll()', () => {
    it('stops and removes all loops', async () => {
      await registry.mount(makeProfile('p1'));
      await registry.mount(makeProfile('p2'));
      expect(registry.list()).toHaveLength(2);

      registry.unmountAll();
      expect(registry.list()).toHaveLength(0);
      expect(mockTriggerScheduler.unregisterTrigger).toHaveBeenCalledTimes(2);
    });
  });

  describe('lifecycle events (subscribeToEvents)', () => {
    it('mounts on agent-profile.created (active), unmounts on agent-profile.deleted', async () => {
      registry.subscribeToEvents();

      eventBus.publish('agent-profile.created', { profile: makeProfile('evt-1') });
      await vi.waitFor(() => expect(registry.get('evt-1')).toBeDefined());
      expect(registry.get('evt-1')!.status).toBe('running');

      eventBus.publish('agent-profile.deleted', { profileId: 'evt-1' });
      expect(registry.get('evt-1')).toBeUndefined();
    });

    it('ignores created profiles that are not active; mounts on later activation', async () => {
      registry.subscribeToEvents();

      eventBus.publish('agent-profile.created', { profile: makeProfile('evt-2', { status: 'inactive' }) });
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(registry.get('evt-2')).toBeUndefined();

      eventBus.publish('agent-profile.updated', { profile: makeProfile('evt-2'), previousStatus: 'inactive' });
      await vi.waitFor(() => expect(registry.get('evt-2')).toBeDefined());
    });

    it('unmounts on deactivation (status active → inactive)', async () => {
      registry.subscribeToEvents();

      eventBus.publish('agent-profile.created', { profile: makeProfile('evt-3') });
      await vi.waitFor(() => expect(registry.get('evt-3')).toBeDefined());

      eventBus.publish('agent-profile.updated', {
        profile: makeProfile('evt-3', { status: 'inactive' }),
        previousStatus: 'active',
      });
      expect(registry.get('evt-3')).toBeUndefined();
    });

    it('is idempotent — second subscribeToEvents call does not double-mount', async () => {
      registry.subscribeToEvents();
      registry.subscribeToEvents();

      eventBus.publish('agent-profile.created', { profile: makeProfile('evt-4') });
      await vi.waitFor(() => expect(registry.get('evt-4')).toBeDefined());
      expect(registry.list()).toHaveLength(1);
    });
  });

  describe('#634: provider 变更重挂（active→active）', () => {
    async function mountViaEvent(id: string, provider: string) {
      const profile = makeProfile(id, { provider });
      await fileStore.createProfile(profile);
      registry.subscribeToEvents();
      eventBus.publish('agent-profile.created', { profile });
      await vi.waitFor(() => expect(registry.get(id)?.status).toBe('running'));
      return profile;
    }

    function publishProviderChange(id: string, snapshotProvider: string) {
      eventBus.publish('agent-profile.updated', {
        profile: makeProfile(id, { provider: snapshotProvider }),
        previousStatus: 'active',
        changedFields: ['provider'],
      });
    }

    it('provider 变更 → 停旧 loop、等其完全退出后以 store 现值重挂（事件 payload 是过期快照也不影响）', async () => {
      await mountViaEvent('p1', 'claude');
      const oldLoop = registry.get('p1')!.loop;

      // store 已改新值；payload 故意带旧快照——重挂必须读 store 现值
      await fileStore.updateProfile('p1', { provider: 'kimi' });
      publishProviderChange('p1', 'claude');

      await vi.waitFor(() => {
        const entry = registry.get('p1');
        expect(entry).toBeDefined();
        expect(entry!.loop).not.toBe(oldLoop);
      });
      const entry = registry.get('p1')!;
      expect(entry.status).toBe('running');
      expect((entry.loop as unknown as { role: AgentProfileData }).role.provider).toBe('kimi');

      // 旧实例 terminated 落盘、新实例 idle
      const states = await fileStore.listStates();
      const p1States = states.filter(s => s.roleId === 'p1');
      expect(p1States.some(s => s.status === 'terminated')).toBe(true);
      expect(p1States.some(s => s.status === 'idle')).toBe(true);
    });

    it('重挂内部串行等待：旧 loop stop 先于新 loop start（单活守卫不触发，无 standby 报错）', async () => {
      await mountViaEvent('p1', 'claude');
      await fileStore.updateProfile('p1', { provider: 'kimi' });
      publishProviderChange('p1', 'kimi');

      await vi.waitFor(() => {
        expect(mockTriggerScheduler.registerTrigger).toHaveBeenCalledTimes(2);
      });

      const unregisterOrder = mockTriggerScheduler.unregisterTrigger.mock.invocationCallOrder[0];
      const secondRegisterOrder = mockTriggerScheduler.registerTrigger.mock.invocationCallOrder[1];
      expect(unregisterOrder).toBeLessThan(secondRegisterOrder);

      // 无单活守卫 standby 失败落盘
      const states = await fileStore.listStates();
      expect(states.some(s => s.lastError?.includes('standby'))).toBe(false);
      expect(registry.get('p1')!.status).toBe('running');
    });

    it('changedFields 不含 provider → 不重挂（既有 loop 保持不动）', async () => {
      await mountViaEvent('p1', 'claude');
      const oldLoop = registry.get('p1')!.loop;

      eventBus.publish('agent-profile.updated', {
        profile: makeProfile('p1', { description: 'new desc' }),
        previousStatus: 'active',
        changedFields: ['description'],
      });
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(registry.get('p1')!.loop).toBe(oldLoop);
      expect(mockTriggerScheduler.registerTrigger).toHaveBeenCalledTimes(1);
    });

    it('新 provider 探测失败 → 落 failed 状态可见，不回退旧 provider', async () => {
      await mountViaEvent('p1', 'claude');
      mockExecSync.mockImplementationOnce(() => { throw new Error('ENOENT: kimi not found'); });

      await fileStore.updateProfile('p1', { provider: 'kimi' });
      publishProviderChange('p1', 'kimi');

      await vi.waitFor(() => expect(registry.get('p1')?.status).toBe('failed'));
      expect(registry.get('p1')!.error).toBeTruthy();
      // 无回退第三次挂载
      expect(mockTriggerScheduler.registerTrigger).toHaveBeenCalledTimes(1);
      // 失败对外可见（F2 error state，含探测失败原因）
      const states = await fileStore.listStates();
      const errState = states.find(s => s.roleId === 'p1' && s.status === 'error');
      expect(errState?.lastError).toContain('not available');
    });

    it('连续多次 provider 变更 → 每次各自触发完整重挂、串行排队，最终挂载取 store 最新现值', async () => {
      await mountViaEvent('p1', 'claude');
      const firstLoop = registry.get('p1')!.loop;

      await fileStore.updateProfile('p1', { provider: 'kimi' });
      publishProviderChange('p1', 'kimi');
      await fileStore.updateProfile('p1', { provider: 'codex' });
      publishProviderChange('p1', 'codex');

      await vi.waitFor(() => {
        expect(mockTriggerScheduler.registerTrigger).toHaveBeenCalledTimes(3);
      });
      const entry = registry.get('p1')!;
      expect(entry.status).toBe('running');
      expect(entry.loop).not.toBe(firstLoop);
      expect((entry.loop as unknown as { role: AgentProfileData }).role.provider).toBe('codex');
    });

    it('重挂等待期间角色被停用 → 不再重挂', async () => {
      await mountViaEvent('p1', 'claude');
      await fileStore.updateProfile('p1', { provider: 'kimi', status: 'inactive' });
      publishProviderChange('p1', 'kimi');

      // 等重挂流程走完（旧 loop 被停且没有新挂载）
      await vi.waitFor(() => {
        expect(mockTriggerScheduler.unregisterTrigger).toHaveBeenCalled();
      });
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(registry.get('p1')).toBeUndefined();
      expect(mockTriggerScheduler.registerTrigger).toHaveBeenCalledTimes(1);
    });
  });
});
