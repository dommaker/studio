import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FileStore } from '@dommaker/studio-shared';
import { withDeliveryLegLock } from '../delivery-leg-lock.js';

const execFileAsync = promisify(execFile);

describe('withDeliveryLegLock', () => {
  let tmpDir: string;
  let repo: string;
  let fileStore: FileStore;
  let previousWorktreesDir: string | undefined;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-leg-lock-'));
    repo = path.join(tmpDir, 'repo');
    fs.mkdirSync(repo);
    await execFileAsync('git', ['init'], { cwd: repo });
    fileStore = new FileStore(path.join(tmpDir, 'data'));
    previousWorktreesDir = process.env.WORKTREES_DIR;
    process.env.WORKTREES_DIR = path.join(tmpDir, 'worktrees');
  });

  afterEach(() => {
    if (previousWorktreesDir === undefined) delete process.env.WORKTREES_DIR;
    else process.env.WORKTREES_DIR = previousWorktreesDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('同一仓库同一腿跨调用串行，不同腿可并行', async () => {
    let sameLegActive = false;
    let sameLegOverlap = false;
    const runSameLeg = () => withDeliveryLegLock({ fileStore, repo, branch: 'PMO-1' }, async () => {
      if (sameLegActive) sameLegOverlap = true;
      sameLegActive = true;
      await new Promise(resolve => setTimeout(resolve, 40));
      sameLegActive = false;
    });
    await Promise.all([runSameLeg(), runSameLeg()]);
    expect(sameLegOverlap).toBe(false);

    let otherLegEntered = false;
    await withDeliveryLegLock({ fileStore, repo, branch: 'PMO-1' }, async () => {
      await withDeliveryLegLock({ fileStore, repo, branch: 'PMO-2' }, async () => {
        otherLegEntered = true;
      });
    });
    expect(otherLegEntered).toBe(true);
  });
});
