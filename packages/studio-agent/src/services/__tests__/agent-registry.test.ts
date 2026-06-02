/**
 * Agent Registry tests — register, get, list, update, delete, cache
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@dommaker/studio-shared', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { AgentRegistry } from '../agent-registry.js';
import type { AgentMetadata } from '../types.js';

function mockPrisma() {
  return {
    agent: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  } as any;
}

function mockStore() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    setex: vi.fn(async (key: string, _ttl: number, value: string) => { store.set(key, value); }),
    keys: vi.fn(async (pattern: string) => {
      const prefix = pattern.replace('*', '');
      return [...store.keys()].filter(k => k.startsWith(prefix));
    }),
    del: vi.fn(async (...keys: string[]) => { keys.forEach(k => store.delete(k)); }),
  } as any;
}

const validSchema = { type: 'object' as const, properties: {} };
const baseMetadata: Omit<AgentMetadata, 'createdAt' | 'updatedAt'> = {
  id: 'test-agent',
  name: 'Test Agent',
  version: '1.0.0',
  category: 'utility',
  inputSchema: validSchema,
  outputSchema: validSchema,
  configSchema: validSchema,
  timeout: 1800,
};

describe('AgentRegistry', () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let store: ReturnType<typeof mockStore>;
  let registry: AgentRegistry;

  beforeEach(() => {
    prisma = mockPrisma();
    store = mockStore();
    registry = new AgentRegistry(prisma, store);
  });

  describe('register', () => {
    it('creates agent and caches it', async () => {
      prisma.agent.findFirst.mockResolvedValue(null);
      prisma.agent.create.mockResolvedValue({
        ...baseMetadata,
        description: null,
        icon: null,
        tags: '[]',
        endpoint: null,
        retryPolicy: null,
        rateLimit: null,
        metadata: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await registry.register(baseMetadata);

      expect(result.id).toBe('test-agent');
      expect(result.version).toBe('1.0.0');
      expect(prisma.agent.create).toHaveBeenCalledTimes(1);
      expect(store.setex).toHaveBeenCalledTimes(1);
    });

    it('throws when agent version already exists', async () => {
      prisma.agent.findFirst.mockResolvedValue({ id: 'test-agent', version: '1.0.0' });

      await expect(registry.register(baseMetadata)).rejects.toThrow('already exists');
    });

    it('rejects invalid JSON schema', async () => {
      await expect(registry.register({
        ...baseMetadata,
        inputSchema: { type: 'invalid_type' } as any,
      })).rejects.toThrow('Invalid JSON Schema');
    });
  });

  describe('get', () => {
    it('returns from cache if available', async () => {
      const cached = { ...baseMetadata, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
      await store.setex('agent:test-agent:1.0.0', 3600, JSON.stringify(cached));

      const result = await registry.get('test-agent', '1.0.0');

      expect(result?.id).toBe('test-agent');
      expect(prisma.agent.findFirst).not.toHaveBeenCalled();
    });

    it('falls back to database and caches result', async () => {
      prisma.agent.findFirst.mockResolvedValue({
        ...baseMetadata,
        description: null,
        icon: null,
        tags: '[]',
        endpoint: null,
        retryPolicy: null,
        rateLimit: null,
        metadata: null,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
      });

      const result = await registry.get('test-agent', '1.0.0');

      expect(result?.id).toBe('test-agent');
      expect(prisma.agent.findFirst).toHaveBeenCalled();
      expect(store.setex).toHaveBeenCalled();
    });

    it('returns null when not found', async () => {
      prisma.agent.findFirst.mockResolvedValue(null);

      const result = await registry.get('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('list', () => {
    it('returns paginated results', async () => {
      prisma.agent.findMany.mockResolvedValue([{
        ...baseMetadata,
        description: null,
        icon: null,
        tags: '[]',
        endpoint: null,
        retryPolicy: null,
        rateLimit: null,
        metadata: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }]);
      prisma.agent.count.mockResolvedValue(1);

      const result = await registry.list({ page: 1, limit: 10 });

      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
    });

    it('filters by category', async () => {
      prisma.agent.findMany.mockResolvedValue([]);
      prisma.agent.count.mockResolvedValue(0);

      await registry.list({ category: 'utility' });

      expect(prisma.agent.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { category: 'utility' },
      }));
    });
  });

  describe('update', () => {
    it('updates and invalidates cache', async () => {
      prisma.agent.update.mockResolvedValue({
        ...baseMetadata,
        name: 'Updated',
        description: null,
        icon: null,
        tags: '[]',
        endpoint: null,
        retryPolicy: null,
        rateLimit: null,
        metadata: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Seed cache first
      await store.setex('agent:test-agent:1.0.0', 3600, '{}');

      const result = await registry.update('test-agent', '1.0.0', { name: 'Updated' });

      expect(result.name).toBe('Updated');
      // Cache should be invalidated
      expect(store.del).toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('deletes and invalidates cache', async () => {
      prisma.agent.delete.mockResolvedValue({});

      await store.setex('agent:test-agent:1.0.0', 3600, '{}');

      await registry.delete('test-agent', '1.0.0');

      expect(prisma.agent.delete).toHaveBeenCalledWith({
        where: { id_version: { id: 'test-agent', version: '1.0.0' } },
      });
      expect(store.del).toHaveBeenCalled();
    });
  });
});
