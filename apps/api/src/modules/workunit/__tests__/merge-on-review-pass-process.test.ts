import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { FileStore } from '@dommaker/studio-shared';
import { WorkUnitService } from '../workunit-review.js';
import type { WorkUnitMetadata } from '../workunit.types.js';

const execFileAsync = promisify(execFile);
const workerPath = path.resolve('apps/api/src/modules/workunit/__tests__/fixtures/merge-recovery-worker.ts');
const tsxPath = path.resolve('node_modules/tsx/dist/cli.mjs');

describe('merge delivery-leg process coordination', () => {
  let tmpDir: string;
  let repo: string;
  let fileStore: FileStore;
  let service: WorkUnitService;
  let markerFile: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-leg-process-'));
    repo = path.join(tmpDir, 'repo');
    markerFile = path.join(tmpDir, 'verification-markers.jsonl');
    fs.mkdirSync(repo);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: repo });
    await execFileAsync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: repo });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'README.md'), 'base\n');
    await execFileAsync('git', ['add', 'README.md'], { cwd: repo });
    await execFileAsync('git', ['commit', '-m', 'base'], { cwd: repo });
    fileStore = new FileStore(path.join(tmpDir, 'data'));
    service = new WorkUnitService(fileStore);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function createBranchWorkUnit(id: string): Promise<string> {
    const worktreePath = path.join(tmpDir, `wt-${id}`);
    const branch = `task/${id}`;
    await execFileAsync('git', ['worktree', 'add', '-b', branch, worktreePath, 'main'], { cwd: repo });
    fs.writeFileSync(path.join(worktreePath, `${id}.txt`), `${id}\n`);
    await execFileAsync('git', ['add', `${id}.txt`], { cwd: worktreePath });
    await execFileAsync('git', ['commit', '-m', id], { cwd: worktreePath });
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath });
    const created = await service.create({
      scope: id,
      type: 'task',
      status: 'in_review',
      metadata: {
        workspaceRoot: repo,
        worktreePath,
        worktreeBranch: branch,
        worktreeBaseBranch: 'main',
        worktreeBaseRepo: repo,
      } satisfies WorkUnitMetadata,
    });
    return { sourceCommit: stdout.trim(), workUnitId: created.id };
  }

  function runWorker(mode: string, workUnitId?: string, expectedCode = 0) {
    const child = spawn(process.execPath, [tsxPath, workerPath, mode, ...(workUnitId ? [workUnitId] : [])], {
      env: {
        ...process.env,
        STUDIO_DATA_DIR: path.join(tmpDir, 'data'),
        PMO_GIT_REPO_ROOTS: tmpDir,
        WORKTREES_DIR: path.join(tmpDir, 'worktrees'),
        MERGE_MARKER_FILE: markerFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const exited = new Promise<void>((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', code => code === expectedCode ? resolve() : reject(new Error(`worker ${mode} exited ${code}: ${stderr}`)));
    });
    return { child, exited };
  }

  it('两个独立进程完成同腿 WU 时验证临界区不重叠，receipt 均在真实目标历史', async () => {
    const firstWu = await createBranchWorkUnit('wu-1');
    const secondWu = await createBranchWorkUnit('wu-2');
    const first = runWorker('review', firstWu.workUnitId);
    const second = runWorker('review', secondWu.workUnitId);
    await Promise.all([first.exited, second.exited]);

    const markers = fs.readFileSync(markerFile, 'utf8').trim().split('\n')
      .map(line => JSON.parse(line) as { type: 'start' | 'end'; pid: number; at: number })
      .sort((a, b) => a.at - b.at);
    let active = 0;
    let overlap = false;
    for (const marker of markers) {
      if (marker.type === 'start') {
        if (active > 0) overlap = true;
        active++;
      } else {
        active--;
      }
    }
    expect(overlap).toBe(false);

    const { stdout: targetHead } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repo });
    for (const item of [firstWu, secondWu]) {
      const updated = await service.getById(item.workUnitId);
      expect(updated!.status).toBe('done');
      const metadata = JSON.parse(updated!.metadata!) as WorkUnitMetadata;
      expect(metadata.mergeReceipt).toEqual(expect.objectContaining({ merged: true, targetBranch: 'main' }));
      expect(metadata.mergeReceipt!.verification.status).toBe('passed');
      await execFileAsync('git', ['merge-base', '--is-ancestor', item.sourceCommit, targetHead.trim()], { cwd: repo });
      await execFileAsync('git', ['merge-base', '--is-ancestor', metadata.mergeReceipt!.mergeCommit!, targetHead.trim()], { cwd: repo });
    }
  }, 30_000);

  it('running 后、Git 前崩溃：新进程恢复 queued/running intent，不永久锁死', async () => {
    const item = await createBranchWorkUnit('wu-before-git');
    await runWorker('crash-before-git', item.workUnitId, 42).exited;
    expect((await service.getById(item.workUnitId))!.status).toBe('in_review');

    await runWorker('recover').exited;

    const updated = await service.getById(item.workUnitId);
    expect(updated!.status).toBe('done');
    const metadata = JSON.parse(updated!.metadata!) as WorkUnitMetadata;
    expect(metadata.mergeReceipt).toEqual(expect.objectContaining({ merged: true, verification: expect.objectContaining({ status: 'passed' }) }));
    const { stdout: recoveredHead } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repo });
    await execFileAsync('git', ['merge-base', '--is-ancestor', item.sourceCommit, recoveredHead.trim()], { cwd: repo });
  }, 30_000);

  it('Git merge 后、base receipt 前崩溃：后续 WU 已推进 HEAD 时仍定位本任务真实 merge commit', async () => {
    const item = await createBranchWorkUnit('wu-before-receipt');
    await runWorker('crash-before-receipt', item.workUnitId, 42).exited;
    const crashed = await service.getById(item.workUnitId);
    expect(crashed!.status).toBe('in_review');
    expect(JSON.parse(crashed!.metadata!).mergeReceipt).toBeUndefined();
    const { stdout: crashedHead } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repo });
    await execFileAsync('git', ['merge-base', '--is-ancestor', item.sourceCommit, crashedHead.trim()], { cwd: repo });
    const later = await createBranchWorkUnit('wu-later');
    await runWorker('review', later.workUnitId).exited;
    const { stdout: laterHead } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repo });
    expect(laterHead.trim()).not.toBe(crashedHead.trim());

    await runWorker('recover').exited;

    const updated = await service.getById(item.workUnitId);
    expect(updated!.status).toBe('done');
    const metadata = JSON.parse(updated!.metadata!) as WorkUnitMetadata;
    expect(metadata.mergeReceipt).toEqual(expect.objectContaining({
      merged: true,
      mergeCommit: crashedHead.trim(),
      verification: expect.objectContaining({ status: 'passed' }),
    }));
    const { stdout: recoveredHead } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repo });
    expect(recoveredHead.trim()).toBe(laterHead.trim());
  }, 30_000);

  it('base receipt 后、verify 前崩溃：从 not-run 续验证和 settle，不重复 merge', async () => {
    const item = await createBranchWorkUnit('wu-before-verify');
    await runWorker('crash-before-verify', item.workUnitId, 42).exited;
    const crashed = await service.getById(item.workUnitId);
    expect(crashed!.status).toBe('in_review');
    expect(JSON.parse(crashed!.metadata!).mergeReceipt).toEqual(expect.objectContaining({
      merged: true,
      verification: expect.objectContaining({ status: 'not-run' }),
    }));
    const { stdout: crashedHead } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repo });

    await runWorker('recover').exited;

    const updated = await service.getById(item.workUnitId);
    expect(updated!.status).toBe('done');
    const metadata = JSON.parse(updated!.metadata!) as WorkUnitMetadata;
    expect(metadata.mergeReceipt).toEqual(expect.objectContaining({
      mergeCommit: crashedHead.trim(),
      verification: expect.objectContaining({ status: 'passed' }),
    }));
    const { stdout: recoveredHead } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repo });
    expect(recoveredHead.trim()).toBe(crashedHead.trim());
  }, 30_000);

  it('已有 receipt 指向 source 之前的基址：恢复拒绝接受，不伪造成 done', async () => {
    const item = await createBranchWorkUnit('wu-invalid-receipt');
    const { stdout: baseHead } = await execFileAsync('git', ['rev-parse', 'main'], { cwd: repo });
    const current = await service.getById(item.workUnitId);
    await service.update(item.workUnitId, { metadata: {
      ...JSON.parse(current!.metadata!),
      mergeIntent: { id: `merge:${item.workUnitId}`, state: 'running', requestedAt: new Date().toISOString() },
      mergeReceipt: {
        id: `merge:${item.workUnitId}`, merged: true, mergedAt: new Date().toISOString(),
        mergeCommit: baseHead.trim(), targetBranch: 'main', verification: { status: 'not-run', ran: [] },
      },
    } });

    await runWorker('recover').exited;

    const updated = await service.getById(item.workUnitId);
    expect(updated!.status).toBe('blocked');
    const metadata = JSON.parse(updated!.metadata!) as WorkUnitMetadata;
    expect(metadata.mergeReceipt!.failure!.kind).toBe('merge-error');
    expect(metadata.blockReason).toContain('回执与当前目标历史不一致');
  }, 30_000);

  it('done 后、cleanup 前崩溃：恢复只补幂等清理，不重复 merge/verify', async () => {
    const item = await createBranchWorkUnit('wu-before-cleanup');
    await runWorker('crash-before-cleanup', item.workUnitId, 42).exited;
    const crashed = await service.getById(item.workUnitId);
    expect(crashed!.status).toBe('done');
    const crashedMeta = JSON.parse(crashed!.metadata!) as WorkUnitMetadata;
    expect(fs.existsSync(crashedMeta.worktreePath!)).toBe(true);
    const { stdout: crashedHead } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repo });
    const markersBefore = fs.readFileSync(markerFile, 'utf8');

    await runWorker('recover').exited;

    const updated = await service.getById(item.workUnitId);
    expect(updated!.status).toBe('done');
    const metadata = JSON.parse(updated!.metadata!) as WorkUnitMetadata;
    expect(metadata.mergeCleanedAt).toEqual(expect.any(String));
    expect(fs.existsSync(crashedMeta.worktreePath!)).toBe(false);
    await expect(execFileAsync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${crashedMeta.worktreeBranch}`], { cwd: repo })).rejects.toThrow();
    expect(fs.readFileSync(markerFile, 'utf8')).toBe(markersBefore);
    const { stdout: recoveredHead } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repo });
    expect(recoveredHead.trim()).toBe(crashedHead.trim());
  }, 30_000);
});
