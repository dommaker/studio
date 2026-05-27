// DeployAgent mergeBranches + pushBranch tests
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSh } from '@dommaker/studio-shared/node';
import { deployAgent } from '../deploy-agent.service.js';

// Create a temp git repo for testing merge operations
const tmpDir = path.join(os.tmpdir(), `deploy-agent-test-${Date.now()}`);

describe('DeployAgent (topology-agnostic)', () => {
  beforeAll(async () => {
    // Create a temporary bare git repo structure for testing
    fs.mkdirSync(tmpDir, { recursive: true });
    await execSh('git init', { cwd: tmpDir, timeoutMs: 10_000 });
    await execSh('git config user.email "test@test.com"', { cwd: tmpDir, timeoutMs: 5_000 });
    await execSh('git config user.name "Test"', { cwd: tmpDir, timeoutMs: 5_000 });

    // Create initial commit on master
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Test');
    await execSh('git add README.md && git commit -m "initial"', { cwd: tmpDir, timeoutMs: 10_000 });

    // Create a feature branch with changes
    await execSh('git checkout -b feature/test', { cwd: tmpDir, timeoutMs: 10_000 });
    fs.writeFileSync(path.join(tmpDir, 'FEATURE.md'), '# Feature');
    await execSh('git add FEATURE.md && git commit -m "feat: test feature"', { cwd: tmpDir, timeoutMs: 10_000 });

    // Back to master
    await execSh('git checkout master', { cwd: tmpDir, timeoutMs: 10_000 });
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── mergeBranches ──

  describe('mergeBranches()', () => {
    it('merges source branch into target branch', async () => {
      const result = await deployAgent.mergeBranches({
        source: 'feature/test',
        target: 'master',
        repoPath: tmpDir,
      });

      expect(result.success).toBe(true);
      expect(result.merged).toBe(true);
      expect(result.summary).toContain('feature/test');
      expect(result.summary).toContain('master');
    });

    it('returns failure for non-existent branch', async () => {
      const result = await deployAgent.mergeBranches({
        source: 'nonexistent/branch',
        target: 'master',
        repoPath: tmpDir,
      });

      expect(result.success).toBe(false);
      expect(result.merged).toBe(false);
    });

    it('same branch merge is a no-op success', async () => {
      const result = await deployAgent.mergeBranches({
        source: 'master',
        target: 'master',
        repoPath: tmpDir,
      });

      // git merge self is a valid no-op (Already up to date)
      expect(result.success).toBe(true);
      expect(result.merged).toBe(true);
    });
  });

  // ── pushBranch ──

  describe('pushBranch()', () => {
    it('reports failure when no remote configured', async () => {
      const result = await deployAgent.pushBranch({
        branch: 'master',
        repoDir: tmpDir,
      });

      // No remote configured in temp repo — pre-flight catches it before push
      expect(result.success).toBe(false);
      expect(result.summary).toMatch(/cannot reach origin/i);
    });

    it('returns correct shape on failure', async () => {
      const result = await deployAgent.pushBranch({
        branch: 'master',
      });

      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('summary');
      expect(typeof result.success).toBe('boolean');
      expect(typeof result.summary).toBe('string');
    });
  });

  // ── mergeBranches with push=true ──

  describe('mergeBranches() with push', () => {
    beforeAll(async () => {
      // Reset repo state: checkout master, create another test branch
      await execSh('git checkout master', { cwd: tmpDir, timeoutMs: 10_000 });
      await execSh('git checkout -b feature/another-test', { cwd: tmpDir, timeoutMs: 10_000 });
      fs.writeFileSync(path.join(tmpDir, 'ANOTHER.md'), '# Another');
      await execSh('git add ANOTHER.md && git commit -m "another test"', { cwd: tmpDir, timeoutMs: 10_000 });
      await execSh('git checkout master', { cwd: tmpDir, timeoutMs: 10_000 });
    });

    it('attempts push when push=true (fails gracefully without remote)', async () => {
      const result = await deployAgent.mergeBranches({
        source: 'feature/another-test',
        target: 'master',
        repoPath: tmpDir,
        push: true,
      });

      // Merge should succeed, push should fail (no remote)
      expect(result.merged).toBe(true);
      expect(result.pushed).toBe(false);
    });

    it('does not push when push is false/omitted', async () => {
      // Reset and create yet another branch
      await execSh('git checkout master', { cwd: tmpDir, timeoutMs: 10_000 });
      await execSh('git checkout -b feature/no-push-test', { cwd: tmpDir, timeoutMs: 10_000 });
      fs.writeFileSync(path.join(tmpDir, 'NO_PUSH.md'), '# no push');
      await execSh('git add NO_PUSH.md && git commit -m "no push"', { cwd: tmpDir, timeoutMs: 10_000 });
      await execSh('git checkout master', { cwd: tmpDir, timeoutMs: 10_000 });

      const result = await deployAgent.mergeBranches({
        source: 'feature/no-push-test',
        target: 'master',
        repoPath: tmpDir,
      });

      expect(result.merged).toBe(true);
      expect(result.pushed).toBe(false);
    });
  });
});
