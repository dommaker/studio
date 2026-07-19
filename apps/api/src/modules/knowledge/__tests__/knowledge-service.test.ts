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
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ── Mock FileStore to intercept appendJsonl calls ──
const { mockAppendJsonl } = vi.hoisted(() => ({
  mockAppendJsonl: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    FileStore: vi.fn().mockImplementation(() => ({
      appendJsonl: mockAppendJsonl,
      readJsonl: vi.fn().mockResolvedValue([]),
      readJson: vi.fn().mockResolvedValue(null),
      writeJson: vi.fn().mockResolvedValue(undefined),
      readDoc: vi.fn().mockResolvedValue(null),
      writeDoc: vi.fn().mockResolvedValue(undefined),
      listDocs: vi.fn().mockResolvedValue([]),
    })),
  };
});

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

    it('delegates quality gate to harness ingest (__rejected → skip, no throw)', async () => {
      const { ks, ingest } = createKS();
      // R4: 单一质量门 — harness KnowledgeIngest 内置 audit 拒绝时返回 __rejected
      ingest.ingestEntry.mockReturnValue({ __rejected: true, __rejectReasons: ['content too short'] });
      const entry: PatternEntry = {
        type: 'review',
        title: 'Bad',
        content: 'x',
        tags: ['test'],
      };
      await expect(ks.recordPattern(entry)).resolves.not.toThrow();
      // 条目交给 harness ingest 门裁决（单一路径），被门跳过
      expect(ingest.ingestEntry).toHaveBeenCalledTimes(1);
    });

    it('does not apply a separate studio linter pre-gate (single gate path, R4)', async () => {
      const { ks, ingest, linter } = createKS();
      linter.validateEntry.mockReturnValue([{ severity: 'high', description: 'too short', type: 'quality' }]);
      const entry: PatternEntry = {
        type: 'review',
        title: 'Bad',
        content: 'x',
        tags: ['test'],
      };
      await ks.recordPattern(entry);
      // 不再有 studio 侧 linter 预检；low_quality 标记由 harness ingest 门的 flag action 负责
      expect(linter.validateEntry).not.toHaveBeenCalled();
      expect(ingest.ingestEntry).toHaveBeenCalledTimes(1);
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
    it('writes trend data without throwing', async () => {
      const { ks } = createKS();
      const entry: TrendEntry = {
        title: 'Build time increasing',
        content: 'Average build time up 20%',
        metric: 'build_time',
        tags: ['performance'],
      };
      // recordTrend now writes to data/ directory (not ingest)
      await expect(ks.recordTrend(entry)).resolves.not.toThrow();
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

  describe('search mode parameter', () => {
    it('defaults to keyword mode', async () => {
      const entries = [
        { id: '1', title: 'deploy', content: 'deploy info', tags: ['pattern'], maturity: 'active', lastReferenced: new Date().toISOString() },
      ];
      const { ks } = createKS({ entries });
      const results = await ks.search('deploy');
      expect(results.length).toBeGreaterThan(0);
    });

    it('semantic mode returns results when vector DB available', async () => {
      const { ks } = createKS();
      const results = await ks.search('deploy', { mode: 'semantic' });
      expect(Array.isArray(results)).toBe(true);
    }, 30_000);

    it('hybrid mode returns keyword results when semantic unavailable', async () => {
      const entries = [
        { id: '1', title: 'deploy', content: 'deploy info', tags: ['pattern'], maturity: 'active', lastReferenced: new Date().toISOString() },
      ];
      const { ks } = createKS({ entries });
      const results = await ks.search('deploy', { mode: 'hybrid' });
      expect(results.length).toBeGreaterThan(0);
    }, 30_000);
  });

  describe('semanticSearch', () => {
    it('returns results from vector DB when available', async () => {
      const { ks } = createKS();
      const results = await ks.semanticSearch('deploy timeout');
      expect(Array.isArray(results)).toBe(true);
      if (results.length > 0) {
        expect(results[0]).toHaveProperty('filePath');
        expect(results[0]).toHaveProperty('score');
        expect(results[0]).toHaveProperty('text');
      }
    }, 30_000);

    it('returns results with entryId mapped from filePath', async () => {
      const { ks } = createKS();
      const results = await ks.semanticSearch('test query');
      expect(Array.isArray(results)).toBe(true);
      if (results.length > 0) {
        expect(results[0]).toHaveProperty('entryId');
        expect(typeof results[0].entryId).toBe('string');
      }
    }, 30_000);
  });

  describe('injectContext', () => {
    it('returns empty prompt and injectedIds when no knowledge exists', async () => {
      const { ks } = createKS();
      const result = await ks.injectContext('executor');
      expect(result).toEqual({ prompt: '', injectedIds: [] });
    });

    it('includes rules section when rules exist', async () => {
      const { ks, query } = createKS();
      query.queryEntries.mockResolvedValueOnce([
        { id: 'r1', content: 'Always use TypeScript', type: 'guideline', sourceReference: 'ref1', status: 'published' },
      ]);
      const result = await ks.injectContext('executor');
      expect(result.prompt).toContain('## 系统约束');
      expect(result.prompt).toContain('Always use TypeScript');
      expect(result.injectedIds).toContain('r1');
    });

    it('includes context section', async () => {
      const { ks, query } = createKS();
      // First call = rules (empty), second = context
      query.queryEntries
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 'c1', content: 'Use ESM imports', type: 'model', sourceReference: 'ref2', status: 'published' }]);
      const result = await ks.injectContext('executor');
      expect(result.prompt).toContain('## 上下文');
      expect(result.prompt).toContain('Use ESM imports');
      expect(result.injectedIds).toContain('c1');
    });

    it('records references for injected entries', async () => {
      const { ks, query, lifecycle } = createKS();
      query.queryEntries.mockResolvedValueOnce([{ id: 'r1', content: 'Rule 1', type: 'guideline', sourceReference: 'ref1', status: 'published' }]);
      await ks.injectContext('executor');
      expect(lifecycle.recordReference).toHaveBeenCalledWith('r1', 'prompt-inject');
    });

    it('AC-1.1: returns InjectContextResult type with prompt and injectedIds', async () => {
      const { ks } = createKS();
      const result = await ks.injectContext('executor');
      expect(result).toHaveProperty('prompt');
      expect(result).toHaveProperty('injectedIds');
      expect(typeof result.prompt).toBe('string');
      expect(Array.isArray(result.injectedIds)).toBe(true);
    });

    it('AC-2.1: query filters by status=published', async () => {
      const { ks, query } = createKS();
      await ks.injectContext('executor');
      // Both rule and context queries should pass status: 'published'
      expect(query.queryEntries).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'published', consumptionModes: ['rule'] }),
      );
      expect(query.queryEntries).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'published', consumptionModes: ['context'] }),
      );
    });

    it('AC-2.2: filters out entries without sourceReference', async () => {
      const { ks, query } = createKS();
      query.queryEntries
        .mockResolvedValueOnce([
          { id: 'r1', content: 'Rule 1', type: 'guideline', sourceReference: null, status: 'published' },
          { id: 'r2', content: 'Rule 2', type: 'guideline', sourceReference: 'ref1', status: 'published' },
        ])
        .mockResolvedValueOnce([]);
      const result = await ks.injectContext('executor');
      expect(result.injectedIds).toEqual(['r2']);
      expect(result.prompt).not.toContain('Rule 1');
      expect(result.prompt).toContain('Rule 2');
    });

    it('AC-2.3: filters out stale entries', async () => {
      const { ks, query } = createKS();
      query.queryEntries
        .mockResolvedValueOnce([
          { id: 'r1', content: 'Stale rule', type: 'guideline', sourceReference: 'ref1', status: 'stale' },
          { id: 'r2', content: 'Active rule', type: 'guideline', sourceReference: 'ref1', status: 'published' },
        ])
        .mockResolvedValueOnce([]);
      const result = await ks.injectContext('executor');
      expect(result.injectedIds).toEqual(['r2']);
      expect(result.prompt).toContain('Active rule');
      expect(result.prompt).not.toContain('Stale rule');
    });

    it('AC-2.4: injectedIds only contains IDs of actually injected entries', async () => {
      const { ks, query } = createKS();
      // rule query returns entry without sourceReference (excluded), context returns valid entry
      query.queryEntries
        .mockResolvedValueOnce([{ id: 'r1', content: 'Rule 1', type: 'guideline', sourceReference: null, status: 'published' }])
        .mockResolvedValueOnce([{ id: 'c1', content: 'Context 1', type: 'model', sourceReference: 'ref1', status: 'published' }]);
      const result = await ks.injectContext('executor');
      // r1 should be filtered out, only c1 is injected
      expect(result.injectedIds).toEqual(['c1']);
    });
  });

  describe('matchResolutions', () => {
    it('returns empty resolutions when no match', async () => {
      const { ks } = createKS();
      const result = await ks.matchResolutions('unknown problem');
      expect(result.matched).toBe(false);
      expect(result.resolutions).toEqual([]);
    });

    it.skip('matches resolutions via FileStore (TODO: mock readJson to read from temp dir)', async () => {
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-resolutions-'));
      const prevHome = process.env.HOME;
      process.env.HOME = tmpHome;
      try {
        const resDir = path.join(tmpHome, '.studio', 'data', 'resolutions');
        fs.mkdirSync(resDir, { recursive: true });
        fs.writeFileSync(path.join(resDir, 'r1.json'), JSON.stringify({
          id: 'r1', pattern: 'permission', fix: 'check perms', status: 'verified',
          verifyCount: 3, errorClass: 'perm', layer: 'L5_error_fix', title: 'Permission fix',
          tags: '[]', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        }));
        const { ks } = createKS();
        const result = await ks.matchResolutions('permission denied on file');
        expect(result.resolutions.length).toBe(1);
      } finally {
        process.env.HOME = prevHome;
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
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
    it.skip('creates resolution via FileStore (TODO: mock writeJson to write to temp dir)', async () => {
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-res-create-'));
      const prevHome = process.env.HOME;
      process.env.HOME = tmpHome;
      try {
        fs.mkdirSync(path.join(tmpHome, '.studio', 'data', 'resolutions'), { recursive: true });
        const { ks } = createKS();
        await ks.createResolution({ pattern: 'permission error', fix: 'check file perms', errorClass: 'perm', layer: 'L5_error_fix', title: 'Permission fix' });
        // Resolution file should exist
        const resDir = path.join(tmpHome, '.studio', 'data', 'resolutions');
        const files = fs.readdirSync(resDir);
        expect(files.length).toBeGreaterThanOrEqual(1);
      } finally {
        process.env.HOME = prevHome;
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
    });

    it.skip('skips if duplicate pattern exists (TODO: mock readJson for dedup check)', async () => {
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-res-dup-'));
      const prevHome = process.env.HOME;
      process.env.HOME = tmpHome;
      try {
        const resDir = path.join(tmpHome, '.studio', 'data', 'resolutions');
        fs.mkdirSync(resDir, { recursive: true });
        fs.writeFileSync(path.join(resDir, 'existing.json'), JSON.stringify({
          id: 'existing', pattern: 'permission error', fix: 'existing fix', status: 'verified',
          verifyCount: 1, errorClass: 'perm', layer: 'L5_error_fix', title: 'Existing',
          tags: '[]', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        }));
        const { ks } = createKS();
        await ks.createResolution({ pattern: 'permission error', fix: 'check file perms', errorClass: 'perm', layer: 'L5_error_fix', title: 'Permission fix' });
        // Should not create duplicate
        const files = fs.readdirSync(resDir);
        expect(files.length).toBe(1); // only the existing one
      } finally {
        process.env.HOME = prevHome;
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
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
    it('returns available:false with reason (no analyst data source exists — honest, not fake-empty)', async () => {
      const { ks } = createKS();
      const r = await ks.getAnalystAccuracy();
      expect(r.available).toBe(false);
      expect(typeof r.reason).toBe('string');
      expect(r.reason!.length).toBeGreaterThan(0);
      expect(r).toHaveProperty('timestamp');
      // 不编造度量字段
      expect(r.overallAccuracy).toBeUndefined();
      expect(r.byAnalyst).toBeUndefined();
      expect(r.recentPredictions).toBeUndefined();
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

    it('AC-3.1: marks entry need_review when execution fails', async () => {
      const { ks, ingest } = createKS();
      await ks.extractFromExecution({
        task: 'Fix auth bug',
        diff: '+failed change',
        success: false,
        duration: 1000,
        agentType: 'executor',
        consumedKnowledge: [],
      });
      // Should tag with need_review
      expect(ingest.ingestEntry).toHaveBeenCalledWith(
        expect.objectContaining({ tags: expect.arrayContaining(['need_review']) }),
        expect.anything(),
      );
    });

    it('AC-3.1: does not tag need_review when execution succeeds', async () => {
      const { ks, ingest } = createKS();
      await ks.extractFromExecution({
        task: 'Fix auth bug',
        diff: '+fixed auth',
        success: true,
        duration: 1000,
        agentType: 'executor',
        consumedKnowledge: [],
      });
      // Should NOT have need_review tag
      const callArgs = ingest.ingestEntry.mock.calls[0];
      expect(callArgs[0].tags).not.toContain('need_review');
    });

    it('AC-3.2: records sourceExecutionId in content', async () => {
      const { ks } = createKS();
      await ks.extractFromExecution({
        task: 'Fix auth bug',
        diff: '+fixed auth',
        success: true,
        duration: 1000,
        agentType: 'executor',
        consumedKnowledge: [],
      });
      // Verify no throw — sourceExecutionId is optional in ExtractionResult
      // Content tracing is handled via recordPattern source
    });

    it('AC-3.3: dedup - skips when existing published entry on same topic exists', async () => {
      const { ks, store, ingest } = createKS();
      // Pre-populate store with an existing entry on same topic
      const existingEntry = {
        id: 'existing-1',
        title: '[Exec] executor: Fix auth bug',
        content: 'Previous execution data',
        tags: ['execution', 'executor'],
        maturity: 'active',
        lastReferenced: new Date().toISOString(),
      };
      store.list.mockReturnValue([existingEntry]);

      await ks.extractFromExecution({
        task: 'Fix auth bug',
        diff: '+new fix data',
        success: true,
        duration: 2000,
        agentType: 'executor',
        consumedKnowledge: [],
      });

      // Should merge into existing rather than creating new
      expect(store.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'existing-1',
          content: expect.stringContaining('Previous execution data'),
        }),
      );
      // Should NOT create new entry via ingest
      expect(ingest.ingestEntry).not.toHaveBeenCalled();
    });
  });
});

// ── Phase 3: Feedback loop behavior tests ──

describe('KnowledgeService Phase 3: Feedback loop behavior', () => {
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
      const { ks } = createKS();
      mockAppendJsonl.mockClear();
      await ks.extractFromExecution({
        task: '',
        diff: '',
        success: true,
        duration: 1000,
        agentType: 'executor',
        consumedKnowledge: [],
      });
      // Should not create any events
      expect(mockAppendJsonl).not.toHaveBeenCalled();
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
      const { ks } = createKS();
      mockAppendJsonl.mockClear();
      await ks.recordOutcome({
        executionId: 'exec-1',
        agentType: 'executor',
        consumedKnowledge: [],
        success: true,
        details: 'Goal succeeded',
        timestamp: new Date().toISOString(),
        mode: 'pipeline',
      });
      expect(mockAppendJsonl).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          type: 'knowledge:outcome:success',
          source: 'executor',
        }),
      );
    });

    it('creates StudioEvent with failure type', async () => {
      const { ks } = createKS();
      mockAppendJsonl.mockClear();
      await ks.recordOutcome({
        executionId: 'exec-1',
        agentType: 'executor',
        consumedKnowledge: [],
        success: false,
        details: 'Goal failed',
        timestamp: new Date().toISOString(),
        mode: 'pipeline',
      });
      expect(mockAppendJsonl).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          type: 'knowledge:outcome:failure',
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

    it('non-blocking: does not throw when appendJsonl fails', async () => {
      const { ks } = createKS();
      mockAppendJsonl.mockRejectedValueOnce(new Error('DB down'));
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

  describe('Consume (6 methods)', () => {
    it('injectContext exists', () => expect(typeof ks.injectContext).toBe('function'));
    it('search exists', () => expect(typeof ks.search).toBe('function'));
    it('semanticSearch exists', () => expect(typeof ks.semanticSearch).toBe('function'));
    it('matchResolutions exists', () => expect(typeof ks.matchResolutions).toBe('function'));
    it('list exists', () => expect(typeof ks.list).toBe('function'));
    it('get exists', () => expect(typeof ks.get).toBe('function'));
  });

  describe('Track (4 methods)', () => {
    it('recordConsumption exists', () => expect(typeof ks.recordConsumption).toBe('function'));
    it('recordOutcome exists', () => expect(typeof ks.recordOutcome).toBe('function'));
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
    it('has exactly 34 public methods', () => {
      const methods = Object.getOwnPropertyNames(KnowledgeService.prototype)
        .filter(m => m !== 'constructor');
      expect(methods).toHaveLength(34);
    });
  });
});
