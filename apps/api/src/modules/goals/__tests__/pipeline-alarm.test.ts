/**
 * Behavioral tests for pipeline-alarm onPhaseFailure
 *
 * AC:
 * - onPhaseFailure calls notifyService.send() with correct type/priority
 * - onPhaseFailure calls knowledgeBus.recordPattern() with correct severity
 * - onPhaseFailure updates GoalExecution DB when executionId provided
 * - onPhaseFailure tolerates missing executionId (no DB update)
 * - All side effects are non-blocking (catch errors internally)
 * - timeout severity → notify type 'timeout', priority 'medium'
 * - exhausted severity → notify type 'human-needed', priority 'high'
 * - error severity → notify type 'task-failed', priority 'medium'
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const {
  mockNotifySend,
  mockRecordPattern,
  mockGoalExecUpdate,
} = vi.hoisted(() => ({
  mockNotifySend: vi.fn().mockResolvedValue(undefined),
  mockRecordPattern: vi.fn().mockResolvedValue(undefined),
  mockGoalExecUpdate: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../outbound-notify/notify.service.js', () => ({
  notifyService: { send: mockNotifySend },
}));

vi.mock('../../knowledge/knowledge-bus.service.js', () => ({
  knowledgeBus: { recordPattern: mockRecordPattern },
}));

vi.mock('@dommaker/studio-prisma', () => ({
  prisma: {
    goalExecution: { update: mockGoalExecUpdate },
  },
}));

vi.mock('@dommaker/studio-shared', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { onPhaseFailure, type AlarmContext } from '../pipeline-alarm.js';

beforeEach(() => {
  vi.clearAllMocks();
});

function makeCtx(overrides?: Partial<AlarmContext>): AlarmContext {
  return {
    goalId: 'goal-12345678',
    phase: 'executing',
    error: 'Something went wrong in the pipeline',
    severity: 'error',
    ...overrides,
  };
}

describe('onPhaseFailure — notification routing', () => {
  test('timeout severity → notifyService type="timeout", priority="medium"', async () => {
    await onPhaseFailure(makeCtx({ severity: 'timeout' }));

    expect(mockNotifySend).toHaveBeenCalledOnce();
    const msg = mockNotifySend.mock.calls[0][0];
    expect(msg.type).toBe('timeout');
    expect(msg.priority).toBe('medium');
  });

  test('exhausted severity → notifyService type="human-needed", priority="high"', async () => {
    await onPhaseFailure(makeCtx({ severity: 'exhausted' }));

    expect(mockNotifySend).toHaveBeenCalledOnce();
    const msg = mockNotifySend.mock.calls[0][0];
    expect(msg.type).toBe('human-needed');
    expect(msg.priority).toBe('high');
  });

  test('error severity → notifyService type="task-failed", priority="medium"', async () => {
    await onPhaseFailure(makeCtx({ severity: 'error' }));

    expect(mockNotifySend).toHaveBeenCalledOnce();
    const msg = mockNotifySend.mock.calls[0][0];
    expect(msg.type).toBe('task-failed');
    expect(msg.priority).toBe('medium');
  });
});

describe('onPhaseFailure — knowledge recording', () => {
  test('timeout → knowledgeBus severity="warning"', async () => {
    await onPhaseFailure(makeCtx({ severity: 'timeout' }));

    expect(mockRecordPattern).toHaveBeenCalledOnce();
    const entry = mockRecordPattern.mock.calls[0][0];
    expect(entry.severity).toBe('warning');
    expect(entry.type).toBe('failure');
  });

  test('exhausted → knowledgeBus severity="critical"', async () => {
    await onPhaseFailure(makeCtx({ severity: 'exhausted' }));

    expect(mockRecordPattern).toHaveBeenCalledOnce();
    const entry = mockRecordPattern.mock.calls[0][0];
    expect(entry.severity).toBe('critical');
  });

  test('knowledge entry includes phase and goalId in context', async () => {
    await onPhaseFailure(makeCtx({ phase: 'review', severity: 'exhausted' }));

    const entry = mockRecordPattern.mock.calls[0][0];
    expect(entry.context.phase).toBe('review');
    expect(entry.context.goalId).toBe('goal-12345678');
  });
});

describe('onPhaseFailure — DB update', () => {
  test('with executionId → updates GoalExecution status to failed', async () => {
    await onPhaseFailure(makeCtx({ executionId: 'exec-123' }));

    expect(mockGoalExecUpdate).toHaveBeenCalledOnce();
    const update = mockGoalExecUpdate.mock.calls[0][0];
    expect(update.where.id).toBe('exec-123');
    expect(update.data.status).toBe('failed');
  });

  test('without executionId → no DB update', async () => {
    await onPhaseFailure(makeCtx());

    expect(mockGoalExecUpdate).not.toHaveBeenCalled();
  });
});

describe('onPhaseFailure — non-blocking', () => {
  test('notifyService failure does not throw', async () => {
    mockNotifySend.mockRejectedValue(new Error('Discord down'));

    await expect(onPhaseFailure(makeCtx())).resolves.toBeUndefined();
  });

  test('knowledgeBus failure does not throw', async () => {
    mockRecordPattern.mockRejectedValue(new Error('KB down'));

    await expect(onPhaseFailure(makeCtx())).resolves.toBeUndefined();
  });

  test('DB update failure does not throw', async () => {
    mockGoalExecUpdate.mockRejectedValue(new Error('DB down'));

    await expect(onPhaseFailure(makeCtx({ executionId: 'exec-123' }))).resolves.toBeUndefined();
  });

  test('all services fail simultaneously → still resolves', async () => {
    mockNotifySend.mockRejectedValue(new Error('notify down'));
    mockRecordPattern.mockRejectedValue(new Error('kb down'));
    mockGoalExecUpdate.mockRejectedValue(new Error('db down'));

    await expect(onPhaseFailure(makeCtx({ executionId: 'exec-123' }))).resolves.toBeUndefined();
  });
});
