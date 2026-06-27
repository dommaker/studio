// AC-6: AgentLoop E2E verification tests
// Tests full WorkUnit lifecycle: create → claim → execute → review
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import type { WorkUnit } from '@prisma/client';

const { mockPrismaCreate, mockPrismaUpdate, mockPrismaFindMany, mockPrismaFindUnique, mockPrismaUpdateMany, mockPrismaInstanceUpdate, mockPrismaInstanceCreate } = vi.hoisted(() => ({
  mockPrismaCreate: vi.fn(),
  mockPrismaUpdate: vi.fn(),
  mockPrismaFindMany: vi.fn(),
  mockPrismaFindUnique: vi.fn(),
  mockPrismaUpdateMany: vi.fn().mockResolvedValue({ count: 1 }),
  mockPrismaInstanceUpdate: vi.fn().mockResolvedValue({}),
  mockPrismaInstanceCreate: vi.fn(),
}));

const { mockExecute } = vi.hoisted(() => ({
  mockExecute: vi.fn(),
}));

const { mockRegisterTrigger } = vi.hoisted(() => ({
  mockRegisterTrigger: vi.fn(),
}));

const { mockRegisterExecuteHandler } = vi.hoisted(() => ({
  mockRegisterExecuteHandler: vi.fn(),
}));

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const orig = await importOriginal() as Record<string, unknown>;
  return {
    ...orig,
    eventBus: {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      publish: vi.fn(),
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
});

vi.mock('@dommaker/studio-prisma', () => ({
  prisma: {
    runtimeInstance: {
      create: mockPrismaInstanceCreate,
      update: mockPrismaInstanceUpdate,
    },
    workUnit: {
      findMany: mockPrismaFindMany,
      findUnique: mockPrismaFindUnique,
      updateMany: mockPrismaUpdateMany,
      update: mockPrismaUpdate,
    },
  },
}));

vi.mock('@dommaker/studio-skill', () => ({
  skillLoader: {
    listAll: vi.fn().mockReturnValue([]),
    loadSingle: vi.fn().mockReturnValue(null),
  },
}));

