/**
 * bootstrap/agent-loop 测试（P2-a）：
 * - enabled：ensureStudioProfile → scheduler.start → registerDefaultTriggers →
 *   registry.subscribeToEvents → 事件订阅（bridges）→ mount，顺序与原 index.ts 一致；
 * - standby（STUDIO_AGENT_LOOP_ENABLED=false）：不注册触发器、不挂 loop，事件订阅保留；
 * - sweepEmptyAgentDirs 幂等清扫（#363）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const calls = vi.hoisted(() => [] as string[]);
const state = vi.hoisted(() => ({
  profiles: [{ name: 'pm' }, { name: 'dev' }] as Array<{ name: string }>,
  sweptRemoved: 0,
}));

vi.mock('@dommaker/studio-shared', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  FileStore: class {
    listProfiles = vi.fn(async () => { calls.push('listProfiles'); return state.profiles; });
    sweepEmptyAgentDirs = vi.fn(async () => ({ removed: state.sweptRemoved }));
  },
}));
vi.mock('../../modules/agent-loop/index.js', () => ({
  agentLoopRegistry: {
    subscribeToEvents: () => calls.push('registry.subscribeToEvents'),
    mount: vi.fn(async (p: { name: string }) => { calls.push(`mount:${p.name}`); return { status: 'running' }; }),
    get: vi.fn(),
  },
}));
vi.mock('../../modules/agents/default-triggers.js', () => ({
  registerDefaultTriggers: () => calls.push('registerDefaultTriggers'),
}));
vi.mock('../../modules/triggers/trigger-registry.js', () => ({
  getTriggerScheduler: () => ({
    start: () => calls.push('scheduler.start'),
    getStates: () => [],
  }),
}));
vi.mock('../../modules/agents/agent-profile.service.js', () => ({
  ensureStudioProfile: vi.fn(async () => { calls.push('ensureStudioProfile'); }),
}));
vi.mock('../../modules/agents/default-provider.js', () => ({
  backfillProfileProviders: vi.fn(async () => 0),
}));
vi.mock('../../modules/triggers/trigger-assignee-check.js', () => ({
  checkTriggerAssignees: vi.fn(async () => []),
}));
vi.mock('../bridges.js', () => ({
  initEventSubscriptions: vi.fn(async () => { calls.push('initEventSubscriptions'); }),
}));

import { startAgentLoops, sweepEmptyAgentDirs } from '../agent-loop.js';

const savedFlag = process.env.STUDIO_AGENT_LOOP_ENABLED;

beforeEach(() => {
  calls.length = 0;
  delete process.env.STUDIO_AGENT_LOOP_ENABLED;
});

afterEach(() => {
  if (savedFlag === undefined) delete process.env.STUDIO_AGENT_LOOP_ENABLED;
  else process.env.STUDIO_AGENT_LOOP_ENABLED = savedFlag;
});

describe('startAgentLoops', () => {
  it('enabled：按原 index.ts 顺序完成装配并挂载全部 active profile', async () => {
    await startAgentLoops();
    expect(calls).toEqual([
      'ensureStudioProfile',
      'listProfiles',
      'scheduler.start',
      'registerDefaultTriggers',
      'registry.subscribeToEvents',
      'initEventSubscriptions',
      'mount:pm',
      'mount:dev',
    ]);
  });

  it('standby：不注册系统触发器、不挂 loop，事件订阅仍保留', async () => {
    process.env.STUDIO_AGENT_LOOP_ENABLED = 'false';
    await startAgentLoops();
    expect(calls).toEqual([
      'ensureStudioProfile',
      'listProfiles',
      'scheduler.start',
      'initEventSubscriptions',
    ]);
    expect(calls).not.toContain('registerDefaultTriggers');
    expect(calls.filter(c => c.startsWith('mount:'))).toEqual([]);
  });
});

describe('sweepEmptyAgentDirs', () => {
  it('幂等清扫不抛错', async () => {
    await expect(sweepEmptyAgentDirs()).resolves.toBeUndefined();
  });
});
