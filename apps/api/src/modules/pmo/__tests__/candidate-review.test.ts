import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileStore, eventBus, stringifyChannels, type AgentProfileData } from '@dommaker/studio-shared';
import { ReviewDispatcher } from '../../agent-loop/review-dispatcher.js';
import { WorkUnitService } from '../../workunit/workunit-review.js';
import { parseWuMetadata, EffectService } from '../../workunit/index.js';
import { buildPmoCandidate, CandidateReviewService, parsePmoCandidateReview } from '../candidate-review.js';
import type { ProjectData } from '../model.js';

let root: string;
let store: FileStore;
let service: WorkUnitService;
let projects: Map<string, ProjectData>;
let recordLearningOutcome: ReturnType<typeof vi.fn>;

const profiles: AgentProfileData[] = ['implementer-a', 'implementer-b', 'reviewer'].map(id => ({
  id, name: id, description: id, channels: '[]', status: 'active', provider: 'claude',
  createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z',
}));

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function makeRepo(name: string): { repo: string; head: string } {
  const repo = path.join(root, name);
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-b', 'master', repo]);
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(repo, 'README.md'), name);
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-m', 'initial');
  git(repo, 'checkout', '-b', 'PMO-1');
  fs.writeFileSync(path.join(repo, `${name}.txt`), name);
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'candidate');
  return { repo, head: git(repo, 'rev-parse', 'HEAD') };
}

function project(legs: Array<{ gitRepo: string; branch: string }>): ProjectData {
  return {
    id: 'proj-1', pmoNumber: 'PMO-1', title: '跨仓交付', description: null,
    requirement: '两个仓库的接口与验收标准一起满足', companyId: null, okrId: null,
    status: 'active', priority: 'normal', progress: 100,
    gitRepo: legs[0]?.gitRepo ?? null, gitBranch: 'PMO-1', specFilePath: null,
    requirementsDocId: null, startedAt: null, completedAt: null,
    createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z',
    reqAlias: 'REQ-0001', deliveryPolicy: 'auto-merge', overallReviewRequired: true,
    channelId: 'ch-1',
    deliveries: legs.map(leg => ({ ...leg, status: 'completed' })),
  };
}

function candidateService(): CandidateReviewService {
  return new CandidateReviewService(store, service, {
    withRepo: async <T>(_repo: string, callback: (capabilityPath: string) => Promise<T>) => callback(_repo),
    getProject: async id => projects.get(id) ?? null,
    updateProject: async (id, input) => {
      const current = projects.get(id)!;
      const updated = { ...current, ...input, updatedAt: new Date().toISOString() };
      projects.set(id, updated);
      return updated;
    },
    recordLearningOutcome,
  });
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pmo-candidate-review-'));
  store = new FileStore(path.join(root, 'data'));
  service = new WorkUnitService(store);
  projects = new Map();
  recordLearningOutcome = vi.fn().mockResolvedValue(undefined);
  for (const profile of profiles) await store.createProfile(profile);
  await store.createChannel({
    id: 'ch-1', name: '#test', type: 'rnd', defaultWorkspaceId: null, defaultPath: null,
    discordChannelId: null, discordWebhookUrl: null,
    members: stringifyChannels(profiles.map(profile => profile.id)),
    createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z',
  });
});

afterEach(() => {
  eventBus.unsubscribeAll?.('workunit.status_changed');
  fs.rmSync(root, { recursive: true, force: true });
});

