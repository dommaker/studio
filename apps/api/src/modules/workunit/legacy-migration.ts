/**
 * #710 存量 WU 幂等升级：在途 Assignment/Mandate + 历史代码完成证据。
 * 旧事件保持原样；新事实经既有 WU 快照事件追加，不伪造请求人、merge 或验证结果。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  parseAttestations,
  withAttestation,
  WorkUnitMetadataRepository,
  type AssignmentRecord,
  type FileStore,
  type MandateRecord,
  type WorkUnitSnapshot,
} from '@dommaker/studio-shared';
import { isValidGitBranch } from '@dommaker/studio-contract';
import { logger } from '@dommaker/studio-shared/node';
import { studioPath } from '@dommaker/studio-shared/studio-dir';
import { execFileAsync } from '../../core/exec-async.js';
import { withDeliveryLegLock } from '../../core/delivery-leg-lock.js';
import { withExecutionRepo } from '../../utils/execution-repo-policy.js';
import { issueMandate, SYSTEM_PRINCIPAL } from './mandate.js';
import { snapshotToData } from './workunit-crud.js';
import { WorkUnitService } from './workunit-review.js';
import type { WorkUnitMetadata, WorkUnitMergeReceipt } from './workunit.types.js';
import { parseWuMetadata } from './wu-metadata.js';
import { workUnitPort, type WorkUnitVerificationPort } from './workunit-ports.js';

const CODE_TYPES = new Set(['task', 'bug', 'feature', 'refactor']);
const SYSTEM_DERIVED_CREATION_MODES = new Set(['analysis-breakdown', 'spec-materialization', 'agent-delegate']);
const RELIABLE_OWNERSHIP_SOURCES = new Set(['requirement', 'file-refs', 'channel-default-path', 'human-reply', 'explicit']);
const GIT_TIMEOUT_MS = 15_000;

export interface LegacyMigrationResult {
  assignments: number;
  mandates: number;
  reauthorizations: number;
  receipts: number;
  repairs: number;
}

export interface LegacyMigrationOptions {
  verify?: WorkUnitVerificationPort['run'];
}

function validString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function legacyAssignment(snapshot: WorkUnitSnapshot, metadata: WorkUnitMetadata): AssignmentRecord {
  const status = snapshot.status === 'active' ? 'running'
    : snapshot.status === 'in_review' ? 'succeeded' : 'waiting';
  const createdAt = validString(metadata.startedAt) ? metadata.startedAt : snapshot.claimedAt ?? snapshot.createdAt;
  const progress = (metadata.progressLog ?? []).filter(entry =>
    Number.isInteger(entry.step) && validString(entry.action) && validString(entry.at),
  ).map(entry => ({
    step: entry.step,
    action: entry.action,
    summary: typeof entry.summary === 'string' ? entry.summary : '',
    at: entry.at,
  }));
  const attestations = parseAttestations(metadata);
  const evidence = Object.entries(attestations ?? {}).flatMap(([level, entry]) => entry ? [{
    level, verdict: entry.verdict, at: entry.at,
  }] : []);
  return {
    id: `legacy-assignment:${snapshot.id}:1`,
    workUnitId: snapshot.id,
    attempt: 1,
    previousAssignmentId: null,
    status,
    reason: 'recovery',
    createdAt,
    updatedAt: snapshot.updatedAt,
    ...(validString(metadata.startedAt) || snapshot.claimedAt ? { startedAt: createdAt } : {}),
    ...(status === 'waiting' && validString(metadata.waitingSince) ? { waitingAt: metadata.waitingSince } : {}),
    ...(status === 'succeeded' ? { endedAt: snapshot.updatedAt } : {}),
    ...(validString(metadata.sessionId) ? { sessionId: metadata.sessionId } : {}),
    ...(validString(metadata.cliSessionId) ? { cliSessionId: metadata.cliSessionId } : {}),
    ...(validString(metadata.worktreePath) ? { worktreePath: metadata.worktreePath } : {}),
    ...(validString(metadata.worktreeBranch) ? { worktreeBranch: metadata.worktreeBranch } : {}),
    tokenCount: typeof metadata._cumulativeTokens === 'number'
      && Number.isFinite(metadata._cumulativeTokens) && metadata._cumulativeTokens >= 0
      ? metadata._cumulativeTokens : 0,
    transcriptCount: 0,
    progress,
    evidence,
  };
}

/** 旧频道消息没有认证主体 id；只有明确的系统派生记录才可使用 System 请求人。 */
function deriveLegacyMandate(snapshot: WorkUnitSnapshot, metadata: WorkUnitMetadata): MandateRecord | null {
  if (!SYSTEM_DERIVED_CREATION_MODES.has(metadata.creationMode ?? '')) return null;
  if (!validString(metadata.workspaceRoot)) return null;
  const reliableOwnership = RELIABLE_OWNERSHIP_SOURCES.has(metadata.ownershipSource ?? '')
    || metadata.worktreeBaseRepo === metadata.workspaceRoot;
  if (!reliableOwnership) return null;
  return issueMandate({
    workUnitId: snapshot.id,
    reqId: snapshot.reqId,
    metadata,
    authorization: { requestedBy: SYSTEM_PRINCIPAL, source: { kind: 'system' } },
  });
}

