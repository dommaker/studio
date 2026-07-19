/**
 * UnifiedQuery - dual-store unified query tests
 * Post studio-prisma removal: "prisma"-sourced entries are rebuilt from
 * KnowledgeStore (preference/rule) + ~/.studio/snapshots/*.json (env).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock knowledge-singletons.js — the only export the SUT imports from it is
// UNIFIED_KNOWLEDGE_DIR (default store baseDir); keep it off the real home dir.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uq-test-'));
vi.mock('../../knowledge-singletons.js', () => ({
  UNIFIED_KNOWLEDGE_DIR: tempDir,
}));

// The SUT reads env snapshots from os.homedir()/.studio/snapshots. Under
// vitest's worker threads, process.env.HOME writes don't reach the C-level
// getenv behind os.homedir() — so mock homedir() itself (per-test temp dir).
const { mockHomeRef } = vi.hoisted(() => ({ mockHomeRef: { dir: '' } }));
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return { ...actual, homedir: () => mockHomeRef.dir };
});

// Use real KnowledgeStore (it's file-based, no external deps)
const { UnifiedQuery } = await import('../unified-query.js');
const { FileKnowledgeStore } = await import('@dommaker/harness');

// ── Helpers: write preference/rule data to KnowledgeStore ──

function savePreference(store: any, pref: Record<string, unknown>) {
  store.save({
    id: `pref-${Math.random().toString(36).slice(2, 8)}`,
    type: 'guideline',
    title: '用户偏好',
    content: JSON.stringify(pref),
    maturity: 'active',
    layer: 'system',
    created: '2026-06-04T00:00:00Z',
    lastReferenced: '2026-06-04T00:00:00Z',
    contributors: [],
    projects: [],
    tags: ['preference', 'user-default'],
    applicablePhases: [],
    sourceReferences: [],
    referencedBy: [],
    executionResults: [],
    consumptionMode: 'reference',
    origin: 'system',
  });
}

function saveRule(store: any, rule: Record<string, unknown>, title: string) {
  store.save({
    id: `rule-${title}-${Math.random().toString(36).slice(2, 8)}`,
    type: 'guideline',
    title,
    content: JSON.stringify(rule),
    maturity: 'active',
    layer: 'system',
    created: '2026-06-04T00:00:00Z',
    lastReferenced: '2026-06-04T00:00:00Z',
    contributors: [],
    projects: [],
    tags: ['rule', 'active'],
    applicablePhases: [],
    sourceReferences: [],
    referencedBy: [],
    executionResults: [],
    consumptionMode: 'reference',
    origin: 'system',
  });
}

/** Write an environment snapshot JSON the way it lands on disk post-Prisma */
function writeSnapshot(homeDir: string, snapshot: Record<string, unknown>, name = '2026-06-04.json') {
  const snapshotsDir = path.join(homeDir, '.studio', 'snapshots');
  fs.mkdirSync(snapshotsDir, { recursive: true });
  fs.writeFileSync(path.join(snapshotsDir, name), JSON.stringify(snapshot));
}

