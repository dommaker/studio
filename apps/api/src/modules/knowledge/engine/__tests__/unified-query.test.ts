/**
 * UnifiedQuery — dual-store unified query tests
 * Phase 2: Prisma (structured) + KnowledgeStore (narrative) → single query entry
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock Prisma
const mockPrisma = {
  userPreference: { findFirst: vi.fn() },
  businessRule: { findMany: vi.fn(), count: vi.fn() },
  environmentSnapshot: { findFirst: vi.fn() },
};
vi.mock('@dommaker/studio-prisma', () => ({ prisma: mockPrisma }));

// Mock knowledge-bus.service.js (UNIFIED_KNOWLEDGE_DIR)
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uq-test-'));
vi.mock('../knowledge-bus.service.js', () => ({
  UNIFIED_KNOWLEDGE_DIR: tempDir,
}));

// Use real KnowledgeStore (it's file-based, no external deps)
const { UnifiedQuery } = await import('../unified-query.js');
const { KnowledgeStore } = await import('@dommaker/harness');

describe('UnifiedQuery', () => {
  let uq: InstanceType<typeof UnifiedQuery>;
  let testDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    // Fresh temp dir per test for isolation
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uq-case-'));
    uq = new UnifiedQuery(new KnowledgeStore({ baseDir: testDir }));
  });

  afterEach(() => {
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
  });

  describe('queryEntries', () => {
    describe('Prisma → KnowledgeEntry', () => {
      it('should convert UserPreference to KnowledgeEntry with context mode', async () => {
        mockPrisma.userPreference.findFirst.mockResolvedValue({
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
        mockPrisma.businessRule.findMany.mockResolvedValue([
          {
            id: 'rule-1',
            name: 'no_redis',
            category: 'constraint',
            description: '禁止 Redis 依赖',
            condition: 'all code',
            action: 'reject redis imports',
            affects: '["executor","reviewer"]',
            status: 'active',
            updatedAt: new Date('2026-06-04'),
          },
        ]);

        const entries = await uq.queryEntries({ consumptionModes: ['rule'] });

        const rule = entries.find(e => e.id === 'rule:no_redis');
        expect(rule).toBeDefined();
        expect(rule!.consumptionMode).toBe('rule');
        expect(rule!.applicableAgents).toEqual(['executor', 'reviewer']);
        expect(rule!.content).toContain('禁止 Redis 依赖');
      });

      it('should convert EnvironmentSnapshot to KnowledgeEntry with context mode', async () => {
        mockPrisma.environmentSnapshot.findFirst.mockResolvedValue({
          id: 'env-1',
          hostname: 'prod-server',
          platform: 'linux',
          nodeVersion: 'v20.11.0',
          nodeEnv: 'production',
          knownLimitations: '["no redis", "no gpu"]',
          createdAt: new Date('2026-06-04'),
        });

        const entries = await uq.queryEntries({ consumptionModes: ['context'] });

        const env = entries.find(e => e.id === 'env:current');
        expect(env).toBeDefined();
        expect(env!.consumptionMode).toBe('context');
        expect(env!.applicableAgents).toEqual([]);
        expect(env!.content).toContain('linux');
        expect(env!.content).toContain('v20');
      });

      it('should return empty when no Prisma data exists', async () => {
        mockPrisma.userPreference.findFirst.mockResolvedValue(null);
        mockPrisma.businessRule.findMany.mockResolvedValue([]);
        mockPrisma.environmentSnapshot.findFirst.mockResolvedValue(null);

        const entries = await uq.queryEntries({ consumptionModes: ['rule', 'context'] });

        expect(entries).toEqual([]);
      });
    });

    describe('agent filtering', () => {
      it('should filter by applicableAgents', async () => {
        mockPrisma.businessRule.findMany.mockResolvedValue([
          { id: 'r1', name: 'global_rule', category: 'constraint', description: 'desc', affects: '[]', status: 'active', updatedAt: new Date() },
          { id: 'r2', name: 'executor_rule', category: 'constraint', description: 'desc', affects: '["executor"]', status: 'active', updatedAt: new Date() },
          { id: 'r3', name: 'reviewer_rule', category: 'constraint', description: 'desc', affects: '["reviewer"]', status: 'active', updatedAt: new Date() },
        ]);
        mockPrisma.userPreference.findFirst.mockResolvedValue(null);
        mockPrisma.environmentSnapshot.findFirst.mockResolvedValue(null);

        const entries = await uq.queryEntries({ consumptionModes: ['rule'], agentType: 'executor' });

        expect(entries.map(e => e.id)).toContain('rule:global_rule');
        expect(entries.map(e => e.id)).toContain('rule:executor_rule');
        expect(entries.map(e => e.id)).not.toContain('rule:reviewer_rule');
      });

      it('should include global entries (empty applicableAgents) for all agents', async () => {
        mockPrisma.businessRule.findMany.mockResolvedValue([
          { id: 'r1', name: 'global', category: 'c', description: 'd', affects: '[]', status: 'active', updatedAt: new Date() },
        ]);
        mockPrisma.userPreference.findFirst.mockResolvedValue(null);
        mockPrisma.environmentSnapshot.findFirst.mockResolvedValue(null);

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
      mockPrisma.businessRule.findMany.mockResolvedValue([
        { id: 'r1', name: 'test_rule', category: 'c', description: 'd', affects: '[]', status: 'active', updatedAt: new Date() },
      ]);
      mockPrisma.userPreference.findFirst.mockResolvedValue(null);
      mockPrisma.environmentSnapshot.findFirst.mockResolvedValue(null);

      const result = await uq.listEntries({ sources: ['prisma', 'store'], consumptionModes: ['rule'] });

      expect(result.entries.some(e => e.source === 'prisma')).toBe(true);
    });
  });

  describe('count', () => {
    it('should count Prisma entries', async () => {
      mockPrisma.businessRule.findMany.mockResolvedValue([{ id: 'r1' }, { id: 'r2' }]);
      mockPrisma.businessRule.count.mockResolvedValue(2);
      mockPrisma.userPreference.findFirst.mockResolvedValue(null);
      mockPrisma.environmentSnapshot.findFirst.mockResolvedValue(null);

      const count = await uq.count({ consumptionModes: ['rule'] });

      expect(count).toBe(2);
    });

    it('should count context entries (preference + env)', async () => {
      mockPrisma.businessRule.findMany.mockResolvedValue([]);
      mockPrisma.businessRule.count.mockResolvedValue(0);
      mockPrisma.userPreference.findFirst.mockResolvedValue({ id: 'p1' });
      mockPrisma.environmentSnapshot.findFirst.mockResolvedValue({ id: 'e1', createdAt: new Date() });

      const count = await uq.count({ consumptionModes: ['context'] });

      expect(count).toBe(2);
    });
  });
});
