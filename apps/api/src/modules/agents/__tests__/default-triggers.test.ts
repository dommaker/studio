// AC-4: Default Trigger registration tests
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRegisterTrigger } = vi.hoisted(() => ({
  mockRegisterTrigger: vi.fn(),
}));

const { mockRegisterExecuteHandler } = vi.hoisted(() => ({
  mockRegisterExecuteHandler: vi.fn(),
}));

vi.mock('../../triggers/trigger-scheduler', () => ({
  TriggerScheduler: vi.fn().mockImplementation(() => ({
    registerTrigger: mockRegisterTrigger,
    getStates: vi.fn().mockReturnValue([]),
  })),
}));

vi.mock('../../triggers/trigger-action', () => ({
  registerExecuteHandler: mockRegisterExecuteHandler,
  unregisterExecuteHandler: vi.fn(),
  executeExecuteAction: vi.fn(),
  executeCreateAction: vi.fn(),
  executeUpdateAction: vi.fn(),
}));

vi.mock('../../goals/stale-recovery', () => ({
  recoverStaleWorkUnits: vi.fn().mockResolvedValue(0),
  recoverOrphanedExecutions: vi.fn().mockResolvedValue(0),
}));

import { registerDefaultTriggers, getDefaultTriggerConfigs } from '../default-triggers';
import { TriggerScheduler } from '../../triggers/trigger-scheduler';

describe('Default Triggers', () => {
  let registry: TriggerScheduler;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new (TriggerScheduler as any)(null);
  });

  it('registers 4 default triggers', () => {
    registerDefaultTriggers(registry);

    expect(mockRegisterTrigger).toHaveBeenCalledTimes(4);
  });

  it('agent-discover fires on workunit.created', () => {
    registerDefaultTriggers(registry);

    const discoverCall = mockRegisterTrigger.mock.calls.find(
      (c: any) => c[0].id === 'agent-discover',
    );
    expect(discoverCall).toBeDefined();
    expect(discoverCall![0].condition).toEqual(
      expect.objectContaining({ type: 'EVENT', event: 'workunit.created' }),
    );
    expect(discoverCall![0].action).toEqual(
      expect.objectContaining({ type: 'EXECUTE', target: 'agent-loop' }),
    );
  });

  it('workunit-timeout fires every 5 minutes', () => {
    registerDefaultTriggers(registry);

    const timeoutCall = mockRegisterTrigger.mock.calls.find(
      (c: any) => c[0].id === 'workunit-timeout',
    );
    expect(timeoutCall).toBeDefined();
    expect(timeoutCall![0].condition).toEqual(
      expect.objectContaining({ type: 'SCHEDULE', cron: '*/5 * * * *' }),
    );
  });

  it('dependency-unlock fires on workunit.done', () => {
    registerDefaultTriggers(registry);

    const unlockCall = mockRegisterTrigger.mock.calls.find(
      (c: any) => c[0].id === 'dependency-unlock',
    );
    expect(unlockCall).toBeDefined();
    expect(unlockCall![0].condition).toEqual(
      expect.objectContaining({ type: 'EVENT', event: 'workunit.done' }),
    );
  });

  it('poll-fallback fires every 30 seconds', () => {
    registerDefaultTriggers(registry);

    const pollCall = mockRegisterTrigger.mock.calls.find(
      (c: any) => c[0].id === 'poll-fallback',
    );
    expect(pollCall).toBeDefined();
    expect(pollCall![0].condition).toEqual(
      expect.objectContaining({ type: 'SCHEDULE' }),
    );
    // 6-field cron (with seconds) for 30-second interval
    expect(pollCall![0].condition.cron).toContain('*/30');
  });

  it('getDefaultTriggerConfigs returns 4 configs', () => {
    const configs = getDefaultTriggerConfigs();
    expect(configs).toHaveLength(4);
    expect(configs.map(c => c.id)).toEqual([
      'agent-discover',
      'workunit-timeout',
      'dependency-unlock',
      'poll-fallback',
    ]);
  });
});
