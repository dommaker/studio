/**
 * auditor-doc-freshness — doc-freshness issue 处理单元测试
 * handleDocFreshnessIssues / processDocFreshnessIssue / autoFixDocDiffs
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const { tmpHome, tmpRepo, mockLogger, mockExecSync } = vi.hoisted(() => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  return {
    tmpHome: fs.mkdtempSync(path.join(os.tmpdir(), 'auditor-docfresh-home-')),
    tmpRepo: fs.mkdtempSync(path.join(os.tmpdir(), 'auditor-docfresh-repo-')),
    mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    mockExecSync: vi.fn(() => ''),
  };
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => tmpHome };
});

vi.mock('@dommaker/studio-shared', () => ({
  logger: mockLogger,
}));

vi.mock('child_process', () => ({
  execSync: mockExecSync,
}));

import {
  handleDocFreshnessIssues,
  processDocFreshnessIssue,
  autoFixDocDiffs,
} from '../auditor-doc-freshness.js';

/** git 命令在 tmp 非仓库目录下必然失败 — 模拟之（生产代码 catch 住，non-blocking） */
function routeExecSync(report?: any) {
  mockExecSync.mockImplementation(((cmd: string) => {
    if (cmd.includes('ci-doc-freshness-check.sh')) return JSON.stringify(report ?? { summary: { totalDiffs: 0 }, diffs: [] });
    if (cmd.startsWith('git')) throw new Error('not a git repository');
    return '';
  }) as any);
}

const prevRepoDir = process.env.REPO_DIR;

beforeAll(() => {
  process.env.REPO_DIR = tmpRepo;
});

afterAll(() => {
  if (prevRepoDir === undefined) delete process.env.REPO_DIR;
  else process.env.REPO_DIR = prevRepoDir;
});

beforeEach(() => {
  vi.clearAllMocks();
  routeExecSync();
});

// ── autoFixDocDiffs ──

describe('autoFixDocDiffs()', () => {
  const docRel = 'docs/a.md';
  let docAbs: string;

  beforeEach(() => {
    docAbs = path.join(tmpRepo, docRel);
    fs.mkdirSync(path.dirname(docAbs), { recursive: true });
    fs.writeFileSync(docAbs, 'timeout is 30 seconds\nother line here\n', 'utf-8');
  });

  it('fixes diff by explicit line number', async () => {
    const summary = await autoFixDocDiffs([{
      doc: docRel, type: 'numeric', claim: 'timeout 30', expected: '60', actual: '30', line: 1,
    }], tmpRepo);

    expect(fs.readFileSync(docAbs, 'utf-8')).toContain('timeout is 60 seconds');
    expect(summary).toContain('已自动修复 1 处');
    expect(summary).toContain(`${docRel} L1`);
    // git commit attempted (and failed in non-repo tmp — non-blocking)
    expect(mockExecSync.mock.calls.some(c => String(c[0]).includes('git checkout -b'))).toBe(true);
  });

  it('locates target line by searching actual value when line missing', async () => {
    const summary = await autoFixDocDiffs([{
      doc: docRel, type: 'status', claim: 'c', expected: 'another', actual: 'other',
    }], tmpRepo);

    expect(fs.readFileSync(docAbs, 'utf-8')).toContain('another line here');
    expect(summary).toContain(`${docRel} L2`);
  });

  it('reports failure for missing file and returns empty summary when nothing fixed', async () => {
    const summary = await autoFixDocDiffs([{
      doc: 'docs/nonexistent.md', type: 'numeric', claim: 'c', expected: '1', actual: '2',
    }], tmpRepo);
    expect(summary).toBe('');
  });

  it('reports failure for missing expected/actual values', async () => {
    const summary = await autoFixDocDiffs([{
      doc: docRel, type: 'numeric', claim: 'c', expected: '', actual: '30',
    }], tmpRepo);
    expect(summary).toBe('');
  });

  it('reports failure when actual value cannot be located', async () => {
    const summary = await autoFixDocDiffs([{
      doc: docRel, type: 'numeric', claim: 'c', expected: 'x', actual: 'not-in-file',
    }], tmpRepo);
    expect(summary).toBe('');
  });

  it('summarizes mixed fixed + failed diffs', async () => {
    const summary = await autoFixDocDiffs([
      { doc: docRel, type: 'numeric', claim: 'c', expected: '60', actual: '30', line: 1 },
      { doc: 'docs/missing.md', type: 'numeric', claim: 'c', expected: '1', actual: '2' },
    ], tmpRepo);

    expect(summary).toContain('已自动修复 1 处');
    expect(summary).toContain('1 处修复失败');
  });
});