async function migrateInFlight(
  snapshot: WorkUnitSnapshot,
  repository: WorkUnitMetadataRepository,
  service: WorkUnitService,
  result: LegacyMigrationResult,
): Promise<void> {
  const metadata = parseWuMetadata(snapshot.metadata);
  if (!snapshot.mandate && metadata.blockReason?.includes('legacy-mandate-reauthorization')) return;
  const derivedMandate = snapshot.mandate ? null : deriveLegacyMandate(snapshot, metadata);
  let addedAssignment = false;
  let addedMandate = false;
  const updated = await repository.mutateSnapshot(snapshot.id, current => {
    if (!['active', 'in_review', 'blocked'].includes(current.status)) return null;
    const currentMetadata = parseWuMetadata(current.metadata);
    const isWaiting = current.status === 'blocked' && currentMetadata.waitingForInput === true;
    if (current.status === 'blocked' && !isWaiting) return null;
    const assignment = (current.assignments ?? []).length === 0
      ? legacyAssignment(current, currentMetadata) : null;
    const mandate = !current.mandate && current.status === snapshot.status ? derivedMandate : null;
    if (!assignment && !mandate) return null;
    addedAssignment = assignment !== null;
    addedMandate = mandate !== null;
    return {
      ...current,
      ...(assignment ? { currentAssignmentId: assignment.id, assignments: [assignment] } : {}),
      ...(mandate ? { mandate } : {}),
    };
  });
  if (addedAssignment) result.assignments++;
  if (addedMandate) result.mandates++;
  const latest = updated ?? await service.getById(snapshot.id);
  if (latest && !latest.mandate && ['active', 'in_review', 'blocked'].includes(latest.status)) {
    // 先取消旧执行轮次，再走统一迁移尾部；普通回复不能替代 Operator 重新授权。
    await service.unclaim(snapshot.id);
    await service.blockForManualRelease(snapshot.id, 'legacy-mandate-reauthorization: 旧请求缺少可靠认证主体，请由 Operator 重新授权');
    result.reauthorizations++;
  }
}

interface LegacyMergeFact {
  mergeCommit: string;
  mergedAt: string;
  targetCommit: string;
  targetBranch: string;
}

async function git(repo: string, args: string[]): Promise<string> {
  return execFileAsync('git', ['-C', repo, ...args], { cwd: repo, timeout: GIT_TIMEOUT_MS });
}

function isNotAncestor(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 1;
}

async function findLegacyMergeCommit(repo: string, wuId: string, sourceCommit: string, targetCommit: string): Promise<string | null> {
  const log = await git(repo, [
    'log', '--merges', '--format=%H%x20%P%x20%s', '--ancestry-path', `${sourceCommit}..${targetCommit}`,
  ]);
  const matches = log.split('\n').filter(line => {
    const [commit, ...rest] = line.trim().split(/\s+/);
    return Boolean(commit) && rest.includes(sourceCommit) && rest.join(' ').includes(`merge: ${wuId} `);
  });
  return matches.length === 1 ? matches[0].trim().split(/\s+/, 1)[0] : null;
}

/** 只读证明来源已进入目标，并定位本 WU 的真实 merge commit；不把目标 HEAD 冒认成回执。 */
async function inspectLegacyMerge(
  repo: string,
  snapshot: WorkUnitSnapshot,
  metadata: WorkUnitMetadata,
): Promise<{ kind: 'merged'; fact: LegacyMergeFact } | { kind: 'unmerged' }> {
  const sourceBranch = metadata.worktreeBranch!;
  const targetBranch = metadata.pmoBranch ?? metadata.worktreeBaseBranch!;
  const sourceCommit = (await git(repo, ['rev-parse', '--verify', `refs/heads/${sourceBranch}`])).trim();
  const targetCommit = (await git(repo, ['rev-parse', '--verify', `refs/heads/${targetBranch}`])).trim();
  try {
    await git(repo, ['merge-base', '--is-ancestor', sourceCommit, targetCommit]);
  } catch (error) {
    if (isNotAncestor(error)) return { kind: 'unmerged' };
    throw error;
  }
  const mergeCommit = await findLegacyMergeCommit(repo, snapshot.id, sourceCommit, targetCommit);
  if (!mergeCommit) throw new Error('无法判定历史 merge commit');
  const mergedAt = (await git(repo, ['show', '-s', '--format=%cI', mergeCommit])).trim();
  return { kind: 'merged', fact: { mergeCommit, mergedAt, targetCommit, targetBranch } };
}

