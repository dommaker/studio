import { createHash } from 'node:crypto';
import { parseChannels, type EffectRecord, type FileStore, type WorkUnitSnapshot } from '@dommaker/studio-shared';
import { isValidGitBranch } from '@dommaker/studio-contract';
import { logger } from '@dommaker/studio-shared/node';
import { execFileAsync } from '../../core/exec-async.js';
import { getStore } from '../../core/store.js';
import { isSystemRole } from '../../core/system-role.js';
import { withExecutionRepo } from '../../utils/execution-repo-policy.js';
import { EffectService, WorkUnitService, parseWuMetadata, type WorkUnitMetadata } from '../workunit/index.js';
import type { TerminalLearningOutcomeInput } from '../knowledge/index.js';
import { CODE_TYPES, matchWuToLeg, partitionSnapshotsByLeg, selectProjectSnapshots } from './evidence-summary.js';
import { resolveDeliveries, type PmoCandidate, type PmoCandidateLeg, type PmoCandidateReview, type ProjectData, type UpdateProjectInput } from './model.js';
import { projectService } from './project.service.js';

const GIT_OP_TIMEOUT_MS = 15_000;

type RepoCapability = <T>(repo: string, callback: (capabilityPath: string) => Promise<T>) => Promise<T>;

export interface CandidateReviewDeps {
  withRepo?: RepoCapability;
  getProject: (id: string) => Promise<ProjectData | null>;
  updateProject: (id: string, input: UpdateProjectInput) => Promise<ProjectData>;
  recordLearningOutcome?: (anchorWorkUnitId: string, input: TerminalLearningOutcomeInput) => Promise<unknown>;
}

export interface CandidateReviewStatus {
  candidate: PmoCandidate;
  status: PmoCandidateReview['status'];
  reviewWorkUnitId?: string;
}

