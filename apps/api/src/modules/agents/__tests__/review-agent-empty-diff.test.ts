// ReviewAgent: empty diff pre-check (reject without LLM)
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// ── Mocks (hoisted before module load) ──

vi.mock('@dommaker/studio-shared/node', () => ({
  execSh: vi.fn(),
}));

vi.mock('@dommaker/studio-shared', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  getModelForTier: vi.fn(() => 'claude-sonnet-4-6'),
  buildSpawnEnv: vi.fn(() => ({})),
  formatConstraintsForPrompt: vi.fn(() => ''),
}));

vi.mock('@dommaker/studio-shared/harness/hooks', () => ({
  afterReview: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../knowledge/knowledge-service.js', () => ({
  knowledgeService: {
    injectContext: vi.fn(() => Promise.resolve(null)),
    recordPattern: vi.fn(() => Promise.resolve()),
  },
}));

vi.mock('../../channels/discovery-exposure.service.js', () => ({
  discoveryExposure: { expose: vi.fn(() => Promise.resolve()) },
}));

vi.mock('../../../daemon/metrics.js', () => ({
  recordExecution: vi.fn(() => Promise.resolve()),
}));

vi.mock('@dommaker/studio-skill', () => ({
  skillLoader: { load: vi.fn(() => []), formatForPrompt: vi.fn(() => '') },
}));

// Mock fs to prevent disk I/O — writeFileSync is no-op, existsSync defaults true
vi.mock('fs', () => ({
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(() => '{}'),
  unlinkSync: vi.fn(),
  mkdtempSync: vi.fn(() => '/tmp/fake-worktree'),
  rmSync: vi.fn(),
}));

import { reviewAgent } from '../review-agent.service.js';
import { execSh } from '@dommaker/studio-shared/node';
import { logger } from '@dommaker/studio-shared';

const mockExecSh = vi.mocked(execSh);

