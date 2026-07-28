/**
 * auditor-rules — 审计规则单元测试
 * classifyError / generateSuggestions / analyzeUserModel / analyzeCircuitHealth
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const { tmpHome, tmpEvents, eventsFile, mockLogger, mockGetStats } = vi.hoisted(() => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const tmpEvents = fs.mkdtempSync(path.join(os.tmpdir(), 'auditor-rules-events-'));
  const eventsFile = path.join(tmpEvents, 'studio-events.jsonl');
  // D18: 统一事件文件按测试文件隔离（resolveStudioEventsFile 懒读 env）
  process.env.STUDIO_EVENTS_FILE = eventsFile;
  return {
    tmpHome: fs.mkdtempSync(path.join(os.tmpdir(), 'auditor-rules-home-')),
    tmpEvents,
    eventsFile,
    mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    mockGetStats: vi.fn(() => ({ total: 0 })),
  };
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => tmpHome };
});

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared')>();
  return { ...actual, logger: mockLogger };
});

vi.mock('../../knowledge/knowledge-service.js', () => ({
  knowledgeService: { getStats: mockGetStats },
}));

import { skillStore } from '../../skills/skill-store.js';
import {
  classifyError,
  studioEventsJsonl,
  generateSuggestions,
  analyzeUserModel,
  analyzeCircuitHealth,
} from '../auditor-rules.js';

/** 模拟 FileStore.readJsonl：读 JSONL 文件，缺失返回 [] */
const fileStoreStub = {
  readJsonl: async (filePath: string) => {
    try {
      return fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    } catch { return []; }
  },
  listDocs: async () => [] as string[],
} as any;

function writeSessionEvents(count: number): void {
  // D18: 历史扁平形态（timestamp 顶层）写入统一事件文件 —— 读方经 getStudioEventTime 兼容
  const eventsJsonl = Array.from({ length: count }, (_, i) => JSON.stringify({
    id: `evt-rules-${i}`,
    type: 'session:summary', source: 'test', payload: '{}', timestamp: new Date().toISOString(),
  })).join('\n');
  fs.writeFileSync(eventsFile, eventsJsonl + '\n', 'utf-8');
}

// ── classifyError ──

describe('classifyError()', () => {
  it('classifies known error categories', () => {
    expect(classifyError('Request timeout after 30s')).toBe('timeout');
    expect(classifyError('operation timed out')).toBe('timeout');
    expect(classifyError('Docker container exited')).toBe('docker');
    expect(classifyError('git worktree add failed')).toBe('git/worktree');
    expect(classifyError('prisma database locked')).toBe('database');
    expect(classifyError('sqlite busy')).toBe('database');
    expect(classifyError('tsc type error')).toBe('type/lint');
    expect(classifyError('eslint lint failed')).toBe('type/lint');
    expect(classifyError('jest test failed')).toBe('test_failure');
    expect(classifyError('listen EADDRINUSE :::3000')).toBe('port_conflict');
    expect(classifyError('EACCES permission denied')).toBe('permission');
    expect(classifyError('llm model token limit exceeded')).toBe('llm/model');
    expect(classifyError('something completely weird')).toBe('other');
  });

  it('handles non-string input gracefully', () => {
    expect(classifyError(null as any)).toBe('other');
    expect(classifyError(12345 as any)).toBe('other');
  });
});

// ── generateSuggestions ──

