import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { forceCommit } from '../git-utils';

const TEST_DIR = join('/tmp', `git-utils-test-${Date.now()}`);

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  // Initialize git repo
  execSync('git init', { cwd: TEST_DIR });
  execSync('git config user.email "test@test.com"', { cwd: TEST_DIR });
  execSync('git config user.name "Test"', { cwd: TEST_DIR });
  // Need at least one commit for HEAD to exist
  execSync('touch README.md && git add . && git commit -m "init"', { cwd: TEST_DIR });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('forceCommit', () => {
  it('returns commitHash when there are changes to commit', () => {
    // Create a file with changes
    const filePath = join(TEST_DIR, 'test.txt');
    execSync('echo "hello" > test.txt', { cwd: TEST_DIR });

    const result = forceCommit(TEST_DIR, 'feat: add test file');

    expect(result.success).toBe(true);
    expect(result.commitHash).toBeDefined();
    expect(typeof result.commitHash).toBe('string');
    expect(result.commitHash!.length).toBeGreaterThan(0);

    // Verify the commit was actually made
    const log = execSync('git log --oneline -1', { cwd: TEST_DIR, encoding: 'utf-8' });
    expect(log).toContain('feat: add test file');
  });

  it('returns undefined commitHash when there are no changes', () => {
    const result = forceCommit(TEST_DIR, 'feat: no changes');

    expect(result.success).toBe(true);
    expect(result.commitHash).toBeUndefined();
  });

  it('correctly escapes double quotes in message', () => {
    execSync('echo "change" > quoted.txt', { cwd: TEST_DIR });

    const result = forceCommit(TEST_DIR, 'feat: add "feature X"');

    expect(result.success).toBe(true);
    expect(result.commitHash).toBeDefined();

    const log = execSync('git log --oneline -1', { cwd: TEST_DIR, encoding: 'utf-8' });
    expect(log).toContain('feature X');
  });

  it('throws on non-git directory', () => {
    const nonGitDir = join(TEST_DIR, 'not-a-repo');
    mkdirSync(nonGitDir);

    expect(() => forceCommit(nonGitDir, 'test')).toThrow();
  });
});
