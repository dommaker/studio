import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileStore, type WorkUnitSnapshot } from '@dommaker/studio-shared';
import { migrateLegacyWorkUnits } from '../legacy-migration.js';
import { WorkUnitService } from '../workunit-review.js';
import { parseWuMetadata } from '../wu-metadata.js';
import { summarizeEvidence } from '../../pmo/evidence-summary.js';
import type { WorkUnitVerificationPort } from '../workunit-ports.js';

const NOW = '2026-11-10T00:00:00.000Z';
const COMPLETED = '2026-11-09T00:00:00.000Z';
const operator = { id: 'operator-1', type: 'Operator' } as const;
const passedVerification: WorkUnitVerificationPort['run'] = async () => ({
  ran: ['test'], source: 'convention',
});

let tmpDir: string;
let store: FileStore;
let service: WorkUnitService;
let previousGitRoots: string | undefined;
let previousWorktreesDir: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-wu-migration-'));
  store = new FileStore(tmpDir);
  service = new WorkUnitService(store);
  previousGitRoots = process.env.PMO_GIT_REPO_ROOTS;
  previousWorktreesDir = process.env.WORKTREES_DIR;
  process.env.PMO_GIT_REPO_ROOTS = tmpDir;
  process.env.WORKTREES_DIR = path.join(tmpDir, 'worktrees');
});

afterEach(() => {
  if (previousGitRoots === undefined) delete process.env.PMO_GIT_REPO_ROOTS;
  else process.env.PMO_GIT_REPO_ROOTS = previousGitRoots;
  if (previousWorktreesDir === undefined) delete process.env.WORKTREES_DIR;
  else process.env.WORKTREES_DIR = previousWorktreesDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function seedLegacy(input: {
  id: string;
  status: string;
  type?: string;
  metadata?: Record<string, unknown>;
  channelId?: string | null;
  reqId?: string | null;
}): Promise<WorkUnitSnapshot> {
  const snapshot: WorkUnitSnapshot = {
    id: input.id,
    parentId: null,
    type: input.type ?? 'task',
    scope: `旧任务 ${input.id}`,
    assigneeId: input.status === 'active' ? 'instance-1' : null,
    status: input.status,
    failureType: null,
    retryCount: 0,
    timeoutAt: null,
    channelId: input.channelId ?? null,
    projectPath: null,
    reqId: input.reqId ?? null,
    metadata: JSON.stringify(input.metadata ?? {}),
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: NOW,
    claimedAt: input.status === 'active' ? NOW : null,
    completedAt: input.status === 'done' ? COMPLETED : null,
  };
  await store.commitSnapshot({
    type: 'created', wuId: snapshot.id, timestamp: snapshot.createdAt,
    data: snapshot as unknown as Record<string, unknown>,
  }, snapshot);
  return snapshot;
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function createRepository(id: string): { repo: string; branch: string } {
  const repo = path.join(tmpDir, id);
  const branch = `task/${id}`;
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 'legacy-test@example.invalid']);
  git(repo, ['config', 'user.name', 'Legacy Test']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'base\n');
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: id, private: true }));
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'base']);
  git(repo, ['checkout', '-b', branch]);
  fs.writeFileSync(path.join(repo, 'README.md'), 'change\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'legacy work']);
  git(repo, ['checkout', 'main']);
  return { repo, branch };
}

function legacyGitMetadata(repo: string, branch: string): Record<string, unknown> {
  return {
    workspaceRoot: repo,
    ownershipSource: 'requirement',
    worktreeBranch: branch,
    worktreeBaseRepo: repo,
    worktreeBaseBranch: 'main',
  };
}

const approvedEvidence = {
  l2: { verdict: 'approved', by: 'reviewer', at: COMPLETED, kind: 'agent-review' },
  l3: { verdict: 'approved', by: 'operator-1', at: COMPLETED, kind: 'human-confirm' },
};