// ── processDocFreshnessIssue ──

describe('processDocFreshnessIssue()', () => {
  const issue = { number: 42, title: '[doc-freshness] a.md', body: '', labels: ['doc-freshness'] };

  it('comments and closes when diff report cannot be parsed', async () => {
    await processDocFreshnessIssue({ ...issue, body: 'no table here' }, mockExecSync as any);

    const cmds = mockExecSync.mock.calls.map(c => String(c[0]));
    expect(cmds.some(c => c.includes('gh issue comment 42') && c.includes('无法解析差异报告'))).toBe(true);
    expect(cmds.some(c => c.includes('gh issue close 42'))).toBe(true);
  });

  it('closes when re-check shows diffs resolved', async () => {
    routeExecSync({ summary: { totalDiffs: 0 }, diffs: [] });
    await processDocFreshnessIssue({ ...issue, body: '| numeric | 2 |' }, mockExecSync as any);

    const cmds = mockExecSync.mock.calls.map(c => String(c[0]));
    expect(cmds.some(c => c.includes('差异已消失'))).toBe(true);
    expect(cmds.some(c => c.includes('gh issue close 42'))).toBe(true);
  });

  it('auto-fixes numeric diffs, creates PR and closes', async () => {
    const docAbs = path.join(tmpRepo, 'docs/a.md');
    fs.mkdirSync(path.dirname(docAbs), { recursive: true });
    fs.writeFileSync(docAbs, 'timeout is 30 seconds\n', 'utf-8');

    routeExecSync({
      summary: { totalDiffs: 1 },
      diffs: [{ type: 'numeric', doc: 'docs/a.md', claim: 'timeout 30', expected: '60', actual: '30', line: 1 }],
    });
    await processDocFreshnessIssue({ ...issue, body: '| numeric | 1 |' }, mockExecSync as any);

    expect(fs.readFileSync(docAbs, 'utf-8')).toContain('60 seconds');
    const cmds = mockExecSync.mock.calls.map(c => String(c[0]));
    expect(cmds.some(c => c.includes('gh pr create'))).toBe(true);
    expect(cmds.some(c => c.includes('Auditor 自动处理报告'))).toBe(true);
    expect(cmds.some(c => c.includes('gh issue close 42'))).toBe(true);
  });

  it('keeps issue open for narrative-only diffs', async () => {
    routeExecSync({
      summary: { totalDiffs: 1 },
      diffs: [{ type: 'narrative', doc: 'docs/b.md', line: 3, claim: 'claims X', actual: 'Y' }],
    });
    await processDocFreshnessIssue({ ...issue, body: '| narrative | 1 |' }, mockExecSync as any);

    const cmds = mockExecSync.mock.calls.map(c => String(c[0]));
    expect(cmds.some(c => c.includes('gh issue comment 42'))).toBe(true);
    expect(cmds.some(c => c.includes('gh issue close 42'))).toBe(false);
    expect(cmds.some(c => c.includes('gh pr create'))).toBe(false);
  });
});

// ── handleDocFreshnessIssues ──

describe('handleDocFreshnessIssues()', () => {
  it('logs and returns when no open issues', async () => {
    mockExecSync.mockImplementation((() => '[]') as any);
    await handleDocFreshnessIssues();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockLogger.info).toHaveBeenCalledWith('[AuditorAgent] No open doc-freshness issues');
  });

  it('returns gracefully when gh CLI fails', async () => {
    mockExecSync.mockImplementation((() => { throw new Error('gh not found'); }) as any);
    await expect(handleDocFreshnessIssues()).resolves.toBeUndefined();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      '[AuditorAgent] gh issue list failed (gh CLI not available?)',
      expect.objectContaining({ error: expect.any(String) }),
    );
  });

  it('processes each listed issue', async () => {
    mockExecSync.mockImplementation(((cmd: string) => {
      if (cmd.includes('gh issue list')) {
        return JSON.stringify([{ number: 7, title: 't', body: 'unparseable', labels: ['doc-freshness'] }]);
      }
      return '';
    }) as any);
    await handleDocFreshnessIssues();

    const cmds = mockExecSync.mock.calls.map(c => String(c[0]));
    expect(cmds.some(c => c.includes('gh issue comment 7'))).toBe(true);
    expect(cmds.some(c => c.includes('gh issue close 7'))).toBe(true);
  });
});
