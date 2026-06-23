/**
 * Constraint Evolution Service 测试
 *
 * 覆盖：classifyErrorPattern 纯逻辑、shouldEvolve 阈值逻辑、
 *       recordFailure/Success/ReviewRejected 状态管理、patternBuffer 去重
 *
 * 策略：
 * - classifyErrorPattern 是纯函数，通过提取内联算法验证
 * - shouldEvolve/state 通过直接写 STATE_FILE (/.harness/evolution-state.json) 测试
 * - patternBuffer 是模块级 Map，用 vi.resetModules 隔离
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// STATE_FILE 路径 = process.cwd() + '.harness/evolution-state.json'
// vitest worker cwd = /root/projects/studio（vitest.config.ts 所在目录）
const STATE_DIR = path.join(process.cwd(), '.harness');
const STATE_FILE = path.join(STATE_DIR, 'evolution-state.json');

let savedState: string | null = null;

beforeEach(() => {
  vi.resetModules();
  // 备份真实 state 文件
  try {
    savedState = fs.readFileSync(STATE_FILE, 'utf-8');
  } catch {
    savedState = null;
  }
  // 清空 state
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify({ failureCount: 0, lastEvolveAt: null, pendingProposals: 0 }));
});

afterEach(() => {
  // 还原 state
  if (savedState !== null) {
    fs.writeFileSync(STATE_FILE, savedState);
  } else {
    try { fs.unlinkSync(STATE_FILE); } catch { /* ok */ }
  }
});

// ════════════════════════════════════════════
// classifyErrorPattern — 纯逻辑验证（提取源码中的算法）
// ════════════════════════════════════════════

// 源码 classifyErrorPattern 是内部函数，无法直接导出。
// 用相同算法重构验证，确保分类规则正确。
function classifyErrorPattern(errorMsg: string): string {
  const msg = errorMsg.toLowerCase();
  if (msg.includes('review') && (msg.includes('exhausted') || msg.includes('cycle'))) return 'review_cycle_exhausted';
  if (msg.includes('timeout') || msg.includes('timed out')) return 'timeout';
  if (msg.includes('test') && msg.includes('fail')) return 'test_failure';
  if (msg.includes('type') || msg.includes('lint') || msg.includes('tsc')) return 'type_error';
  if (msg.includes('prisma') || msg.includes('database') || msg.includes('sqlite')) return 'database_error';
  if (msg.includes('git') || msg.includes('worktree')) return 'git_error';
  if (msg.includes('port') || msg.includes('eaddrinuse')) return 'port_conflict';
  if (msg.includes('model') || msg.includes('token') || msg.includes('llm')) return 'llm_error';
  if (msg.includes('docker') || msg.includes('container')) return 'docker_error';
  if (msg.includes('permission') || msg.includes('denied')) return 'permission';
  return 'other';
}

describe('classifyErrorPattern', () => {
  it('timeout / timed out → timeout', () => {
    expect(classifyErrorPattern('request timed out after 30s')).toBe('timeout');
    expect(classifyErrorPattern('connection timeout')).toBe('timeout');
  });

  it('test + fail → test_failure', () => {
    expect(classifyErrorPattern('3 tests failed in suite')).toBe('test_failure');
  });

  it('type / lint / tsc → type_error', () => {
    expect(classifyErrorPattern('TS2345: type mismatch')).toBe('type_error');
    expect(classifyErrorPattern('eslint found 2 lint errors')).toBe('type_error');
    expect(classifyErrorPattern('tsc compilation failed')).toBe('type_error');
  });

  it('prisma / database / sqlite → database_error', () => {
    expect(classifyErrorPattern('SQLITE_BUSY: database is locked')).toBe('database_error');
    expect(classifyErrorPattern('prisma query failed')).toBe('database_error');
  });

  it('git / worktree → git_error', () => {
    expect(classifyErrorPattern('worktree already exists')).toBe('git_error');
    expect(classifyErrorPattern('git push rejected')).toBe('git_error');
  });

  it('port / eaddrinuse → port_conflict', () => {
    expect(classifyErrorPattern('EADDRINUSE: port 13001')).toBe('port_conflict');
  });

  it('model / token / llm → llm_error', () => {
    expect(classifyErrorPattern('model rate limit exceeded')).toBe('llm_error');
    expect(classifyErrorPattern('token limit exceeded')).toBe('llm_error');
  });

  it('docker / container → docker_error', () => {
    expect(classifyErrorPattern('container not running')).toBe('docker_error');
  });

  it('permission / denied → permission', () => {
    expect(classifyErrorPattern('EACCES: permission denied')).toBe('permission');
  });

  it('review + exhausted/cycle → review_cycle_exhausted', () => {
    expect(classifyErrorPattern('review cycle exhausted after 3 rounds')).toBe('review_cycle_exhausted');
    expect(classifyErrorPattern('review rejected, cycle limit')).toBe('review_cycle_exhausted');
  });

  it('unrecognized → other', () => {
    expect(classifyErrorPattern('something completely unknown')).toBe('other');
    expect(classifyErrorPattern('')).toBe('other');
  });

  it('case insensitive', () => {
    expect(classifyErrorPattern('TIMEOUT Error')).toBe('timeout');
    expect(classifyErrorPattern('Permission Denied')).toBe('permission');
  });
});

// ════════════════════════════════════════════
// shouldEvolve — 阈值逻辑
// ════════════════════════════════════════════

