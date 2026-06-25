// AC-3: AgentLoop core tests
// Tests AgentLoop lifecycle: start, canClaim, onNewWorkUnit, tryClaim, execute
// Skill injection removed — session-manager handles via formatForPrompt + loadSkill MCP
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.hoisted() ensures these are available when vi.mock factories run
const { mockClaim, mockUnclaim, mockGetById, mockUpdateStatus } = vi.hoisted(() => ({
  mockClaim: vi.fn(),
  mockUnclaim: vi.fn(),
  mockGetById: vi.fn(),
  mockUpdateStatus: vi.fn(),
}));

const { mockWuClaim, mockWuTransitionStatus } = vi.hoisted(() => ({
  mockWuClaim: vi.fn().mockResolvedValue({ id: 'wu-1', status: 'active' }),
  mockWuTransitionStatus: vi.fn().mockResolvedValue({ id: 'wu-1', status: 'in_review' }),
}));

const { mockExecute } = vi.hoisted(() => ({
  mockExecute: vi.fn(),
}));

const { mockRegisterTrigger, mockUnregisterTrigger } = vi.hoisted(() => ({
  mockRegisterTrigger: vi.fn(),
  mockUnregisterTrigger: vi.fn(),
}));

const { mockRegisterExecuteHandler, mockUnregisterExecuteHandler } = vi.hoisted(() => ({
  mockRegisterExecuteHandler: vi.fn(),
  mockUnregisterExecuteHandler: vi.fn(),
}));

const { mockPrismaCreate, mockPrismaUpdate, mockPrismaFindMany, mockPrismaInstanceUpdate } = vi.hoisted(() => ({
  mockPrismaCreate: vi.fn().mockResolvedValue({
    id: 'inst-1',
    roleId: 'role-1',
    sessionId: null,
    status: 'idle',
    currentWorkUnitId: null,
    startedAt: new Date(),
    terminatedAt: null,
    metadata: null,
  }),
  mockPrismaUpdate: vi.fn().mockResolvedValue({}),
  mockPrismaFindMany: vi.fn().mockResolvedValue([]),
  mockPrismaInstanceUpdate: vi.fn().mockResolvedValue({
    id: 'inst-1',
    status: 'terminated',
    terminatedAt: new Date(),
  }),
}));

// Mock dependencies
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
      create: mockPrismaCreate,
      update: mockPrismaInstanceUpdate,
    },
    workUnit: {
      findMany: mockPrismaFindMany,
      update: mockPrismaUpdate,
    },
  },
}));

vi.mock('@dommaker/studio-agent', () => ({
  agentExecutor: {
    execute: mockExecute,
  },
}));

vi.mock('../../workunit/workunit.service', () => ({
  WorkUnitService: vi.fn().mockImplementation(() => ({
    claim: mockWuClaim,
    transitionStatus: mockWuTransitionStatus,
  })),
}));

vi.mock('../../triggers/trigger-scheduler', () => ({
  TriggerScheduler: vi.fn().mockImplementation(() => ({
    registerTrigger: mockRegisterTrigger,
    unregisterTrigger: mockUnregisterTrigger,
    getStates: vi.fn().mockReturnValue([]),
  })),
}));

vi.mock('../../triggers/trigger-action', () => ({
  registerExecuteHandler: mockRegisterExecuteHandler,
  unregisterExecuteHandler: mockUnregisterExecuteHandler,
  executeExecuteAction: vi.fn(),
  executeCreateAction: vi.fn(),
  executeUpdateAction: vi.fn(),
}));

import { AgentLoop } from '../agent-loop';
import type { TriggerScheduler } from '../../triggers/trigger-scheduler';

