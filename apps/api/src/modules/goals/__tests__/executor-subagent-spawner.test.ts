// BT-11/BT-12: Executor sub-agent 调度单元测试
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock external dependencies
vi.mock('@dommaker/studio-shared', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  buildSpawnEnv: vi.fn(() => ({ ANTHROPIC_API_KEY: 'test-key' })),
}));

vi.mock('@dommaker/studio-shared/node', () => ({
  execSh: vi.fn(),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    existsSync: vi.fn(),
  };
});

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execSync: vi.fn(),
  };
});

// Import after mocks
const { spawnExecutorSubAgents, forceCommit } = await import('../executor-subagent-spawner.js');
const { execSh } = await import('@dommaker/studio-shared/node');

const mockExecSh = vi.mocked(execSh);

describe('spawnExecutorSubAgents (BT-11: sub-agent spawn)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('single AC → spawns 1 sub-agent', async () => {
    mockExecSh.mockResolvedValueOnce({
      stdout: JSON.stringify({ result: 'done', is_error: false }),
      stderr: '',
    });

    const results = await spawnExecutorSubAgents({
      worktree: '/tmp/test-worktree',
      goalTitle: 'test goal',
      acs: [{
        id: 'ac1',
        acs: ['add feature X'],
        files: ['src/x.ts'],
      }],
    });

    expect(results).toHaveLength(1);
    expect(results[0].acId).toBe('ac1');
    expect(results[0].success).toBe(true);
    expect(mockExecSh).toHaveBeenCalledTimes(1);
  });

  it('2 independent ACs → spawns 2 sub-agents in parallel (1 wave)', async () => {
    mockExecSh
      .mockResolvedValueOnce({ stdout: JSON.stringify({ result: 'ac1 done', is_error: false }), stderr: '' })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ result: 'ac2 done', is_error: false }), stderr: '' });

    const results = await spawnExecutorSubAgents({
      worktree: '/tmp/test-worktree',
      goalTitle: 'test goal',
      acs: [
        { id: 'ac1', acs: ['feature A'], files: ['a.ts'] },
        { id: 'ac2', acs: ['feature B'], files: ['b.ts'] },
      ],
    });

    expect(results).toHaveLength(2);
    expect(results.every(r => r.success)).toBe(true);
    expect(mockExecSh).toHaveBeenCalledTimes(2);
  });

  it('2 ACs with file overlap → 2 waves (serial)', async () => {
    mockExecSh
      .mockResolvedValueOnce({ stdout: JSON.stringify({ result: 'ac1 done', is_error: false }), stderr: '' })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ result: 'ac2 done', is_error: false }), stderr: '' });

    const results = await spawnExecutorSubAgents({
      worktree: '/tmp/test-worktree',
      goalTitle: 'test goal',
      acs: [
        { id: 'ac1', acs: ['change shared'], files: ['shared.ts'] },
        { id: 'ac2', acs: ['also change shared'], files: ['shared.ts'] },
      ],
    });

    expect(results).toHaveLength(2);
    expect(mockExecSh).toHaveBeenCalledTimes(2);
    // Verify calls were sequential (not parallel) — first call completed before second
    const calls = mockExecSh.mock.calls;
    expect(calls).toHaveLength(2);
  });

  it('2 ACs with dependency → 2 waves (serial by dependency)', async () => {
    mockExecSh
      .mockResolvedValueOnce({ stdout: JSON.stringify({ result: 'ac1 done', is_error: false }), stderr: '' })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ result: 'ac2 done', is_error: false }), stderr: '' });

    const results = await spawnExecutorSubAgents({
      worktree: '/tmp/test-worktree',
      goalTitle: 'test goal',
      acs: [
        { id: 'ac1', acs: ['base'], files: ['a.ts'] },
        { id: 'ac2', acs: ['depends on ac1'], files: ['b.ts'], dependencies: ['ac1'] },
      ],
    });

    expect(results).toHaveLength(2);
    expect(mockExecSh).toHaveBeenCalledTimes(2);
  });
});