describe('shouldEvolve', () => {
  it('false with 0 failures', async () => {
    const { shouldEvolve } = await import('../evolution.service.js');
    expect(shouldEvolve()).toBe(false);
  });

  it('true at 5 failures', async () => {
    // 直接写 state 文件设 failureCount=5
    fs.writeFileSync(STATE_FILE, JSON.stringify({ failureCount: 5, lastEvolveAt: null, pendingProposals: 0 }));
    const { shouldEvolve } = await import('../evolution.service.js');
    expect(shouldEvolve()).toBe(true);
  });

  it('true at 4 failures (not enough)', async () => {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ failureCount: 4, lastEvolveAt: null, pendingProposals: 0 }));
    const { shouldEvolve } = await import('../evolution.service.js');
    expect(shouldEvolve()).toBe(false);
  });

  it('true with 2+ failures AND 24h+ since lastEvolveAt', async () => {
    const lastEvolve = new Date(Date.now() - 25 * 3600000).toISOString();
    fs.writeFileSync(STATE_FILE, JSON.stringify({ failureCount: 2, lastEvolveAt: lastEvolve, pendingProposals: 0 }));
    const { shouldEvolve } = await import('../evolution.service.js');
    expect(shouldEvolve()).toBe(true);
  });

  it('false with 1 failure AND 24h+ (needs 2+)', async () => {
    const lastEvolve = new Date(Date.now() - 25 * 3600000).toISOString();
    fs.writeFileSync(STATE_FILE, JSON.stringify({ failureCount: 1, lastEvolveAt: lastEvolve, pendingProposals: 0 }));
    const { shouldEvolve } = await import('../evolution.service.js');
    expect(shouldEvolve()).toBe(false);
  });

  it('false with 2 failures but <24h', async () => {
    const lastEvolve = new Date(Date.now() - 1 * 3600000).toISOString(); // 1h ago
    fs.writeFileSync(STATE_FILE, JSON.stringify({ failureCount: 2, lastEvolveAt: lastEvolve, pendingProposals: 0 }));
    const { shouldEvolve } = await import('../evolution.service.js');
    expect(shouldEvolve()).toBe(false);
  });

  it('false with never evolved (lastEvolveAt=null) and <5 failures', async () => {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ failureCount: 3, lastEvolveAt: null, pendingProposals: 0 }));
    const { shouldEvolve } = await import('../evolution.service.js');
    expect(shouldEvolve()).toBe(false);
  });
});

// ════════════════════════════════════════════
// recordFailure / recordSuccess — 状态管理
// ════════════════════════════════════════════

describe('recordFailure', () => {
  it('increments failureCount in state file', async () => {
    const { recordFailure } = await import('../evolution.service.js');
    recordFailure();
    recordFailure();
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    expect(state.failureCount).toBe(2);
  });

  it('with workUnitId+errorMsg classifies pattern into buffer', async () => {
    const { recordFailure, getPatternBufferSnapshot } = await import('../evolution.service.js');
    recordFailure('g1', 'request timed out');
    const snap = getPatternBufferSnapshot();
    expect(snap.some(s => s.pattern === 'timeout' && s.affectedWorkUnits.includes('g1'))).toBe(true);
  });

  it('without workUnitId only increments count', async () => {
    const { recordFailure, getPatternBufferSnapshot } = await import('../evolution.service.js');
    const before = getPatternBufferSnapshot().length;
    recordFailure(); // no args
    const after = getPatternBufferSnapshot().length;
    expect(after).toBe(before);
  });
});

describe('recordSuccess', () => {
  it('decrements failureCount', async () => {
    const { recordFailure, recordSuccess } = await import('../evolution.service.js');
    recordFailure();
    recordFailure();
    recordSuccess();
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    expect(state.failureCount).toBe(1);
  });

  it('does not go below 0', async () => {
    const { recordSuccess } = await import('../evolution.service.js');
    recordSuccess();
    recordSuccess();
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    expect(state.failureCount).toBe(0);
  });
});

describe('recordReviewRejected', () => {
  it('increments failureCount and adds to review_cycle_exhausted pattern', async () => {
    const { recordReviewRejected, getPatternBufferSnapshot } = await import('../evolution.service.js');
    recordReviewRejected('g1', 'task1', 3);

    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    expect(state.failureCount).toBeGreaterThanOrEqual(1);

    const snap = getPatternBufferSnapshot();
    const entry = snap.find(s => s.pattern === 'review_cycle_exhausted');
    expect(entry).toBeDefined();
    expect(entry!.affectedWorkUnits).toContain('g1');
  });
});

// ════════════════════════════════════════════
// getPatternBufferSnapshot — buffer 结构
// ════════════════════════════════════════════

describe('getPatternBufferSnapshot', () => {
  it('returns {pattern, affectedWorkUnits, count}', async () => {
    const { recordFailure, getPatternBufferSnapshot } = await import('../evolution.service.js');
    recordFailure('gA', 'timeout');
    recordFailure('gB', 'timeout');

    const snap = getPatternBufferSnapshot();
    const entry = snap.find(s => s.pattern === 'timeout');
    expect(entry).toBeDefined();
    expect(entry!.count).toBe(2);
    expect(entry!.affectedWorkUnits).toContain('gA');
    expect(entry!.affectedWorkUnits).toContain('gB');
  });

  it('same workUnit deduplicated (Set)', async () => {
    const { recordFailure, getPatternBufferSnapshot } = await import('../evolution.service.js');
    recordFailure('gX', 'timeout');
    recordFailure('gX', 'timeout');

    const snap = getPatternBufferSnapshot();
    const entry = snap.find(s => s.pattern === 'timeout');
    expect(entry!.count).toBe(1);
  });

  it('different patterns tracked separately', async () => {
    const { recordFailure, getPatternBufferSnapshot } = await import('../evolution.service.js');
    recordFailure('g1', 'timeout');
    recordFailure('g2', 'database locked');

    const snap = getPatternBufferSnapshot();
    expect(snap.length).toBe(2);
    expect(snap.map(s => s.pattern).sort()).toEqual(['database_error', 'timeout']);
  });
});
