// AC-3: AgentLoop knowledge search analysis tests
// Agent Loop rewrite (ac-agent-loop-rewrite): removed canClaim/onNewWorkUnit/tryClaim/execute/scanForWork
// New loop behavior tested in agent-loop-v2.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.hoisted() ensures these are available when vi.mock factories run
const { mockWuClaim, mockWuUnclaim, mockWuTransitionStatus } = vi.hoisted(() => ({
  mockWuClaim: vi.fn().mockResolvedValue({ id: 'wu-1', status: 'active' }),
  mockWuUnclaim: vi.fn().mockResolvedValue({ id: 'wu-1', status: 'unassigned' }),
  mockWuTransitionStatus: vi.fn().mockResolvedValue({ id: 'wu-1', status: 'in_review' }),
}));

const { mockExecuteLightweight } = vi.hoisted(() => ({
  mockExecuteLightweight: vi.fn(),
}));

const { mockPrismaCreate, mockPrismaUpdate, mockPrismaFindMany, mockPrismaFindUnique, mockPrismaInstanceUpdate } = vi.hoisted(() => ({
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
  mockPrismaFindUnique: vi.fn().mockResolvedValue(null),
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
      findUnique: mockPrismaFindUnique,
      update: mockPrismaUpdate,
    },
    channelMessage: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({}),
    },
  },
}));

vi.mock('@dommaker/studio-agent', () => ({
  agentRunner: {
    executeLightweight: mockExecuteLightweight,
  },
}));

vi.mock('../../workunit/workunit.service', () => ({
  WorkUnitService: vi.fn().mockImplementation(() => ({
    claim: mockWuClaim,
    unclaim: mockWuUnclaim,
    transitionStatus: mockWuTransitionStatus,
  })),
}));

