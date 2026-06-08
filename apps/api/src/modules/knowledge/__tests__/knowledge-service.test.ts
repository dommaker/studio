/**
 * KnowledgeService — Phase 1A behavior tests (Produce + Consume)
 *
 * Tests verify KnowledgeService methods produce same behavior as originals:
 * - recordPattern/Incident/Trend: ingest with quality gate + dedup
 * - search: keyword scoring + ranking
 * - injectContext: rule + context + signal assembly
 * - matchResolutions: Prisma delegation
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { KnowledgeService } from '../knowledge-service.js';
import type { PatternEntry, IncidentEntry, TrendEntry } from '../knowledge-service.js';

// ── Mock factories ──

function createMockStore(initialEntries: any[] = []) {
  const entries = [...initialEntries];
  return {
    list: vi.fn(() => entries),
    get: vi.fn((id: string) => entries.find(e => e.id === id) || null),
    save: vi.fn((entry: any) => { entries.push(entry); return entry; }),
    update: vi.fn(),
    delete: vi.fn(),
    _entries: entries, // expose for test setup
  };
}

function createMockLifecycle() {
  return {
    recordReference: vi.fn(),
    shouldAutoPromote: vi.fn(() => false),
  };
}

function createMockIngest() {
  return {
    ingestEntry: vi.fn((entry: any, opts: any) => ({
      id: `ingested-${Date.now()}`,
      ...entry,
      ...opts,
      lastReferenced: new Date().toISOString(),
      contributors: ['test'],
    })),
  };
}

function createMockLinter() {
  return {
    validateEntry: vi.fn(() => []), // no issues
  };
}

function createMockPrisma() {
  return {
    resolution: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'res-1' }),
    },
    studioEvent: {
      create: vi.fn().mockResolvedValue({ id: 'event-1' }),
    },
    userPreference: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
    businessRule: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
    environmentSnapshot: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
  };
}

function createMockQuery() {
  return {
    queryEntries: vi.fn().mockResolvedValue([]),
    listEntries: vi.fn().mockResolvedValue([]),
    getIndexes: vi.fn().mockReturnValue([]),
    count: vi.fn().mockResolvedValue(0),
  };
}

function createMockEventEmitter() {
  return { emit: vi.fn() };
}

// ── Helper: create KnowledgeService with mocks ──

function createKS(opts?: { entries?: any[] }) {
  const store = createMockStore(opts?.entries);
  const lifecycle = createMockLifecycle();
  const ingest = createMockIngest();
  const linter = createMockLinter();
  const prisma = createMockPrisma();
  const query = createMockQuery();
  const eventEmitter = createMockEventEmitter();

  const ks = new KnowledgeService({
    store: store as any,
    lifecycle: lifecycle as any,
    ingest: ingest as any,
    linter: linter as any,
    prisma: prisma as any,
    query: query as any,
    eventEmitter: eventEmitter as any,
  });

  return { ks, store, lifecycle, ingest, linter, prisma, query, eventEmitter };
}

// ── Produce ──

describe('KnowledgeService Phase 1A: Produce', () => {
  describe('recordPattern', () => {
    it('ingests entry with correct type mapping', async () => {
      const { ks, ingest } = createKS();
      const entry: PatternEntry = {
        type: 'review',
        title: 'Test pattern',
        content: 'Some content here for quality check',
        tags: ['test'],
      };
      await ks.recordPattern(entry);
      expect(ingest.ingestEntry).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'guideline', title: 'Test pattern' }),
        expect.objectContaining({ source: expect.stringContaining('pattern:'), layer: 'project' }),
      );
    });

    it('rejects triage entry without root_cause', async () => {
      const { ks, ingest } = createKS();
      const entry: PatternEntry = {
        type: 'triage',
        title: 'Bad triage',
        content: 'no root cause here',
        tags: ['triage'],
      };
      await ks.recordPattern(entry);
      // Should NOT call ingest (rejected by triage quality gate)
      expect(ingest.ingestEntry).not.toHaveBeenCalled();
    });

    it('accepts triage entry with root_cause + fix_action', async () => {
      const { ks, ingest } = createKS();
      const entry: PatternEntry = {
        type: 'triage',
        title: 'Good triage',
        content: 'root_cause: X caused Y. fix_action: change Z.',
        tags: ['triage'],
      };
      await ks.recordPattern(entry);
      expect(ingest.ingestEntry).toHaveBeenCalled();
    });

    it('marks low_quality when linter finds blockers', async () => {
      const { ks, ingest, linter } = createKS();
      linter.validateEntry.mockReturnValue([{ severity: 'high', description: 'too short', type: 'quality' }]);
      const entry: PatternEntry = {
        type: 'review',
        title: 'Bad',
        content: 'x',
        tags: ['test'],
      };
      await ks.recordPattern(entry);
      expect(ingest.ingestEntry).toHaveBeenCalledWith(
        expect.objectContaining({ tags: expect.arrayContaining(['low_quality']) }),
        expect.anything(),
      );
    });

    it('does not throw on failure (best-effort)', async () => {
      const { ks, ingest } = createKS();
      ingest.ingestEntry.mockImplementation(() => { throw new Error('DB down'); });
      const entry: PatternEntry = { type: 'review', title: 'X', content: 'content here for quality', tags: [] };
      await expect(ks.recordPattern(entry)).resolves.not.toThrow();
    });
  });

  describe('recordIncident', () => {
    it('ingests as pitfall type with severity tags', async () => {
      const { ks, ingest } = createKS();
      const entry: IncidentEntry = {
        title: 'DB outage',
        content: 'Connection pool exhausted',
        severity: 'critical',
        tags: ['ops'],
      };
      await ks.recordIncident(entry);
      expect(ingest.ingestEntry).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'pitfall', tags: expect.arrayContaining(['incident', 'critical']) }),
        expect.objectContaining({ layer: 'tech', consumptionMode: 'signal' }),
      );
    });
  });

  describe('recordTrend', () => {
    it('ingests with trend tag', async () => {
      const { ks, ingest } = createKS();
      const entry: TrendEntry = {
        title: 'Build time increasing',
        content: 'Average build time up 20%',
        metric: 'build_time',
        tags: ['performance'],
      };
      await ks.recordTrend(entry);
      expect(ingest.ingestEntry).toHaveBeenCalledWith(
        expect.objectContaining({ tags: expect.arrayContaining(['trend']) }),
        expect.objectContaining({ source: expect.stringContaining('trend:') }),
      );
    });
  });
});

// ── Consume ──

describe('KnowledgeService Phase 1A: Consume', () => {
  describe('search', () => {
    it('returns empty for empty store', async () => {
      const { ks } = createKS();
      const results = await ks.search('test query');
      expect(results).toEqual([]);
    });

    it('returns entries matching keywords, sorted by score', async () => {
      const entries = [
        { id: '1', title: 'deploy timeout', content: 'deploy timeout caused by network', tags: ['pattern'], maturity: 'active', lastReferenced: new Date().toISOString() },
        { id: '2', title: 'test guide', content: 'how to write tests', tags: ['guideline'], maturity: 'active', lastReferenced: new Date().toISOString() },
        { id: '3', title: 'deploy fix', content: 'deploy timeout fix: increase timeout', tags: ['pitfall'], maturity: 'verified', lastReferenced: new Date().toISOString() },
      ];
      const { ks } = createKS({ entries });
      const results = await ks.search('deploy timeout', { limit: 5 });
      expect(results.length).toBeGreaterThan(0);
      // Pitfall (weight 3) should rank higher than pattern (weight 2) for same keywords
      expect(results[0].entry.id).toBe('3');
    });

    it('records references for returned entries', async () => {
      const entries = [
        { id: '1', title: 'test', content: 'test content here', tags: ['pattern'], maturity: 'active', lastReferenced: new Date().toISOString() },
      ];
      const { ks, lifecycle } = createKS({ entries });
      await ks.search('test');
      expect(lifecycle.recordReference).toHaveBeenCalledWith('1', 'search');
    });

    it('excludes archived entries', async () => {
      const entries = [
        { id: '1', title: 'old', content: 'archived content', tags: ['pattern'], maturity: 'archived', lastReferenced: new Date().toISOString() },
        { id: '2', title: 'new', content: 'active content', tags: ['pattern'], maturity: 'active', lastReferenced: new Date().toISOString() },
      ];
      const { ks } = createKS({ entries });
      const results = await ks.search('content', { limit: 5 });
      expect(results.every(r => r.entry.id !== '1')).toBe(true);
    });

    it('penalizes low_quality entries', async () => {
      const entries = [
        { id: '1', title: 'good', content: 'good deploy info', tags: ['pattern'], maturity: 'active', lastReferenced: new Date().toISOString() },
        { id: '2', title: 'bad', content: 'deploy info low quality', tags: ['pattern', 'low_quality'], maturity: 'active', lastReferenced: new Date().toISOString() },
      ];
      const { ks } = createKS({ entries });
      const results = await ks.search('deploy', { limit: 5 });
      expect(results[0].entry.id).toBe('1'); // good ranks higher
    });
  });

  describe('injectContext', () => {
    it('returns empty string when no knowledge exists', async () => {
      const { ks } = createKS();
      const result = await ks.injectContext('executor');
      expect(result).toBe('');
    });

    it('includes rules section when rules exist', async () => {
      const { ks, query } = createKS();
      query.queryEntries.mockResolvedValueOnce([
        { id: 'r1', content: 'Always use TypeScript', type: 'guideline' },
      ]);
      const result = await ks.injectContext('executor');
      expect(result).toContain('## 系统约束');
      expect(result).toContain('Always use TypeScript');
    });

    it('includes context section', async () => {
      const { ks, query } = createKS();
      // First call = rules (empty), second = context
      query.queryEntries
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 'c1', content: 'Use ESM imports', type: 'model' }]);
      const result = await ks.injectContext('executor');
      expect(result).toContain('## 上下文');
      expect(result).toContain('Use ESM imports');
    });

    it('records references for injected entries', async () => {
      const { ks, query, lifecycle } = createKS();
      query.queryEntries.mockResolvedValueOnce([{ id: 'r1', content: 'Rule 1', type: 'guideline' }]);
      await ks.injectContext('executor');
      expect(lifecycle.recordReference).toHaveBeenCalledWith('r1', 'prompt-inject');
    });
  });

  describe('matchResolutions', () => {
    it('returns empty resolutions when no match', async () => {
      const { ks } = createKS();
      const result = await ks.matchResolutions('unknown problem');
      expect(result.matched).toBe(false);
      expect(result.resolutions).toEqual([]);
    });

    it('matches resolutions via Prisma', async () => {
      const { ks, prisma } = createKS();
      prisma.resolution.findMany.mockResolvedValueOnce([
        { id: 'r1', problem: 'permission error', fix: 'check perms', status: 'verified', pattern: 'permission', verifyCount: 3, errorClass: 'perm', layer: 'L5_error_fix', title: 'Permission fix', tags: '[]', createdAt: new Date(), updatedAt: new Date() },
      ]);
      const result = await ks.matchResolutions('permission denied on file');
      expect(result.resolutions.length).toBe(1);
      expect(prisma.resolution.findMany).toHaveBeenCalled();
    });
  });
});

// ── Phase 1B: Track + Lifecycle + Resolve ──

describe('KnowledgeService Phase 1B: Track', () => {
  describe('recordConsumption', () => {
    it('calls lifecycle.recordReference for each entry', () => {
      const { ks, lifecycle } = createKS();
      ks.recordConsumption(['id1', 'id2', 'id3'], 'search');
      expect(lifecycle.recordReference).toHaveBeenCalledTimes(3);
      expect(lifecycle.recordReference).toHaveBeenCalledWith('id1', 'search');
      expect(lifecycle.recordReference).toHaveBeenCalledWith('id2', 'search');
      expect(lifecycle.recordReference).toHaveBeenCalledWith('id3', 'search');
    });

    it('continues on individual failures', () => {
      const { ks, lifecycle } = createKS();
      lifecycle.recordReference
        .mockImplementationOnce(() => { throw new Error('fail'); })
        .mockImplementationOnce(() => {});
      expect(() => ks.recordConsumption(['id1', 'id2'], 'ctx')).not.toThrow();
      expect(lifecycle.recordReference).toHaveBeenCalledTimes(2);
    });
  });
});

describe('KnowledgeService Phase 1B: Lifecycle', () => {
  describe('promote', () => {
    it('promotes draft → verified', async () => {
      const entries = [
        { id: 'e1', title: 'Test', content: 'A'.repeat(60), tags: ['pattern'], maturity: 'draft', lastReferenced: new Date().toISOString() },
      ];
      const { ks, store } = createKS({ entries });
      store.update = vi.fn().mockReturnValue(entries[0]);
      await ks.promote('e1');
      expect(store.update).toHaveBeenCalledWith('e1', expect.objectContaining({ maturity: 'verified' }));
    });

    it('promotes verified → proven', async () => {
      const entries = [
        { id: 'e1', title: 'Test', content: 'A'.repeat(120), tags: ['pattern'], maturity: 'verified', lastReferenced: new Date().toISOString() },
      ];
      const { ks, store } = createKS({ entries });
      store.update = vi.fn().mockReturnValue(entries[0]);
      await ks.promote('e1');
      expect(store.update).toHaveBeenCalledWith('e1', expect.objectContaining({ maturity: 'proven' }));
    });

    it('does not promote if entry not found', async () => {
      const { ks, store } = createKS();
      store.update = vi.fn();
      await ks.promote('nonexistent');
      expect(store.update).not.toHaveBeenCalled();
    });
  });

  describe('decay', () => {
    it('decays proven → verified when stale', async () => {
      const staleDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(); // 1 year ago
      const entries = [
        { id: 'e1', title: 'Old', content: 'content', tags: ['pattern'], maturity: 'proven', lastReferenced: staleDate },
      ];
      const { ks, store } = createKS({ entries });
      store.update = vi.fn().mockReturnValue(entries[0]);
      await ks.decay('e1');
      expect(store.update).toHaveBeenCalledWith('e1', expect.objectContaining({ maturity: 'verified' }));
    });

    it('does not decay recent entries', async () => {
      const entries = [
        { id: 'e1', title: 'Fresh', content: 'content', tags: ['pattern'], maturity: 'proven', lastReferenced: new Date().toISOString() },
      ];
      const { ks, store } = createKS({ entries });
      store.update = vi.fn();
      await ks.decay('e1');
      expect(store.update).not.toHaveBeenCalled();
    });
  });

  describe('merge', () => {
    it('merges source into target and deletes source', async () => {
      const entries = [
        { id: 'src', title: 'Source', content: 'source content', tags: ['pattern'], maturity: 'draft' },
        { id: 'tgt', title: 'Target', content: 'target content', tags: ['pattern'], maturity: 'verified' },
      ];
      const { ks, store } = createKS({ entries });
      store.delete = vi.fn().mockResolvedValue(undefined);
      await ks.merge('src', 'tgt');
      expect(store.save).toHaveBeenCalled();
      expect(store.delete).toHaveBeenCalledWith('src');
    });
  });
});

describe('KnowledgeService Phase 1B: Resolve', () => {
  describe('createResolution', () => {
    it('creates resolution via Prisma', async () => {
      const { ks, prisma } = createKS();
      await ks.createResolution({ pattern: 'permission error', fix: 'check file perms', errorClass: 'perm', layer: 'L5_error_fix', title: 'Permission fix' });
      expect(prisma.resolution.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          pattern: 'permission error',
          fix: 'check file perms',
          status: 'pending',
        }),
      });
    });

    it('skips if duplicate pattern exists', async () => {
      const { ks, prisma } = createKS();
      prisma.resolution.findFirst.mockResolvedValueOnce({ id: 'existing' });
      await ks.createResolution({ pattern: 'permission error', fix: 'check file perms', errorClass: 'perm', layer: 'L5_error_fix', title: 'Permission fix' });
      expect(prisma.resolution.create).not.toHaveBeenCalled();
    });
  });
});

// ── Phase 1C: Measure + Extract ──

describe('KnowledgeService Phase 1C: Measure', () => {
  describe('getFlywheelMetrics', () => {
    it('returns metrics with correct shape', async () => {
      const entries = [
        { id: '1', title: 'A', content: 'x', tags: ['pattern'], maturity: 'proven', lastReferenced: new Date().toISOString() },
        { id: '2', title: 'B', content: 'y', tags: ['guideline'], maturity: 'draft', lastReferenced: new Date().toISOString() },
      ];
      const { ks } = createKS({ entries });
      const m = await ks.getFlywheelMetrics();
      expect(m).toHaveProperty('quality');
      expect(m).toHaveProperty('hitRate');
      expect(m).toHaveProperty('improvement');
      expect(m).toHaveProperty('freshness');
      expect(m).toHaveProperty('timestamp');
      expect(typeof m.quality).toBe('number');
    });

    it('calculates quality based on maturity distribution', async () => {
      const entries = [
        { id: '1', title: 'A', content: 'x', tags: ['pattern'], maturity: 'proven', lastReferenced: new Date().toISOString() },
        { id: '2', title: 'B', content: 'y', tags: ['pattern'], maturity: 'proven', lastReferenced: new Date().toISOString() },
      ];
      const { ks } = createKS({ entries });
      const m = await ks.getFlywheelMetrics();
      expect(m.quality).toBeGreaterThan(0);
    });
  });

  describe('getHealthReport', () => {
    it('returns health report with correct shape', async () => {
      const entries = [
        { id: '1', title: 'A', content: 'x', tags: ['pattern'], maturity: 'active', lastReferenced: new Date().toISOString() },
      ];
      const { ks } = createKS({ entries });
      const r = await ks.getHealthReport();
      expect(r).toHaveProperty('score');
      expect(r).toHaveProperty('totalEntries');
      expect(r).toHaveProperty('staleEntries');
      expect(r).toHaveProperty('timestamp');
      expect(r.totalEntries).toBe(1);
    });

    it('counts stale entries', async () => {
      const staleDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
      const entries = [
        { id: '1', title: 'Fresh', content: 'x', tags: ['pattern'], maturity: 'active', lastReferenced: new Date().toISOString() },
        { id: '2', title: 'Stale', content: 'y', tags: ['pattern'], maturity: 'active', lastReferenced: staleDate },
      ];
      const { ks } = createKS({ entries });
      const r = await ks.getHealthReport();
      expect(r.staleEntries).toBeGreaterThanOrEqual(1);
    });
  });

  describe('getAuditReport', () => {
    it('returns audit report with correct shape', async () => {
      const { ks } = createKS();
      const r = await ks.getAuditReport();
      expect(r).toHaveProperty('findings');
      expect(r).toHaveProperty('trend');
      expect(r).toHaveProperty('timestamp');
      expect(Array.isArray(r.findings)).toBe(true);
    });
  });

  describe('getAnalystAccuracy', () => {
    it('returns accuracy report with correct shape', async () => {
      const { ks } = createKS();
      const r = await ks.getAnalystAccuracy();
      expect(r).toHaveProperty('overallAccuracy');
      expect(r).toHaveProperty('byAnalyst');
      expect(r).toHaveProperty('recentPredictions');
      expect(r).toHaveProperty('timestamp');
    });
  });
});

describe('KnowledgeService Phase 1C: Extract', () => {
  describe('extractFromExecution', () => {
    it('does not throw for valid input', async () => {
      const { ks } = createKS();
      await expect(ks.extractFromExecution({
        task: 'Fix auth bug',
        diff: '+fixed auth',
        success: true,
        duration: 1000,
        agentType: 'executor',
        consumedKnowledge: [],
      })).resolves.not.toThrow();
    });
  });
});

// ── Phase 3: Feedback loop behavior tests ──

describe('KnowledgeService Phase 3: Feedback loop behavior', () => {
  describe('pipelineStepFeedback', () => {
    it('creates StudioEvent with correct type pattern (success)', async () => {
      const { ks, prisma } = createKS();
      await ks.pipelineStepFeedback({
        goalId: 'goal-1',
        executionId: 'exec-1',
        phase: 'executor',
        success: true,
        durationMs: 5000,
        tokensUsed: 1000,
      });
      expect(prisma.studioEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: 'knowledge:pipeline:executor:success',
            source: 'pipeline',
          }),
        }),
      );
    });

    it('creates StudioEvent with correct type pattern (failure)', async () => {
      const { ks, prisma } = createKS();
      await ks.pipelineStepFeedback({
        goalId: 'goal-1',
        executionId: 'exec-1',
        phase: 'executor',
        success: false,
        durationMs: 5000,
        error: 'Agent failed',
      });
      expect(prisma.studioEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: 'knowledge:pipeline:executor:failure',
          }),
        }),
      );
    });

    it('emits knowledge event on eventEmitter', async () => {
      const { ks, eventEmitter } = createKS();
      await ks.pipelineStepFeedback({
        goalId: 'goal-1',
        executionId: 'exec-1',
        phase: 'executor',
        success: true,
        durationMs: 5000,
      });
      expect(eventEmitter.emit).toHaveBeenCalledWith('knowledge',
        expect.objectContaining({ type: 'pipelineStepFeedback' }),
      );
    });

    it('non-blocking: does not throw when prisma fails', async () => {
      const { ks, prisma } = createKS();
      (prisma.studioEvent.create as any).mockRejectedValueOnce(new Error('DB down'));
      await expect(ks.pipelineStepFeedback({
        goalId: 'goal-1',
        executionId: 'exec-1',
        phase: 'executor',
        success: true,
        durationMs: 5000,
      })).resolves.not.toThrow();
    });
  });

  describe('extractFromExecution', () => {
    it('calls recordPattern with execution data', async () => {
      const { ks, ingest } = createKS();
      await ks.extractFromExecution({
        task: 'Fix auth bug',
        diff: '+fixed auth',
        success: true,
        duration: 1000,
        agentType: 'executor',
        consumedKnowledge: [],
      });
      // recordPattern calls ingest.ingestEntry
      expect(ingest.ingestEntry).toHaveBeenCalled();
    });

    it('emits knowledge event on success', async () => {
      const { ks, eventEmitter } = createKS();
      await ks.extractFromExecution({
        task: 'Fix auth bug',
        diff: '+fixed auth',
        success: true,
        duration: 1000,
        agentType: 'executor',
        consumedKnowledge: [],
      });
      expect(eventEmitter.emit).toHaveBeenCalledWith('knowledge',
        expect.objectContaining({ type: 'extractFromExecution' }),
      );
    });

    it('skips when no diff and no task', async () => {
      const { ks, prisma } = createKS();
      await ks.extractFromExecution({
        task: '',
        diff: '',
        success: true,
        duration: 1000,
        agentType: 'executor',
        consumedKnowledge: [],
      });
      // Should not create any events
      expect(prisma.studioEvent.create).not.toHaveBeenCalled();
    });

    it('records consumption for consumed knowledge entries', async () => {
      const { ks, lifecycle } = createKS();
      await ks.extractFromExecution({
        task: 'Fix auth bug',
        diff: '+fixed auth',
        success: true,
        duration: 1000,
        agentType: 'executor',
        consumedKnowledge: ['entry-1', 'entry-2'],
      });
      expect(lifecycle.recordReference).toHaveBeenCalledTimes(2);
      expect(lifecycle.recordReference).toHaveBeenCalledWith('entry-1', 'execution:executor');
    });
  });

  describe('recordOutcome', () => {
    it('creates StudioEvent with success type', async () => {
      const { ks, prisma } = createKS();
      await ks.recordOutcome({
        executionId: 'exec-1',
        agentType: 'executor',
        consumedKnowledge: [],
        success: true,
        details: 'Goal succeeded',
        timestamp: new Date().toISOString(),
        mode: 'pipeline',
      });
      expect(prisma.studioEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: 'knowledge:outcome:success',
            source: 'executor',
          }),
        }),
      );
    });

    it('creates StudioEvent with failure type', async () => {
      const { ks, prisma } = createKS();
      await ks.recordOutcome({
        executionId: 'exec-1',
        agentType: 'executor',
        consumedKnowledge: [],
        success: false,
        details: 'Goal failed',
        timestamp: new Date().toISOString(),
        mode: 'pipeline',
      });
      expect(prisma.studioEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: 'knowledge:outcome:failure',
          }),
        }),
      );
    });

    it('updates referencedBy for consumed entries', async () => {
      const entry = { id: 'entry-1', referencedBy: [] };
      const { ks, store } = createKS({ entries: [entry] });
      await ks.recordOutcome({
        executionId: 'exec-1',
        agentType: 'executor',
        consumedKnowledge: ['entry-1'],
        success: true,
        details: 'ok',
        timestamp: new Date().toISOString(),
      });
      expect(store.get).toHaveBeenCalledWith('entry-1');
      expect(entry.referencedBy).toContain('exec-1');
      expect(store.save).toHaveBeenCalledWith(entry);
    });

    it('emits knowledge event', async () => {
      const { ks, eventEmitter } = createKS();
      await ks.recordOutcome({
        executionId: 'exec-1',
        agentType: 'executor',
        consumedKnowledge: [],
        success: true,
        details: 'ok',
        timestamp: new Date().toISOString(),
      });
      expect(eventEmitter.emit).toHaveBeenCalledWith('knowledge',
        expect.objectContaining({ type: 'recordOutcome' }),
      );
    });

    it('non-blocking: does not throw when prisma fails', async () => {
      const { ks, prisma } = createKS();
      (prisma.studioEvent.create as any).mockRejectedValueOnce(new Error('DB down'));
      await expect(ks.recordOutcome({
        executionId: 'exec-1',
        agentType: 'executor',
        consumedKnowledge: [],
        success: true,
        details: 'ok',
        timestamp: new Date().toISOString(),
      })).resolves.not.toThrow();
    });
  });
});

// ── Phase 0: Contract verification ──

describe('KnowledgeService Phase 0: contract', () => {
  const { ks } = createKS();

  describe('Produce (6 methods)', () => {
    it('extractFromExecution exists', () => expect(typeof ks.extractFromExecution).toBe('function'));
    it('extractFromConversation exists', () => expect(typeof ks.extractFromConversation).toBe('function'));
    it('recordPattern exists', () => expect(typeof ks.recordPattern).toBe('function'));
    it('recordIncident exists', () => expect(typeof ks.recordIncident).toBe('function'));
    it('recordTrend exists', () => expect(typeof ks.recordTrend).toBe('function'));
    it('recordAnalystAccuracy exists', () => expect(typeof ks.recordAnalystAccuracy).toBe('function'));
  });

  describe('Consume (5 methods)', () => {
    it('injectContext exists', () => expect(typeof ks.injectContext).toBe('function'));
    it('search exists', () => expect(typeof ks.search).toBe('function'));
    it('matchResolutions exists', () => expect(typeof ks.matchResolutions).toBe('function'));
    it('list exists', () => expect(typeof ks.list).toBe('function'));
    it('get exists', () => expect(typeof ks.get).toBe('function'));
  });

  describe('Track (4 methods)', () => {
    it('recordConsumption exists', () => expect(typeof ks.recordConsumption).toBe('function'));
    it('recordOutcome exists', () => expect(typeof ks.recordOutcome).toBe('function'));
    it('recordFeedback exists', () => expect(typeof ks.recordFeedback).toBe('function'));
    it('pipelineStepFeedback exists', () => expect(typeof ks.pipelineStepFeedback).toBe('function'));
  });

  describe('Lifecycle (4 methods)', () => {
    it('promote exists', () => expect(typeof ks.promote).toBe('function'));
    it('decay exists', () => expect(typeof ks.decay).toBe('function'));
    it('merge exists', () => expect(typeof ks.merge).toBe('function'));
    it('graduateConstraint exists', () => expect(typeof ks.graduateConstraint).toBe('function'));
  });

  describe('Resolve (2 methods)', () => {
    it('createResolution exists', () => expect(typeof ks.createResolution).toBe('function'));
    it('verifyResolution exists', () => expect(typeof ks.verifyResolution).toBe('function'));
  });

  describe('Measure (5 methods)', () => {
    it('getFlywheelMetrics exists', () => expect(typeof ks.getFlywheelMetrics).toBe('function'));
    it('getHealthReport exists', () => expect(typeof ks.getHealthReport).toBe('function'));
    it('getAuditReport exists', () => expect(typeof ks.getAuditReport).toBe('function'));
    it('getAnalystAccuracy exists', () => expect(typeof ks.getAnalystAccuracy).toBe('function'));
    it('getStats exists', () => expect(typeof ks.getStats).toBe('function'));
  });

  describe('method count', () => {
    it('has exactly 29 public methods', () => {
      const methods = Object.getOwnPropertyNames(KnowledgeService.prototype)
        .filter(m => m !== 'constructor');
      expect(methods).toHaveLength(29);
    });
  });
});
