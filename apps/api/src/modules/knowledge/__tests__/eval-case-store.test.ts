/**
 * EvalCaseStore — file-based CRUD tests
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock fs before importing the module under test
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

import * as fs from 'fs';
import {
  listEvalCases,
  createEvalCase,
  updateEvalCase,
  invalidateEvalCaseCache,
} from '../eval-case-store.js';

const mockFs = vi.mocked(fs);
const fsStore = (fs as any).__store;
const fsReset = (fs as any).__reset;

// #219：SUT 的 DATA_DIR = studioDir() 在 import 期冻结，STUDIO_HOME 优先于 os.homedir()；
// setup 已把 STUDIO_HOME 钉到进程级隔离根，这里用同一优先级算 fs-mock 的 key。
const DATA_FILE = require('path').join(
  process.env.STUDIO_HOME || require('path').join(require('os').homedir(), '.studio'),
  'eval-cases.json',
);

beforeEach(() => {
  vi.clearAllMocks();
  fsReset();
  invalidateEvalCaseCache();
});

describe('eval-case-store', () => {
  describe('listEvalCases', () => {
    it('returns empty when no file exists', () => {
      expect(listEvalCases()).toEqual([]);
    });

    it('returns all records when no filter', () => {
      const records = [
        { id: '1', type: 'eval_case', level: 'agent_knowledge', content: 'c1', sourceGoalId: 'g1', status: 'active', createdAt: '', updatedAt: '' },
        { id: '2', type: 'eval_case', level: 'agent_knowledge', content: 'c2', sourceGoalId: 'g2', status: 'inactive', createdAt: '', updatedAt: '' },
      ];
      fsStore.set(DATA_FILE, JSON.stringify(records));
      invalidateEvalCaseCache();
      expect(listEvalCases()).toHaveLength(2);
    });

    it('filters by status', () => {
      const records = [
        { id: '1', type: 'eval_case', level: 'agent_knowledge', content: 'c1', sourceGoalId: 'g1', status: 'active', createdAt: '', updatedAt: '' },
        { id: '2', type: 'eval_case', level: 'agent_knowledge', content: 'c2', sourceGoalId: 'g2', status: 'inactive', createdAt: '', updatedAt: '' },
      ];
      fsStore.set(DATA_FILE, JSON.stringify(records));
      invalidateEvalCaseCache();
      expect(listEvalCases({ status: 'active' })).toHaveLength(1);
    });
  });

  describe('createEvalCase', () => {
    it('creates record with defaults', () => {
      const result = createEvalCase({ content: 'test', sourceGoalId: 'g1' });
      expect(result.type).toBe('eval_case');
      expect(result.status).toBe('active');
      expect(result.level).toBe('agent_knowledge');
      expect(result.content).toBe('test');
      expect(result.id).toBeDefined();
      expect(mockFs.writeFileSync).toHaveBeenCalled();
    });

    it('accepts custom status', () => {
      const result = createEvalCase({ content: 'c', sourceGoalId: 'g1', status: 'pending' });
      expect(result.status).toBe('pending');
    });

    it('accepts triggerCondition', () => {
      const result = createEvalCase({ content: 'c', sourceGoalId: 'g1', triggerCondition: 'on error' });
      expect(result.triggerCondition).toBe('on error');
    });
  });

  describe('updateEvalCase', () => {
    it('returns null for nonexistent id', () => {
      expect(updateEvalCase('missing', { status: 'done' })).toBeNull();
    });

    it('updates status and updatedAt', () => {
      const record = { id: '1', type: 'eval_case', level: 'agent_knowledge', content: 'c', sourceGoalId: 'g1', status: 'active', createdAt: '2026-01-01', updatedAt: '2026-01-01' };
      fsStore.set(DATA_FILE, JSON.stringify([record]));
      invalidateEvalCaseCache();

      const result = updateEvalCase('1', { status: 'inactive' });
      expect(result).not.toBeNull();
      expect(result!.status).toBe('inactive');
      expect(result!.updatedAt).not.toBe('2026-01-01');
    });
  });

  describe('cache', () => {
    it('invalidateEvalCaseCache forces reload', () => {
      // Must have a file so readFileSync is actually called
      fsStore.set(DATA_FILE, JSON.stringify([{ id: '1', type: 'eval_case', level: 'agent_knowledge', content: 'c', sourceGoalId: 'g', status: 'active', createdAt: '', updatedAt: '' }]));
      invalidateEvalCaseCache();

      listEvalCases();
      listEvalCases();
      expect(mockFs.readFileSync).toHaveBeenCalledTimes(1);

      invalidateEvalCaseCache();
      listEvalCases();
      expect(mockFs.readFileSync).toHaveBeenCalledTimes(2);
    });
  });
});
