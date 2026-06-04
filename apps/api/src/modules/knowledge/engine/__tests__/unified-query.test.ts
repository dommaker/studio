/**
 * UnifiedQuery — dual-store unified query tests
 * Phase 2: Prisma (structured) + KnowledgeStore (narrative) → single query entry
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
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

describe('UnifiedQuery', () => {
  let uq: InstanceType<typeof UnifiedQuery>;

  beforeEach(() => {
    vi.clearAllMocks();
    uq = new UnifiedQuery();
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
