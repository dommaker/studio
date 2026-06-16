/**
 * Contract Test RED Check tests — Layer 4
 *
 * CT-3 monitoring: RED verification results
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  verifyRedState,
  cleanupRedCheckFiles,
  type RedCheckInput,
} from '../contract-test-red-check.js';

// Mock child_process to avoid actual vitest execution
vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

import { execSync } from 'child_process';
const mockExecSync = vi.mocked(execSync);

describe('verifyRedState', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-red-check-'));
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes test file to worktree', () => {
    mockExecSync.mockReturnValue(JSON.stringify({
      numTotalTests: 1,
      numFailedTests: 0,
    }));

    const input: RedCheckInput = {
      acGroupId: 'g1',
      contractTests: [{
        file: 'test/g1.test.ts',
        content: `it('test1', () => {});`,
      }],
      worktree: tmpDir,
    };

    verifyRedState(input);

    const testPath = path.join(tmpDir, 'test/g1.test.ts');
    expect(fs.existsSync(testPath)).toBe(true);
    const content = fs.readFileSync(testPath, 'utf-8');
    expect(content).toBe(`it('test1', () => {});`);
  });

  it('detects RED state (test failure)', () => {
    mockExecSync.mockImplementation(() => {
      const err = new Error('Test failed') as Error & { status: number; stdout: string; stderr: string };
      err.status = 1;
      err.stdout = JSON.stringify({
        numTotalTests: 2,
        numFailedTests: 2,
      });
      err.stderr = '';
      throw err;
    });

    const input: RedCheckInput = {
      acGroupId: 'g1',
      contractTests: [{
        file: 'g1.test.ts',
        content: `it('test1', () => { expect(1).toBe(2); });`,
      }],
      worktree: tmpDir,
    };

    const result = verifyRedState(input);

    expect(result.files[0].isRed).toBe(true);
    expect(result.files[0].failureType).toBe('failed');
    expect(result.files[0].exitCode).toBe(1);
    expect(result.files[0].failureCount).toBe(2);
    expect(result.overallRed).toBe(true);
  });

  it('detects non-RED state (tests pass)', () => {
    mockExecSync.mockReturnValue(JSON.stringify({
      numTotalTests: 1,
      numFailedTests: 0,
    }));

    const input: RedCheckInput = {
      acGroupId: 'g1',
      contractTests: [{
        file: 'g1.test.ts',
        content: `it('test1', () => {});`,
      }],
      worktree: tmpDir,
    };

    const result = verifyRedState(input);

    expect(result.files[0].isRed).toBe(false);
    expect(result.files[0].failureType).toBe('passed');
    expect(result.files[0].exitCode).toBe(0);
    expect(result.overallRed).toBe(false);
  });

  it('detects syntax error', () => {
    mockExecSync.mockImplementation(() => {
      const err = new Error('Syntax error') as Error & { status: number; stdout: string; stderr: string };
      err.status = 2;
      err.stdout = 'SyntaxError: Unexpected token';
      err.stderr = '';
      throw err;
    });

    const input: RedCheckInput = {
      acGroupId: 'g1',
      contractTests: [{
        file: 'g1.test.ts',
        content: `invalid javascript {{{`,
      }],
      worktree: tmpDir,
    };

    const result = verifyRedState(input);

    expect(result.files[0].isRed).toBe(false);
    expect(result.files[0].failureType).toBe('syntax_error');
  });

  it('handles write failure', () => {
    // Create a directory where we want to write a file, so writeFileSync will fail
    const blockedPath = path.join(tmpDir, 'test.ts');
    fs.mkdirSync(blockedPath, { recursive: true }); // Create a directory, not a file

    const input: RedCheckInput = {
      acGroupId: 'g1',
      contractTests: [{
        file: 'test.ts', // This will try to write to a directory
        content: `it('test', () => {});`,
      }],
      worktree: tmpDir,
    };

    const result = verifyRedState(input);

    expect(result.files[0].written).toBe(false);
    expect(result.files[0].isRed).toBe(false);
    expect(result.files[0].failureType).toBe('error');
  });

  it('aggregates multiple files', () => {
    mockExecSync.mockImplementation(() => {
      const err = new Error('Test failed') as Error & { status: number; stdout: string; stderr: string };
      err.status = 1;
      err.stdout = JSON.stringify({
        numTotalTests: 1,
        numFailedTests: 1,
      });
      err.stderr = '';
      throw err;
    });

    const input: RedCheckInput = {
      acGroupId: 'g1',
      contractTests: [
        { file: 'a.test.ts', content: `it('a', () => {});` },
        { file: 'b.test.ts', content: `it('b', () => {});` },
      ],
      worktree: tmpDir,
    };

    const result = verifyRedState(input);

    expect(result.files.length).toBe(2);
    expect(result.totalTests).toBe(2);
    expect(result.totalFailures).toBe(2);
    expect(result.overallRed).toBe(true);
  });

  it('overallRed is false if any file is not RED', () => {
    let callCount = 0;
    mockExecSync.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // First file: RED (failure)
        const err = new Error('Test failed') as Error & { status: number; stdout: string; stderr: string };
        err.status = 1;
        err.stdout = JSON.stringify({ numTotalTests: 1, numFailedTests: 1 });
        err.stderr = '';
        throw err;
      } else {
        // Second file: not RED (pass)
        return JSON.stringify({ numTotalTests: 1, numFailedTests: 0 });
      }
    });

    const input: RedCheckInput = {
      acGroupId: 'g1',
      contractTests: [
        { file: 'a.test.ts', content: `it('a', () => {});` },
        { file: 'b.test.ts', content: `it('b', () => {});` },
      ],
      worktree: tmpDir,
    };

    const result = verifyRedState(input);

    expect(result.files[0].isRed).toBe(true);
    expect(result.files[1].isRed).toBe(false);
    expect(result.overallRed).toBe(false);
  });
});

describe('cleanupRedCheckFiles', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-red-cleanup-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('removes written test files', () => {
    const testPath = path.join(tmpDir, 'test.ts');
    fs.writeFileSync(testPath, 'content');

    cleanupRedCheckFiles(tmpDir, [{ file: 'test.ts' }]);

    expect(fs.existsSync(testPath)).toBe(false);
  });

  it('does not throw for non-existing files', () => {
    expect(() => {
      cleanupRedCheckFiles(tmpDir, [{ file: 'nonexistent.ts' }]);
    }).not.toThrow();
  });
});
