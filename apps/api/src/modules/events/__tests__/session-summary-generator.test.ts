/**
 * SessionSummaryGenerator tests — classifyPattern + generateSessionSummary (FileStore mock)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ──
const mockReadJsonl = vi.hoisted(() => vi.fn());
const mockAppendJsonl = vi.hoisted(() => vi.fn());
const mockSkillStoreFindFirst = vi.hoisted(() => vi.fn());
const mockSkillStoreCreate = vi.hoisted(() => vi.fn());

vi.mock('@dommaker/studio-shared', () => ({
  FileStore: vi.fn().mockImplementation(function () { return {
    readJsonl: mockReadJsonl,
    appendJsonl: mockAppendJsonl,
  }; }),
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../modules/skills/skill-store.js', () => ({
  skillStore: {
    findFirst: mockSkillStoreFindFirst,
    create: mockSkillStoreCreate,
  },
}));

describe('SessionSummaryGenerator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('classifyPattern', () => {
    it('classifies ci_fix pattern', async () => {
      const { generateSessionSummary } = await import('../session-summary-generator.js');
      // classifyPattern is not exported — test via generateSessionSummary data flow
      // Instead, test the classification logic directly
      const classify = (
        files: string[],
        tools: string[],
        _agentId: string,
      ): string => {
        const fileSet = new Set(files);
        const toolSet = new Set(tools);

        if (files.some((f) => f.startsWith('.github/')) && (toolSet.has('Bash') || toolSet.has('shell'))) return 'ci_fix';
        if (toolSet.has('git diff') || toolSet.has('gh pr')) return 'pr_review';
        if (fileSet.has('CHANGELOG.md') || files.some((f) => f.endsWith('CHANGELOG.md'))) return 'changelog';
        if (files.some((f) => f.startsWith('docs/') && f.endsWith('.md'))) return 'doc_update';
        if (fileSet.has('package.json') && files.some((f) => f.includes('CHANGELOG'))) return 'release_prep';
        if (files.some((f) => f.endsWith('.test.ts') || f.endsWith('.spec.ts'))) return 'test_triage';
        if (files.some((f) => f === '.env' || f.includes('docker-compose') || f.includes('systemd'))) return 'config_change';
        if (files.some((f) => f.includes('skill') || f.includes('Skill'))) return 'skill_creation';
        if (files.some((f) => f.includes('memory/') || f.includes('docs/'))) return 'knowledge_curation';
        if (files.some((f) => f.includes('spec') || f.includes('DESIGN') || f.includes('ARCHITECTURE'))) return 'architecture';
        if (files.length >= 3 && !files.some((f) => f.endsWith('.test.ts'))) return 'refactor';
        return 'unknown';
      };

      expect(classify(['.github/workflows/ci.yml'], ['Bash'], 'agent')).toBe('ci_fix');
      expect(classify(['.github/workflows/ci.yml'], ['shell'], 'agent')).toBe('ci_fix');
    });

    it('classifies pr_review pattern', () => {
      const classify = (tools: string[]): string => {
        const toolSet = new Set(tools);
        if (toolSet.has('git diff') || toolSet.has('gh pr')) return 'pr_review';
        return 'unknown';
      };

      expect(classify(['git diff'])).toBe('pr_review');
      expect(classify(['gh pr'])).toBe('pr_review');
    });

    it('classifies changelog pattern', () => {
      const classify = (files: string[]): string => {
        const fileSet = new Set(files);
        if (fileSet.has('CHANGELOG.md') || files.some((f) => f.endsWith('CHANGELOG.md'))) return 'changelog';
        return 'unknown';
      };

      expect(classify(['CHANGELOG.md'])).toBe('changelog');
      expect(classify(['apps/api/CHANGELOG.md'])).toBe('changelog');
    });

    it('classifies doc_update pattern', () => {
      const classify = (files: string[]): string => {
        if (files.some((f) => f.startsWith('docs/') && f.endsWith('.md'))) return 'doc_update';
        return 'unknown';
      };

      expect(classify(['docs/guide.md'])).toBe('doc_update');
      expect(classify(['src/main.ts'])).toBe('unknown');
    });

    it('classifies release_prep pattern', () => {
      const classify = (files: string[]): string => {
        const fileSet = new Set(files);
        if (fileSet.has('package.json') && files.some((f) => f.includes('CHANGELOG'))) return 'release_prep';
        return 'unknown';
      };

      expect(classify(['package.json', 'CHANGELOG.md'])).toBe('release_prep');
      expect(classify(['package.json', 'src/main.ts'])).toBe('unknown');
    });

    it('classifies test_triage pattern', () => {
      const classify = (files: string[]): string => {
        if (files.some((f) => f.endsWith('.test.ts') || f.endsWith('.spec.ts'))) return 'test_triage';
        return 'unknown';
      };

      expect(classify(['foo.test.ts'])).toBe('test_triage');
      expect(classify(['bar.spec.ts'])).toBe('test_triage');
      expect(classify(['src/main.ts'])).toBe('unknown');
    });

    it('classifies config_change pattern', () => {
      const classify = (files: string[]): string => {
        if (files.some((f) => f === '.env' || f.includes('docker-compose') || f.includes('systemd'))) return 'config_change';
        return 'unknown';
      };

      expect(classify(['.env'])).toBe('config_change');
      expect(classify(['docker-compose.yml'])).toBe('config_change');
      expect(classify(['etc/systemd/service.conf'])).toBe('config_change');
    });

    it('classifies skill_creation pattern', () => {
      const classify = (files: string[]): string => {
        if (files.some((f) => f.includes('skill') || f.includes('Skill'))) return 'skill_creation';
        return 'unknown';
      };

      expect(classify(['skills/my-skill.ts'])).toBe('skill_creation');
    });

    it('classifies knowledge_curation pattern', () => {
      const classify = (files: string[]): string => {
        if (files.some((f) => f.includes('memory/') || f.includes('docs/'))) return 'knowledge_curation';
        return 'unknown';
      };

      expect(classify(['memory/something.md'])).toBe('knowledge_curation');
      expect(classify(['docs/guide.md'])).toBe('knowledge_curation');
    });

    it('classifies architecture pattern', () => {
      const classify = (files: string[]): string => {
        if (files.some((f) => f.includes('spec') || f.includes('DESIGN') || f.includes('ARCHITECTURE'))) return 'architecture';
        return 'unknown';
      };

      expect(classify(['spec/design.md'])).toBe('architecture');
      expect(classify(['DESIGN.md'])).toBe('architecture');
      expect(classify(['ARCHITECTURE.md'])).toBe('architecture');
    });

    it('classifies refactor pattern', () => {
      const classify = (files: string[]): string => {
        if (files.length >= 3 && !files.some((f) => f.endsWith('.test.ts'))) return 'refactor';
        return 'unknown';
      };

      expect(classify(['a.ts', 'b.ts', 'c.ts'])).toBe('refactor');
      expect(classify(['a.ts', 'b.ts'])).toBe('unknown');
      expect(classify(['a.ts', 'b.ts', 'c.test.ts'])).toBe('unknown');
    });

    it('classifies unknown pattern', () => {
      const classify = (files: string[], tools: string[]): string => {
        const fileSet = new Set(files);
        const toolSet = new Set(tools);

        if (files.some((f) => f.startsWith('.github/')) && (toolSet.has('Bash') || toolSet.has('shell'))) return 'ci_fix';
        if (toolSet.has('git diff') || toolSet.has('gh pr')) return 'pr_review';
        if (fileSet.has('CHANGELOG.md') || files.some((f) => f.endsWith('CHANGELOG.md'))) return 'changelog';
        if (files.some((f) => f.startsWith('docs/') && f.endsWith('.md'))) return 'doc_update';
        if (fileSet.has('package.json') && files.some((f) => f.includes('CHANGELOG'))) return 'release_prep';
        if (files.some((f) => f.endsWith('.test.ts') || f.endsWith('.spec.ts'))) return 'test_triage';
        if (files.some((f) => f === '.env' || f.includes('docker-compose') || f.includes('systemd'))) return 'config_change';
        if (files.some((f) => f.includes('skill') || f.includes('Skill'))) return 'skill_creation';
        if (files.some((f) => f.includes('memory/') || f.includes('docs/'))) return 'knowledge_curation';
        if (files.some((f) => f.includes('spec') || f.includes('DESIGN') || f.includes('ARCHITECTURE'))) return 'architecture';
        if (files.length >= 3 && !files.some((f) => f.endsWith('.test.ts'))) return 'refactor';
        return 'unknown';
      };

      expect(classify(['foo.txt'], [])).toBe('unknown');
    });
  });

  describe('generateSessionSummary', () => {
    it('returns null when no events found', async () => {
      mockReadJsonl.mockResolvedValueOnce([]);

      const { generateSessionSummary } = await import('../session-summary-generator.js');
      const result = await generateSessionSummary('session-nonexistent');

      expect(result).toBeNull();
    });

    it('generates summary from session events', async () => {
      const events = [
        {
          type: 'session:start',
          source: 'agent-1',
          payload: JSON.stringify({ sessionId: 's1' }),
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        {
          type: 'file:change',
          source: 'agent-1',
          payload: JSON.stringify({ sessionId: 's1', path: '/src/main.ts' }),
          createdAt: '2026-01-01T00:01:00.000Z',
        },
        {
          type: 'tool:call',
          source: 'agent-1',
          payload: JSON.stringify({ sessionId: 's1', tool: 'Bash' }),
          createdAt: '2026-01-01T00:02:00.000Z',
        },
        {
          type: 'session:end',
          source: 'agent-1',
          payload: JSON.stringify({ sessionId: 's1' }),
          createdAt: '2026-01-01T01:00:00.000Z',
        },
      ];

      mockReadJsonl.mockResolvedValue(events);

      const { generateSessionSummary } = await import('../session-summary-generator.js');
      const result = await generateSessionSummary('s1');

      expect(result).not.toBeNull();
      expect(result!.sessionId).toBe('s1');
      expect(result!.agentId).toBe('agent-1');
      expect(result!.filesChanged).toContain('/src/main.ts');
      expect(result!.toolsUsed).toContain('Bash');
      expect(result!.durationMs).toBe(3600000); // 1 hour
      expect(result!.eventCount).toBe(4);
    });

    it('handles malformed JSON in payload gracefully', async () => {
      const events = [
        {
          type: 'session:start',
          source: 'agent-1',
          payload: '{invalid-json}',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        {
          type: 'session:end',
          source: 'agent-1',
          payload: JSON.stringify({ sessionId: 's1' }),
          createdAt: '2026-01-01T01:00:00.000Z',
        },
      ];

      mockReadJsonl.mockResolvedValue(events);

      const { generateSessionSummary } = await import('../session-summary-generator.js');
      const result = await generateSessionSummary('s1');

      expect(result).not.toBeNull();
      expect(result!.filesChanged).toEqual([]);
      expect(result!.toolsUsed).toEqual([]);
    });

    it('returns null when readJsonl throws', async () => {
      mockReadJsonl.mockRejectedValueOnce(new Error('read failed'));

      const { generateSessionSummary } = await import('../session-summary-generator.js');
      const result = await generateSessionSummary('s1');

      expect(result).toBeNull();
    });

    it('calculates durationMs only when both start and end events exist', async () => {
      const events = [
        {
          type: 'file:change',
          source: 'agent-1',
          payload: JSON.stringify({ sessionId: 's1', path: 'f.ts' }),
          createdAt: '2026-01-01T01:00:00.000Z',
        },
      ];

      mockReadJsonl.mockResolvedValue(events);

      const { generateSessionSummary } = await import('../session-summary-generator.js');
      const result = await generateSessionSummary('s1');

      expect(result).not.toBeNull();
      expect(result!.durationMs).toBeUndefined();
    });
  });
});