describe('spawnExecutorSubAgents (BT-12: failure handling)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('1 sub-agent fails → only that one returns success=false', async () => {
    mockExecSh
      .mockResolvedValueOnce({ stdout: JSON.stringify({ result: 'ac1 done', is_error: false }), stderr: '' })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ result: 'ac2 failed', is_error: true }), stderr: '' });

    const results = await spawnExecutorSubAgents({
      worktree: '/tmp/test-worktree',
      goalTitle: 'test goal',
      acs: [
        { id: 'ac1', acs: ['feature A'], files: ['a.ts'] },
        { id: 'ac2', acs: ['feature B'], files: ['b.ts'] },
      ],
    });

    const ac1Result = results.find(r => r.acId === 'ac1');
    const ac2Result = results.find(r => r.acId === 'ac2');
    expect(ac1Result?.success).toBe(true);
    expect(ac2Result?.success).toBe(false);
  });

  it('wave has failure → subsequent waves not executed', async () => {
    // Wave 1: ac1 succeeds, ac2 fails
    mockExecSh
      .mockResolvedValueOnce({ stdout: JSON.stringify({ result: 'ac1 done', is_error: false }), stderr: '' })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ result: 'ac2 failed', is_error: true }), stderr: '' });

    const results = await spawnExecutorSubAgents({
      worktree: '/tmp/test-worktree',
      goalTitle: 'test goal',
      acs: [
        { id: 'ac1', acs: ['feature A'], files: ['a.ts'] },
        { id: 'ac2', acs: ['feature B'], files: ['b.ts'] },
        { id: 'ac3', acs: ['feature C'], files: ['c.ts'], dependencies: ['ac1'] },
      ],
    });

    // ac1 + ac2 in wave 1, ac3 in wave 2
    // ac2 failed → wave 2 not executed
    expect(results).toHaveLength(2); // only wave 1 results
    expect(results.find(r => r.acId === 'ac3')).toBeUndefined();
  });

  it('execSh throws → sub-agent returns success=false with error', async () => {
    mockExecSh.mockRejectedValueOnce(new Error('claude CLI crashed'));

    const results = await spawnExecutorSubAgents({
      worktree: '/tmp/test-worktree',
      goalTitle: 'test goal',
      acs: [{ id: 'ac1', acs: ['test'], files: ['a.ts'] }],
    });

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('claude CLI crashed');
  });
});

// BT-13: Parent 统一 commit
describe('forceCommit (BT-13)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when no changes (git status empty)', async () => {
    const { execSync } = await import('child_process');
    const mockExecSync = vi.mocked(execSync);
    mockExecSync.mockReturnValueOnce(''); // git status --porcelain returns empty

    const result = forceCommit('/tmp/worktree', 'feat: test');
    expect(result).toBeNull();
  });

  it('returns commit hash when changes present', async () => {
    const { execSync } = await import('child_process');
    const mockExecSync = vi.mocked(execSync);
    mockExecSync
      .mockReturnValueOnce('M src/x.ts\n')      // git status --porcelain
      .mockReturnValueOnce('')                   // git add -A
      .mockReturnValueOnce('[master abc1234]')   // git commit
      .mockReturnValueOnce('abc1234def5678\n');  // git rev-parse HEAD

    const result = forceCommit('/tmp/worktree', 'feat: test change');
    expect(result).toBe('abc1234def5678');
    expect(mockExecSync).toHaveBeenCalledTimes(4);
  });

  it('escapes double quotes in commit message', async () => {
    const { execSync } = await import('child_process');
    const mockExecSync = vi.mocked(execSync);
    mockExecSync
      .mockReturnValueOnce('M src/x.ts\n')
      .mockReturnValueOnce('')
      .mockReturnValueOnce('')
      .mockReturnValueOnce('abc\n');

    forceCommit('/tmp/worktree', 'feat: add "feature X"');
    // The commit call should have escaped quotes
    const commitCall = mockExecSync.mock.calls[2];
    expect(commitCall[0]).toContain('\\"');
  });
});