describe('generateSuggestions()', () => {
  let lowSrId: string;
  let highSrDraftId: string;
  let normalId: string;

  beforeAll(() => {
    writeSessionEvents(5);
  });

  beforeEach(() => {
    skillStore.deleteMany({ name: { startsWith: '__rules_test_' } });

    const s1 = skillStore.create({ companyId: 'rules-test', name: '__rules_test_low_sr', source: 'extraction', status: 'published' });
    skillStore.update(s1.id, { usageCount: 10, successRate: 0.2 });
    lowSrId = s1.id;

    const s2 = skillStore.create({ companyId: 'rules-test', name: '__rules_test_high_sr_draft', source: 'extraction', status: 'draft' });
    skillStore.update(s2.id, { usageCount: 8, successRate: 0.85 });
    highSrDraftId = s2.id;

    const s3 = skillStore.create({ companyId: 'rules-test', name: '__rules_test_normal', source: 'extraction', status: 'published' });
    skillStore.update(s3.id, { usageCount: 20, successRate: 0.6 });
    normalId = s3.id;
  });

  afterAll(() => {
    skillStore.deleteMany({ name: { startsWith: '__rules_test_' } });
  });

  it('detects skill_weight underperform (low) + auto-demote (high) for low-SR published skill', async () => {
    const suggestions = await generateSuggestions(fileStoreStub, new Map(), new Map());
    const forSkill = suggestions.filter(s => s.skillId === lowSrId);

    const underperform = forSkill.find(s => s.risk === 'low' && s.type === 'skill_weight');
    expect(underperform).toBeDefined();
    expect(underperform!.detail).toContain('建议优化 prompt');

    const demote = forSkill.find(s => s.risk === 'high' && s.data?.action === 'demote');
    expect(demote).toBeDefined();
    expect(demote!.detail).toContain('自动降级为 draft');
  });

  it('detects skill_status publish for high-SR draft skill', async () => {
    const suggestions = await generateSuggestions(fileStoreStub, new Map(), new Map());
    const s = suggestions.find(s => s.skillId === highSrDraftId && s.type === 'skill_status');
    expect(s).toBeDefined();
    expect(s!.risk).toBe('low');
    expect(s!.data?.currentStatus).toBe('draft');
  });

  it('does NOT trigger skill rules for normal skills', async () => {
    const suggestions = await generateSuggestions(fileStoreStub, new Map(), new Map());
    // normal: SR 0.6 published, usage 20/5 sessions → 400% usage rate, no rule hits
    expect(suggestions.filter(s => s.skillId === normalId).length).toBe(0);
  });

  it('detects skill_inactive when usage rate < 10% of active sessions', async () => {
    writeSessionEvents(40); // 3 usages / 40 sessions = 7.5% < 10%
    try {
      const s = skillStore.create({ companyId: 'rules-test', name: '__rules_test_inactive', source: 'extraction', status: 'published' });
      skillStore.update(s.id, { usageCount: 3, successRate: 0.6 });

      const suggestions = await generateSuggestions(fileStoreStub, new Map(), new Map());
      const inactive = suggestions.find(s2 => s2.skillId === s.id && s2.data?.usageRate !== undefined);
      expect(inactive).toBeDefined();
      expect(inactive!.risk).toBe('low');
      expect(inactive!.detail).toContain('建议废弃');
    } finally {
      writeSessionEvents(5);
    }
  });

  it('skips skill audit when active sessions < 5', async () => {
    fs.unlinkSync(eventsFile);
    try {
      const suggestions = await generateSuggestions(fileStoreStub, new Map(), new Map());
      expect(suggestions.filter(s => s.skillId).length).toBe(0);
    } finally {
      writeSessionEvents(5);
    }
  });

  it('detects param_tuning: timeout >= 3 + totalErrors >= 5', async () => {
    const agentTypeStats = new Map([['executor', { total: 10, failed: 6 }]]);
    const errorByAgentType = new Map([['executor', new Map([['timeout', 4], ['other', 2]])]]);

    const suggestions = await generateSuggestions(fileStoreStub, agentTypeStats, errorByAgentType);
    const pt = suggestions.filter(s => s.type === 'param_tuning');
    expect(pt.length).toBe(1);
    expect(pt[0].risk).toBe('high');
    expect(pt[0].detail).toContain('sessionTimeoutMinutes');
  });

  it('detects prompt_optimization: failureRate > 0.3 + llm/model dominant', async () => {
    const agentTypeStats = new Map([['analyst', { total: 10, failed: 5 }]]);
    const errorByAgentType = new Map([['analyst', new Map([['llm/model', 4], ['timeout', 1]])]]);

    const suggestions = await generateSuggestions(fileStoreStub, agentTypeStats, errorByAgentType);
    const po = suggestions.filter(s => s.type === 'prompt_optimization');
    expect(po.length).toBe(1);
    expect(po[0].agentType).toBe('analyst');
  });
});