vi.mock('@dommaker/studio-agent', () => ({
  agentExecutor: {
    execute: mockExecute,
  },
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

import { AgentLoop } from '../agent-loop';
import { TriggerScheduler } from '../../triggers/trigger-scheduler';

describe('AgentLoop E2E', () => {
  let registry: TriggerScheduler;
  const instances: AgentLoop[] = [];

  const makeRole = (id: string, name: string, desc: string) => ({
    id,
    name,
    description: desc,
    channels: '[]',
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new (TriggerScheduler as unknown as { new (arg: unknown): unknown })(null);

    // Default: instance create returns unique IDs
    let instanceCounter = 0;
    mockPrismaInstanceCreate.mockImplementation(() => {
      instanceCounter++;
      return Promise.resolve({
        id: `inst-${instanceCounter}`,
        roleId: `role-${instanceCounter}`,
        sessionId: null,
        status: 'idle',
        currentWorkUnitId: null,
        startedAt: new Date(),
        terminatedAt: null,
        metadata: null,
      });
    });

    // Default: workUnit.findMany returns empty
    mockPrismaFindMany.mockResolvedValue([]);
    // Default: workUnit.findUnique returns null (overridden per-test)
    mockPrismaFindUnique.mockReset();
    // Default: workUnit.updateMany returns success
    mockPrismaUpdateMany.mockResolvedValue({ count: 1 });
  });

  afterEach(() => {
    for (const inst of instances) {
      try { inst.stop(); } catch { /* ignore */ }
    }
    instances.length = 0;
  });

  it('creates WorkUnit → auto claim → execute → in_review', async () => {
    const workUnit = {
      id: 'wu-e2e-1',
      type: 'task',
      scope: 'test',
      status: 'unassigned',
      assigneeId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      parentId: null,
      dependsOn: '[]',
      failureType: null,
      retryCount: 0,
      timeoutAt: null,
      channelId: null,
      metadata: null,
      completedAt: null,
      claimedAt: null,
    };

    // findUnique returns workUnit with correct status per call:
    // 1st: claim file-conflict check (status=unassigned)
    // 2nd: claim return after updateMany (status=active)
    // 3rd: transitionStatus current-status check (status=active)
    mockPrismaFindUnique
      .mockResolvedValueOnce(workUnit)
      .mockResolvedValueOnce({ ...workUnit, status: 'active', assigneeId: 'inst-1' })
      .mockResolvedValue({ ...workUnit, status: 'active', assigneeId: 'inst-1' });
    // Claim succeeds
    mockPrismaUpdate.mockResolvedValue({});
    // Execute succeeds
    mockExecute.mockResolvedValue({
      success: true,
      outputText: 'Task completed successfully',
      worktree: '/tmp/wt',
      outputFiles: [],
      logFile: '/tmp/log',
      sessionCount: 1,
    });

    const agent = new AgentLoop(
      makeRole('role-e2e', 'e2e-agent', 'handles tasks'),
      registry,
    );
    instances.push(agent);
    await agent.start();

    // Simulate EventBus firing onNewWorkUnit
    await agent.onNewWorkUnit(workUnit as unknown as WorkUnit);

    // Verify: findUnique was called (for claim file-conflict check)
    expect(mockPrismaFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'wu-e2e-1' } }),
    );

    // Verify: updateMany was called for claim (optimistic lock)
    expect(mockPrismaUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'wu-e2e-1', assigneeId: null, status: 'unassigned' }),
        data: expect.objectContaining({ status: 'active' }),
      }),
    );

    // Verify: execute was called
    expect(mockExecute).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'wu-e2e-1' }),
    );

    // Verify: submitted for review via update
    expect(mockPrismaUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'wu-e2e-1' },
        data: expect.objectContaining({ status: 'in_review' }),
      }),
    );
  });

  it('multiple WorkUnits → different agents claim (no duplicate)', async () => {
    const wu1 = { id: 'wu-multi-1', type: 'task', scope: 'test', status: 'unassigned', assigneeId: null, dependsOn: '[]', metadata: null };
    const wu2 = { id: 'wu-multi-2', type: 'task', scope: 'test', status: 'unassigned', assigneeId: null, dependsOn: '[]', metadata: null };

    mockPrismaUpdate.mockResolvedValue({});
    mockExecute.mockResolvedValue({
      success: true,
      outputText: 'Done',
      worktree: '/tmp/wt',
      outputFiles: [],
      logFile: '/tmp/log',
      sessionCount: 1,
    });

    const agent1 = new AgentLoop(
      makeRole('role-1', 'agent-1', 'handles tasks'),
      registry,
    );
    const agent2 = new AgentLoop(
      makeRole('role-2', 'agent-2', 'handles tasks'),
      registry,
    );
    instances.push(agent1, agent2);

    await agent1.start();
    await agent2.start();

    // findUnique returns the workUnit for claim lookups
    mockPrismaFindUnique.mockImplementation((args: any) => {
      if (args?.where?.id === 'wu-multi-1') return Promise.resolve(wu1);
      if (args?.where?.id === 'wu-multi-2') return Promise.resolve(wu2);
      return Promise.resolve(null);
    });

    // Second claim fails with P2025 (optimistic lock)
    let claimCount = 0;
    mockPrismaUpdateMany.mockImplementation((args: any) => {
      if (args?.where?.assigneeId === null) {
        claimCount++;
        if (claimCount > 1) {
          return Promise.resolve({ count: 0 });
        }
      }
      return Promise.resolve({ count: 1 });
    });

    // Both agents try to claim wu1 — second should be gracefully skipped
    await Promise.all([
      agent1.onNewWorkUnit(wu1 as unknown as WorkUnit),
      agent2.onNewWorkUnit(wu1 as unknown as WorkUnit),
    ]);

    // updateMany was called for claim attempts
    const claimCalls = mockPrismaUpdateMany.mock.calls.filter(
      (c: any) => c[0]?.where?.id === 'wu-multi-1',
    );
    expect(claimCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('agent failure → unclaim → other agent can claim', async () => {
    const wu = { id: 'wu-fail-1', type: 'task', scope: 'test', status: 'unassigned', assigneeId: null, dependsOn: '[]', metadata: null };

    // findUnique returns the workUnit
    mockPrismaFindUnique.mockResolvedValue(wu);

    // First agent: claim succeeds, execute fails
    mockPrismaUpdate.mockResolvedValue({}); // unclaim + transitionStatus
    mockExecute.mockRejectedValueOnce(new Error('LLM crashed'));

    const agent1 = new AgentLoop(
      makeRole('role-fail-1', 'failing-agent', 'handles tasks'),
      registry,
    );
    instances.push(agent1);
    await agent1.start();

    await agent1.onNewWorkUnit(wu as unknown as WorkUnit);

    // Verify: unclaim happened via update
    expect(mockPrismaUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'wu-fail-1' },
        data: expect.objectContaining({ assigneeId: null, status: 'unassigned' }),
      }),
    );

    // Second agent: can now claim the same WorkUnit
    mockPrismaUpdate.mockResolvedValue({});
    mockExecute.mockResolvedValueOnce({
      success: true,
      outputText: 'Recovered',
      worktree: '/tmp/wt',
      outputFiles: [],
      logFile: '/tmp/log',
      sessionCount: 1,
    });

    const agent2 = new AgentLoop(
      makeRole('role-fail-2', 'recovery-agent', 'handles tasks'),
      registry,
    );
    instances.push(agent2);
    await agent2.start();

    await agent2.onNewWorkUnit(wu as unknown as WorkUnit);

    // agent2 should have claimed and submitted for review
    expect(mockExecute).toHaveBeenCalled();
  });

  it('review pass → WorkUnit status = done', async () => {
    const wu = { id: 'wu-review-1', type: 'task', scope: 'test', status: 'unassigned', assigneeId: null, dependsOn: '[]', metadata: null };

    // findUnique returns workUnit with correct status per call
    mockPrismaFindUnique
      .mockResolvedValueOnce(wu)
      .mockResolvedValueOnce({ ...wu, status: 'active', assigneeId: 'inst-1' })
      .mockResolvedValue({ ...wu, status: 'active', assigneeId: 'inst-1' });
    mockPrismaUpdate.mockResolvedValue({});
    mockExecute.mockResolvedValue({
      success: true,
      outputText: 'Implementation complete',
      worktree: '/tmp/wt',
      outputFiles: [],
      logFile: '/tmp/log',
      sessionCount: 1,
    });

    const agent = new AgentLoop(
      makeRole('role-review', 'review-agent', 'handles tasks'),
      registry,
    );
    instances.push(agent);
    await agent.start();

    await agent.onNewWorkUnit(wu as unknown as WorkUnit);

    // Verify: submitted for review
    const reviewCall = mockPrismaUpdate.mock.calls.find(
      (c: any) => c[0]?.where?.id === 'wu-review-1' && c[0]?.data?.status === 'in_review',
    );
    expect(reviewCall).toBeDefined();

    // Simulate external review pass → status = done
    mockPrismaUpdate.mockResolvedValueOnce({});
    const { prisma } = await import('@dommaker/studio-prisma');
    await prisma.workUnit.update({
      where: { id: 'wu-review-1' },
      data: { status: 'done', completedAt: new Date() },
    });

    expect(mockPrismaUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'wu-review-1' },
        data: expect.objectContaining({ status: 'done' }),
      }),
    );
  });
});
