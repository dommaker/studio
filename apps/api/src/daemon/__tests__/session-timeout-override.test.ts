/**
 * Behavioral tests for P3: Daemon session timeout override
 *
 * AC:
 * - runTask passes state.config.timeoutMs as AgentTask.timeoutMs
 * - executeLightweight uses task.timeoutMs when provided (overrides tier default)
 * - executeLightweight falls back to getSessionTimeout(tier) when task.timeoutMs not set
 * - reviewAgent uses complexity-based timeout: simple=10, medium=15, complex=25
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ───

const {
  mockExecuteLightweight,
} = vi.hoisted(() => ({
  mockExecuteLightweight: vi.fn().mockResolvedValue({
    success: true,
    worktree: '/tmp/wt',
    outputFiles: [],
    logFile: '/tmp/log',
    sessionCount: 1,
    totalDurationMs: 1000,
    outputText: '',
  }),
}));

vi.mock('@dommaker/studio-agent', () => ({
  agentRunner: { executeLightweight: mockExecuteLightweight },
}));

vi.mock('@dommaker/studio-shared', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  parseStreamEvents: vi.fn(),
  extractUsage: vi.fn(),
  extractWriteContent: vi.fn(),
}));

vi.mock('@dommaker/studio-shared/node', () => ({
  readSessionIdFile: vi.fn().mockReturnValue('test-session-id'),
}));

vi.mock('./metrics.js', () => ({
  recordExecution: vi.fn(),
}));

vi.mock('./task-logger.js', () => ({
  writeTaskLog: vi.fn(),
  classifyTaskError: vi.fn().mockReturnValue({ category: 'unknown', severity: 'warning' }),
}));

import { SessionManager } from '../session-manager.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SessionManager.runTask — timeout override', () => {
  test('passes config.timeoutMs to executeLightweight as task.timeoutMs', async () => {
    const manager = new SessionManager();
    manager.register({
      name: 'analyst',
      worktree: '/tmp/repo',
      modelTier: 'premium',
      timeoutMs: 30 * 60 * 1000, // 30 min
      persistent: true,
    });

    await manager.runTask('analyst', {
      prompt: 'test prompt',
      outputFile: '/tmp/out.json',
    });

    expect(mockExecuteLightweight).toHaveBeenCalledOnce();
    const task = mockExecuteLightweight.mock.calls[0][0];
    expect(task.timeoutMs).toBe(30 * 60 * 1000);
  });

  test('reviewer session passes 15min timeoutMs', async () => {
    const manager = new SessionManager();
    manager.register({
      name: 'reviewer',
      worktree: '/tmp/review',
      modelTier: 'standard',
      timeoutMs: 15 * 60 * 1000,
      persistent: true,
    });

    await manager.runTask('reviewer', {
      prompt: 'review this',
      outputFile: '/tmp/review-out.json',
    });

    const task = mockExecuteLightweight.mock.calls[0][0];
    expect(task.timeoutMs).toBe(15 * 60 * 1000);
    expect(task.model).toBe('standard');
  });

  test('ad-hoc session uses provided timeoutMs', async () => {
    const manager = new SessionManager();
    manager.registerAdhoc({
      name: 'adhoc-test',
      worktree: '/tmp/adhoc',
      modelTier: 'fast',
      timeoutMs: 10 * 60 * 1000,
      persistent: false,
    });

    await manager.runTask('adhoc-test', {
      prompt: 'quick task',
      outputFile: '/tmp/adhoc-out.json',
    });

    const task = mockExecuteLightweight.mock.calls[0][0];
    expect(task.timeoutMs).toBe(10 * 60 * 1000);
  });
});
