// AC-4: Default Trigger registration tests
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRegisterTrigger } = vi.hoisted(() => ({
  mockRegisterTrigger: vi.fn(),
}));

const { mockRegisterExecuteHandler } = vi.hoisted(() => ({
  mockRegisterExecuteHandler: vi.fn(),
}));

vi.mock('../../triggers/trigger-scheduler', () => ({
  TriggerScheduler: vi.fn().mockImplementation(function () { return {
    registerTrigger: mockRegisterTrigger,
    getStates: vi.fn().mockReturnValue([]),
  }; }),
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

  it('registers 10 default triggers', () => {
    registerDefaultTriggers(registry);

    expect(mockRegisterTrigger).toHaveBeenCalledTimes(10);
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

  it('does not register stale-recovery handler (workunit-timeout is UPDATE, not EXECUTE)', () => {
    registerDefaultTriggers(registry);

    // Bug 3 fix: stale-recovery handler was dead code (UPDATE action doesn't call EXECUTE handlers)
    const staleCalls = mockRegisterExecuteHandler.mock.calls.filter(
      (c: any) => c[0] === 'stale-recovery',
    );
    expect(staleCalls).toHaveLength(0);
  });

  it('getDefaultTriggerConfigs returns 10 configs', () => {
    const configs = getDefaultTriggerConfigs();
    expect(configs).toHaveLength(10);
    expect(configs.map(c => c.id)).toEqual([
      'workunit-timeout',
      'agent-timeout',
      'knowledge-quality-audit',
      'okr-metric-sync',
      'session-knowledge-extraction',
      'zero-consumption-audit',
      'knowledge-synthesis',
      'workunit-input-reminder',
      'evolution-daily-scan',
      'doc-semantic-review',
    ]);
  });

  it('workunit-input-reminder fires every 5 minutes (F5)', () => {
    registerDefaultTriggers(registry);

    const reminderCall = mockRegisterTrigger.mock.calls.find(
      (c: any) => c[0].id === 'workunit-input-reminder',
    );
    expect(reminderCall).toBeDefined();
    expect(reminderCall![0].condition).toEqual(
      expect.objectContaining({ type: 'SCHEDULE', cron: '*/5 * * * *' }),
    );
    expect(reminderCall![0].action).toEqual(
      expect.objectContaining({ type: 'EXECUTE', target: 'workunit-input-reminder-scan' }),
    );
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

  it('zero-consumption-audit fires daily at 5:17 and creates WorkUnit', () => {
    registerDefaultTriggers(registry);

    const auditCall = mockRegisterTrigger.mock.calls.find(
      (c: any) => c[0].id === 'zero-consumption-audit',
    );
    expect(auditCall).toBeDefined();
    expect(auditCall![0].condition).toEqual(
      expect.objectContaining({ type: 'SCHEDULE', cron: '17 5 * * *' }),
    );
    expect(auditCall![0].action).toEqual(
      expect.objectContaining({
        type: 'CREATE',
        target: 'WorkUnit',
      }),
    );
    expect(auditCall![0].action.payload.type).toBe('analysis');
    expect(auditCall![0].action.payload.scope).toContain('referencedBy');
  });

  it('knowledge-synthesis fires weekly Monday 10:23 and creates WorkUnit', () => {
    registerDefaultTriggers(registry);

    const synthesisCall = mockRegisterTrigger.mock.calls.find(
      (c: any) => c[0].id === 'knowledge-synthesis',
    );
    expect(synthesisCall).toBeDefined();
    expect(synthesisCall![0].condition).toEqual(
      expect.objectContaining({ type: 'SCHEDULE', cron: '23 10 * * 1' }),
    );
    expect(synthesisCall![0].action).toEqual(
      expect.objectContaining({
        type: 'CREATE',
        target: 'WorkUnit',
      }),
    );
    expect(synthesisCall![0].action.payload.type).toBe('analysis');
    expect(synthesisCall![0].action.payload.scope).toContain('knowledge-synthesis-skill');
  });

  it('doc-semantic-review fires weekly Friday 9:47 and creates WorkUnit', () => {
    registerDefaultTriggers(registry);

    const reviewCall = mockRegisterTrigger.mock.calls.find(
      (c: any) => c[0].id === 'doc-semantic-review',
    );
    expect(reviewCall).toBeDefined();
    expect(reviewCall![0].condition).toEqual(
      expect.objectContaining({ type: 'SCHEDULE', cron: '47 9 * * 5' }),
    );
    expect(reviewCall![0].action).toEqual(
      expect.objectContaining({
        type: 'CREATE',
        target: 'WorkUnit',
      }),
    );
    expect(reviewCall![0].action.payload.type).toBe('analysis');
    expect(reviewCall![0].action.payload.scope).toContain('README.md');
    expect(reviewCall![0].action.payload.scope).toContain('sync-docs');
  });
});
