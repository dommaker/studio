/**
 * Behavioral tests for runner-briefing.ts
 *
 * Wave-4: writeRequirementsMd cases moved from worktree-resolver.test.ts;
 * buildCachePrefix lockfile-detection matrix and writeContractTests added.
 *
 * Strategy: mock fs + logger, let real code run, assert on written content.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockExistsSync, mockReadFileSync, mockWriteFile, mockMkdir } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockWriteFile: vi.fn().mockResolvedValue(undefined),
  mockMkdir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
  };
});

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    writeFile: mockWriteFile,
    mkdir: mockMkdir,
  };
});

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared')>();
  return {
    ...actual,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});

import { buildCachePrefix, writeRequirementsMd, writeContractTests } from '../runner-briefing.js';
import type { AgentTask } from '../types.js';

function makeTask(overrides?: AgentTask['parameters']): AgentTask {
  return {
    id: 'task-1',
    executionId: 'exec-1',
    provider: 'claude',
    prompt: 'do something',
    parameters: { ...overrides },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockWriteFile.mockResolvedValue(undefined);
  mockMkdir.mockResolvedValue(undefined);
});

describe('buildCachePrefix()', () => {
  test('detects pnpm from pnpm-lock.yaml', () => {
    mockExistsSync.mockImplementation((p: string) => p.endsWith('/pnpm-lock.yaml'));
    mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT'); });

    const prefix = buildCachePrefix('/repo');

    expect(prefix).toContain('- 包管理器: pnpm');
    expect(prefix).toContain('- 安装依赖: `pnpm install`');
    expect(prefix).toContain('- 运行测试: `pnpm test`');
    expect(prefix).toContain('SHARED_CACHE_PREFIX');
  });

  test('detects yarn from yarn.lock (no pnpm-lock.yaml)', () => {
    mockExistsSync.mockImplementation((p: string) => p.endsWith('/yarn.lock'));
    mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT'); });

    const prefix = buildCachePrefix('/repo');

    expect(prefix).toContain('- 包管理器: yarn');
    expect(prefix).toContain('- 安装依赖: `yarn install`');
    expect(prefix).toContain('- 运行测试: `yarn test`');
  });

  test('falls back to npm when no pnpm/yarn lockfile', () => {
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT'); });

    const prefix = buildCachePrefix('/repo');

    expect(prefix).toContain('- 包管理器: npm');
    expect(prefix).toContain('- 安装依赖: `npm install`');
    expect(prefix).toContain('- 运行测试: `npm test`');
  });

  test('appends CLAUDE.md content when present', () => {
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockReturnValue('# CLAUDE RULES');

    const prefix = buildCachePrefix('/repo');

    expect(prefix).toContain('# CLAUDE RULES');
  });

  test('omits CLAUDE.md section when read fails', () => {
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT'); });

    const prefix = buildCachePrefix('/repo');

    expect(prefix).not.toContain('# CLAUDE RULES');
  });
});

describe('writeRequirementsMd()', () => {
  const task = makeTask();

  beforeEach(() => {
    mockWriteFile.mockClear();
  });

  function getWrittenContent(): string {
    const call = mockWriteFile.mock.calls.find(
      (c) => typeof c[1] === 'string' && c[1].includes('# 需求'),
    );
    return call ? call[1] : '';
  }

  test('with testFiles: uses vitest run with specified files, no "npm test" constraint', async () => {
    const testFiles = ['src/foo.test.ts', 'src/bar.test.ts'];
    const acGroup = {
      acs: ['AC1: do thing'],
      files: ['src/foo.ts'],
      implementationNotes: 'use X',
    };

    await writeRequirementsMd('/worktree', task, acGroup, testFiles);

    const content = getWrittenContent();
    expect(content).toContain('npx vitest run src/foo.test.ts src/bar.test.ts');
    expect(content).not.toContain('完成前必须运行 npm test');
    expect(content).toContain('type check');
    expect(content).toContain('lint');
  });

  test('without testFiles: falls back to npm test', async () => {
    const acGroup = {
      acs: ['AC1: do thing'],
      files: ['src/foo.ts'],
    };

    await writeRequirementsMd('/worktree', task, acGroup);

    const content = getWrittenContent();
    expect(content).toContain('完成前必须运行 npm test');
  });

  test('with empty testFiles array: falls back to npm test', async () => {
    const acGroup = {
      acs: ['AC1: do thing'],
      files: ['src/foo.ts'],
    };

    await writeRequirementsMd('/worktree', task, acGroup, []);

    const content = getWrittenContent();
    expect(content).toContain('完成前必须运行 npm test');
  });

  test('with testFiles: progress.json command uses vitest run', async () => {
    const testFiles = ['src/foo.test.ts'];
    const acGroup = { acs: ['AC1'], files: ['src/foo.ts'] };

    await writeRequirementsMd('/worktree', task, acGroup, testFiles);

    const content = getWrittenContent();
    expect(content).toContain('command: "npx vitest run src/foo.test.ts"');
  });

  test('without testFiles: progress.json command uses npm test', async () => {
    const acGroup = { acs: ['AC1'], files: ['src/foo.ts'] };

    await writeRequirementsMd('/worktree', task, acGroup);

    const content = getWrittenContent();
    expect(content).toContain('command: "npm test"');
  });
});

describe('writeContractTests()', () => {
  test('writes each contract test to <worktree>/<file>, creating dirs', async () => {
    const contractTests = [
      { file: '__tests__/ac1.test.ts', content: 'test("ac1", () => {});' },
      { file: '__tests__/nested/ac2.test.ts', content: 'test("ac2", () => {});' },
    ];

    await writeContractTests('/worktree', contractTests);

    expect(mockMkdir).toHaveBeenCalledWith('/worktree/__tests__', { recursive: true });
    expect(mockMkdir).toHaveBeenCalledWith('/worktree/__tests__/nested', { recursive: true });
    expect(mockWriteFile).toHaveBeenCalledWith(
      '/worktree/__tests__/ac1.test.ts', contractTests[0].content, 'utf-8',
    );
    expect(mockWriteFile).toHaveBeenCalledWith(
      '/worktree/__tests__/nested/ac2.test.ts', contractTests[1].content, 'utf-8',
    );
  });

  test('no-op on empty array', async () => {
    await writeContractTests('/worktree', []);

    expect(mockMkdir).not.toHaveBeenCalled();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });
});