export function parsePmoCandidateReview(metadata: unknown): {
  projectId: string;
  candidate: PmoCandidate;
} | null {
  const value = parseWuMetadata(typeof metadata === 'string' ? metadata : null).pmoCandidateReview;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return typeof record.projectId === 'string' && typeof record.candidate === 'object' && record.candidate !== null
    ? record as { projectId: string; candidate: PmoCandidate }
    : null;
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function isCandidateReview(snapshot: WorkUnitSnapshot): boolean {
  return parsePmoCandidateReview(snapshot.metadata) !== null;
}

function evidenceRevision(snapshots: WorkUnitSnapshot[]): string {
  return hash(snapshots.filter(snapshot => !isCandidateReview(snapshot)).map(snapshot => {
    const metadata = parseWuMetadata(snapshot.metadata);
    return {
      id: snapshot.id,
      status: snapshot.status,
      type: snapshot.type,
      ac: metadata.ac,
      attestations: metadata.attestations,
      verifyReport: metadata.verifyReport,
      mergeReceipt: metadata.mergeReceipt,
      legacyEvidence: metadata.legacyEvidence,
    };
  }));
}

/** 候选只绑定真实腿 head 与交付证据；Effect、派单时间和评审 WU 自身不参与指纹。 */
export async function buildPmoCandidate(
  project: ProjectData,
  snapshots: WorkUnitSnapshot[],
  withRepo: RepoCapability = withExecutionRepo,
): Promise<PmoCandidate> {
  const legs = resolveDeliveries(project);
  const { perLeg, shared } = partitionSnapshotsByLeg(legs, snapshots);
  const candidateLegs: PmoCandidateLeg[] = [];
  for (let index = 0; index < legs.length; index++) {
    const leg = legs[index];
    if (!leg.gitRepo || !leg.branch) throw new Error('整体评审候选存在缺 gitRepo/branch 的必需腿');
    // 存量数据纵深防线：首个 Git 子进程前拒绝非法分支，仓库访问持 capability。
    if (!isValidGitBranch(leg.branch)) throw new Error(`非法 PMO 分支名，拒绝读取候选: ${leg.branch}`);
    const gitRepo = leg.gitRepo;
    const branch = leg.branch;
    await withRepo(gitRepo, async capabilityRepo => {
      const { getDefaultBranch } = await import('@dommaker/studio-agent');
      const baseBranch = getDefaultBranch(capabilityRepo);
      const stdout = await execFileAsync('git', ['-C', capabilityRepo, 'rev-parse', '--verify', `${branch}^{commit}`], {
        cwd: capabilityRepo, timeout: GIT_OP_TIMEOUT_MS,
      });
      const headCommit = stdout.trim();
      if (!headCommit) throw new Error(`整体评审候选读取不到腿 head: ${branch}`);
      candidateLegs.push({
        gitRepo,
        branch,
        baseBranch,
        headCommit,
        evidenceRevision: evidenceRevision([...perLeg[index], ...shared]),
      });
    });
  }
  const implementerIds = [...new Set(snapshots.filter(snapshot => CODE_TYPES.has(snapshot.type) && !isCandidateReview(snapshot))
    // requestedBy/grantedBy 会沿派生链继承，不能据此认定实际实现者。
    .flatMap(snapshot => [snapshot.assigneeRoleId, snapshot.assigneeId])
    .filter((id): id is string => Boolean(id)))].sort();
  return { id: hash(candidateLegs), legs: candidateLegs, implementerIds };
}

function anchorFor(project: ProjectData, snapshots: WorkUnitSnapshot[]): WorkUnitSnapshot {
  // 调用方已按 PMO 归属筛选；存量 WU 可能只有 REQ 血缘而没有 metadata.pmoId。
  const owned = snapshots.filter(snapshot => !isCandidateReview(snapshot));
  const anchor = owned.find(snapshot => snapshot.type === 'plan') ?? owned[0];
  if (!anchor) throw new Error('整体评审需要项目内持久 WU 作为 Effect 锚点');
  return anchor;
}

export class CandidateReviewService {
  private readonly effects: EffectService;
  private readonly pendingRetries = new Set<string>();

  constructor(
    private readonly fileStore: FileStore,
    private readonly workUnitService: WorkUnitService,
    private readonly deps: CandidateReviewDeps,
  ) {
    this.effects = new EffectService(fileStore);
  }

  private scheduleRetry(effect: EffectRecord): void {
    if (this.pendingRetries.has(effect.id)) return;
    this.pendingRetries.add(effect.id);
    const delay = Math.max(0, (effect.nextAttemptAt ? Date.parse(effect.nextAttemptAt) : Date.now()) - Date.now());
    const timer = setTimeout(() => {
      this.pendingRetries.delete(effect.id);
      void this.executeEffect(effect).catch(error => logger.warn('[CandidateReview] persistent effect retry failed', {
        effectId: effect.id, error: String(error),
      }));
    }, delay);
    timer.unref?.();
  }

  private async executeEffect(effect: EffectRecord): Promise<EffectRecord | null> {
    const executed = await this.effects.execute(effect.workUnitId, effect.id, context => context.effect.kind === 'pmo-review-dispatch'
      ? this.performDispatch(context.workUnit, context.effect.id)
      : this.performResult(context.workUnit, context.effect.id));
    if (executed?.status === 'queued') this.scheduleRetry(executed);
    return executed;
  }

  async getReviewStatus(project: ProjectData, snapshots: WorkUnitSnapshot[]): Promise<CandidateReviewStatus> {
    const candidate = await buildPmoCandidate(project, snapshots, this.deps.withRepo ?? withExecutionRepo);
    const record = project.candidateReview;
    return {
      candidate,
      status: record?.candidate.id === candidate.id ? record.status : 'pending',
      ...(record?.candidate.id === candidate.id && record.reviewWorkUnitId ? { reviewWorkUnitId: record.reviewWorkUnitId } : {}),
    };
  }

  async ensureReview(project: ProjectData, snapshots: WorkUnitSnapshot[]): Promise<CandidateReviewStatus> {
    const candidate = await buildPmoCandidate(project, snapshots, this.deps.withRepo ?? withExecutionRepo);
    const existing = project.candidateReview;
    if (existing?.candidate.id === candidate.id && existing.status !== 'pending') {
      return { candidate, status: existing.status, ...(existing.reviewWorkUnitId ? { reviewWorkUnitId: existing.reviewWorkUnitId } : {}) };
    }
    const anchor = anchorFor(project, snapshots);
    const effect = await this.effects.enqueue(anchor.id, {
      kind: 'pmo-review-dispatch',
      idempotencyKey: `pmo-review-dispatch:${project.id}:${candidate.id}`,
      trigger: 'automatic',
      payload: { projectId: project.id, candidate },
    });
    if (existing?.candidate.id !== candidate.id) {
      await this.deps.updateProject(project.id, {
        candidateReview: { candidate, status: 'pending', updatedAt: new Date().toISOString() },
      });
    }
    await this.executeEffect(effect);
    const latest = await this.deps.getProject(project.id);
    const record = latest?.candidateReview;
    return {
      candidate,
      status: record?.candidate.id === candidate.id ? record.status : 'pending',
      ...(record?.candidate.id === candidate.id && record.reviewWorkUnitId ? { reviewWorkUnitId: record.reviewWorkUnitId } : {}),
    };
  }

  private async loadProjectSnapshots(projectId: string): Promise<WorkUnitSnapshot[]> {
    const { RequirementService } = await import('../requirements/index.js');
    const requirements = await new RequirementService(this.fileStore).list();
    return selectProjectSnapshots(projectId, requirements, await this.fileStore.getIndex());
  }

  async submitHumanReview(
    projectId: string,
    by: string,
    input: { verdict: 'pass' | 'reject'; summary?: string; issues?: Array<{ message: string; leg?: string }> },
  ): Promise<CandidateReviewStatus> {
    const project = await this.deps.getProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);
    const snapshots = await this.loadProjectSnapshots(projectId);
    const candidate = await buildPmoCandidate(project, snapshots, this.deps.withRepo ?? withExecutionRepo);
    const anchor = anchorFor(project, snapshots);
    if (project.candidateReview?.candidate.id !== candidate.id) {
      await this.deps.updateProject(projectId, {
        candidateReview: { candidate, status: 'pending', updatedAt: new Date().toISOString() },
      });
    }
    const effect = await this.effects.enqueue(anchor.id, {
      kind: 'pmo-review-result',
      idempotencyKey: `pmo-review-result:${project.id}:${candidate.id}:human:${by}`,
      trigger: 'manual',
      payload: { projectId, candidate, ...input, reviewer: { id: by, kind: 'human' } },
    });
    await this.executeEffect(effect);
    const record = (await this.deps.getProject(projectId))?.candidateReview;
    return {
      candidate,
      status: record?.candidate.id === candidate.id ? record.status : 'pending',
      ...(record?.reviewWorkUnitId ? { reviewWorkUnitId: record.reviewWorkUnitId } : {}),
    };
  }

  async recoverEffects() {
    const result = await this.effects.recover(context => context.effect.kind === 'pmo-review-dispatch'
      ? this.performDispatch(context.workUnit, context.effect.id)
      : this.performResult(context.workUnit, context.effect.id), {
      include: (_snapshot, effect) => effect.kind === 'pmo-review-dispatch' || effect.kind === 'pmo-review-result',
    });
    for (const snapshot of await this.fileStore.getIndex()) {
      for (const effect of snapshot.effects ?? []) {
        if ((effect.kind === 'pmo-review-dispatch' || effect.kind === 'pmo-review-result') && effect.status === 'queued') {
          this.scheduleRetry(effect);
        }
      }
    }
    return result;
  }

  private async performResult(anchor: WorkUnitSnapshot, effectId: string): Promise<Record<string, unknown>> {
    const effect = anchor.effects?.find(item => item.id === effectId);
    if (!effect) throw new Error(`整体评审结果 Effect ${effectId} 不存在`);
    const projectId = effect.payload?.projectId;
    const candidate = effect.payload?.candidate as PmoCandidate | undefined;
    const verdict = effect.payload?.verdict;
    if (typeof projectId !== 'string' || !candidate
      || (verdict !== 'pass' && verdict !== 'reject' && verdict !== 'needs-info')) {
      throw new Error('整体评审结果 Effect 缺 projectId/candidate/verdict');
    }
    const project = await this.deps.getProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);
    if (project.candidateReview?.candidate.id !== candidate.id) return { stale: true };
    const reviewer = effect.payload?.reviewer as { id: string; kind: 'agent' | 'human' };
    const independent = reviewer.id.length > 0 && !candidate.implementerIds.includes(reviewer.id);
    const status = verdict === 'pass' && independent ? 'approved'
      : verdict === 'reject' && independent ? 'rejected'
        : 'human-required';
    const affectedSnapshots = status === 'rejected' ? await this.loadProjectSnapshots(projectId) : [];
    const repairWorkUnitIds = status === 'rejected'
      ? await this.createRepairWorkUnits(project, candidate, anchor, effect.payload?.issues, effect.payload?.summary)
      : [];
    await this.deps.updateProject(projectId, {
      candidateReview: {
        ...project.candidateReview,
        candidate,
        status,
        ...(status === 'human-required' ? {} : { reviewer }),
        ...(typeof effect.payload?.summary === 'string' ? { summary: effect.payload.summary } : {}),
        ...(repairWorkUnitIds.length > 0 ? { repairWorkUnitIds } : {}),
        updatedAt: new Date().toISOString(),
      },
    });
    if (status === 'rejected') {
      const input: TerminalLearningOutcomeInput = {
        eventId: `pmo-review-rejected:${projectId}:${candidate.id}`,
        kind: 'pmo-review-rejected',
        workUnitIds: affectedSnapshots.map(snapshot => snapshot.id),
      };
      if (this.deps.recordLearningOutcome) {
        await this.deps.recordLearningOutcome(anchorFor(project, affectedSnapshots).id, input);
      } else {
        const { getKnowledgeOutcomeEffects } = await import('../knowledge/index.js');
        await getKnowledgeOutcomeEffects(this.fileStore).trigger(anchorFor(project, affectedSnapshots).id, input);
      }
    }
    return { status, ...(repairWorkUnitIds.length > 0 ? { repairWorkUnitIds } : {}), ...(independent ? {} : { selfReviewRejected: true }) };
  }

  private async createRepairWorkUnits(
    project: ProjectData,
    candidate: PmoCandidate,
    resultAnchor: WorkUnitSnapshot,
    rawIssues: unknown,
    summary: unknown,
  ): Promise<string[]> {
    const issues = (Array.isArray(rawIssues) ? rawIssues : []).flatMap(value => {
      if (typeof value !== 'object' || value === null) return [];
      const issue = value as Record<string, unknown>;
      return typeof issue.message === 'string' && issue.message
        ? [{ message: issue.message, ...(typeof issue.leg === 'string' ? { leg: issue.leg } : {}) }]
        : [];
    });
    if (issues.length === 0) issues.push({ message: typeof summary === 'string' && summary ? summary : '修复整体评审拒绝的问题' });
    const snapshots = await this.fileStore.getIndex();
    const anchor = snapshots.find(snapshot => snapshot.type === 'plan' && parseWuMetadata(snapshot.metadata).pmoId === project.id)
      ?? (resultAnchor.parentId ? snapshots.find(snapshot => snapshot.id === resultAnchor.parentId) : resultAnchor)
      ?? resultAnchor;
    const repairIds: string[] = [];
    for (const leg of candidate.legs) {
      const scoped = issues.filter(issue => !issue.leg || issue.leg === leg.branch);
      if (scoped.length === 0) continue;
      const repair = await this.workUnitService.createGuarded({
        type: 'task',
        scope: `修复 ${project.pmoNumber} 整体评审问题（${leg.branch}）：${scoped.map(issue => issue.message).join('；')}`,
        status: 'unassigned',
        channelId: project.channelId ?? anchor.channelId,
        parentId: anchor.id,
        reqId: anchor.reqId ?? project.reqAlias ?? null,
        metadata: {
          pmoId: project.id,
          title: `${project.pmoNumber} 整体评审修复（${leg.branch}）`,
          workspaceRoot: leg.gitRepo,
          pmoBranch: leg.branch,
          ac: scoped.map(issue => issue.message),
          pmoCandidateRepair: { projectId: project.id, candidateId: candidate.id, gitRepo: leg.gitRepo },
        },
      }, current => !current.some(snapshot => {
        const marker = parseWuMetadata(snapshot.metadata).pmoCandidateRepair;
        if (typeof marker !== 'object' || marker === null) return false;
        const value = marker as Record<string, unknown>;
        return value.candidateId === candidate.id && value.gitRepo === leg.gitRepo;
      }));
      if (repair) repairIds.push(repair.id);
      else {
        const existing = (await this.fileStore.getIndex()).find(snapshot => {
          const marker = parseWuMetadata(snapshot.metadata).pmoCandidateRepair;
          if (typeof marker !== 'object' || marker === null) return false;
          const value = marker as Record<string, unknown>;
          return value.candidateId === candidate.id && value.gitRepo === leg.gitRepo;
        });
        if (existing) repairIds.push(existing.id);
      }
    }
    return repairIds;
  }

  private async performDispatch(anchor: WorkUnitSnapshot, effectId: string): Promise<Record<string, unknown>> {
    const effect = anchor.effects?.find(item => item.id === effectId);
    const projectId = effect?.payload?.projectId;
    const candidate = effect?.payload?.candidate as PmoCandidate | undefined;
    if (typeof projectId !== 'string' || !candidate) throw new Error('整体评审派单 Effect 缺 projectId/candidate');
    const allSnapshots = await this.fileStore.getIndex();
    const snapshots = await this.loadProjectSnapshots(projectId);
    const project = await this.deps.getProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);
    const existing = allSnapshots.find(snapshot => parsePmoCandidateReview(snapshot.metadata)?.candidate.id === candidate.id);
    if (existing) {
      if (project.candidateReview?.candidate.id === candidate.id && !project.candidateReview.reviewWorkUnitId) {
        await this.deps.updateProject(projectId, {
          candidateReview: { ...project.candidateReview, reviewWorkUnitId: existing.id, updatedAt: new Date().toISOString() },
        });
      }
      return { reviewWorkUnitId: existing.id, duplicatePrevented: true };
    }
    const currentCandidate = await buildPmoCandidate(project, snapshots, this.deps.withRepo ?? withExecutionRepo);
    if (currentCandidate.id !== candidate.id) return { stale: true };

    const channelId = project.channelId ?? anchor.channelId;
    const channel = channelId ? await this.fileStore.getChannel(channelId) : null;
    const memberIds = parseChannels(channel?.members);
    const profiles = memberIds.length > 0 ? await this.fileStore.listProfiles({ status: 'active' }) : [];
    const eligible = profiles.filter(profile => memberIds.includes(profile.id)
      && !isSystemRole(profile) && !candidate.implementerIds.includes(profile.id));
    if (!channelId || eligible.length === 0) {
      await this.deps.updateProject(projectId, {
        candidateReview: { candidate, status: 'human-required', updatedAt: new Date().toISOString() },
      });
      return { humanRequired: true };
    }

    const scope = this.reviewScope(project, candidate, snapshots);
    const metadata: WorkUnitMetadata = {
      pmoId: project.id,
      title: `${project.pmoNumber} 整体评审`,
      effectId,
      excludeAssignees: candidate.implementerIds,
      reviewInput: { mode: 'pmo-candidate', skill: 'code-review' },
      pmoCandidateReview: { projectId, candidate },
    };
    const review = await this.workUnitService.createGuarded({
      type: 'review', scope, status: 'unassigned', channelId, parentId: anchor.id,
      reqId: anchor.reqId ?? project.reqAlias ?? null, metadata,
    }, current => !current.some(snapshot => parsePmoCandidateReview(snapshot.metadata)?.candidate.id === candidate.id));
    if (!review) {
      const adopted = (await this.fileStore.getIndex()).find(snapshot => parsePmoCandidateReview(snapshot.metadata)?.candidate.id === candidate.id);
      if (adopted) return { reviewWorkUnitId: adopted.id, duplicatePrevented: true };
      throw new Error('整体评审建单被并发守卫拒绝且找不到既有评审');
    }
    await this.deps.updateProject(projectId, {
      candidateReview: {
        candidate, status: 'pending', reviewWorkUnitId: review.id, updatedAt: new Date().toISOString(),
      },
    });
    return { reviewWorkUnitId: review.id };
  }

  private reviewScope(project: ProjectData, candidate: PmoCandidate, snapshots: WorkUnitSnapshot[]): string {
    const acceptance = snapshots.flatMap(snapshot => parseWuMetadata(snapshot.metadata).ac ?? []);
    const legs = candidate.legs.map(leg => {
      const evidence = snapshots.filter(snapshot => matchWuToLeg(snapshot.metadata, leg)
        || !candidate.legs.some(other => matchWuToLeg(snapshot.metadata, other)))
        .map(snapshot => {
          const metadata = parseWuMetadata(snapshot.metadata);
          return {
            id: snapshot.id,
            status: snapshot.status,
            attestations: metadata.attestations,
            verification: metadata.mergeReceipt?.verification ?? metadata.verifyReport,
          };
        });
      return `- ${leg.gitRepo} ${leg.branch} base=${leg.baseBranch} head=${leg.headCommit} evidence=${leg.evidenceRevision}
  diff: git -C ${leg.gitRepo} diff ${leg.baseBranch}...${leg.headCommit}
  验证证据: ${JSON.stringify(evidence)}`;
    }).join('\n');
    return `对 ${project.pmoNumber} 的确切多仓候选做整体评审 +code-review

需求：${project.requirement ?? project.description ?? project.title}
验收标准：${acceptance.length > 0 ? acceptance.join('；') : '按项目需求与既有验证证据验收'}
候选腿（含 base/head diff 与验证事实）：
${legs}

逐仓执行给定 diff 命令检查真实变更，并核对跨仓接口、验收标准、验证证据和交付顺序。不得凭实现者叙述通过；无法取得候选事实时输出 needs-info。
REVIEW_RESULT 的每个 reject issue 必须带可定位的 message，并尽量带 leg=<对应 branch>。
最后一行输出：REVIEW_RESULT: {"verdict":"pass"|"reject"|"needs-info","summary":"...","issues":[{"severity":"error","message":"...","leg":"..."}]}`;
  }
}

const services = new WeakMap<FileStore, CandidateReviewService>();

export function getCandidateReviewService(fileStore: FileStore = getStore()): CandidateReviewService {
  const existing = services.get(fileStore);
  if (existing) return existing;
  const service = new CandidateReviewService(fileStore, new WorkUnitService(fileStore), {
    getProject: id => projectService.getFresh(id),
    updateProject: (id, input) => projectService.update(id, input),
  });
  services.set(fileStore, service);
  return service;
}