async function verifyLegacyTarget(
  repo: string,
  snapshot: WorkUnitSnapshot,
  metadata: WorkUnitMetadata,
  fact: LegacyMergeFact,
  verify: WorkUnitVerificationPort['run'],
) {
  const worktreesDir = process.env.WORKTREES_DIR || studioPath('worktrees');
  await fs.promises.mkdir(worktreesDir, { recursive: true });
  const verificationWorktree = path.join(worktreesDir, `legacy-verify-${snapshot.id}-${randomUUID()}`);
  try {
    await git(repo, ['worktree', 'add', '--detach', '--', verificationWorktree, fact.targetCommit]);
    return await verify(snapshotToData(snapshot), metadata, verificationWorktree, { cwdProvenance: 'merge-target' });
  } finally {
    await git(repo, ['worktree', 'remove', '--force', '--', verificationWorktree]).catch(error => {
      logger.warn('[LegacyMigration] temporary verification worktree cleanup failed', {
        workUnitId: snapshot.id, error: String(error),
      });
    });
  }
}

async function ensureRepair(
  snapshot: WorkUnitSnapshot,
  reason: string,
  service: WorkUnitService,
  repository: WorkUnitMetadataRepository,
  result: LegacyMigrationResult,
  fileStore: FileStore,
): Promise<void> {
  const metadata = parseWuMetadata(snapshot.metadata);
  const findRepair = async () => (await fileStore.getIndex())
    .find(item => parseWuMetadata(item.metadata).legacyRepairOf === snapshot.id);
  const existing = await findRepair();
  const created = existing ? null : await service.createGuarded({
    type: 'bug',
    scope: `修复历史交付：${snapshot.scope}`.slice(0, 500),
    status: 'unassigned',
    channelId: snapshot.channelId,
    reqId: snapshot.reqId ?? null,
    metadata: {
      creationMode: 'legacy-repair',
      legacyRepairOf: snapshot.id,
      legacyRepairReason: reason,
      ac: [`核实并补齐历史 WU ${snapshot.id} 的真实合并与验证证据`],
      ...(validString(metadata.pmoId) ? { pmoId: metadata.pmoId } : {}),
      ...(validString(metadata.workspaceRoot) ? { workspaceRoot: metadata.workspaceRoot } : {}),
      ...(validString(metadata.pmoBranch) ? { pmoBranch: metadata.pmoBranch } : {}),
      ...(validString(metadata.worktreeBaseBranch) ? { worktreeBaseBranch: metadata.worktreeBaseBranch } : {}),
    },
    authorization: { requestedBy: SYSTEM_PRINCIPAL, source: { kind: 'system' } },
  }, snapshots => !snapshots.some(item => parseWuMetadata(item.metadata).legacyRepairOf === snapshot.id));
  // 另一进程可能已在 guarded create 前建单；认养它并完成原单标记，不能提前返回。
  const repair = existing ?? created ?? await findRepair();
  if (!repair) throw new Error(`Unable to create or adopt legacy repair for ${snapshot.id}`);
  const checkedAt = new Date().toISOString();
  const updated = await repository.mutateSnapshot(snapshot.id, current => {
    const currentMetadata = parseWuMetadata(current.metadata);
    if (current.status !== 'done' || currentMetadata.mergeReceipt) return null;
    if (currentMetadata.legacyEvidence?.status === 'legacy-unverified'
      && currentMetadata.legacyEvidence.repairWorkUnitId === repair.id
      && currentMetadata.legacyEvidence.reason === reason) return null;
    currentMetadata.legacyEvidence = {
      status: 'legacy-unverified', checkedAt, reason, repairWorkUnitId: repair.id,
    };
    return { ...current, metadata: JSON.stringify(currentMetadata) };
  });
  if (updated && created) result.repairs++;
}

