// AC-3: AgentLoop knowledge search analysis tests
// Agent Loop rewrite (ac-agent-loop-rewrite): removed canClaim/onNewWorkUnit/tryClaim/execute/scanForWork
// New loop behavior tested in agent-loop-v2.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FileStore } from '@dommaker/studio-shared';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const { mockExecSync, mockProcessKill } = vi.hoisted(() => ({
  mockExecSync: vi.fn().mockReturnValue('Claude Code CLI version 1.0.0'),
  mockProcessKill: vi.fn(),
}));

vi.mock('child_process', () => ({
  execSync: mockExecSync,
}));

// vi.hoisted() ensures these are available when vi.mock factories run
const { mockWuClaim, mockWuUnclaim, mockWuTransitionStatus } = vi.hoisted(() => ({
  mockWuClaim: vi.fn().mockResolvedValue({ id: 'wu-1', status: 'active' }),
  mockWuUnclaim: vi.fn().mockResolvedValue({ id: 'wu-1', status: 'unassigned' }),
  mockWuTransitionStatus: vi.fn().mockResolvedValue({ id: 'wu-1', status: 'in_review' }),
}));

const { mockExecuteLightweight } = vi.hoisted(() => ({
  mockExecuteLightweight: vi.fn(),
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

vi.mock('@dommaker/studio-agent', () => ({
  agentRunner: {
    executeLightweight: mockExecuteLightweight,
  },
}));

vi.mock('../../workunit/workunit.service', () => ({
  WorkUnitService: vi.fn().mockImplementation(function () { return {
    claim: mockWuClaim,
    unclaim: mockWuUnclaim,
    transitionStatus: mockWuTransitionStatus,
  }; }),
}));

vi.mock('../../triggers/trigger-scheduler', () => ({
  TriggerScheduler: vi.fn().mockImplementation(function () { return {
    getStates: vi.fn().mockReturnValue([]),
    registerTrigger: vi.fn(),
    unregisterTrigger: vi.fn(),
    registerExecuteHandler: vi.fn(),
    dispose: vi.fn(),
  }; }),
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

const { mockInjectContext, mockRecordOutcome, mockExtractFromExecution } = vi.hoisted(() => ({
  mockInjectContext: vi.fn().mockResolvedValue({ prompt: '## 系统约束\n- test rule', injectedIds: ['rule-1'] }),
  mockRecordOutcome: vi.fn().mockResolvedValue(undefined),
  mockExtractFromExecution: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../knowledge/knowledge-service', () => ({
  knowledgeService: {
    injectContext: mockInjectContext,
    recordOutcome: mockRecordOutcome,
    extractFromExecution: mockExtractFromExecution,
  },
}));

import { AgentLoop, analyzeKnowledgeSearch, extractKnowledgeEntryIds, extractInputTokens, isProcessAlive, writeToolCallEvents, resolveToolTraceFile } from '../agent-loop';

describe('AgentLoop', () => {
  let agentLoop: AgentLoop;
  let testDir: string;
  let fileStore: FileStore;

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
    // mockImplementation from prior test persists through clearAllMocks; reset explicitly
    mockExecSync.mockReturnValue('Claude Code CLI version 1.0.0');
    testDir = path.join(os.tmpdir(), `agent-loop-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    fileStore = new FileStore(testDir);
  });

  afterEach(async () => {
    if (agentLoop) {
      agentLoop.stop();
      // runLoop 内部有 sleep(15_000)，waitForStop 可能需要等 sleep 完成
      // 给 2 秒超时，超时后直接继续（runLoop 会在后台退出，loopPromise 有 .catch 不会泄漏）
      await Promise.race([
        agentLoop.waitForStop(),
        new Promise(resolve => setTimeout(resolve, 2000)),
      ]);
    }
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }, 5000);

  describe('start()', () => {
    it('creates RuntimeInstance with idle status', async () => {
      agentLoop = new AgentLoop(mockRole, fileStore);
      await agentLoop.start();

      // Verify agent state was created via FileStore
      const agentStates = await fileStore.listStates();
      const match = agentStates.find(s => s.roleId === 'role-1');
      expect(match).toBeDefined();
      expect(match!.status).toBe('idle');
    });

    describe('AC-4.6: PID tracking', () => {
      it('writes process.pid to RuntimeState on start', async () => {
        agentLoop = new AgentLoop(mockRole, fileStore);
        await agentLoop.start();

        const agentStates = await fileStore.listStates();
        const match = agentStates.find(s => s.roleId === 'role-1');
        expect(match).toBeDefined();
        expect(match!.pid).toBe(process.pid);
      });
    });
  });

  describe('AC-3: EVENT trigger registration', () => {
    it('start() registers workunit.created EVENT trigger', async () => {
      agentLoop = new AgentLoop(mockRole, fileStore);
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
      agentLoop = new AgentLoop(mockRole, fileStore);
      await agentLoop.start();

      expect(mockTriggerScheduler.registerExecuteHandler).toHaveBeenCalledWith(
        expect.stringContaining('agent-loop-role-1'),
        expect.any(Function)
      );
    });

    it('stop() unregisters EVENT trigger', async () => {
      agentLoop = new AgentLoop(mockRole, fileStore);
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

  describe('GAP-5: Knowledge injection in agentStep', () => {
    it('calls injectContext with workUnit type', async () => {
      mockExecuteLightweight.mockResolvedValue({
        success: true, outputText: 'ACTION: PROGRESS:working',
        logFile: '/tmp/log', worktree: '/tmp/wt', outputFiles: [], sessionCount: 1,
      });

      agentLoop = new AgentLoop(mockRole, fileStore);
      await agentLoop.start();

      const target = {
        workUnit: {
          id: 'wu-1', type: 'task', scope: 'test', channelId: 'ch-1',
          status: 'active', assigneeId: 'agent-1', parentId: null,
          failureType: null, retryCount: 0, timeoutAt: null,
          projectPath: null, metadata: null, claimedAt: null,
          completedAt: null, createdAt: new Date(), updatedAt: new Date(),
        },
      };

      await (agentLoop as unknown as { agentStep(t: unknown): Promise<unknown> }).agentStep(target);

      expect(mockInjectContext).toHaveBeenCalledWith('task', expect.any(Object));
    });

    it('passes knowledgeContext in AgentTask parameters', async () => {
      mockExecuteLightweight.mockResolvedValue({
        success: true, outputText: 'ACTION: PROGRESS:working',
        logFile: '/tmp/log', worktree: '/tmp/wt', outputFiles: [], sessionCount: 1,
      });

      agentLoop = new AgentLoop(mockRole, fileStore);
      await agentLoop.start();

      const target = {
        workUnit: {
          id: 'wu-1', type: 'task', scope: 'test', channelId: 'ch-1',
          status: 'active', assigneeId: 'agent-1', parentId: null,
          failureType: null, retryCount: 0, timeoutAt: null,
          projectPath: null, metadata: null, claimedAt: null,
          completedAt: null, createdAt: new Date(), updatedAt: new Date(),
        },
      };

      await (agentLoop as unknown as { agentStep(t: unknown): Promise<unknown> }).agentStep(target);

      expect(mockExecuteLightweight).toHaveBeenCalledWith(
        expect.objectContaining({
          parameters: expect.objectContaining({
            knowledgeContext: expect.stringContaining('test rule'),
          }),
        })
      );
    });

    it('does not block when injectContext fails', async () => {
      mockInjectContext.mockRejectedValueOnce(new Error('DB timeout'));
      mockExecuteLightweight.mockResolvedValue({
        success: true, outputText: 'ACTION: PROGRESS:working',
        logFile: '/tmp/log', worktree: '/tmp/wt', outputFiles: [], sessionCount: 1,
      });

      agentLoop = new AgentLoop(mockRole, fileStore);
      await agentLoop.start();

      const target = {
        workUnit: {
          id: 'wu-1', type: 'task', scope: 'test', channelId: 'ch-1',
          status: 'active', assigneeId: 'agent-1', parentId: null,
          failureType: null, retryCount: 0, timeoutAt: null,
          projectPath: null, metadata: null, claimedAt: null,
          completedAt: null, createdAt: new Date(), updatedAt: new Date(),
        },
      };

      await expect(
        (agentLoop as unknown as { agentStep(t: unknown): Promise<unknown> }).agentStep(target)
      ).resolves.toBeDefined();
    });
  });

  describe('GAP-6: recordOutcome + extractFromExecution', () => {
    it('calls recordOutcome and does not block', async () => {
      mockExecuteLightweight.mockResolvedValue({
        success: true, outputText: 'ACTION: COMPLETE:done',
        logFile: '/tmp/log', worktree: '/tmp/wt', outputFiles: [], sessionCount: 1,
      });

      agentLoop = new AgentLoop(mockRole, fileStore);
      await agentLoop.start();

      const target = {
        workUnit: {
          id: 'wu-1', type: 'task', scope: 'test', channelId: 'ch-1',
          status: 'active', assigneeId: 'agent-1', parentId: null,
          failureType: null, retryCount: 0, timeoutAt: null,
          projectPath: null, metadata: null, claimedAt: null,
          completedAt: null, createdAt: new Date(), updatedAt: new Date(),
        },
      };

      const result = await (agentLoop as unknown as { agentStep(t: unknown): Promise<unknown> }).agentStep(target);

      // recordOutcome was called (verification works)
      expect(mockRecordOutcome).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, agentType: 'claude' })
      );
      // StepResult is returned normally
      expect(result).toHaveProperty('action');
    });

    it('R1: threads injectContext injectedIds into outcome records as consumedKnowledge', async () => {
      // mockInjectContext default: { prompt: '## 系统约束\n- test rule', injectedIds: ['rule-1'] }
      mockExecuteLightweight.mockResolvedValue({
        success: true, outputText: 'ACTION: COMPLETE:done',
        logFile: '/tmp/log', worktree: '/tmp/wt', outputFiles: [], sessionCount: 1,
      });

      agentLoop = new AgentLoop(mockRole, fileStore);
      await agentLoop.start();

      const target = {
        workUnit: {
          id: 'wu-1', type: 'task', scope: 'test', channelId: 'ch-1',
          status: 'active', assigneeId: 'agent-1', parentId: null,
          failureType: null, retryCount: 0, timeoutAt: null,
          projectPath: null, metadata: null, claimedAt: null,
          completedAt: null, createdAt: new Date(), updatedAt: new Date(),
        },
      };

      await (agentLoop as unknown as { agentStep(t: unknown): Promise<unknown> }).agentStep(target);
      // recordExecutionOutcome 是 fire-and-forget：extractFromExecution 在
      // recordOutcome 之后的 microtask 链上，先让事件循环排空再断言
      await new Promise(r => setImmediate(r));

      // R1 反馈环: 注入的知识条目 id 必须贯穿到 outcome/extraction（不再硬编码 []）
      expect(mockInjectContext).toHaveBeenCalled();
      expect(mockRecordOutcome).toHaveBeenCalledWith(
        expect.objectContaining({ consumedKnowledge: ['rule-1'] })
      );
      expect(mockExtractFromExecution).toHaveBeenCalledWith(
        expect.objectContaining({ consumedKnowledge: ['rule-1'] })
      );
    });

    it('R1: reports empty consumedKnowledge when nothing was injected', async () => {
      mockInjectContext.mockResolvedValueOnce({ prompt: '', injectedIds: [] });
      mockExecuteLightweight.mockResolvedValue({
        success: true, outputText: 'ACTION: PROGRESS:working',
        logFile: '/tmp/log', worktree: '/tmp/wt', outputFiles: [], sessionCount: 1,
      });

      agentLoop = new AgentLoop(mockRole, fileStore);
      await agentLoop.start();

      const target = {
        workUnit: {
          id: 'wu-1', type: 'task', scope: 'test', channelId: 'ch-1',
          status: 'active', assigneeId: 'agent-1', parentId: null,
          failureType: null, retryCount: 0, timeoutAt: null,
          projectPath: null, metadata: null, claimedAt: null,
          completedAt: null, createdAt: new Date(), updatedAt: new Date(),
        },
      };

      await (agentLoop as unknown as { agentStep(t: unknown): Promise<unknown> }).agentStep(target);

      expect(mockRecordOutcome).toHaveBeenCalledWith(
        expect.objectContaining({ consumedKnowledge: [] })
      );
    });

    it('does not block when recordOutcome fails', async () => {
      mockRecordOutcome.mockRejectedValueOnce(new Error('DB timeout'));
      mockExecuteLightweight.mockResolvedValue({
        success: true, outputText: 'ACTION: PROGRESS:working',
        logFile: '/tmp/log', worktree: '/tmp/wt', outputFiles: [], sessionCount: 1,
      });

      agentLoop = new AgentLoop(mockRole, fileStore);
      await agentLoop.start();

      const target = {
        workUnit: {
          id: 'wu-1', type: 'task', scope: 'test', channelId: 'ch-1',
          status: 'active', assigneeId: 'agent-1', parentId: null,
          failureType: null, retryCount: 0, timeoutAt: null,
          projectPath: null, metadata: null, claimedAt: null,
          completedAt: null, createdAt: new Date(), updatedAt: new Date(),
        },
      };

      await expect(
        (agentLoop as unknown as { agentStep(t: unknown): Promise<unknown> }).agentStep(target)
      ).resolves.toBeDefined();
    });
  });

  describe('AgentTask new interface', () => {
    it('uses provider instead of agentType', async () => {
      mockExecuteLightweight.mockResolvedValue({
        success: true, outputText: 'ACTION: PROGRESS:working',
        logFile: '/tmp/log', worktree: '/tmp/wt', outputFiles: [], sessionCount: 1,
      });

      agentLoop = new AgentLoop(mockRole, fileStore);
      await agentLoop.start();

      const target = {
        workUnit: {
          id: 'wu-1', type: 'task', scope: 'test', channelId: 'ch-1',
          status: 'active', assigneeId: 'agent-1', parentId: null,
          failureType: null, retryCount: 0, timeoutAt: null,
          projectPath: null, metadata: null, claimedAt: null,
          completedAt: null, createdAt: new Date(), updatedAt: new Date(),
        },
      };

      await (agentLoop as unknown as { agentStep(t: unknown): Promise<unknown> }).agentStep(target);

      const callArg = mockExecuteLightweight.mock.calls[0][0];
      expect(callArg.provider).toBe('claude');
      expect(callArg).not.toHaveProperty('agentType');
    });

    // AC-2.2: provider from role profile
    it('uses role.provider when set', async () => {
      mockExecuteLightweight.mockResolvedValue({
        success: true, outputText: 'ACTION: PROGRESS:working',
        logFile: '/tmp/log', worktree: '/tmp/wt', outputFiles: [], sessionCount: 1,
      });

      const roleWithCodex = { ...mockRole, provider: 'codex' as const };
      agentLoop = new AgentLoop(roleWithCodex, fileStore);
      await agentLoop.start();

      const target = {
        workUnit: {
          id: 'wu-1', type: 'task', scope: 'test', channelId: 'ch-1',
          status: 'active', assigneeId: 'agent-1', parentId: null,
          failureType: null, retryCount: 0, timeoutAt: null,
          projectPath: null, metadata: null, claimedAt: null,
          completedAt: null, createdAt: new Date(), updatedAt: new Date(),
        },
      };

      await (agentLoop as unknown as { agentStep(t: unknown): Promise<unknown> }).agentStep(target);

      const callArg = mockExecuteLightweight.mock.calls[0][0];
      expect(callArg.provider).toBe('codex');
    });

    // AC-2.3: provider null → fallback 'claude'
    it('falls back to claude when role.provider is null', async () => {
      mockExecuteLightweight.mockResolvedValue({
        success: true, outputText: 'ACTION: PROGRESS:working',
        logFile: '/tmp/log', worktree: '/tmp/wt', outputFiles: [], sessionCount: 1,
      });

      const roleWithNullProvider = { ...mockRole, provider: null as unknown as undefined };
      agentLoop = new AgentLoop(roleWithNullProvider, fileStore);
      await agentLoop.start();

      const target = {
        workUnit: {
          id: 'wu-1', type: 'task', scope: 'test', channelId: 'ch-1',
          status: 'active', assigneeId: 'agent-1', parentId: null,
          failureType: null, retryCount: 0, timeoutAt: null,
          projectPath: null, metadata: null, claimedAt: null,
          completedAt: null, createdAt: new Date(), updatedAt: new Date(),
        },
      };

      await (agentLoop as unknown as { agentStep(t: unknown): Promise<unknown> }).agentStep(target);

      const callArg = mockExecuteLightweight.mock.calls[0][0];
      expect(callArg.provider).toBe('claude');
    });

    it('passes sessionId and maxTurns in parameters', async () => {
      mockExecuteLightweight.mockResolvedValue({
        success: true, outputText: 'ACTION: PROGRESS:working',
        logFile: '/tmp/log', worktree: '/tmp/wt', outputFiles: [], sessionCount: 1,
      });

      agentLoop = new AgentLoop(mockRole, fileStore);
      await agentLoop.start();

      const target = {
        workUnit: {
          id: 'wu-1', type: 'task', scope: 'test', channelId: 'ch-1',
          status: 'active', assigneeId: 'agent-1', parentId: null,
          failureType: null, retryCount: 0, timeoutAt: null,
          projectPath: null, metadata: null, claimedAt: null,
          completedAt: null, createdAt: new Date(), updatedAt: new Date(),
        },
      };

      await (agentLoop as unknown as { agentStep(t: unknown): Promise<unknown> }).agentStep(target);

      expect(mockExecuteLightweight).toHaveBeenCalledWith(
        expect.objectContaining({
          parameters: expect.objectContaining({
            maxTurns: 50,
          }),
        })
      );
    });

    it('does not pass sessionFlags', async () => {
      mockExecuteLightweight.mockResolvedValue({
        success: true, outputText: 'ACTION: PROGRESS:working',
        logFile: '/tmp/log', worktree: '/tmp/wt', outputFiles: [], sessionCount: 1,
      });

      agentLoop = new AgentLoop(mockRole, fileStore);
      await agentLoop.start();

      const target = {
        workUnit: {
          id: 'wu-1', type: 'task', scope: 'test', channelId: 'ch-1',
          status: 'active', assigneeId: 'agent-1', parentId: null,
          failureType: null, retryCount: 0, timeoutAt: null,
          projectPath: null, metadata: null, claimedAt: null,
          completedAt: null, createdAt: new Date(), updatedAt: new Date(),
        },
      };

      await (agentLoop as unknown as { agentStep(t: unknown): Promise<unknown> }).agentStep(target);

      const params = mockExecuteLightweight.mock.calls[0][0].parameters;
      expect(params).not.toHaveProperty('sessionFlags');
      expect(params).toHaveProperty('sessionId');
    });
  });

  describe('Session truncation (input_tokens detection)', () => {
    it('resets sessionId when input_tokens exceed threshold', async () => {
      // First call: create session (no existing sessionId)
      mockExecuteLightweight.mockResolvedValueOnce({
        success: true, outputText: JSON.stringify({
          type: 'usage',
          input_tokens: 150_000,
        }),
        logFile: '/tmp/log', worktree: '/tmp/wt', outputFiles: [], sessionCount: 2,
      });
      // Second call: after reset, no sessionId should be passed
      mockExecuteLightweight.mockResolvedValueOnce({
        success: true, outputText: 'ACTION: PROGRESS:working',
        logFile: '/tmp/log', worktree: '/tmp/wt', outputFiles: [], sessionCount: 1,
      });

      agentLoop = new AgentLoop(mockRole, fileStore);
      await agentLoop.start();

      const target = {
        workUnit: {
          id: 'wu-1', type: 'task', scope: 'test', channelId: 'ch-1',
          status: 'active', assigneeId: 'agent-1', parentId: null,
          failureType: null, retryCount: 0, timeoutAt: null,
          projectPath: null, metadata: null, claimedAt: null,
          completedAt: null, createdAt: new Date(), updatedAt: new Date(),
        },
      };

      // First call: creates session, returns high tokens
      await (agentLoop as unknown as { agentStep(t: unknown): Promise<unknown> }).agentStep(target);

      // Second call: should NOT have sessionId (was reset)
      await (agentLoop as unknown as { agentStep(t: unknown): Promise<unknown> }).agentStep(target);

      const secondCallParams = mockExecuteLightweight.mock.calls[1][0].parameters;
      // fix/guard-and-resume: session 截断后 instance.sessionId 置 null，下一步按
      // non-resume 路径生成新 sessionId（新生命周期），不再传 undefined。
      expect(secondCallParams.sessionId).toMatch(/^[0-9a-f]{8}-/);
      expect(secondCallParams.sessionResume).toBeUndefined();
    });

    it('does not reset sessionId when input_tokens below threshold', async () => {
      // First call: create session, low tokens
      mockExecuteLightweight.mockResolvedValueOnce({
        success: true, outputText: JSON.stringify({
          type: 'usage',
          input_tokens: 50_000,
        }),
        logFile: '/tmp/log', worktree: '/tmp/wt', outputFiles: [], sessionCount: 1,
      });
      // Second call: should still have sessionId (not reset)
      mockExecuteLightweight.mockResolvedValueOnce({
        success: true, outputText: 'ACTION: PROGRESS:working',
        logFile: '/tmp/log', worktree: '/tmp/wt', outputFiles: [], sessionCount: 1,
      });

      agentLoop = new AgentLoop(mockRole, fileStore);
      await agentLoop.start();

      const target = {
        workUnit: {
          id: 'wu-1', type: 'task', scope: 'test', channelId: 'ch-1',
          status: 'active', assigneeId: 'agent-1', parentId: null,
          failureType: null, retryCount: 0, timeoutAt: null,
          projectPath: null, metadata: null, claimedAt: null,
          completedAt: null, createdAt: new Date(), updatedAt: new Date(),
        },
      };

      await (agentLoop as unknown as { agentStep(t: unknown): Promise<unknown> }).agentStep(target);
      await (agentLoop as unknown as { agentStep(t: unknown): Promise<unknown> }).agentStep(target);

      const secondCallParams = mockExecuteLightweight.mock.calls[1][0].parameters;
      expect(secondCallParams.sessionId).toBeDefined();
    });
  });

  describe('AC-4.5: Health probe', () => {
    it('start() continues normally when claude CLI is available', async () => {
      mockExecSync.mockReturnValue('Claude Code CLI version 1.0.0');

      agentLoop = new AgentLoop(mockRole, fileStore);
      await agentLoop.start();

      const agentStates = await fileStore.listStates();
      const match = agentStates.find(s => s.roleId === 'role-1');
      expect(match).toBeDefined();
      expect(mockExecSync).toHaveBeenCalledWith('claude --version', expect.objectContaining({ timeout: 5000 }));
    });

    it('start() does not start the loop when claude CLI is not available (F2: records error state)', async () => {
      mockExecSync.mockImplementation(() => { throw new Error('ENOENT'); });

      agentLoop = new AgentLoop(mockRole, fileStore);
      const started = await agentLoop.start();

      // Loop did not start — no EVENT trigger registered
      expect(started).toBe(false);
      expect(mockTriggerScheduler.registerTrigger).not.toHaveBeenCalled();

      // F2: failure IS recorded in runtime state for UI/monitoring visibility
      const agentStates = await fileStore.listStates();
      const match = agentStates.find(s => s.roleId === 'role-1');
      expect(match).toBeDefined();
      expect(match!.status).toBe('error');
      expect(match!.lastError).toBeTruthy();
      expect(match!.lastErrorAt).toBeTruthy();
    });
  });

  describe('AC-4.6: Dead instance cleanup', () => {
    it('cleans up dead previous instance with non-existent PID on start', async () => {
      // Create a "dead" instance state manually with non-existent PID
      await fileStore.createState('dead-instance', {
        id: 'dead-instance',
        roleId: 'role-1',
        sessionId: null,
        status: 'active',
        currentWorkUnitId: null,
        startedAt: '2026-01-01T00:00:00Z',
        terminatedAt: null,
        lastHeartbeat: null,
        metadata: null,
        pid: 999_999_999,
      });

      agentLoop = new AgentLoop(mockRole, fileStore);
      await agentLoop.start();

      const deadState = await fileStore.getState('dead-instance');
      expect(deadState).not.toBeNull();
      expect(deadState!.status).toBe('terminated');
    });
  });

  describe('AC-4.3/4.4: extractInputTokens()', () => {
    it('returns null for empty string', () => {
      expect(extractInputTokens('')).toBeNull();
    });

    it('returns input_tokens from result event', () => {
      const output = JSON.stringify({ type: 'result', input_tokens: 75_000 });
      expect(extractInputTokens(output)).toBe(75_000);
    });

    it('returns null when no result event found', () => {
      const output = JSON.stringify({ type: 'usage', input_tokens: 50_000 });
      expect(extractInputTokens(output)).toBeNull();
    });

    it('returns null for non-JSON lines', () => {
      expect(extractInputTokens('not json')).toBeNull();
    });

    it('parses result event from multi-line output', () => {
      const output = [
        JSON.stringify({ type: 'text', text: 'hello' }),
        JSON.stringify({ type: 'result', input_tokens: 42_000 }),
        JSON.stringify({ type: 'usage', input_tokens: 50_000 }),
      ].join('\n');
      expect(extractInputTokens(output)).toBe(42_000);
    });

    it('tracks lastInputTokens in agentStep metadataUpdates', async () => {
      mockExecuteLightweight.mockResolvedValue({
        success: true,
        outputText: JSON.stringify({ type: 'result', input_tokens: 42_000 }),
        logFile: '/tmp/log', worktree: '/tmp/wt', outputFiles: [], sessionCount: 1,
      });

      agentLoop = new AgentLoop(mockRole, fileStore);
      await agentLoop.start();

      const target = {
        workUnit: {
          id: 'wu-last-tokens', type: 'task', scope: 'test', channelId: 'ch-1',
          status: 'active', assigneeId: 'agent-1', parentId: null,
          failureType: null, retryCount: 0, timeoutAt: null,
          projectPath: null, metadata: null, claimedAt: null,
          completedAt: null, createdAt: new Date(), updatedAt: new Date(),
        },
      };

      const result = await (agentLoop as unknown as { agentStep(t: unknown): Promise<unknown> }).agentStep(target);
      const resultTyped = result as { metadataUpdates?: Record<string, unknown> };
      expect(resultTyped.metadataUpdates).toBeDefined();
      expect(resultTyped.metadataUpdates!.lastInputTokens).toBe(42_000);
    });
  });

  describe('isProcessAlive()', () => {
    it('returns true for current process PID', () => {
      expect(isProcessAlive(process.pid)).toBe(true);
    });

    it('returns false for non-existent PID', () => {
      expect(isProcessAlive(999_999_999)).toBe(false);
    });
  });

  describe('writeToolCallEvents() — T-1.1', () => {
    let testDir: string;

    beforeEach(() => {
      testDir = path.join(os.tmpdir(), `toolcall-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    });

    afterEach(() => {
      try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('writes tool:call JSONL from stream-json output（D18: StudioEvent 形态）', () => {
      const eventsFile = path.join(testDir, 'studio-events.jsonl');
      const streamOutput = [
        '{"type":"assistant","content":[{"type":"tool_use","name":"Read","input":{"file_path":"/foo.ts"}}]}',
        '{"type":"assistant","content":[{"type":"tool_use","name":"Edit","input":{"file_path":"/bar.ts","old_string":"x","new_string":"y"}}]}',
        '{"type":"result"}',
      ].join('\n');

      const count = writeToolCallEvents(streamOutput, eventsFile);
      expect(count).toBe(2);

      // Verify JSONL content
      const raw = fs.readFileSync(eventsFile, 'utf-8').trim().split('\n');
      expect(raw.length).toBe(2);

      const first = JSON.parse(raw[0]);
      expect(first.type).toBe('tool:call');
      expect(first.source).toBe('agent-loop');
      const firstPayload = JSON.parse(first.payload);
      expect(firstPayload.tool).toBe('Read');
      expect(firstPayload.caller).toBe('agent-loop');

      const second = JSON.parse(raw[1]);
      expect(second.type).toBe('tool:call');
      const secondPayload = JSON.parse(second.payload);
      expect(secondPayload.tool).toBe('Edit');
      expect(secondPayload.success).toBe(true);
    });

    it('returns 0 for empty output', () => {
      const eventsFile = path.join(testDir, 'empty.jsonl');
      const count = writeToolCallEvents('', eventsFile);
      expect(count).toBe(0);
    });

    it('returns 0 for output without tool_use', () => {
      const eventsFile = path.join(testDir, 'no-tools.jsonl');
      const count = writeToolCallEvents('{"type":"result","result":"done"}', eventsFile);
      expect(count).toBe(0);
    });
  });

  describe('D18: 统一事件文件 (resolveStudioEventsFile)', () => {
    let testDir: string;
    let prevStudioEventsFile: string | undefined;

    beforeEach(() => {
      testDir = path.join(os.tmpdir(), `eventsfile-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
      prevStudioEventsFile = process.env.STUDIO_EVENTS_FILE;
    });

    afterEach(() => {
      if (prevStudioEventsFile === undefined) delete process.env.STUDIO_EVENTS_FILE;
      else process.env.STUDIO_EVENTS_FILE = prevStudioEventsFile;
      try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('resolveToolTraceFile 默认指向测试隔离的统一事件文件', () => {
      delete process.env.STUDIO_EVENTS_FILE;
      expect(resolveToolTraceFile()).toBe(path.join(os.tmpdir(), 'studio-test-logs', 'studio-events.jsonl'));
    });

    it('resolveToolTraceFile honors STUDIO_EVENTS_FILE override', () => {
      process.env.STUDIO_EVENTS_FILE = path.join(testDir, 'studio-events.jsonl');
      expect(resolveToolTraceFile()).toBe(path.join(testDir, 'studio-events.jsonl'));
    });

    it('agent-loop writes tool traces into the resolved events file', () => {
      process.env.STUDIO_EVENTS_FILE = path.join(testDir, 'studio-events.jsonl');
      const streamOutput = [
        '{"type":"assistant","content":[{"type":"tool_use","name":"Read","input":{"file_path":"/foo.ts"}}]}',
        '{"type":"result"}',
      ].join('\n');

      const count = writeToolCallEvents(streamOutput, resolveToolTraceFile());
      expect(count).toBe(1);

      const traceFile = path.join(testDir, 'studio-events.jsonl');
      expect(fs.existsSync(traceFile)).toBe(true);
      const first = JSON.parse(fs.readFileSync(traceFile, 'utf-8').trim().split('\n')[0]);
      expect(first.type).toBe('tool:call');
      expect(JSON.parse(first.payload).tool).toBe('Read');
    });
  });

  describe('R2-fix: agentStep tool:call 接线（rawOutput 优先于 outputText）', () => {
    let prevStudioEventsFile: string | undefined;

    const makeTarget = (metadata: Record<string, unknown> | null = null) => ({
      workUnit: {
        id: 'wu-r2-wiring', type: 'task', scope: 'test', channelId: 'ch-1',
        status: 'active', assigneeId: 'agent-1', parentId: null,
        failureType: null, retryCount: 0, timeoutAt: null,
        projectPath: null, metadata: metadata ? JSON.stringify(metadata) : null, claimedAt: null,
        completedAt: null, createdAt: new Date(), updatedAt: new Date(),
      },
    });

    const traceFile = () => path.join(testDir, 'studio-events.jsonl');

    beforeEach(() => {
      prevStudioEventsFile = process.env.STUDIO_EVENTS_FILE;
      process.env.STUDIO_EVENTS_FILE = traceFile();
    });

    afterEach(() => {
      if (prevStudioEventsFile === undefined) delete process.env.STUDIO_EVENTS_FILE;
      else process.env.STUDIO_EVENTS_FILE = prevStudioEventsFile;
    });

    it('rawOutput（stream-json）中的 tool_use 落盘为 tool:call 事件（含 message.content 与 content 两种形状）', async () => {
      mockExecuteLightweight.mockResolvedValue({
        success: true,
        outputText: 'ACTION: PROGRESS:working',
        rawOutput: [
          // message.content 形状（claude stream-json assistant 事件）
          '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/foo.ts"}}]}}',
          // 直接 content 形状
          '{"type":"assistant","content":[{"type":"tool_use","name":"Edit","input":{"file_path":"/bar.ts"}}]}',
          '{"type":"result","result":"done"}',
        ].join('\n'),
        logFile: '/tmp/log', worktree: '/tmp/wt', outputFiles: [], sessionCount: 1,
      });

      agentLoop = new AgentLoop(mockRole, fileStore);
      await agentLoop.start();
      await (agentLoop as unknown as { agentStep(t: unknown): Promise<unknown> }).agentStep(makeTarget());

      expect(fs.existsSync(traceFile())).toBe(true);
      const lines = fs.readFileSync(traceFile(), 'utf-8').trim().split('\n');
      expect(lines.length).toBe(2);

      const first = JSON.parse(lines[0]);
      expect(first.type).toBe('tool:call');
      expect(first.source).toBe('agent-loop');
      const firstPayload = JSON.parse(first.payload);
      expect(firstPayload.tool).toBe('Read');
      expect(firstPayload.success).toBe(true);
      expect(firstPayload.caller).toBe('agent-loop');
      expect(typeof firstPayload.timestamp).toBe('number');
      expect(typeof first.createdAt).toBe('string');

      const second = JSON.parse(lines[1]);
      expect(second.type).toBe('tool:call');
      expect(JSON.parse(second.payload).tool).toBe('Edit');
    });

    it('仅 outputText（extractResult 纯文本）时产 0 条——接线必须走 rawOutput', async () => {
      mockExecuteLightweight.mockResolvedValue({
        success: true,
        outputText: 'ACTION: PROGRESS:working\n已完成第一步，继续中。',
        logFile: '/tmp/log', worktree: '/tmp/wt', outputFiles: [], sessionCount: 1,
      });

      agentLoop = new AgentLoop(mockRole, fileStore);
      await agentLoop.start();
      await (agentLoop as unknown as { agentStep(t: unknown): Promise<unknown> }).agentStep(makeTarget());

      // 0 条 tool:call → writeToolCallEvents 提前返回，不落盘
      expect(fs.existsSync(traceFile())).toBe(false);
    });
  });

  describe('wireup④: metadata._cumulativeTokens 累计写回', () => {
    const makeTarget = (metadata: Record<string, unknown> | null = null) => ({
      workUnit: {
        id: 'wu-cumulative-tokens', type: 'task', scope: 'test', channelId: 'ch-1',
        status: 'active', assigneeId: 'agent-1', parentId: null,
        failureType: null, retryCount: 0, timeoutAt: null,
        projectPath: null, metadata: metadata ? JSON.stringify(metadata) : null, claimedAt: null,
        completedAt: null, createdAt: new Date(), updatedAt: new Date(),
      },
    });

    it('本次 executionTokens 累加到既有 _cumulativeTokens', async () => {
      mockExecuteLightweight.mockResolvedValue({
        success: true,
        outputText: 'ACTION: PROGRESS:working',
        usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0, model: 'm' },
        logFile: '/tmp/log', worktree: '/tmp/wt', outputFiles: [], sessionCount: 1,
      });

      agentLoop = new AgentLoop(mockRole, fileStore);
      await agentLoop.start();
      const result = await (agentLoop as unknown as { agentStep(t: unknown): Promise<unknown> }).agentStep(makeTarget({ _cumulativeTokens: 70 }));
      const { metadataUpdates } = result as { metadataUpdates?: Record<string, unknown> };
      expect(metadataUpdates).toBeDefined();
      expect(metadataUpdates!._cumulativeTokens).toBe(220);
    });

    it('CLI 未回报 usage 时按 0 累加（既有值不变；无既有值记 0）', async () => {
      mockExecuteLightweight.mockResolvedValue({
        success: true,
        outputText: 'ACTION: PROGRESS:working',
        logFile: '/tmp/log', worktree: '/tmp/wt', outputFiles: [], sessionCount: 1,
      });

      agentLoop = new AgentLoop(mockRole, fileStore);
      await agentLoop.start();

      const withExisting = await (agentLoop as unknown as { agentStep(t: unknown): Promise<unknown> }).agentStep(makeTarget({ _cumulativeTokens: 70 }));
      expect((withExisting as { metadataUpdates?: Record<string, unknown> }).metadataUpdates!._cumulativeTokens).toBe(70);

      const fresh = await (agentLoop as unknown as { agentStep(t: unknown): Promise<unknown> }).agentStep(makeTarget());
      expect((fresh as { metadataUpdates?: Record<string, unknown> }).metadataUpdates!._cumulativeTokens).toBe(0);
    });
  });
});