vi.mock('../../triggers/trigger-scheduler', () => ({
  TriggerScheduler: vi.fn().mockImplementation(() => ({
    getStates: vi.fn().mockReturnValue([]),
    registerTrigger: vi.fn(),
    unregisterTrigger: vi.fn(),
    registerExecuteHandler: vi.fn(),
    dispose: vi.fn(),
  })),
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

import { AgentLoop, analyzeKnowledgeSearch, extractKnowledgeEntryIds } from '../agent-loop';

describe('AgentLoop', () => {
  let agentLoop: AgentLoop;

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
  });

  afterEach(() => {
    if (agentLoop) {
      try { agentLoop.stop(); } catch { /* ignore */ }
    }
  });

  describe('start()', () => {
    it('creates RuntimeInstance with idle status', async () => {
      agentLoop = new AgentLoop(mockRole);
      await agentLoop.start();

      expect(mockPrismaCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          roleId: 'role-1',
          status: 'idle',
        }),
      });
    });
  });

  describe('AC-3: EVENT trigger registration', () => {
    it('start() registers workunit.created EVENT trigger', async () => {
      agentLoop = new AgentLoop(mockRole);
      await agentLoop.start();

      expect(mockTriggerScheduler.registerTrigger).toHaveBeenCalledWith(
        expect.objectContaining({
          condition: { type: 'EVENT', event: 'workunit.created' },
          action: expect.objectContaining({ type: 'EXECUTE' }),
          enabled: true,
        })
      );
    });

    it('start() registers EXECUTE handler', async () => {
      agentLoop = new AgentLoop(mockRole);
      await agentLoop.start();

      expect(mockTriggerScheduler.registerExecuteHandler).toHaveBeenCalledWith(
        expect.stringContaining('agent-loop-role-1'),
        expect.any(Function)
      );
    });

    it('stop() unregisters EVENT trigger', async () => {
      agentLoop = new AgentLoop(mockRole);
      await agentLoop.start();
      agentLoop.stop();

      expect(mockTriggerScheduler.unregisterTrigger).toHaveBeenCalledWith(
        expect.stringContaining('agent-loop-role-1')
      );
    });
  });

  describe('analyzeKnowledgeSearch()', () => {
    it('returns empty when log content is empty', () => {
      const result = analyzeKnowledgeSearch('');
      expect(result.searched).toBe(false);
      expect(result.searchCalls).toEqual([]);
    });

    it('returns empty when no knowledge-related tool calls exist', () => {
      const log = JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/tmp/src/index.ts' } }],
        },
      });
      const result = analyzeKnowledgeSearch(log);
      expect(result.searched).toBe(false);
      expect(result.searchCalls).toEqual([]);
    });

    it('detects Read tool call targeting knowledge base', () => {
      const log = JSON.stringify({
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use', name: 'Read',
            input: { file_path: '/root/.studio/knowledge/pattern-auth.md' },
          }],
        },
      });
      const result = analyzeKnowledgeSearch(log);
      expect(result.searched).toBe(true);
      expect(result.searchCalls).toHaveLength(1);
      expect(result.searchCalls[0].tool).toBe('Read');
    });

    it('detects Bash grep targeting knowledge base', () => {
      const log = JSON.stringify({
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use', name: 'Bash',
            input: { command: 'grep -r "auth" ~/.studio/knowledge/' },
          }],
        },
      });
      const result = analyzeKnowledgeSearch(log);
      expect(result.searched).toBe(true);
      expect(result.searchCalls).toHaveLength(1);
      expect(result.searchCalls[0].tool).toBe('Bash');
    });

    it('detects Glob targeting knowledge base', () => {
      const log = JSON.stringify({
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use', name: 'Glob',
            input: { pattern: '.studio/knowledge/**/*.md' },
          }],
        },
      });
      const result = analyzeKnowledgeSearch(log);
      expect(result.searched).toBe(true);
      expect(result.searchCalls).toHaveLength(1);
      expect(result.searchCalls[0].tool).toBe('Glob');
    });

    it('counts multiple knowledge searches', () => {
      const log = [
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [{
              type: 'tool_use', name: 'Bash',
              input: { command: 'grep -r "auth" ~/.studio/knowledge/' },
            }],
          },
        }),
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [{
              type: 'tool_use', name: 'Read',
              input: { file_path: '/root/.studio/knowledge/pattern-auth.md' },
            }],
          },
        }),
      ].join('\n');
      const result = analyzeKnowledgeSearch(log);
      expect(result.searched).toBe(true);
      expect(result.searchCalls).toHaveLength(2);
    });

    it('ignores non-knowledge tool calls', () => {
      const log = [
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/tmp/src/index.ts' } }],
          },
        }),
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }],
          },
        }),
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/tmp/src/new.ts', content: 'x' } }],
          },
        }),
      ].join('\n');
      const result = analyzeKnowledgeSearch(log);
      expect(result.searched).toBe(false);
      expect(result.searchCalls).toEqual([]);
    });

    it('skips malformed JSON lines', () => {
      const log = `not valid json\n${JSON.stringify({
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use', name: 'Read',
            input: { file_path: '/root/.studio/knowledge/test.md' },
          }],
        },
      })}`;
      const result = analyzeKnowledgeSearch(log);
      expect(result.searched).toBe(true);
      expect(result.searchCalls).toHaveLength(1);
    });
  });

  describe('extractKnowledgeEntryIds()', () => {
    it('extracts entry ID from Read tool call', () => {
      const analysis = {
        searched: true,
        searchCalls: [{ tool: 'Read', detail: '/root/.studio/knowledge/decision-DEC-001.md' }],
      };
      const result = extractKnowledgeEntryIds(analysis);
      expect(result).toEqual(['decision-DEC-001']);
    });

    it('extracts entry ID from Bash grep command', () => {
      const analysis = {
        searched: true,
        searchCalls: [{ tool: 'Bash', detail: 'grep -r "auth" /root/.studio/knowledge/pattern-auth.md' }],
      };
      const result = extractKnowledgeEntryIds(analysis);
      expect(result).toEqual(['pattern-auth']);
    });

    it('excludes _index.md', () => {
      const analysis = {
        searched: true,
        searchCalls: [{ tool: 'Read', detail: '/root/.studio/knowledge/_index.md' }],
      };
      const result = extractKnowledgeEntryIds(analysis);
      expect(result).toEqual([]);
    });

    it('deduplicates entries accessed multiple times', () => {
      const analysis = {
        searched: true,
        searchCalls: [
          { tool: 'Read', detail: '/root/.studio/knowledge/decision-DEC-001.md' },
          { tool: 'Read', detail: '/root/.studio/knowledge/decision-DEC-001.md' },
          { tool: 'Bash', detail: 'grep "DEC-001" ~/.studio/knowledge/decision-DEC-001.md' },
        ],
      };
      const result = extractKnowledgeEntryIds(analysis);
      expect(result).toEqual(['decision-DEC-001']);
    });

    it('returns empty for searchCalls without detail', () => {
      const analysis = {
        searched: true,
        searchCalls: [{ tool: 'Glob', detail: undefined }],
      };
      const result = extractKnowledgeEntryIds(analysis);
      expect(result).toEqual([]);
    });

    it('handles subdirectory paths like arch-patterns/concept.md', () => {
      const analysis = {
        searched: true,
        searchCalls: [{ tool: 'Read', detail: '/root/.studio/knowledge/arch-patterns/concept.md' }],
      };
      const result = extractKnowledgeEntryIds(analysis);
      // Should extract filename only, not path with subdirectory
      expect(result).toEqual(['arch-patterns/concept']);
    });
  });
});
