/**
 * Agent Registry tests — register, get, list, update, delete, cache
 *
 * Post-migration: persistence is per-agent JSON files under
 * `~/.studio/agents-registry/` via FileStore (studio-prisma was removed).
 * Tests redirect `os.homedir()` to a tmp dir so the real file-backed
 * code paths run without touching the real home directory.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const { TEST_HOME } = vi.hoisted(() => {
  const nodePath = require('path');
  const nodeOs = require('os');
  const testHome = nodePath.join(nodeOs.tmpdir(), `agent-registry-test-${process.pid}`);
  // #219 setup 把 STUDIO_HOME 钉到隔离根后，studioDir() 走 env 优先于 os.homedir()，
  // 仅靠下面的 homedir mock 会被旁路（SUT 写 setup 根、断言读 TEST_HOME）。
  // 此处把 STUDIO_HOME 同步钉到 TEST_HOME/.studio（仍是 per-pid 临时目录，不碰真实 ~/.studio）。
  process.env.STUDIO_HOME = nodePath.join(testHome, '.studio');
  return { TEST_HOME: testHome };
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

vi.mock('@dommaker/studio-shared', async (importOriginal) => ({
  // Spread real module: AgentRegistry constructs `new FileStore()` internally.
  ...(await importOriginal<typeof import('@dommaker/studio-shared')>()),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { AgentRegistry } from '../agent-registry.js';
import type { AgentMetadata } from '../types.js';

function mockStore() {
  const map = new Map<string, string>();
  return {
    __map: map,
    get: vi.fn(async (key: string) => map.get(key) ?? null),
    setex: vi.fn(async (key: string, _ttl: number, value: string) => { map.set(key, value); }),
    keys: vi.fn(async (pattern: string) => {
      const prefix = pattern.replace('*', '');
      return [...map.keys()].filter(k => k.startsWith(prefix));
    }),
    del: vi.fn(async (...keys: string[]) => { keys.forEach(k => map.delete(k)); }),
  } as any;
}

const validSchema = { type: 'object' as const, properties: {} };
const baseMetadata: Omit<AgentMetadata, 'createdAt' | 'updatedAt'> = {
  id: 'test-agent',
  name: 'Test Agent',
  version: '1.0.0',
  category: 'tool',
  inputSchema: validSchema,
  outputSchema: validSchema,
  configSchema: validSchema,
  timeout: 1800,
};

const agentFile = (id: string, version: string) =>
  path.join(TEST_HOME, '.studio', 'agents-registry', `${id}_${version}.json`);

describe('AgentRegistry', () => {
  let store: ReturnType<typeof mockStore>;
  let registry: AgentRegistry;

  beforeEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
    fs.mkdirSync(TEST_HOME, { recursive: true });
    store = mockStore();
    registry = new AgentRegistry(store);
  });

  afterAll(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  describe('register', () => {
    it('creates agent file and caches it', async () => {
      const result = await registry.register(baseMetadata);

      expect(result.id).toBe('test-agent');
      expect(result.version).toBe('1.0.0');
      // Real persistence: JSON file written to the registry dir
      expect(fs.existsSync(agentFile('test-agent', '1.0.0'))).toBe(true);
      const onDisk = JSON.parse(fs.readFileSync(agentFile('test-agent', '1.0.0'), 'utf-8'));
      expect(onDisk.name).toBe('Test Agent');
      expect(store.setex).toHaveBeenCalledTimes(1);
    });

    it('throws when agent version already exists', async () => {
      await registry.register(baseMetadata);

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

      // Cache hit: metadata returned even though no agent file exists on disk
      expect(result?.id).toBe('test-agent');
      expect(fs.existsSync(agentFile('test-agent', '1.0.0'))).toBe(false);
    });

    it('falls back to file store and caches result', async () => {
      await registry.register(baseMetadata);
      // Drop the cache so get() must fall back to the JSON file
      store.__map.clear();
      store.setex.mockClear();

      const result = await registry.get('test-agent', '1.0.0');

      expect(result?.id).toBe('test-agent');
      expect(store.setex).toHaveBeenCalled();
    });

    it('returns null when not found', async () => {
      const result = await registry.get('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('list', () => {
    it('returns paginated results', async () => {
      await registry.register(baseMetadata);

      const result = await registry.list({ page: 1, limit: 10 });

      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
    });

    it('filters by category', async () => {
      await registry.register(baseMetadata);
      await registry.register({ ...baseMetadata, id: 'other-agent', category: 'custom' });

      const result = await registry.list({ category: 'tool' });

      expect(result.total).toBe(1);
      expect(result.data).toHaveLength(1);
      expect(result.data[0].id).toBe('test-agent');
      expect(result.data[0].category).toBe('tool');
    });
  });

  describe('update', () => {
    it('updates and invalidates cache', async () => {
      await registry.register(baseMetadata);
      // register() already cached the agent
      expect(store.__map.size).toBeGreaterThan(0);

      const result = await registry.update('test-agent', '1.0.0', { name: 'Updated' });

      expect(result.name).toBe('Updated');
      // Cache should be invalidated
      expect(store.del).toHaveBeenCalled();
      // Real persistence updated on disk
      const onDisk = JSON.parse(fs.readFileSync(agentFile('test-agent', '1.0.0'), 'utf-8'));
      expect(onDisk.name).toBe('Updated');
    });
  });

  describe('delete', () => {
    it('deletes and invalidates cache', async () => {
      await registry.register(baseMetadata);
      expect(fs.existsSync(agentFile('test-agent', '1.0.0'))).toBe(true);

      await registry.delete('test-agent', '1.0.0');

      expect(fs.existsSync(agentFile('test-agent', '1.0.0'))).toBe(false);
      expect(store.del).toHaveBeenCalled();
    });
  });
});
