/**
 * P0: Analyst output file path resolution tests
 *
 * Root cause: outputFile was relative (.analyst/output-xxx.json), but API process
 * CWD differs from worktree. Claude writes to worktree, session-manager reads from
 * CWD — file not found → parse fails → output lost.
 *
 * Fix: runClaudeCode resolves relative outputFile to absolute before daemon call.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ──
vi.mock('@dommaker/studio-shared', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  modelGateway: { isAvailable: vi.fn(() => false), promptJson: vi.fn() },
}));

const { mockSubmitAdhocJob } = vi.hoisted(() => ({ mockSubmitAdhocJob: vi.fn() }));
vi.mock('../../../daemon/studio-daemon.js', () => ({
  daemon: { submitAdhocJob: mockSubmitAdhocJob },
}));

vi.mock('../analyst-knowledge.js', () => ({
  ensureWorktree: vi.fn(),
}));

vi.mock('../../../daemon/metrics.js', () => ({
  parseClaudeUsage: vi.fn(() => ({ inputTokens: 0, outputTokens: 0, cacheHitTokens: 0 })),
}));

import { runClaudeCode } from '../analyst-executor.js';
import * as path from 'path';

// Mock fs.existsSync to always return false (no output file found — text-only path)
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => ''),
  };
});

describe('runClaudeCode output file path resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const validDoc = {
    requirement: { title: 'test', acGroups: [{ id: 'g1', acs: ['AC1'], files: ['src/a.ts'], dependencies: [] }], tags: [], constraints: [] },
    design: { acGroups: [{ id: 'g1', implementationNotes: 'notes' }] },
    task: { acGroups: [{ id: 'g1' }] },
  };

  it('resolves relative outputFile to absolute using REPO_DIR', async () => {
    const origEnv = process.env.REPO_DIR;
    process.env.REPO_DIR = '/test/worktree';

    // Mock: daemon succeeds with valid JSON output via outputText (file not needed)
    mockSubmitAdhocJob.mockResolvedValueOnce({
      success: true,
      output: JSON.stringify({ result: JSON.stringify(validDoc) }),
    });

    try {
      await runClaudeCode('prompt', '.analyst/output-123.json');
    } catch {
      // May throw if text parse fails — that's OK, we're testing the daemon call args
    }

    // Verify: daemon received absolute path, not relative
    expect(mockSubmitAdhocJob).toHaveBeenCalledTimes(1);
    const callArgs = mockSubmitAdhocJob.mock.calls[0];
    const jobSpec = callArgs[0]; // first arg: JobSpec
    expect(jobSpec.outputFile).toBe('/test/worktree/.analyst/output-123.json');
    expect(path.isAbsolute(jobSpec.outputFile)).toBe(true);

    if (origEnv === undefined) delete process.env.REPO_DIR;
    else process.env.REPO_DIR = origEnv;
  });

  it('preserves absolute outputFile unchanged', async () => {
    mockSubmitAdhocJob.mockResolvedValueOnce({
      success: true,
      output: JSON.stringify({ result: JSON.stringify(validDoc) }),
    });

    try {
      await runClaudeCode('prompt', '/absolute/path/output.json');
    } catch { /* OK */ }

    const callArgs = mockSubmitAdhocJob.mock.calls[0];
    expect(callArgs[0].outputFile).toBe('/absolute/path/output.json');
  });

  it('returns rawOutput from daemon result', async () => {
    const daemonOutput = JSON.stringify({ result: JSON.stringify(validDoc) });
    mockSubmitAdhocJob.mockResolvedValueOnce({
      success: true,
      output: daemonOutput,
    });

    const result = await runClaudeCode('prompt', '.analyst/out.json');
    expect(result.rawOutput).toBe(daemonOutput);
    expect(result.doc).toBeDefined();
    expect(result.doc.requirement.title).toBe('test');
  });
});
