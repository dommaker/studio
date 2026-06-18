// BT-14: Integration 空 merge 检查测试
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

/**
 * 测试策略：创建临时 git repo，验证空 merge 检测逻辑。
 *
 * 检测逻辑（与 scheduler-prompt.ts 一致）：
 *   git merge <branch> --no-ff --no-edit
 *   git diff HEAD@{1} --stat → 空字符串 = empty merge
 */
describe('empty merge detection (BT-14)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'integration-test-'));
    // Init repo with initial commit
    execSync('git init', { cwd: tmpDir });
    execSync('git config user.email "test@test.com"', { cwd: tmpDir });
    execSync('git config user.name "Test"', { cwd: tmpDir });
    fs.writeFileSync(path.join(tmpDir, 'initial.txt'), 'initial');
    execSync('git add -A && git commit -m "initial"', { cwd: tmpDir });
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('detects empty branch merge (no actual changes)', () => {
    // Create a branch without any new commits (same as master)
    execSync('git checkout -b task/empty-branch', { cwd: tmpDir });
    execSync('git checkout master', { cwd: tmpDir });

    // Merge empty branch
    execSync('git merge task/empty-branch --no-ff --no-edit', { cwd: tmpDir });

    // Check diff after merge
    const diffStat = execSync('git diff HEAD@{1} --stat', { cwd: tmpDir }).toString();
    // Empty branch merge → "Already up to date" or empty diff
    expect(diffStat.trim()).toBe('');
  });

  it('non-empty merge has actual changes', () => {
    // Create a branch with actual changes
    execSync('git checkout -b task/real-change', { cwd: tmpDir });
    fs.writeFileSync(path.join(tmpDir, 'new-file.txt'), 'new content');
    execSync('git add -A && git commit -m "add new file"', { cwd: tmpDir });
    execSync('git checkout master', { cwd: tmpDir });

    // Merge branch with changes
    execSync('git merge task/real-change --no-ff --no-edit', { cwd: tmpDir });

    // Check diff after merge
    const diffStat = execSync('git diff HEAD@{1} --stat', { cwd: tmpDir }).toString();
    expect(diffStat.trim().length).toBeGreaterThan(0);
    expect(diffStat).toContain('new-file.txt');
  });

  it('parent diff also works as fallback', () => {
    // Create branch with changes
    execSync('git checkout -b task/change', { cwd: tmpDir });
    fs.writeFileSync(path.join(tmpDir, 'changed.txt'), 'content');
    execSync('git add -A && git commit -m "add"', { cwd: tmpDir });
    execSync('git checkout master', { cwd: tmpDir });
    execSync('git merge task/change --no-ff --no-edit', { cwd: tmpDir });

    const parentDiff = execSync('git diff HEAD^1 HEAD --stat', { cwd: tmpDir }).toString();
    expect(parentDiff.trim().length).toBeGreaterThan(0);
  });
});
