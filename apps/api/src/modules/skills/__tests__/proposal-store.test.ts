/**
 * ProposalStore — file-based CRUD tests
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('fs', () => {
  const store = new Map<string, string>();
  return {
    existsSync: vi.fn((p: string) => store.has(p)),
    readFileSync: vi.fn((p: string) => store.get(p) || '[]'),
    writeFileSync: vi.fn((p: string, data: string) => { store.set(p, data); }),
    mkdirSync: vi.fn(),
    __store: store,
    __reset: () => store.clear(),
  };
});

vi.mock('@dommaker/studio-shared', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import * as fs from 'fs';
import { ProposalStore } from '../proposal-store.js';
import type { ProposalRecord } from '../proposal-store.js';

const mockFs = vi.mocked(fs);
const fsStore = (fs as any).__store;
const fsReset = (fs as any).__reset;

const DATA_FILE = require('path').join(require('os').homedir(), '.studio', 'proposals.json');

function makeProposal(overrides: Partial<ProposalRecord> = {}): ProposalRecord {
  return {
    id: 'prop-1',
    skillId: 'skill-1',
    status: 'pending',
    proposedBy: 'agent',
    proposedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('ProposalStore', () => {
  let store: ProposalStore;

  beforeEach(() => {
    vi.clearAllMocks();
    fsReset();
    store = new ProposalStore();
    store.invalidateCache();
  });

  describe('list', () => {
    it('returns empty when no file', () => {
      expect(store.list()).toEqual([]);
    });

    it('filters by status string', () => {
      const proposals = [makeProposal({ id: '1', status: 'pending' }), makeProposal({ id: '2', status: 'approved' })];
      fsStore.set(DATA_FILE, JSON.stringify(proposals));
      store.invalidateCache();
      expect(store.list({ status: 'pending' })).toHaveLength(1);
    });

    it('filters by status in array', () => {
      const proposals = [makeProposal({ id: '1', status: 'pending' }), makeProposal({ id: '2', status: 'approved' }), makeProposal({ id: '3', status: 'rejected' })];
      fsStore.set(DATA_FILE, JSON.stringify(proposals));
      store.invalidateCache();
      expect(store.list({ status: { in: ['pending', 'approved'] } })).toHaveLength(2);
    });

    it('filters by skillId', () => {
      const proposals = [makeProposal({ id: '1', skillId: 'a' }), makeProposal({ id: '2', skillId: 'b' })];
      fsStore.set(DATA_FILE, JSON.stringify(proposals));
      store.invalidateCache();
      expect(store.list({ skillId: 'a' })).toHaveLength(1);
    });

    it('filters by proposedBy', () => {
      const proposals = [makeProposal({ id: '1', proposedBy: 'agent' }), makeProposal({ id: '2', proposedBy: 'human' })];
      fsStore.set(DATA_FILE, JSON.stringify(proposals));
      store.invalidateCache();
      expect(store.list({ proposedBy: 'human' })).toHaveLength(1);
    });

    it('supports orderBy and take', () => {
      const proposals = [makeProposal({ id: '1', proposedAt: '2026-01-01' }), makeProposal({ id: '2', proposedAt: '2026-01-02' })];
      fsStore.set(DATA_FILE, JSON.stringify(proposals));
      store.invalidateCache();
      const result = store.list({}, { orderBy: { field: 'proposedAt', dir: 'desc' }, take: 1 });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('2');
    });
  });

  describe('get', () => {
    it('returns null for missing id', () => {
      expect(store.get('missing')).toBeNull();
    });

    it('returns proposal by id', () => {
      fsStore.set(DATA_FILE, JSON.stringify([makeProposal({ id: 'found' })]));
      store.invalidateCache();
      expect(store.get('found')).not.toBeNull();
    });
  });

  describe('create', () => {
    it('creates with defaults', () => {
      const result = store.create({ skillId: 's1', proposedBy: 'agent' });
      expect(result.status).toBe('pending');
      expect(result.skillId).toBe('s1');
      expect(result.id).toBeDefined();
      expect(result.proposedAt).toBeDefined();
      expect(mockFs.writeFileSync).toHaveBeenCalled();
    });

    it('accepts custom status', () => {
      const result = store.create({ skillId: 's1', proposedBy: 'agent', status: 'auto_approved' });
      expect(result.status).toBe('auto_approved');
    });

    it('accepts summary and metadata', () => {
      const result = store.create({ skillId: 's1', proposedBy: 'agent', summary: 'test', metadata: { key: 'value' } });
      expect(result.summary).toBe('test');
      expect(result.metadata).toEqual({ key: 'value' });
    });
  });

  describe('update', () => {
    it('returns null for missing id', () => {
      expect(store.update('missing', { status: 'approved' })).toBeNull();
    });

    it('updates fields', () => {
      fsStore.set(DATA_FILE, JSON.stringify([makeProposal()]));
      store.invalidateCache();
      const result = store.update('prop-1', { status: 'approved', reviewedAt: '2026-01-02' });
      expect(result?.status).toBe('approved');
      expect(result?.reviewedAt).toBe('2026-01-02');
    });
  });

  describe('cache', () => {
    it('invalidateCache forces reload', () => {
      // Must have a file so readFileSync is actually called
      fsStore.set(DATA_FILE, JSON.stringify([makeProposal()]));
      store.invalidateCache();

      store.list();
      store.list();
      expect(mockFs.readFileSync).toHaveBeenCalledTimes(1);

      store.invalidateCache();
      store.list();
      expect(mockFs.readFileSync).toHaveBeenCalledTimes(2);
    });
  });
});