describe('PMO 候选整体评审（#720）', () => {
  it('绑定每腿 head/证据并用持久 Effect 派出排除全部实现者的评审', async () => {
    const a = makeRepo('repo-a');
    const b = makeRepo('repo-b');
    const current = project([
      { gitRepo: a.repo, branch: 'PMO-1' }, { gitRepo: b.repo, branch: 'PMO-1' },
    ]);
    projects.set(current.id, current);
    const anchor = await service.create({
      type: 'plan', scope: '规划', status: 'done', channelId: 'ch-1', reqId: 'REQ-0001',
      metadata: { pmoId: current.id },
    });
    for (const [repo, assigneeId] of [[a.repo, 'implementer-a'], [b.repo, 'implementer-b']] as const) {
      await service.create({
        type: 'task', scope: '实现', status: 'done', channelId: 'ch-1', reqId: 'REQ-0001', assigneeId,
        metadata: { pmoId: current.id, workspaceRoot: repo, pmoBranch: 'PMO-1' },
      });
    }

    const status = await candidateService().ensureReview(current, await store.getIndex());

    expect(status.status).toBe('pending');
    expect(status.candidate.legs.map(leg => leg.headCommit)).toEqual([a.head, b.head]);
    expect(status.candidate.legs[0].evidenceRevision).not.toBe(status.candidate.legs[1].evidenceRevision);
    const review = (await store.getIndex()).find(wu => parsePmoCandidateReview(wu.metadata)?.candidate.id === status.candidate.id);
    expect(review).toBeDefined();
    expect(review!.parentId).toBe(anchor.id);
    expect(review!.scope).toContain(`diff master...${a.head}`);
    expect(review!.scope).toContain('验证证据');
    expect(JSON.parse(review!.metadata!).excludeAssignees).toEqual(expect.arrayContaining(['implementer-a', 'implementer-b']));
    expect(JSON.parse(review!.metadata!).selfReview).toBeUndefined();
    const persistedAnchor = (await store.getIndex({ id: anchor.id }))[0];
    expect(persistedAnchor.effects?.some(effect => effect.kind === 'pmo-review-dispatch' && effect.status === 'succeeded')).toBe(true);
    expect(persistedAnchor.effectReceipts?.some(receipt => receipt.outcome === 'succeeded'
      && receipt.result?.reviewWorkUnitId === review!.id)).toBe(true);
  });

  it('没有独立 reviewer 时只允许人工结论，人工批准也留下持久结果回执', async () => {
    const a = makeRepo('repo-a');
    const b = makeRepo('repo-b');
    await store.updateChannel('ch-1', { members: stringifyChannels(['implementer-a']) });
    const current = project([
      { gitRepo: a.repo, branch: 'PMO-1' }, { gitRepo: b.repo, branch: 'PMO-1' },
    ]);
    projects.set(current.id, current);
    const anchor = await service.create({
      type: 'plan', scope: '规划', status: 'done', channelId: 'ch-1', reqId: 'REQ-0001',
      metadata: { pmoId: current.id },
    });
    await service.create({
      type: 'task', scope: '实现', status: 'done', channelId: 'ch-1', reqId: 'REQ-0001', assigneeId: 'implementer-a',
      metadata: { pmoId: current.id, workspaceRoot: a.repo, pmoBranch: 'PMO-1' },
    });
    const reviewService = candidateService();

    const fallback = await reviewService.ensureReview(current, await store.getIndex());
    expect(fallback.status).toBe('human-required');
    expect((await store.getIndex()).some(wu => parsePmoCandidateReview(wu.metadata))).toBe(false);

    const approved = await reviewService.submitHumanReview(current.id, 'operator-1', { verdict: 'pass', summary: '人工验收通过' });
    expect(approved.status).toBe('approved');
    expect(projects.get(current.id)!.candidateReview?.reviewer).toEqual({ id: 'operator-1', kind: 'human' });
    const persistedAnchor = (await store.getIndex({ id: anchor.id }))[0];
    expect(persistedAnchor.effects?.some(effect => effect.kind === 'pmo-review-result' && effect.status === 'succeeded')).toBe(true);
    expect(persistedAnchor.effectReceipts?.some(receipt => receipt.result?.status === 'approved')).toBe(true);
  });

  it('Agent 评审 done 与结果 Effect 同事务落盘，恢复后批准确切候选', async () => {
    const a = makeRepo('repo-a');
    const b = makeRepo('repo-b');
    const current = project([
      { gitRepo: a.repo, branch: 'PMO-1' }, { gitRepo: b.repo, branch: 'PMO-1' },
    ]);
    projects.set(current.id, current);
    await service.create({
      type: 'plan', scope: '规划', status: 'done', channelId: 'ch-1', reqId: 'REQ-0001',
      metadata: { pmoId: current.id },
    });
    await service.create({
      type: 'task', scope: '实现', status: 'done', channelId: 'ch-1', reqId: 'REQ-0001', assigneeId: 'implementer-a',
      metadata: { pmoId: current.id, workspaceRoot: a.repo, pmoBranch: 'PMO-1' },
    });
    const reviewService = candidateService();
    const dispatched = await reviewService.ensureReview(current, await store.getIndex());
    const review = (await store.getIndex()).find(wu => parsePmoCandidateReview(wu.metadata)?.candidate.id === dispatched.candidate.id)!;
    await service.update(review.id, { assigneeId: 'reviewer' });
    await service.updateMetadata(review.id, { reviewReport: { approved: true, reason: '跨仓接口一致' } });

    await service.transitionStatus(review.id, 'active');
    await service.transitionStatus(review.id, 'in_review');
    await service.transitionStatus(review.id, 'done');

    const completed = (await store.getIndex({ id: review.id }))[0];
    expect(completed.effects?.some(effect => effect.kind === 'pmo-review-result' && effect.status === 'queued'
      && effect.payload?.verdict === 'pass')).toBe(true);
    expect(projects.get(current.id)!.candidateReview?.status).toBe('pending');
    const dispatcher = new ReviewDispatcher(store, service, reviewService);
    dispatcher.subscribeToEvents();
    await dispatcher.waitForSettled();
    expect(projects.get(current.id)!.candidateReview?.status).toBe('approved');
    expect(projects.get(current.id)!.candidateReview?.reviewer).toEqual({ id: 'reviewer', kind: 'agent' });
    const recovered = (await store.getIndex({ id: review.id }))[0];
    expect(recovered.effectReceipts?.some(receipt => receipt.outcome === 'succeeded' && receipt.result?.status === 'approved')).toBe(true);
  });

  it('拒绝创建逐腿修复任务，修复证据形成新候选并强制复审', async () => {
    const a = makeRepo('repo-a');
    const b = makeRepo('repo-b');
    const current = project([
      { gitRepo: a.repo, branch: 'PMO-1' }, { gitRepo: b.repo, branch: 'PMO-1' },
    ]);
    projects.set(current.id, current);
    const anchor = await service.create({
      type: 'plan', scope: '规划', status: 'done', channelId: 'ch-1', reqId: 'REQ-0001',
      metadata: { pmoId: current.id },
      authorization: {
        requestedBy: { id: 'system', type: 'System' }, source: { kind: 'system' },
        repositories: [a.repo, b.repo].map(repo => ({ repo, leg: 'PMO-1' })),
      },
    });
    const implementationIds: string[] = [];
    for (const repo of [a.repo, b.repo]) {
      const implementation = await service.create({
        type: 'task', scope: '实现', status: 'done', channelId: 'ch-1', reqId: 'REQ-0001', assigneeId: 'implementer-a',
        metadata: { pmoId: current.id, workspaceRoot: repo, pmoBranch: 'PMO-1' },
      });
      implementationIds.push(implementation.id);
    }
    const reviewService = candidateService();
    const first = await reviewService.ensureReview(current, await store.getIndex());

    const rejected = await reviewService.submitHumanReview(current.id, 'operator-1', {
      verdict: 'reject', summary: '跨仓接口不兼容', issues: [{ message: '统一两个仓库的接口版本' }],
    });

    expect(rejected.status).toBe('rejected');
    expect(recordLearningOutcome).toHaveBeenCalledWith(anchor.id, {
      eventId: `pmo-review-rejected:${current.id}:${first.candidate.id}`,
      kind: 'pmo-review-rejected',
      workUnitIds: expect.arrayContaining([anchor.id, ...implementationIds]),
    });
    expect(recordLearningOutcome.mock.calls[0][1].workUnitIds).toHaveLength(3);
    const repairs = (await store.getIndex()).filter(wu => parseWuMetadata(wu.metadata).pmoCandidateRepair);
    expect(repairs).toHaveLength(2);
    expect(repairs.map(wu => parseWuMetadata(wu.metadata).workspaceRoot).sort()).toEqual([a.repo, b.repo].sort());
    expect(repairs.every(wu => parseWuMetadata(wu.metadata).ac?.includes('统一两个仓库的接口版本'))).toBe(true);
    const second = await reviewService.ensureReview(projects.get(current.id)!, await store.getIndex());
    expect(second.candidate.id).not.toBe(first.candidate.id);
    expect(second.status).toBe('pending');
    expect(second.reviewWorkUnitId).not.toBe(first.reviewWorkUnitId);
  });

  it('任一腿 head 或证据变化都会使旧批准失效', async () => {
    const a = makeRepo('repo-a');
    const b = makeRepo('repo-b');
    const current = project([
      { gitRepo: a.repo, branch: 'PMO-1' }, { gitRepo: b.repo, branch: 'PMO-1' },
    ]);
    projects.set(current.id, current);
    await service.create({
      type: 'plan', scope: '规划', status: 'done', channelId: 'ch-1', reqId: 'REQ-0001',
      metadata: { pmoId: current.id },
    });
    const implementation = await service.create({
      type: 'task', scope: '实现', status: 'done', channelId: 'ch-1', reqId: 'REQ-0001', assigneeId: 'implementer-a',
      metadata: { pmoId: current.id, workspaceRoot: a.repo, pmoBranch: 'PMO-1' },
    });
    const reviewService = candidateService();
    const approved = await reviewService.ensureReview(current, await store.getIndex());
    await reviewService.submitHumanReview(current.id, 'operator-1', { verdict: 'pass' });

    fs.writeFileSync(path.join(a.repo, 'new.txt'), 'new head');
    git(a.repo, 'add', 'new.txt');
    git(a.repo, 'commit', '-m', 'change candidate head');
    const afterHead = await reviewService.ensureReview(projects.get(current.id)!, await store.getIndex());
    expect(afterHead.candidate.id).not.toBe(approved.candidate.id);
    expect(afterHead.status).toBe('pending');

    await reviewService.submitHumanReview(current.id, 'operator-1', { verdict: 'pass' });
    await service.updateMetadata(implementation.id, {
      attestations: { l3: { verdict: 'approved', by: 'operator-1', at: new Date().toISOString(), kind: 'human-confirm' } },
    });
    const afterEvidence = await reviewService.ensureReview(projects.get(current.id)!, await store.getIndex());
    expect(afterEvidence.candidate.id).not.toBe(afterHead.candidate.id);
    expect(afterEvidence.status).toBe('pending');
  });

  it('实现者绕过认领过滤提交通过结论时仍转人工，不接受自评', async () => {
    const a = makeRepo('repo-a');
    const b = makeRepo('repo-b');
    const current = project([
      { gitRepo: a.repo, branch: 'PMO-1' }, { gitRepo: b.repo, branch: 'PMO-1' },
    ]);
    projects.set(current.id, current);
    await service.create({
      type: 'plan', scope: '规划', status: 'done', channelId: 'ch-1', reqId: 'REQ-0001',
      metadata: { pmoId: current.id },
    });
    await service.create({
      type: 'task', scope: '实现', status: 'done', channelId: 'ch-1', reqId: 'REQ-0001', assigneeId: 'implementer-a',
      metadata: { pmoId: current.id, workspaceRoot: a.repo, pmoBranch: 'PMO-1' },
    });
    const reviewService = candidateService();
    const dispatched = await reviewService.ensureReview(current, await store.getIndex());
    const review = (await store.getIndex()).find(wu => parsePmoCandidateReview(wu.metadata)?.candidate.id === dispatched.candidate.id)!;
    await service.update(review.id, { assigneeId: 'implementer-a' });
    await service.updateMetadata(review.id, { reviewReport: { approved: true, reason: '自评通过' } });
    await service.transitionStatus(review.id, 'active');
    await service.transitionStatus(review.id, 'in_review');
    await service.transitionStatus(review.id, 'done');

    await reviewService.recoverEffects();

    expect(projects.get(current.id)!.candidateReview?.status).toBe('human-required');
    expect(projects.get(current.id)!.candidateReview?.reviewer).toBeUndefined();
  });

  it('重启只凭 queued 派单 Effect 恢复，重复恢复不创建第二个评审', async () => {
    const a = makeRepo('repo-a');
    const b = makeRepo('repo-b');
    const current = project([
      { gitRepo: a.repo, branch: 'PMO-1' }, { gitRepo: b.repo, branch: 'PMO-1' },
    ]);
    projects.set(current.id, current);
    const anchor = await service.create({
      type: 'plan', scope: '规划', status: 'done', channelId: 'ch-1', reqId: 'REQ-0001',
      metadata: { pmoId: current.id },
    });
    await service.create({
      type: 'task', scope: '实现', status: 'done', channelId: 'ch-1', reqId: 'REQ-0001', assigneeId: 'implementer-a',
      metadata: { pmoId: current.id, workspaceRoot: a.repo, pmoBranch: 'PMO-1' },
    });
    const snapshots = await store.getIndex();
    const candidate = await buildPmoCandidate(current, snapshots, async <T>(_repo: string, callback: (path: string) => Promise<T>) => callback(_repo));
    projects.set(current.id, {
      ...current, candidateReview: { candidate, status: 'pending', updatedAt: new Date().toISOString() },
    });
    await new EffectService(store).enqueue(anchor.id, {
      kind: 'pmo-review-dispatch', idempotencyKey: `pmo-review-dispatch:${current.id}:${candidate.id}`,
      trigger: 'automatic', payload: { projectId: current.id, candidate },
    });

    const reviewService = candidateService();
    await reviewService.recoverEffects();
    await reviewService.recoverEffects();

    const reviews = (await store.getIndex()).filter(wu => parsePmoCandidateReview(wu.metadata)?.candidate.id === candidate.id);
    expect(reviews).toHaveLength(1);
    const persistedAnchor = (await store.getIndex({ id: anchor.id }))[0];
    expect(persistedAnchor.effectReceipts?.filter(receipt => receipt.outcome === 'succeeded')).toHaveLength(1);
    expect(projects.get(current.id)!.candidateReview?.reviewWorkUnitId).toBe(reviews[0].id);
  });
});