describe('存量在途 WU 迁移', () => {
  it('从有效旧字段补 active/waiting/in_review Assignment，并只派生可靠系统 Mandate', async () => {
    const reliable = {
      creationMode: 'analysis-breakdown',
      workspaceRoot: '/repo/api',
      ownershipSource: 'requirement',
      pmoId: 'PMO-1',
      tokenBudget: 12_000,
    };
    await seedLegacy({
      id: 'legacy-active', status: 'active', reqId: 'REQ-0001',
      metadata: {
        ...reliable,
        startedAt: '2026-11-09T01:00:00.000Z',
        sessionId: 'studio-session-1', cliSessionId: 'cli-session-1',
        worktreePath: '/worktrees/wu-1', worktreeBranch: 'task/wu-1',
        _cumulativeTokens: 321,
        progressLog: [{ step: 1, action: 'progress', summary: '已完成第一步', at: NOW }],
      },
    });
    await seedLegacy({
      id: 'legacy-waiting', status: 'blocked',
      metadata: { ...reliable, waitingForInput: true, waitingSince: NOW, sessionId: 'studio-session-2' },
    });
    await seedLegacy({
      id: 'legacy-review', status: 'in_review',
      metadata: { ...reliable, sessionId: 'studio-session-3', attestations: approvedEvidence },
    });

    await migrateLegacyWorkUnits(store);
    const active = (await service.getById('legacy-active'))!;
    const waiting = (await service.getById('legacy-waiting'))!;
    const review = (await service.getById('legacy-review'))!;

    expect(active.execution?.current).toMatchObject({
      status: 'running', reason: 'recovery', tokenCount: 321, progressCount: 1,
    });
    expect((await store.getIndex({ id: active.id }))[0]?.assignments?.[0]).toMatchObject({
      sessionId: 'studio-session-1', cliSessionId: 'cli-session-1',
      worktreePath: '/worktrees/wu-1', worktreeBranch: 'task/wu-1',
    });
    expect(waiting.execution?.current).toMatchObject({ status: 'waiting', waitingAt: NOW });
    expect(review.execution?.current).toMatchObject({ status: 'succeeded', evidenceCount: 2 });
    for (const wu of [active, waiting, review]) {
      expect(wu.mandate).toMatchObject({
        requestedBy: { id: 'system', type: 'System' },
        repositories: [{ repo: '/repo/api', leg: null }],
        budget: { tokens: 12_000, planSteps: null },
      });
    }

    const before = await store.getIndex();
    await migrateLegacyWorkUnits(store);
    expect(await store.getIndex()).toEqual(before);
  });

  it('旧频道请求没有认证主体证据时交回重新授权，不猜 Operator 权限', async () => {
    await seedLegacy({
      id: 'legacy-untrusted', status: 'active',
      metadata: {
        creationMode: 'mention', createdBy: 'mention', anchorMessageId: 'message-1',
        workspaceRoot: '/repo/api', ownershipSource: 'channel-default-path',
      },
    });

    await migrateLegacyWorkUnits(store);

    const blocked = (await service.getById('legacy-untrusted'))!;
    expect(blocked.status).toBe('blocked');
    expect(blocked.mandate).toBeUndefined();
    expect(blocked.execution?.current?.status).toBe('cancelled');
    expect(parseWuMetadata(blocked.metadata).blockReason).toContain('reauthorization');

    const authorized = await service.authorizeMandate(blocked.id, operator, { reason: '确认旧任务归属' });
    expect(authorized.mandate).toMatchObject({ requestedBy: operator, grantedBy: operator });
  });
});