describe('ReviewAgent — empty diff pre-check', () => {
  let worktree: string;

  beforeEach(() => {
    worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'review-test-'));
    // Default: git commands return empty (simulates empty diff), non-git throws
    mockExecSh.mockImplementation(async (cmd: string) => {
      if (cmd.includes('git diff') || cmd.includes('git log')) {
        return { stdout: '', stderr: '' };
      }
      throw new Error(`Unexpected execSh call: ${cmd.slice(0, 60)}`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try { fs.rmSync(worktree, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('rejects without spawning Claude when diff is empty', async () => {
    vi.spyOn(reviewAgent as any, 'hasChanges').mockResolvedValue(true);
    vi.spyOn(reviewAgent as any, 'isSimpleChange').mockResolvedValue(false);

    const result = await reviewAgent.review({
      taskId: 'test-empty-diff',
      projectId: 'proj',
      worktree,
      taskDescription: 'test task',
      acceptanceCriteria: ['AC1'],
    });

    // Should reject with score=0
    expect(result.approved).toBe(false);
    expect(result.score).toBe(0);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].severity).toBe('error');
    expect(result.issues[0].message).toContain('Empty diff');

    // Claude should NOT be spawned
    const claudeCalls = mockExecSh.mock.calls.filter(
      ([cmd]) => (cmd as string).includes('claude'),
    );
    expect(claudeCalls).toHaveLength(0);
  });

  it('logs diff stats with isEmpty=true and emits warn', async () => {
    vi.spyOn(reviewAgent as any, 'hasChanges').mockResolvedValue(true);
    vi.spyOn(reviewAgent as any, 'isSimpleChange').mockResolvedValue(false);

    await reviewAgent.review({
      taskId: 'test-empty-log',
      projectId: 'proj',
      worktree,
      taskDescription: 'test',
    });

    // Monitoring log includes isEmpty: true
    const infoCalls = (logger.info as any).mock.calls;
    const diffStatsLog = infoCalls.find(
      (c: unknown[]) => c[0] === '[ReviewAgent] Diff stats',
    );
    expect(diffStatsLog).toBeDefined();
    expect(diffStatsLog[1]).toMatchObject({ isEmpty: true, diffSize: 0 });

    // Warn log emitted
    const warnCalls = (logger.warn as any).mock.calls;
    const rejectWarn = warnCalls.find(
      (c: unknown[]) => String(c[0]).includes('Empty diff'),
    );
    expect(rejectWarn).toBeDefined();
  });

  it('proceeds to Claude spawn when diff is non-empty', async () => {
    vi.spyOn(reviewAgent as any, 'hasChanges').mockResolvedValue(true);
    vi.spyOn(reviewAgent as any, 'isSimpleChange').mockResolvedValue(false);

    // Non-empty diff: override execSh per call
    // Call order after spy bypass:
    //   1. git diff HEAD~1 --stat (main diff stat)
    //   2. git diff HEAD~1 (main diff content)
    //   3. claude spawn (cat ... | claude ...)
    let callIdx = 0;
    mockExecSh.mockImplementation(async (cmd: string) => {
      callIdx++;
      if (callIdx === 1) return { stdout: 'file.ts | 10 ++++++++++\n', stderr: '' };
      if (callIdx === 2) return { stdout: 'diff --git a/file.ts b/file.ts\n+new line\n', stderr: '' };
      if ((cmd as string).includes('claude')) {
        return { stdout: JSON.stringify({ result: 'done', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 } }), stderr: '' };
      }
      throw new Error(`Unexpected: ${(cmd as string).slice(0, 60)}`);
    });

    // Mock report for readFileSync
    const mockReport = {
      overallApproved: false,
      issues: [{ severity: 'error', message: 'test issue' }],
      suggestions: [],
      stanceReports: {},
    };
    (fs.readFileSync as any).mockReturnValue(JSON.stringify(mockReport));

    const result = await reviewAgent.review({
      taskId: 'test-nonempty',
      projectId: 'proj',
      worktree,
      taskDescription: 'test',
      acceptanceCriteria: ['AC1'],
    });

    // Result returned (not short-circuited by empty check)
    expect(result).toBeDefined();
    expect(result).toHaveProperty('approved');
    expect(result).toHaveProperty('score');

    // Diff stats log shows isEmpty: false
    const infoCalls = (logger.info as any).mock.calls;
    const diffStatsLog = infoCalls.find(
      (c: unknown[]) => c[0] === '[ReviewAgent] Diff stats',
    );
    expect(diffStatsLog).toBeDefined();
    expect(diffStatsLog[1]).toMatchObject({ isEmpty: false });
    expect((diffStatsLog[1] as Record<string, unknown>).diffSize).toBeGreaterThan(0);

    // Claude WAS spawned
    const claudeCalls = mockExecSh.mock.calls.filter(
      ([cmd]) => (cmd as string).includes('claude'),
    );
    expect(claudeCalls.length).toBeGreaterThan(0);
  });
});

describe('ReviewAgent — isSimpleChange total lines check', () => {
  let worktree: string;

  beforeEach(() => {
    worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'review-lines-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try { fs.rmSync(worktree, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  /** Call isSimpleChange directly via any-cast */
  async function callIsSimpleChange(acs?: string[]): Promise<boolean> {
    return (reviewAgent as any).isSimpleChange(worktree, acs);
  }

  it('AC1: returns false when total changed lines > 20', async () => {
    // 21 added lines → should be false
    mockExecSh.mockResolvedValueOnce({ stdout: '21\t0\tsrc/foo.ts\n', stderr: '' });
    expect(await callIsSimpleChange()).toBe(false);
  });

  it('AC3: returns true when total changed lines = 20 (boundary)', async () => {
    // Exactly 20 added lines → should be true
    mockExecSh.mockResolvedValueOnce({ stdout: '20\t0\tsrc/foo.ts\n', stderr: '' });
    expect(await callIsSimpleChange()).toBe(true);
  });

  it('AC3: returns true when total changed lines < 20', async () => {
    mockExecSh.mockResolvedValueOnce({ stdout: '5\t0\tsrc/foo.ts\n', stderr: '' });
    expect(await callIsSimpleChange()).toBe(true);
  });

  it('AC3: returns false when total changed lines = 21 (boundary+1)', async () => {
    mockExecSh.mockResolvedValueOnce({ stdout: '21\t0\tsrc/foo.ts\n', stderr: '' });
    expect(await callIsSimpleChange()).toBe(false);
  });

  it('AC2: preserves existing behavior — >3 ACs returns false', async () => {
    mockExecSh.mockResolvedValueOnce({ stdout: '5\t0\tsrc/foo.ts\n', stderr: '' });
    expect(await callIsSimpleChange(['a', 'b', 'c', 'd'])).toBe(false);
  });

  it('AC2: preserves existing behavior — deletions returns false', async () => {
    mockExecSh.mockResolvedValueOnce({ stdout: '5\t3\tsrc/foo.ts\n', stderr: '' });
    expect(await callIsSimpleChange()).toBe(false);
  });

  it('AC2: preserves existing behavior — >2 source files returns false', async () => {
    mockExecSh.mockResolvedValueOnce({
      stdout: '5\t0\tsrc/a.ts\n5\t0\tsrc/b.ts\n5\t0\tsrc/c.ts\n',
      stderr: '',
    });
    expect(await callIsSimpleChange()).toBe(false);
  });
});
