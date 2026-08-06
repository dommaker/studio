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

    it('AC-1.3: mount 跳过 name=studio 角色（status=skipped，不创建 loop）', async () => {
      const studioProfile = makeProfile('studio-id');
      studioProfile.name = 'studio';
      const entry = await registry.mount(studioProfile);

      expect(entry.status).toBe('skipped');
      expect(entry.loop).toBeNull();
      // 不注册 trigger
      expect(mockTriggerScheduler.registerTrigger).not.toHaveBeenCalled();
      // get 仍可查到（便于调试）
      expect(registry.get('studio-id')).toBe(entry);
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
});
