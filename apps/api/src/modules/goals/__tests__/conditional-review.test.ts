/**
 * Conditional Review Trigger — 仅 worktree 有代码变更时触发审查
 *
 * 验证 hasCodeChanges() 的判定逻辑：
 * - worktree 无 diff → false（跳过 review）
 * - worktree 有代码 diff → true（正常 review）
 * - worktree 仅有 metadata 变更 → false（跳过 review）
 * - git 命令失败 → true（安全默认值，不阻断 review）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execSync: vi.fn(),
  };
});

// Mock heavy dependencies to avoid side effects during import
vi.mock('@dommaker/studio-prisma', () => ({ prisma: {} }));
vi.mock('@dommaker/studio-shared', () => ({
  eventBus: { publish: vi.fn() },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../core/event-store.js', () => ({ eventStore: { subscribe: vi.fn() } }));
vi.mock('../goal.service.js', () => ({ goalService: { updateStepExecution: vi.fn() } }));
vi.mock('../knowledge/knowledge-bus.service.js', () => ({ knowledgeBus: { recordPattern: vi.fn() } }));
vi.mock('@dommaker/studio-shared/harness/hooks', () => ({
  recordDecision: vi.fn(),
}));
vi.mock('../harness/evolution.service.js', () => ({
  recordFailure: vi.fn(),
  recordSuccess: vi.fn(),
  runEvolution: vi.fn(),
}));
vi.mock('../review-orchestrator.js', () => ({
  readReviewCycle: vi.fn(),
  handleReviewCycle: vi.fn(),
  MAX_REVIEW_CYCLES: 3,
}));
vi.mock('../knowledge-promoter.js', () => ({
  triggerPostCompletionKnowledge: vi.fn(),
  triggerFailureKnowledge: vi.fn(),
}));

import { execSync } from 'child_process';
import { hasCodeChanges } from '../event-handler.js';

const mockExecSync = vi.mocked(execSync);

describe('hasCodeChanges', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns false when git diff --name-only is empty (no changes)', () => {
    mockExecSync.mockReturnValue('');

    const result = hasCodeChanges('/tmp/fake-worktree');

    expect(result).toBe(false);
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining('git diff'),
      expect.objectContaining({ cwd: '/tmp/fake-worktree' }),
    );
  });

  it('returns true when worktree has code file changes', () => {
    // --name-only format: one file path per line
    mockExecSync.mockReturnValue('src/handler.ts\nsrc/utils.ts\n');

    const result = hasCodeChanges('/tmp/fake-worktree');

    expect(result).toBe(true);
  });

  it('returns false when only metadata files changed', () => {
    mockExecSync.mockReturnValue('.progress.json\n.review-report.json\n.agent.log\n.prompt.md\n');

    const result = hasCodeChanges('/tmp/fake-worktree');

    expect(result).toBe(false);
  });

  it('returns true when mixed code and metadata files changed', () => {
    mockExecSync.mockReturnValue('.progress.json\nsrc/handler.ts\n');

    const result = hasCodeChanges('/tmp/fake-worktree');

    expect(result).toBe(true);
  });

  it('returns true when git command fails (safe default)', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('git not found');
    });

    const result = hasCodeChanges('/tmp/fake-worktree');

    expect(result).toBe(true);
  });

  it('filters .claude/ directory from metadata', () => {
    mockExecSync.mockReturnValue('.claude/settings.json\n.claude/cache.json\n.progress.json\n');

    const result = hasCodeChanges('/tmp/fake-worktree');

    expect(result).toBe(false);
  });
});
