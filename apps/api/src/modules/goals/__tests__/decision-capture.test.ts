/**
 * P4 Decision Capture — 验证 extractDecision 在管线完成后被调用
 *
 * AC: After discussion, call extractDecision → check Store
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ── Mocks ──────────────────────────────────────────────────

const mockExtractDecision = vi.fn().mockResolvedValue({
  topic: 'Use Prisma for DB',
  category: 'architecture',
  context: 'Need ORM for PostgreSQL',
  decision: 'Prisma',
  alternatives: ['TypeORM', 'Drizzle'],
  rationale: 'Best TypeScript support',
  consequences: 'Migration lock-in',
  participants: [],
  sourceType: 'llm-extraction',
  revisable: true,
});

const mockExtract = vi.fn().mockResolvedValue(null);
const mockExtractFromCompletion = vi.fn().mockResolvedValue(null);
const mockExtractFromError = vi.fn().mockResolvedValue(null);

vi.mock('../../agents/knowledge-agent.service.js', () => ({
  knowledgeAgent: {
    extract: mockExtract,
    extractFromCompletion: mockExtractFromCompletion,
    extractFromError: mockExtractFromError,
    extractDecision: mockExtractDecision,
  },
}));

vi.mock('@dommaker/studio-prisma', () => ({
  prisma: {},
}));

vi.mock('@dommaker/studio-shared', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../knowledge/knowledge-bus.service.js', () => ({
  sharedLifecycle: { recordReference: vi.fn() },
  knowledgeBus: { recordDecision: vi.fn() },
}));

vi.mock('@dommaker/studio-shared/harness/hooks', () => ({
  afterAgentComplete: vi.fn().mockResolvedValue(undefined),
  recordDecision: vi.fn(),
}));

vi.mock('../../tools-std/skill-extraction.service.js', () => ({
  skillExtractionService: { extractFromGoalExecution: vi.fn().mockResolvedValue(null) },
}));

// ── Tests ──────────────────────────────────────────────────

describe('P4 Decision Capture: extractDecision wiring', () => {
  let worktree: string;

  beforeEach(() => {
    worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-test-'));
    vi.clearAllMocks();
  });

  afterEach(() => {
    try { fs.rmSync(worktree, { recursive: true }); } catch {}
  });

  it('calls extractDecision with review report content', async () => {
    fs.writeFileSync(path.join(worktree, '.review-report.json'), JSON.stringify({
      score: 85,
      issues: [],
      summary: 'Good implementation',
    }));

    const { triggerPostCompletionKnowledge } = await import('../knowledge-promoter.js');

    triggerPostCompletionKnowledge(
      'task-1',
      { projectId: 'proj-1', description: 'Test task', name: 'Test' },
      worktree,
      undefined,
      'exec-1',
      'goal-1',
      {},
    );

    // Wait for async fire-and-forget calls
    await new Promise(r => setTimeout(r, 50));

    expect(mockExtractDecision).toHaveBeenCalledTimes(1);
    const [content, source] = mockExtractDecision.mock.calls[0];
    expect(content).toContain('Good implementation');
    expect(source).toBe('task:task-1');
  });

  it('calls extractDecision with progress notes content', async () => {
    fs.writeFileSync(path.join(worktree, '.progress.json'), JSON.stringify({
      completedSteps: ['AC-1'],
      notes: 'Decided to use Prisma over TypeORM',
    }));

    const { triggerPostCompletionKnowledge } = await import('../knowledge-promoter.js');

    triggerPostCompletionKnowledge(
      'task-2',
      { projectId: 'proj-1', description: 'Test task', name: 'Test' },
      worktree,
      undefined,
      'exec-2',
      'goal-2',
      {},
    );

    await new Promise(r => setTimeout(r, 50));

    expect(mockExtractDecision).toHaveBeenCalledTimes(1);
    const [content] = mockExtractDecision.mock.calls[0];
    expect(content).toContain('Prisma over TypeORM');
  });

  it('combines review report + progress notes', async () => {
    fs.writeFileSync(path.join(worktree, '.review-report.json'), JSON.stringify({ score: 90 }));
    fs.writeFileSync(path.join(worktree, '.progress.json'), JSON.stringify({ notes: 'Used vitest' }));

    const { triggerPostCompletionKnowledge } = await import('../knowledge-promoter.js');

    triggerPostCompletionKnowledge(
      'task-3',
      { projectId: 'proj-1', description: null, name: 'Test' },
      worktree,
      undefined,
      'exec-3',
      'goal-3',
      {},
    );

    await new Promise(r => setTimeout(r, 50));

    expect(mockExtractDecision).toHaveBeenCalledTimes(1);
    const [content] = mockExtractDecision.mock.calls[0];
    expect(content).toContain('score');
    expect(content).toContain('vitest');
  });

  it('skips extractDecision when no worktree files exist', async () => {
    const { triggerPostCompletionKnowledge } = await import('../knowledge-promoter.js');

    triggerPostCompletionKnowledge(
      'task-4',
      { projectId: 'proj-1', description: 'Test', name: 'Test' },
      worktree,
      undefined,
      'exec-4',
      'goal-4',
      {},
    );

    await new Promise(r => setTimeout(r, 50));

    expect(mockExtractDecision).not.toHaveBeenCalled();
  });

  it('does not block on extractDecision error', async () => {
    mockExtractDecision.mockRejectedValueOnce(new Error('API timeout'));
    fs.writeFileSync(path.join(worktree, '.progress.json'), JSON.stringify({ notes: 'test' }));

    const { triggerPostCompletionKnowledge } = await import('../knowledge-promoter.js');

    // Should not throw
    expect(() => {
      triggerPostCompletionKnowledge(
        'task-5',
        { projectId: 'proj-1', description: 'Test', name: 'Test' },
        worktree,
        undefined,
        'exec-5',
        'goal-5',
        {},
      );
    }).not.toThrow();

    await new Promise(r => setTimeout(r, 50));
    expect(mockExtractDecision).toHaveBeenCalledTimes(1);
  });
});