describe('UnifiedQuery', () => {
  let uq: InstanceType<typeof UnifiedQuery>;
  let testDir: string;
  let testHome: string;

  beforeEach(() => {
    vi.clearAllMocks();
    // Point os.homedir() at an empty temp dir before constructing anything,
    // so snapshot reads are deterministic (box-independent).
    mockHomeRef.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uq-home-'));
    testHome = mockHomeRef.dir;
    // Fresh temp dir per test for isolation
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uq-case-'));
    uq = new UnifiedQuery(new FileKnowledgeStore({ baseDir: testDir }));
  });

  afterEach(() => {
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(testHome, { recursive: true, force: true }); } catch {}
    mockHomeRef.dir = '';
  });

  describe('queryEntries', () => {
    describe('Prisma -> KnowledgeEntry', () => {
      it('should convert UserPreference to KnowledgeEntry with context mode', async () => {
        // UserPreference is read from KnowledgeStore
        savePreference((uq as any).store, {
          id: 'pref-1',
          userId: 'default',
          preferredModel: 'premium',
          responseStyle: 'concise',
          activeHours: '[9,10,11,14,15,16]',
          confidence: 0.8,
          updatedAt: new Date('2026-06-04'),
        });

        const entries = await uq.queryEntries({ consumptionModes: ['context'] });

        const pref = entries.find(e => e.id === 'pref:user');
        expect(pref).toBeDefined();
        expect(pref!.consumptionMode).toBe('context');
        expect(pref!.origin).toBe('system');
        expect(pref!.applicableAgents).toEqual([]);
        expect(pref!.content).toContain('premium');
        expect(pref!.content).toContain('concise');
      });

      it('should convert BusinessRule to KnowledgeEntry with rule mode', async () => {
        // BusinessRule is read from KnowledgeStore
        saveRule((uq as any).store, {
          id: 'rule-1',
          name: 'no_redis',
          category: 'constraint',
          description: '禁止 Redis 依赖',
          condition: 'all code',
          action: 'reject redis imports',
          affects: '["executor","reviewer"]',
          status: 'active',
          updatedAt: new Date('2026-06-04'),
        }, 'no_redis');

        const entries = await uq.queryEntries({ consumptionModes: ['rule'] });

        const rule = entries.find(e => e.id === 'rule:no_redis');
        expect(rule).toBeDefined();
        expect(rule!.consumptionMode).toBe('rule');
        expect(rule!.applicableAgents).toEqual(['executor', 'reviewer']);
        expect(rule!.content).toContain('禁止 Redis 依赖');
      });

      it('should convert EnvironmentSnapshot to KnowledgeEntry with context mode', async () => {
        // EnvironmentSnapshot is read from ~/.studio/snapshots/*.json (FileStore world)
        writeSnapshot(testHome, {
          id: 'env-1',
          hostname: 'prod-server',
          platform: 'linux',
          nodeVersion: 'v20.11.0',
          nodeEnv: 'production',
          knownLimitations: '["no redis", "no gpu"]',
          createdAt: '2026-06-04T00:00:00.000Z',
        });

        const entries = await uq.queryEntries({ consumptionModes: ['context'] });

        const env = entries.find(e => e.id === 'env:current');
        expect(env).toBeDefined();
        expect(env!.consumptionMode).toBe('context');
        expect(env!.applicableAgents).toEqual([]);
        expect(env!.content).toContain('linux');
        expect(env!.content).toContain('v20');
      });

      it('should return empty when no store data or snapshots exist', async () => {
        const entries = await uq.queryEntries({ consumptionModes: ['rule', 'context'] });

        expect(entries).toEqual([]);
      });
    });

    describe('agent filtering', () => {
      it('should filter by applicableAgents', async () => {
        saveRule((uq as any).store, {
          id: 'r1', category: 'constraint', description: 'desc',
          affects: '[]', status: 'active', updatedAt: new Date(),
        }, 'global_rule');
        saveRule((uq as any).store, {
          id: 'r2', category: 'constraint', description: 'desc',
          affects: '["executor"]', status: 'active', updatedAt: new Date(),
        }, 'executor_rule');
        saveRule((uq as any).store, {
          id: 'r3', category: 'constraint', description: 'desc',
          affects: '["reviewer"]', status: 'active', updatedAt: new Date(),
        }, 'reviewer_rule');

        const entries = await uq.queryEntries({ consumptionModes: ['rule'], agentType: 'executor' });

        expect(entries.map(e => e.id)).toContain('rule:global_rule');
        expect(entries.map(e => e.id)).toContain('rule:executor_rule');
        expect(entries.map(e => e.id)).not.toContain('rule:reviewer_rule');
      });

      it('should include global entries (empty applicableAgents) for all agents', async () => {
        saveRule((uq as any).store, {
          id: 'r1', category: 'c', description: 'd',
          affects: '[]', status: 'active', updatedAt: new Date(),
        }, 'global');

        const entries = await uq.queryEntries({ consumptionModes: ['rule'], agentType: 'analyst' });

        expect(entries).toHaveLength(1);
        expect(entries[0].id).toBe('rule:global');
      });
    });
  });

  describe('getIndexes', () => {
    it('should return empty when KnowledgeStore has no matching entries', () => {
      const indexes = uq.getIndexes({ consumptionModes: ['signal'] });
      expect(indexes).toEqual([]);
    });
  });

  describe('listEntries', () => {
    it('should return store entries with pagination', async () => {
      // Save some entries to the store
      const store = (uq as any).store;
      store.save({
        id: 'list-1', type: 'guideline', title: 'Entry 1', content: 'Content 1',
        maturity: 'verified', layer: 'project', created: '2026-06-01T00:00:00Z',
        lastReferenced: '2026-06-04T00:00:00Z', contributors: ['test'], projects: [],
        tags: ['pattern'], applicablePhases: [], sourceReferences: [], referencedBy: [],
        executionResults: [], consumptionMode: 'signal', origin: 'agent',
      });
      store.save({
        id: 'list-2', type: 'pitfall', title: 'Entry 2', content: 'Content 2',
        maturity: 'draft', layer: 'project', created: '2026-06-02T00:00:00Z',
        lastReferenced: '2026-06-03T00:00:00Z', contributors: ['test'], projects: [],
        tags: ['incident'], applicablePhases: [], sourceReferences: [], referencedBy: [],
        executionResults: [], consumptionMode: 'signal', origin: 'agent',
      });

      const result = await uq.listEntries({ limit: 10 });

      expect(result.total).toBeGreaterThanOrEqual(2);
      expect(result.entries.length).toBeGreaterThanOrEqual(2);
    });

    it('should filter by consumptionMode', async () => {
      const store = (uq as any).store;
      store.save({
        id: 'mode-signal', type: 'guideline', title: 'Signal', content: 'C',
        maturity: 'verified', layer: 'project', created: '2026-06-01T00:00:00Z',
        lastReferenced: '2026-06-04T00:00:00Z', contributors: [], projects: [],
        tags: [], applicablePhases: [], sourceReferences: [], referencedBy: [],
        executionResults: [], consumptionMode: 'signal', origin: 'agent',
      });
      store.save({
        id: 'mode-ref', type: 'guideline', title: 'Ref', content: 'C',
        maturity: 'verified', layer: 'project', created: '2026-06-01T00:00:00Z',
        lastReferenced: '2026-06-04T00:00:00Z', contributors: [], projects: [],
        tags: [], applicablePhases: [], sourceReferences: [], referencedBy: [],
        executionResults: [], consumptionMode: 'reference', origin: 'agent',
      });

      const result = await uq.listEntries({ consumptionModes: ['signal'] });

      expect(result.entries.every(e => e.consumptionMode === 'signal')).toBe(true);
    });

    it('should apply offset and limit', async () => {
      const store = (uq as any).store;
      for (let i = 0; i < 5; i++) {
        store.save({
          id: `page-${i}`, type: 'guideline', title: `Entry ${i}`, content: 'C',
          maturity: 'verified', layer: 'project', created: '2026-06-01T00:00:00Z',
          lastReferenced: `2026-06-0${i + 1}T00:00:00Z`, contributors: [], projects: [],
          tags: [], applicablePhases: [], sourceReferences: [], referencedBy: [],
          executionResults: [], consumptionMode: 'signal', origin: 'agent',
        });
      }

      const page1 = await uq.listEntries({ limit: 2, offset: 0 });
      const page2 = await uq.listEntries({ limit: 2, offset: 2 });

      expect(page1.entries).toHaveLength(2);
      expect(page2.entries).toHaveLength(2);
      expect(page1.entries[0].id).not.toBe(page2.entries[0].id);
      expect(page1.total).toBe(page2.total);
    });

    it('should filter by origin', async () => {
      const store = (uq as any).store;
      store.save({
        id: 'origin-ext', type: 'guideline', title: 'External', content: 'C',
        maturity: 'verified', layer: 'project', created: '2026-06-01T00:00:00Z',
        lastReferenced: '2026-06-04T00:00:00Z', contributors: [], projects: [],
        tags: [], applicablePhases: [], sourceReferences: [], referencedBy: [],
        executionResults: [], consumptionMode: 'reference', origin: 'external',
      });

      const result = await uq.listEntries({ origins: ['external'] });

      expect(result.entries.every(e => e.origin === 'external')).toBe(true);
    });

    it('should include Prisma entries when sources include prisma', async () => {
      // BusinessRule is now read from KnowledgeStore by prismaToEntries,
      // and the returned entries are tagged with source: 'prisma'.
      saveRule((uq as any).store, {
        id: 'r1', category: 'c', description: 'd',
        affects: '[]', status: 'active', updatedAt: new Date(),
      }, 'test_rule');

      const result = await uq.listEntries({ sources: ['prisma', 'store'], consumptionModes: ['rule'] });

      expect(result.entries.some(e => e.source === 'prisma')).toBe(true);
    });
  });

  describe('count', () => {
    it('should count Prisma entries', async () => {
      // count() reads rules from KnowledgeStore via store.list({ tags: ['rule', 'active'] })
      saveRule((uq as any).store, {
        id: 'r1', category: 'c', description: 'd',
        affects: '[]', status: 'active', updatedAt: new Date(),
      }, 'rule_a');
      saveRule((uq as any).store, {
        id: 'r2', category: 'c', description: 'd',
        affects: '[]', status: 'active', updatedAt: new Date(),
      }, 'rule_b');

      // Use sources: ['prisma'] to avoid double-counting via store source
      const count = await uq.count({ consumptionModes: ['rule'], sources: ['prisma'] });

      expect(count).toBe(2);
    });

    it('should count context entries (preference + env)', async () => {
      // preference from KnowledgeStore + env from ~/.studio/snapshots/
      savePreference((uq as any).store, {
        id: 'p1',
        preferredModel: 'test',
        updatedAt: new Date(),
      });
      writeSnapshot(testHome, { id: 'e1', createdAt: '2026-06-04T00:00:00.000Z' });

      // Use sources: ['prisma'] to avoid double-counting via store source
      const count = await uq.count({ consumptionModes: ['context'], sources: ['prisma'] });

      expect(count).toBe(2);
    });
  });
});