describe('历史完成代码 WU 的真实 Git 对账', () => {
  it('外部已合并且目标验证通过：补带标记的 legacy receipt，不改完成时间', async () => {
    const { repo, branch } = createRepository('legacy-merged');
    git(repo, ['merge', '--no-ff', '-m', 'merge: legacy-merged external delivery', '--', branch]);
    const mergeCommit = git(repo, ['rev-parse', 'HEAD']);
    const original = await seedLegacy({
      id: 'legacy-merged', status: 'done', channelId: 'channel-1', reqId: 'REQ-0001',
      metadata: { ...legacyGitMetadata(repo, branch), pmoId: 'PMO-1', attestations: approvedEvidence },
    });

    await migrateLegacyWorkUnits(store, { verify: passedVerification });

    const migrated = (await service.getById(original.id))!;
    const metadata = parseWuMetadata(migrated.metadata);
    expect(migrated.status).toBe('done');
    expect(migrated.completedAt?.toISOString()).toBe(COMPLETED);
    expect(metadata.mergeReceipt).toMatchObject({
      legacy: true, merged: true, mergeCommit, targetBranch: 'main',
      verification: { status: 'passed', ran: ['test'] },
    });
    expect(metadata.legacyEvidence).toMatchObject({ status: 'reconciled' });
    expect(metadata.attestations?.l1).toMatchObject({ verdict: 'approved', ref: mergeCommit });
    expect((await store.getIndex()).filter(s => parseWuMetadata(s.metadata).legacyRepairOf === original.id)).toEqual([]);
    expect(summarizeEvidence([(await store.getIndex({ id: original.id }))[0]!]).deliverable).toBe(true);
  });

  it('历史分支未合并：保留 done 历史并只创建一个严格交付内的修复 WU', async () => {
    const { repo, branch } = createRepository('legacy-unmerged');
    const original = await seedLegacy({
      id: 'legacy-unmerged', status: 'done', channelId: 'channel-1', reqId: 'REQ-0002',
      metadata: { ...legacyGitMetadata(repo, branch), pmoId: 'PMO-2', attestations: approvedEvidence },
    });

    await migrateLegacyWorkUnits(store, { verify: passedVerification });
    await migrateLegacyWorkUnits(store, { verify: passedVerification });

    const snapshots = await store.getIndex();
    const historical = snapshots.find(s => s.id === original.id)!;
    const repairs = snapshots.filter(s => parseWuMetadata(s.metadata).legacyRepairOf === original.id);
    expect(historical.status).toBe('done');
    expect(historical.completedAt).toBe(COMPLETED);
    expect(parseWuMetadata(historical.metadata)).toMatchObject({
      legacyEvidence: { status: 'legacy-unverified', repairWorkUnitId: repairs[0]?.id },
    });
    expect(parseWuMetadata(historical.metadata).mergeReceipt).toBeUndefined();
    expect(repairs).toHaveLength(1);
    expect(repairs[0]).toMatchObject({ type: 'bug', status: 'unassigned', reqId: 'REQ-0002' });
    expect(repairs[0].mandate).toMatchObject({
      requestedBy: { id: 'system', type: 'System' },
      repositories: [{ repo, leg: null }],
    });
    expect(summarizeEvidence([historical, repairs[0]!])).toMatchObject({ deliverable: false, inFlight: 1 });
    expect(summarizeEvidence([historical]).mergeMissing).toEqual([historical.id]);
  });

  it('真实仓库中来源分支已消失：无法判定时标 legacy-unverified 并开修复单', async () => {
    const { repo, branch } = createRepository('legacy-unknown');
    git(repo, ['branch', '-D', branch]);
    const original = await seedLegacy({
      id: 'legacy-unknown', status: 'done',
      metadata: legacyGitMetadata(repo, branch),
    });
    const verify = vi.fn(passedVerification);

    await migrateLegacyWorkUnits(store, { verify });

    const snapshots = await store.getIndex();
    const historical = snapshots.find(s => s.id === original.id)!;
    expect(parseWuMetadata(historical.metadata).legacyEvidence).toMatchObject({
      status: 'legacy-unverified', reason: expect.stringContaining('无法判定'),
    });
    expect(parseWuMetadata(historical.metadata).mergeReceipt).toBeUndefined();
    expect(snapshots.filter(s => parseWuMetadata(s.metadata).legacyRepairOf === original.id)).toHaveLength(1);
    expect(verify).not.toHaveBeenCalled();
  });

  it('真实合并但验证失败时不补 receipt，修复单承接后续处理', async () => {
    const { repo, branch } = createRepository('legacy-failed-verify');
    git(repo, ['merge', '--no-ff', '-m', 'merge: legacy-failed-verify external delivery', '--', branch]);
    const original = await seedLegacy({
      id: 'legacy-failed-verify', status: 'done', metadata: legacyGitMetadata(repo, branch),
    });

    await migrateLegacyWorkUnits(store, {
      verify: async () => ({ ran: [], source: 'convention', failure: { command: 'test', tail: 'red' } }),
    });

    const historical = (await service.getById(original.id))!;
    expect(parseWuMetadata(historical.metadata).mergeReceipt).toBeUndefined();
    expect(parseWuMetadata(historical.metadata).legacyEvidence).toMatchObject({ status: 'legacy-unverified' });
    expect((await store.getIndex()).filter(s => parseWuMetadata(s.metadata).legacyRepairOf === original.id)).toHaveLength(1);
  });
});
