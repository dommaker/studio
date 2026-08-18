/**
 * SkillStore — file-based CRUD tests
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('fs', () => {
  const store = new Map<string, string>();
  return {
    existsSync: vi.fn((p: string) => store.has(p)),
    readFileSync: vi.fn((p: string) => store.get(p) || '[]'),
    writeFileSync: vi.fn((p: string, data: string) => { store.set(p, data); }),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
    __store: store,
    __reset: () => store.clear(),
  };
});

vi.mock('@dommaker/studio-shared', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import * as fs from 'fs';
import { SkillStore } from '../skill-store.js';
import type { SkillRecord } from '../skill-store.js';

const mockFs = vi.mocked(fs);
const fsStore = (fs as any).__store;
const fsReset = (fs as any).__reset;

// #219: SUT 经 studioDir() 解析数据根（STUDIO_HOME env 优先于 os.homedir()），
// setup-isolated-data 已把 STUDIO_HOME 钉到隔离根，此处必须与 SUT 保持同一解析优先级。
const DATA_FILE = require('path').join(
  process.env.STUDIO_HOME || require('path').join(require('os').homedir(), '.studio'),
  'skills-index.json'
);

function makeSkill(overrides: Partial<SkillRecord> = {}): SkillRecord {
  return {
    id: 'skill-1',
    companyId: 'comp-1',
    name: 'test-skill',
    source: 'manual',
    status: 'draft',
    version: 1,
    autoLoad: false,
    isBuiltin: false,
    usageCount: 0,
    successRate: 0,
    avgDuration: 0,
    extractedAt: '2026-01-01T00:00:00Z',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('SkillStore', () => {
  let store: SkillStore;

  beforeEach(() => {
    vi.clearAllMocks();
    fsReset();
    store = new SkillStore();
    store.invalidateCache();
  });

  describe('list', () => {
    it('returns empty when no file', () => {
      expect(store.list()).toEqual([]);
    });

    it('filters by companyId', () => {
      const skills = [makeSkill({ id: '1', companyId: 'a' }), makeSkill({ id: '2', companyId: 'b' })];
      fsStore.set(DATA_FILE, JSON.stringify(skills));
      store.invalidateCache();
      expect(store.list({ companyId: 'a' })).toHaveLength(1);
    });

    it('filters by status', () => {
      const skills = [makeSkill({ id: '1', status: 'active' }), makeSkill({ id: '2', status: 'draft' })];
      fsStore.set(DATA_FILE, JSON.stringify(skills));
      store.invalidateCache();
      expect(store.list({ status: 'active' })).toHaveLength(1);
    });

    it('filters by name contains', () => {
      const skills = [makeSkill({ id: '1', name: 'deploy-skill' }), makeSkill({ id: '2', name: 'review-skill' })];
      fsStore.set(DATA_FILE, JSON.stringify(skills));
      store.invalidateCache();
      expect(store.list({ name: { contains: 'deploy' } })).toHaveLength(1);
    });

    it('supports skip and take', () => {
      const skills = [makeSkill({ id: '1' }), makeSkill({ id: '2' }), makeSkill({ id: '3' })];
      fsStore.set(DATA_FILE, JSON.stringify(skills));
      store.invalidateCache();
      expect(store.list({}, { skip: 1, take: 1 })).toHaveLength(1);
    });
  });

  describe('count', () => {
    it('counts filtered records', () => {
      const skills = [makeSkill({ id: '1', status: 'active' }), makeSkill({ id: '2', status: 'draft' })];
      fsStore.set(DATA_FILE, JSON.stringify(skills));
      store.invalidateCache();
      expect(store.count({ status: 'active' })).toBe(1);
    });
  });

  describe('get', () => {
    it('returns null for missing id', () => {
      expect(store.get('missing')).toBeNull();
    });

    it('returns skill by id', () => {
      fsStore.set(DATA_FILE, JSON.stringify([makeSkill({ id: 'found' })]));
      store.invalidateCache();
      expect(store.get('found')).not.toBeNull();
    });
  });

  describe('findFirst', () => {
    it('returns first match', () => {
      const skills = [makeSkill({ id: '1', name: 'a' }), makeSkill({ id: '2', name: 'b' })];
      fsStore.set(DATA_FILE, JSON.stringify(skills));
      store.invalidateCache();
      expect(store.findFirst({ name: 'b' })?.id).toBe('2');
    });
  });

  describe('create', () => {
    it('creates with defaults', () => {
      const result = store.create({ companyId: 'c1', name: 'new-skill' });
      expect(result.name).toBe('new-skill');
      expect(result.status).toBe('draft');
      expect(result.version).toBe(1);
      expect(result.usageCount).toBe(0);
      expect(mockFs.writeFileSync).toHaveBeenCalled();
    });

    it('writes SKILL.md when prompt provided', () => {
      store.create({ companyId: 'c1', name: 'with-prompt', prompt: '# Hello' });
      expect(mockFs.mkdirSync).toHaveBeenCalled();
      // writeFileSync called for index file + SKILL.md
      const writeCalls = mockFs.writeFileSync.mock.calls;
      expect(writeCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('update', () => {
    it('returns null for missing id', () => {
      expect(store.update('missing', { name: 'x' })).toBeNull();
    });

    it('updates fields', () => {
      fsStore.set(DATA_FILE, JSON.stringify([makeSkill()]));
      store.invalidateCache();
      const result = store.update('skill-1', { name: 'updated', status: 'active' });
      expect(result?.name).toBe('updated');
      expect(result?.status).toBe('active');
    });

    it('increments version', () => {
      fsStore.set(DATA_FILE, JSON.stringify([makeSkill({ version: 3 })]));
      store.invalidateCache();
      const result = store.update('skill-1', { version: { increment: 1 } });
      expect(result?.version).toBe(4);
    });
  });

  describe('delete', () => {
    it('returns false for missing id', () => {
      expect(store.delete('missing')).toBe(false);
    });

    it('removes skill and calls rmSync', () => {
      fsStore.set(DATA_FILE, JSON.stringify([makeSkill({ trigger: 'always' })]));
      store.invalidateCache();
      expect(store.delete('skill-1')).toBe(true);
      expect(mockFs.writeFileSync).toHaveBeenCalled();
    });
  });

  describe('deleteMany', () => {
    it('deletes matching records', () => {
      const skills = [makeSkill({ id: '1', companyId: 'a' }), makeSkill({ id: '2', companyId: 'b' })];
      fsStore.set(DATA_FILE, JSON.stringify(skills));
      store.invalidateCache();
      expect(store.deleteMany({ companyId: 'a' })).toBe(1);
    });
  });
});
