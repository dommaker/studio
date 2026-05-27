/**
 * DeployAgent push resilience tests
 *
 * AC-1: pushBranch() pre-flight git ls-remote connectivity check
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSh } from '@dommaker/studio-shared/node';
import { deployAgent } from '../deploy-agent.service.js';

const tmpDir = path.join(os.tmpdir(), `deploy-resilience-test-${Date.now()}`);

describe('DeployAgent push resilience (AC-1)', () => {
  beforeAll(async () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    await execSh('git init', { cwd: tmpDir, timeoutMs: 10_000 });
    await execSh('git config user.email "test@test.com"', { cwd: tmpDir, timeoutMs: 5_000 });
    await execSh('git config user.name "Test"', { cwd: tmpDir, timeoutMs: 5_000 });
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Test');
    await execSh('git add README.md && git commit -m "initial"', { cwd: tmpDir, timeoutMs: 10_000 });
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ============================================================
  // AC-1: pushBranch pre-flight connectivity check
  // ============================================================
  describe('pushBranch() pre-flight', () => {
    it('AC-1.1: pushBranch aborts when git ls-remote fails (no remote)', async () => {
      // No remote configured → git ls-remote fails → push should abort
      const result = await deployAgent.pushBranch({
        branch: 'master',
        repoDir: tmpDir,
      });

      expect(result.success).toBe(false);
      expect(result.summary).toMatch(/cannot reach origin/i);
      // Should NOT attempt push (no "Push failed" from actual push)
      expect(result.summary).not.toContain('Push failed');
    });

    it('AC-1.2: pushBranch with a real remote passes pre-flight then attempts push', async () => {
      // Create another temp repo to use as a fake remote
      const fakeRemoteDir = path.join(os.tmpdir(), `fake-remote-${Date.now()}`);
      fs.mkdirSync(fakeRemoteDir, { recursive: true });
      try {
        await execSh('git init --bare', { cwd: fakeRemoteDir, timeoutMs: 10_000 });

        // Add as remote
        await execSh(`git remote add origin ${fakeRemoteDir}`, { cwd: tmpDir, timeoutMs: 10_000 });

        const result = await deployAgent.pushBranch({
          branch: 'master',
          repoDir: tmpDir,
        });

        // ls-remote succeeds, push should succeed (to local bare repo)
        expect(result.success).toBe(true);
        expect(result.summary).toContain('Pushed');
      } finally {
        fs.rmSync(fakeRemoteDir, { recursive: true, force: true });
      }
    });

    it('AC-1.3: pushBranch result shape on failure', async () => {
      const result = await deployAgent.pushBranch({
        branch: 'master',
        repoDir: tmpDir,
      });

      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('summary');
      expect(typeof result.success).toBe('boolean');
      expect(typeof result.summary).toBe('string');
    });
  });

  // ============================================================
  // AC-1: mergeBranches with push triggers pre-flight
  // ============================================================
  describe('mergeBranches() push pre-flight', () => {
    it('AC-1.4: mergeBranches with push=true aborts when no remote', async () => {
      // Create feature branch
      await execSh('git checkout -b feature/resilience-test', { cwd: tmpDir, timeoutMs: 10_000 });
      fs.writeFileSync(path.join(tmpDir, 'RESILIENCE.md'), '# Resilience');
      await execSh('git add RESILIENCE.md && git commit -m "resilience test"', { cwd: tmpDir, timeoutMs: 10_000 });
      await execSh('git checkout master', { cwd: tmpDir, timeoutMs: 10_000 });

      const result = await deployAgent.mergeBranches({
        source: 'feature/resilience-test',
        target: 'master',
        repoPath: tmpDir,
        push: true,
      });

      // merge should succeed but push should fail (no remote → pre-flight catches it)
      expect(result.merged).toBe(true);
      expect(result.pushed).toBe(false);
    });
  });
});