describe('AgentLoop', () => {
  let agentLoop: AgentLoop;
  let mockRegistry: TriggerScheduler;

  const mockRole = {
    id: 'role-1',
    name: 'test-agent',
    description: 'A test agent for unit testing',
    channels: '[]',
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset hoisted mocks to defaults
    mockPrismaUpdate.mockResolvedValue({});
    mockPrismaFindMany.mockResolvedValue([]);
    mockWuClaim.mockResolvedValue({ id: 'wu-1', status: 'active' });
    mockWuTransitionStatus.mockResolvedValue({ id: 'wu-1', status: 'in_review' });
    mockPrismaCreate.mockResolvedValue({
      id: 'inst-1',
      roleId: 'role-1',
      sessionId: null,
      status: 'idle',
      currentWorkUnitId: null,
      startedAt: new Date(),
      terminatedAt: null,
      metadata: null,
    });
    mockRegistry = { registerTrigger: mockRegisterTrigger } as unknown as TriggerScheduler;
  });

  afterEach(() => {
    if (agentLoop) {
      try { agentLoop.stop(); } catch { /* ignore */ }
    }
  });

  describe('start()', () => {
    it('creates RuntimeInstance with idle status', async () => {
      agentLoop = new AgentLoop(mockRole, mockRegistry);
      await agentLoop.start();

      expect(mockPrismaCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          roleId: 'role-1',
          status: 'idle',
        }),
      });
    });

    it('registers EVENT trigger for workunit.created', async () => {
      agentLoop = new AgentLoop(mockRole, mockRegistry);
      await agentLoop.start();

      expect(mockRegisterTrigger).toHaveBeenCalledWith(
        expect.objectContaining({
          condition: expect.objectContaining({
            type: 'EVENT',
            event: 'workunit.created',
          }),
          action: expect.objectContaining({
            type: 'EXECUTE',
            target: 'agent-loop',
          }),
        }),
      );
    });

    it('registers agent-scan-workunits handler for poll-fallback trigger', async () => {
      agentLoop = new AgentLoop(mockRole, mockRegistry);
      await agentLoop.start();

      // Bug 1 fix: poll-fallback trigger targets 'agent-scan-workunits' but no handler was registered
      expect(mockRegisterExecuteHandler).toHaveBeenCalledWith(
        'agent-scan-workunits',
        expect.any(Function),
      );
    });

    it('calls scanForWork on startup', async () => {
      const scanSpy = vi.spyOn(AgentLoop.prototype, 'scanForWork');
      agentLoop = new AgentLoop(mockRole, mockRegistry);
      await agentLoop.start();

      expect(scanSpy).toHaveBeenCalled();
      scanSpy.mockRestore();
    });

    it('starts periodic scan interval with SCAN_INTERVAL_MS', async () => {
      const setIntervalSpy = vi.spyOn(global, 'setInterval');
      agentLoop = new AgentLoop(mockRole, mockRegistry);
      await agentLoop.start();

      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 30_000);
      setIntervalSpy.mockRestore();
    });
  });

  describe('stop()', () => {
    it('clears periodic scan interval', async () => {
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');
      agentLoop = new AgentLoop(mockRole, mockRegistry);
      await agentLoop.start();

      expect((agentLoop as any).scanInterval).not.toBeNull();
      agentLoop.stop();

      expect(clearIntervalSpy).toHaveBeenCalled();
      clearIntervalSpy.mockRestore();
    });
  });

  describe('canClaim()', () => {
    it('returns true when idle + type matches + status=unassigned', async () => {
      agentLoop = new AgentLoop(
        { ...mockRole, description: 'handles tasks and bugs' },
        mockRegistry,
      );
      // Start to create instance
      await agentLoop.start();

      const workUnit = {
        id: 'wu-1',
        type: 'task',
        scope: 'test',
        status: 'unassigned',
        assigneeId: null,
      };
      expect((agentLoop as any).canClaim(workUnit)).toBe(true);
    });

    it('returns false when processing=true', async () => {
      agentLoop = new AgentLoop(mockRole, mockRegistry);
      await agentLoop.start();
      (agentLoop as any).processing = true;

      const workUnit = { id: 'wu-1', type: 'task', scope: 'test', status: 'unassigned' };
      expect((agentLoop as any).canClaim(workUnit)).toBe(false);
    });

    it('returns false when type not in acceptedTypes', async () => {
      agentLoop = new AgentLoop(
        { ...mockRole, description: 'handles bugs only' },
        mockRegistry,
      );
      await agentLoop.start();

      const workUnit = { id: 'wu-1', type: 'task', scope: 'test', status: 'unassigned' };
      expect((agentLoop as any).canClaim(workUnit)).toBe(false);
    });

    it('returns false when status !== unassigned', async () => {
      agentLoop = new AgentLoop(mockRole, mockRegistry);
      await agentLoop.start();

      const workUnit = { id: 'wu-1', type: 'task', scope: 'test', status: 'active' };
      expect((agentLoop as any).canClaim(workUnit)).toBe(false);
    });
  });

  describe('onNewWorkUnit()', () => {
    it('calls tryClaim when canClaim returns true', async () => {
      mockPrismaUpdate.mockResolvedValue({}); // claim succeeds
      mockExecute.mockResolvedValue({
        success: true,
        outputText: 'Done',
        worktree: '/tmp/wt',
        outputFiles: [],
        logFile: '/tmp/log',
        sessionCount: 1,
      });

      agentLoop = new AgentLoop(
        { ...mockRole, description: 'handles tasks' },
        mockRegistry,
      );
      await agentLoop.start();

      const tryClaimSpy = vi.spyOn(agentLoop as any, 'tryClaim');
      const workUnit = { id: 'wu-1', type: 'task', scope: 'test', status: 'unassigned', assigneeId: null };

      await agentLoop.onNewWorkUnit(workUnit as any);
      expect(tryClaimSpy).toHaveBeenCalledWith(workUnit);
    });

    it('skips when canClaim returns false', async () => {
      agentLoop = new AgentLoop(mockRole, mockRegistry);
      await agentLoop.start();
      (agentLoop as any).processing = true;

      const tryClaimSpy = vi.spyOn(agentLoop as any, 'tryClaim');
      const workUnit = { id: 'wu-1', type: 'task', scope: 'test', status: 'unassigned' };

      await agentLoop.onNewWorkUnit(workUnit as any);
      expect(tryClaimSpy).not.toHaveBeenCalled();
    });

    it('skips when already processing', async () => {
      agentLoop = new AgentLoop(mockRole, mockRegistry);
      await agentLoop.start();
      (agentLoop as any).processing = true;

      const tryClaimSpy = vi.spyOn(agentLoop as any, 'tryClaim');
      const workUnit = { id: 'wu-1', type: 'task', scope: 'test', status: 'unassigned' };

      await agentLoop.onNewWorkUnit(workUnit as any);
      expect(tryClaimSpy).not.toHaveBeenCalled();
    });
  });

  describe('tryClaim()', () => {
    it('claims via prisma → executes → transitions to in_review', async () => {
      mockExecute.mockResolvedValue({
        success: true,
        outputText: 'Task completed',
        worktree: '/tmp/wt',
        outputFiles: [],
        logFile: '/tmp/log',
        sessionCount: 1,
      });

      agentLoop = new AgentLoop(
        { ...mockRole, description: 'handles tasks' },
        mockRegistry,
      );
      await agentLoop.start();

      const workUnit = { id: 'wu-1', type: 'task', scope: 'test', status: 'unassigned', assigneeId: null };
      await (agentLoop as any).tryClaim(workUnit);

      // Claim via prisma.workUnit.update (optimistic lock)
      expect(mockPrismaUpdate).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ id: 'wu-1', assigneeId: null, status: 'unassigned' }),
        data: expect.objectContaining({ assigneeId: 'inst-1', status: 'active' }),
      }));
      // Submit for review via prisma.workUnit.update
      expect(mockPrismaUpdate).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'wu-1' },
        data: { status: 'in_review' },
      }));
    });

    it('handles claim conflict gracefully (skip)', async () => {
      const err = new Error('Record to update not found') as any;
      err.code = 'P2025';
      mockPrismaUpdate.mockRejectedValue(err);

      agentLoop = new AgentLoop(mockRole, mockRegistry);
      await agentLoop.start();

      const workUnit = { id: 'wu-1', type: 'task', scope: 'test', status: 'unassigned', assigneeId: null };
      // Should not throw
      await expect((agentLoop as any).tryClaim(workUnit)).resolves.toBeUndefined();
    });

    it('on execution exception: unclaims via direct prisma', async () => {
      mockExecute.mockImplementation(() => Promise.reject(new Error('execution failed')));

      agentLoop = new AgentLoop(mockRole, mockRegistry);
      await agentLoop.start();

      const workUnit = { id: 'wu-1', type: 'task', scope: 'test', status: 'unassigned', assigneeId: null };
      await (agentLoop as any).tryClaim(workUnit);

      // Unclaim via direct prisma (state machine doesn't support active→unassigned)
      expect(mockPrismaUpdate).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ assigneeId: null, status: 'unassigned' }),
      }));
    });

    it('on execute returns success=false: unclaims instead of in_review', async () => {
      mockExecute.mockResolvedValue({
        success: false,
        error: 'tests failed',
        worktree: '/tmp/wt',
        outputFiles: [],
        logFile: '/tmp/log',
        sessionCount: 1,
      });

      agentLoop = new AgentLoop(
        { ...mockRole, description: 'handles tasks' },
        mockRegistry,
      );
      await agentLoop.start();

      const workUnit = { id: 'wu-1', type: 'task', scope: 'test', status: 'unassigned', assigneeId: null };
      await (agentLoop as any).tryClaim(workUnit);

      // Issue 4: success=false → unclaim, NOT in_review
      expect(mockPrismaUpdate).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ assigneeId: null, status: 'unassigned' }),
      }));
    });

  });

  describe('execute()', () => {
    it('passes WorkUnit info to agentExecutor without skill injection', async () => {
      mockExecute.mockResolvedValue({
        success: true,
        outputText: 'Result',
        worktree: '/tmp/wt',
        outputFiles: [],
        logFile: '/tmp/log',
        sessionCount: 1,
      });

      agentLoop = new AgentLoop(mockRole, mockRegistry);
      await agentLoop.start();

      const workUnit = { id: 'wu-1', type: 'task', scope: 'fix docs-freshness API' };
      await (agentLoop as any).execute(workUnit);

      expect(mockExecute).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'wu-1',
          executionId: expect.stringContaining('wu-1'),
          prompt: expect.stringContaining('fix docs-freshness API'),
        }),
      );
      // Skill content should NOT be in the prompt
      expect(mockExecute).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.not.stringContaining('## Available Skills'),
        }),
      );
    });

    it('posts result to discussion space', async () => {
      const { eventBus } = await import('@dommaker/studio-shared');
      mockExecute.mockResolvedValue({
        success: true,
        outputText: 'Task completed successfully',
        worktree: '/tmp/wt',
        outputFiles: [],
        logFile: '/tmp/log',
        sessionCount: 1,
      });

      agentLoop = new AgentLoop(mockRole, mockRegistry);
      await agentLoop.start();

      const workUnit = { id: 'wu-1', type: 'task', scope: 'test' };
      await (agentLoop as any).execute(workUnit);

      expect(eventBus.publish).toHaveBeenCalledWith(
        'channel.message.created',
        expect.objectContaining({
          workUnitId: 'wu-1',
          content: expect.stringContaining('Task completed'),
        }),
      );
    });

    it('throws on agentExecutor failure', async () => {
      mockExecute.mockRejectedValue(new Error('LLM timeout'));

      agentLoop = new AgentLoop(mockRole, mockRegistry);
      await agentLoop.start();

      const workUnit = { id: 'wu-1', type: 'task', scope: 'test' };
      await expect((agentLoop as any).execute(workUnit)).rejects.toThrow('LLM timeout');
    });
  });
});
