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

  it('registers 7 default triggers', () => {
    registerDefaultTriggers(registry);

    expect(mockRegisterTrigger).toHaveBeenCalledTimes(7);
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

  it('dependency-unlock fires on workunit.done with $event.id template', () => {
    registerDefaultTriggers(registry);

    const unlockCall = mockRegisterTrigger.mock.calls.find(
      (c: any) => c[0].id === 'dependency-unlock',
    );
    expect(unlockCall).toBeDefined();
    expect(unlockCall![0].condition).toEqual(
      expect.objectContaining({ type: 'EVENT', event: 'workunit.done' }),
    );
    // Bug 2 fix: dependsOn should use $event.id template, not contains: ''
    expect(unlockCall![0].action.config.query.dependsOn).toEqual({ contains: '$event.id' });
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

  it('does not register stale-recovery handler (workunit-timeout is UPDATE, not EXECUTE)', () => {
    registerDefaultTriggers(registry);

    // Bug 3 fix: stale-recovery handler was dead code (UPDATE action doesn't call EXECUTE handlers)
    const staleCalls = mockRegisterExecuteHandler.mock.calls.filter(
      (c: any) => c[0] === 'stale-recovery',
    );
    expect(staleCalls).toHaveLength(0);
  });

  it('getDefaultTriggerConfigs returns 5 configs', () => {
    const configs = getDefaultTriggerConfigs();
    expect(configs).toHaveLength(5);
    expect(configs.map(c => c.id)).toEqual([
      'agent-discover',
      'workunit-timeout',
      'dependency-unlock',
      'poll-fallback',
      'knowledge-quality-audit',
    ]);
  });

  it('knowledge-quality-audit fires daily and creates a WorkUnit', () => {
    registerDefaultTriggers(registry);

    const auditCall = mockRegisterTrigger.mock.calls.find(
      (c: any) => c[0].id === 'knowledge-quality-audit',
    );
    expect(auditCall).toBeDefined();
    expect(auditCall![0].condition).toEqual(
      expect.objectContaining({ type: 'SCHEDULE' }),
    );
    expect(auditCall![0].action).toEqual(
      expect.objectContaining({
        type: 'CREATE',
        target: 'WorkUnit',
      }),
    );
    expect(auditCall![0].action.payload.type).toBe('analysis');
    expect(auditCall![0].action.payload.scope).toContain('knowledge-quality-skill');
  });

  it('agent-timeout fires every 2 minutes', () => {
    registerDefaultTriggers(registry);

    const timeoutCall = mockRegisterTrigger.mock.calls.find(
      (c: any) => c[0].id === 'agent-timeout',
    );
    expect(timeoutCall).toBeDefined();
    expect(timeoutCall![0].condition).toEqual(
      expect.objectContaining({ type: 'SCHEDULE', cron: '*/2 * * * *' }),
    );
    expect(timeoutCall![0].action).toEqual(
      expect.objectContaining({ type: 'EXECUTE', target: 'agent-timeout-scan' }),
    );
  });

  it('session-knowledge-extraction fires daily at 4:17 and creates WorkUnit', () => {
    registerDefaultTriggers(registry);

    const extractCall = mockRegisterTrigger.mock.calls.find(
      (c: any) => c[0].id === 'session-knowledge-extraction',
    );
    expect(extractCall).toBeDefined();
    expect(extractCall![0].condition).toEqual(
      expect.objectContaining({ type: 'SCHEDULE', cron: '17 4 * * *' }),
    );
    expect(extractCall![0].action).toEqual(
      expect.objectContaining({
        type: 'CREATE',
        target: 'WorkUnit',
      }),
    );
    expect(extractCall![0].action.payload.type).toBe('analysis');
    expect(extractCall![0].action.payload.scope).toContain('data/sessions');
  });
});
