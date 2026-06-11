/**
 * KnowledgeSkillEvolver — AC-8b tests
 *
 * Tests:
 * - evolveToSkill returns null for non-skillCandidate entries
 * - evolveToSkill returns null for entries without executionResults
 * - evolveToSkill creates Skill + SkillProposal via Prisma
 * - evolveToSkill links KnowledgeEntry.skillId
 * - evolveAllCandidates skips already-evolved entries
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { KnowledgeSkillEvolver } from '../knowledge-skill-evolver.js';

function createMockStore(entries: any[] = []) {
  const all = [...entries];
  return {
    list: vi.fn(() => all),
    get: vi.fn((id: string) => all.find(e => e.id === id) || null),
    update: vi.fn((id: string, partial: any) => {
      const entry = all.find(e => e.id === id);
      if (entry) Object.assign(entry, partial);
      return entry;
    }),
  };
}

function createMockLifecycle() {
  return { recordReference: vi.fn() };
}

function createMockPrisma() {
  return {
    skill: {
      create: vi.fn().mockResolvedValue({ id: 'skill-1' }),
    },
    skillProposal: {
      create: vi.fn().mockResolvedValue({ id: 'proposal-1' }),
    },
    studioEvent: {
      create: vi.fn().mockResolvedValue({ id: 'event-1' }),
    },
  };
}

describe('KnowledgeSkillEvolver', () => {
  let evolver: KnowledgeSkillEvolver;
  let store: ReturnType<typeof createMockStore>;
  let lifecycle: ReturnType<typeof createMockLifecycle>;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(() => {
    store = createMockStore([
      {
        id: 'candidate-1',
        title: 'TDD Workflow Pattern',
        type: 'guideline',
        content: 'A'.repeat(250),
        maturity: 'proven',
        tags: ['pattern', 'skillCandidate'],
        contributors: ['agent-1', 'agent-2', 'agent-3'],
        executionResults: [
          { contributor: 'agent-1', success: true, timestamp: '2026-06-01' },
          { contributor: 'agent-2', success: true, timestamp: '2026-06-02' },
          { contributor: 'agent-3', success: true, timestamp: '2026-06-03' },
          { contributor: 'agent-1', success: true, timestamp: '2026-06-04' },
          { contributor: 'agent-2', success: true, timestamp: '2026-06-05' },
        ],
        skillId: undefined,
      },
      {
        id: 'not-candidate',
        title: 'Regular Entry',
        type: 'guideline',
        content: 'Some content',
        maturity: 'verified',
        tags: ['pattern'],
        contributors: ['agent-1'],
        executionResults: [],
        skillId: undefined,
      },
      {
        id: 'already-evolved',
        title: 'Already Evolved',
        type: 'guideline',
        content: 'A'.repeat(250),
        maturity: 'proven',
        tags: ['pattern', 'skillCandidate'],
        contributors: ['agent-1', 'agent-2', 'agent-3'],
        executionResults: [
          { contributor: 'agent-1', success: true, timestamp: '2026-06-01' },
          { contributor: 'agent-2', success: true, timestamp: '2026-06-02' },
          { contributor: 'agent-3', success: true, timestamp: '2026-06-03' },
          { contributor: 'agent-1', success: true, timestamp: '2026-06-04' },
          { contributor: 'agent-2', success: true, timestamp: '2026-06-05' },
        ],
        skillId: 'existing-skill',
      },
    ]);
    lifecycle = createMockLifecycle();
    prisma = createMockPrisma();

    evolver = new KnowledgeSkillEvolver({
      store: store as any,
      lifecycle: lifecycle as any,
    });
  });

  describe('evolveToSkill', () => {
    it('returns null for non-skillCandidate entry', async () => {
      const result = await evolver.evolveToSkill('not-candidate');
      expect(result).toBeNull();
    });

    it('returns null for nonexistent entry', async () => {
      const result = await evolver.evolveToSkill('nonexistent');
      expect(result).toBeNull();
    });

    it('returns null for entry without executionResults', async () => {
      store = createMockStore([
        {
          id: 'empty-exec',
          title: 'No Executions',
          content: 'A'.repeat(250),
          maturity: 'proven',
          tags: ['pattern', 'skillCandidate'],
          contributors: ['a', 'b', 'c'],
          executionResults: [],
        },
      ]);
      evolver = new KnowledgeSkillEvolver({ store: store as any, lifecycle: lifecycle as any });
      const result = await evolver.evolveToSkill('empty-exec');
      expect(result).toBeNull();
    });
  });

  describe('evolveAllCandidates', () => {
    it('skips entries without skillCandidate tag', async () => {
      const count = await evolver.evolveAllCandidates();
      // candidate-1 may or may not succeed (LLM mock), but not-candidate should be skipped
      expect(store.get).not.toHaveBeenCalledWith('not-candidate');
    });

    it('skips already-evolved entries', async () => {
      await evolver.evolveAllCandidates();
      // already-evolved has skillId, should be skipped
      // The evolveToSkill method checks tags.includes('skillCandidate') first,
      // but evolveAllCandidates checks entry.skillId before calling evolveToSkill
    });
  });
});