// ── analyzeUserModel ──

describe('analyzeUserModel()', () => {
  const stateFile = path.join(tmpHome, '.claude', 'user-model-state.json');

  afterEach(() => {
    try { fs.unlinkSync(stateFile); } catch {}
  });

  it('returns empty when state file missing', async () => {
    const result = await analyzeUserModel();
    expect(result).toEqual([]);
  });

  it('suggests weight tune for rising/falling patterns and rule promote for heavy lens', async () => {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({
      patterns: {
        foo: { occurrences: 6, trend: 'rising', sessions: ['s1', 's2'] },
        bar: { occurrences: 4, trend: 'falling' },
        baz: { occurrences: 1, trend: 'rising' }, // below threshold
      },
      lensWeights: { security: 3, style: 1 },
    }), 'utf-8');

    const result = await analyzeUserModel();

    const rising = result.find(s => s.data?.concept === 'foo');
    expect(rising).toBeDefined();
    expect(rising!.type).toBe('model_weight_tune');
    expect(rising!.risk).toBe('low');
    expect(rising!.detail).toContain('固化权重');

    const falling = result.find(s => s.data?.concept === 'bar');
    expect(falling).toBeDefined();
    expect(falling!.detail).toContain('降权');

    expect(result.find(s => s.data?.concept === 'baz')).toBeUndefined();

    const lens = result.find(s => s.type === 'derived_rule_promote');
    expect(lens).toBeDefined();
    expect(lens!.risk).toBe('high');
    expect(lens!.data?.lens).toBe('security');
  });

  it('handles malformed state file without throwing', async () => {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, '{not valid json', 'utf-8');
    const result = await analyzeUserModel();
    expect(Array.isArray(result)).toBe(true);
  });
});

// ── analyzeCircuitHealth ──

describe('analyzeCircuitHealth()', () => {
  const prevRepoDir = process.env.REPO_DIR;

  beforeAll(() => {
    // Point REPO_DIR at empty tmp → Circuit 5 (CONTEXT.md scan) skipped deterministically
    process.env.REPO_DIR = tmpHome;
  });

  afterAll(() => {
    if (prevRepoDir === undefined) delete process.env.REPO_DIR;
    else process.env.REPO_DIR = prevRepoDir;
  });

  it('flags cold circuit when knowledge bus is empty', async () => {
    mockGetStats.mockReturnValue({ total: 0 });
    const result = await analyzeCircuitHealth(fileStoreStub);
    expect(result.length).toBe(1);
    expect(result[0].type).toBe('circuit_fix');
    expect(result[0].risk).toBe('high');
    expect(result[0].detail).toContain('知识总线为空');
  });

  it('flags low accumulation when total < 10', async () => {
    mockGetStats.mockReturnValue({ total: 5, pattern: 3, failure: 2 });
    const result = await analyzeCircuitHealth(fileStoreStub);
    const lowTotal = result.find(s => s.detail.includes('仅 5 条'));
    expect(lowTotal).toBeDefined();
    expect(lowTotal!.risk).toBe('high');
  });

  it('flags knowledge island when only one knowledge type exists', async () => {
    mockGetStats.mockReturnValue({ total: 20, pattern: 20 });
    const result = await analyzeCircuitHealth(fileStoreStub);
    const island = result.find(s => s.detail.includes('知识孤岛'));
    expect(island).toBeDefined();
    expect(island!.risk).toBe('high');
  });

  it('returns no circuit_fix when bus is healthy', async () => {
    mockGetStats.mockReturnValue({ total: 50, pattern: 20, failure: 15, trend: 15 });
    const result = await analyzeCircuitHealth(fileStoreStub);
    expect(result.filter(s => s.risk === 'high').length).toBe(0);
  });
});

// ── studioEventsJsonl ──

describe('studioEventsJsonl()', () => {
  it('resolves 统一事件文件（D18，STUDIO_EVENTS_FILE 可覆盖）', () => {
    expect(studioEventsJsonl()).toBe(eventsFile);
  });
});