async function recordLegacyReceipt(
  snapshot: WorkUnitSnapshot,
  fact: LegacyMergeFact,
  verification: Awaited<ReturnType<WorkUnitVerificationPort['run']>>,
  repository: WorkUnitMetadataRepository,
): Promise<boolean> {
  const checkedAt = new Date().toISOString();
  const updated = await repository.mutateSnapshot(snapshot.id, current => {
    const metadata = parseWuMetadata(current.metadata);
    if (current.status !== 'done' || metadata.mergeReceipt) return null;
    const receipt: WorkUnitMergeReceipt = {
      id: `legacy-merge:${current.id}`,
      legacy: true,
      merged: true,
      mergedAt: fact.mergedAt,
      mergeCommit: fact.mergeCommit,
      targetBranch: fact.targetBranch,
      verification: { status: 'passed', ran: verification.ran },
    };
    metadata.mergeReceipt = receipt;
    metadata.mergedAt = fact.mergedAt;
    metadata.mergeCommit = fact.mergeCommit;
    metadata.legacyEvidence = { status: 'reconciled', checkedAt };
    metadata.attestations = withAttestation(metadata.attestations, 'l1', {
      verdict: 'approved', by: 'legacy-reconciliation', at: checkedAt, kind: 'verify',
      summary: verification.ran.join('；').slice(0, 300), ref: fact.mergeCommit,
    });
    metadata.verifyReport = { commands: verification.ran, source: 'convention', passedAt: checkedAt };
    return { ...current, metadata: JSON.stringify(metadata) };
  });
  return updated !== null;
}

async function migrateHistoricalDone(
  snapshot: WorkUnitSnapshot,
  service: WorkUnitService,
  repository: WorkUnitMetadataRepository,
  fileStore: FileStore,
  options: LegacyMigrationOptions,
  result: LegacyMigrationResult,
): Promise<void> {
  const metadata = parseWuMetadata(snapshot.metadata);
  if (metadata.legacyEvidence?.status === 'legacy-unverified' && metadata.legacyEvidence.repairWorkUnitId) return;
  if (!validString(metadata.worktreeBranch) || !validString(metadata.worktreeBaseRepo)
    || !validString(metadata.worktreeBaseBranch)
    || (metadata.pmoBranch !== undefined && !validString(metadata.pmoBranch))) {
    await ensureRepair(snapshot, '无法判定：旧 WU 缺少完整 Git 来源/目标记录', service, repository, result, fileStore);
    return;
  }
  if (![metadata.worktreeBranch, metadata.worktreeBaseBranch, ...(metadata.pmoBranch ? [metadata.pmoBranch] : [])]
    .every(isValidGitBranch)) {
    await ensureRepair(snapshot, '无法判定：旧 WU 的 Git 分支记录无效', service, repository, result, fileStore);
    return;
  }

  try {
    await withExecutionRepo(metadata.worktreeBaseRepo, repo => withDeliveryLegLock({
      fileStore, repo, branch: metadata.pmoBranch ?? metadata.worktreeBaseBranch!,
    }, async () => {
      const inspected = await inspectLegacyMerge(repo, snapshot, metadata);
      if (inspected.kind === 'unmerged') {
        await ensureRepair(snapshot, '历史来源分支未进入目标分支', service, repository, result, fileStore);
        return;
      }
      const verify = options.verify ?? (await workUnitPort('verification')).run;
      const verification = await verifyLegacyTarget(repo, snapshot, metadata, inspected.fact, verify);
      if (verification.failure || verification.ran.length === 0) {
        const reason = verification.failure
          ? `历史合并目标验证失败（${verification.failure.command}）`
          : '历史合并目标没有可执行的验证，不能自动补证';
        await ensureRepair(snapshot, reason, service, repository, result, fileStore);
        return;
      }
      if (await recordLegacyReceipt(snapshot, inspected.fact, verification, repository)) result.receipts++;
    }));
  } catch (error) {
    await ensureRepair(snapshot, `无法判定：真实 Git 对账失败（${String(error).slice(0, 240)}）`, service, repository, result, fileStore);
  }
}

/** 启动期可重入迁移；单项失败向上交给 bootstrap soft-step，下次启动继续补差。 */
export async function migrateLegacyWorkUnits(
  fileStore: FileStore,
  options: LegacyMigrationOptions = {},
): Promise<LegacyMigrationResult> {
  const repository = new WorkUnitMetadataRepository(fileStore);
  const service = new WorkUnitService(fileStore);
  const result: LegacyMigrationResult = { assignments: 0, mandates: 0, reauthorizations: 0, receipts: 0, repairs: 0 };
  const snapshots = await fileStore.getIndex();
  for (const snapshot of snapshots) {
    const metadata = parseWuMetadata(snapshot.metadata);
    if (snapshot.status === 'done' && CODE_TYPES.has(snapshot.type) && !metadata.mergeReceipt) {
      await migrateHistoricalDone(snapshot, service, repository, fileStore, options, result);
    } else if (snapshot.status === 'active' || snapshot.status === 'in_review'
      || (snapshot.status === 'blocked' && metadata.waitingForInput === true)) {
      await migrateInFlight(snapshot, repository, service, result);
    }
  }
  if (Object.values(result).some(count => count > 0)) logger.info('[LegacyMigration] WorkUnit upgrade completed', result);
  return result;
}
