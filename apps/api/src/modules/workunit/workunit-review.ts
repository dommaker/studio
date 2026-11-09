/**
 * WorkUnit 评审验收层 —— WorkUnitReviewService（#672 自 workunit.service.ts 拆分，纯代码移动）。
 *
 * 本层：评审验收收口——reviewPassed/reviewRejected、attestation 幂等补写
 * （writeHumanConfirmation/writeAgentReviewAttestation/recordL1Verification）、
 * verifyManually（#551 人工重跑 L1 业务下沉）、blockForMergeFailure/blockForManualRelease/
 * blockForAllUnfit（转人工类迁移）。全部迁移类写经生命周期层 persistSnapshot 统一尾部。
 * 状态机由 workunit-lifecycle.ts 经窄接口注入，模块级共享件：reviewPassTracker /
 * waitForReviewPassSettled（#228 测试可观测性）与 ManualVerifyResult。
 */

import { withAttestation, deriveDisplayState, createSettledTracker, WorkUnitSnapshotConflictError, type AttestationEntry, type FileStore, type WorkUnitSnapshot, type WorkUnitEvent } from '@dommaker/studio-shared';
import { mergeWorktreeBranchOnReviewPass, cleanupPrototypeWorktreeOnReviewPass } from './merge-on-review-pass.js';
import { MandateService, type MandateExpansion } from './mandate.js';
import type { MandatePrincipal } from '@dommaker/studio-shared';
import { parseWuMetadata } from './wu-metadata.js';
import { isAcceptedMergeReceipt, type WorkUnitMetadata, type ReviewAttestationSource, type WorkUnitMergeIntent, type WorkUnitMergeReceipt } from './workunit.types.js';
import { snapshotToData, WorkUnitCrudService, type WorkUnitData, type WorkUnitLifecycleRepository, type WorkUnitRepository } from './workunit-crud.js';
import { WorkUnitLifecycleService, type WorkUnitLifecycle, type WorkUnitLifecyclePersistence } from './workunit-lifecycle.js';
import { WorkUnitQueryService, type WorkUnitQuery } from './workunit-query.js';
import { workUnitPort, type WorkUnitAuditActor } from './workunit-ports.js';
import { logger } from '@dommaker/studio-shared/node';
import { HostExecutionPolicyError } from '../../core/host-execution-policy.js';
import { getStore } from '../../core/store.js';

/**
 * #228 测试可观测性（纯增量，不改变行为）：登记 reviewPassed 的 best-effort
 * 收尾（自动合并 / 原型 worktree 清理）在途 promise。收尾是 fire-and-forget，
 * 测试侧原本只能 waitFor 轮询盲等——全量负载下 git mock 链 + 频道消息落盘
 * 会吃满 3s 预算（merge-on-review-pass 偶发红）。
 */
const reviewPassTracker = createSettledTracker();
/** 同一 WU 的 merge effect 单飞；防止并发 reviewPassed 重跑 Git/LLM/清理。 */
const reviewPassMergeEffects = new Map<string, Promise<void>>();

/** #551：verifyManually 的判别联合结果——kind 承载守卫/执行结论，HTTP 语义由路由层映射 */
export type ManualVerifyResult =
  | { kind: 'not-found' }
  | { kind: 'not-code-type'; wuType: string }
  | { kind: 'no-worktree' }
  | { kind: 'invalid-worktree' }
  | { kind: 'no-commands' }
  | { kind: 'failed'; failure: { command: string; tail: string } }
  | { kind: 'verified'; report: unknown };

function trackReviewPassEffect(effect: Promise<unknown>): void {
  reviewPassTracker.track(effect);
}

/** #591：attestation 来源 → 埋点主体（human-confirm=人审；agent-review/缺省=agent 侧） */
function attestationActor(attestation?: ReviewAttestationSource): WorkUnitAuditActor | undefined {
  if (!attestation) return undefined;
  return { id: attestation.by, type: attestation.kind === 'human-confirm' ? 'human' : 'agent' };
}

/**
 * 等待当前已触发的全部 reviewPassed 收尾落定（测试用确定性信号，替代 waitFor 盲等）。
 * 收尾在 reviewPassed 返回前已同步登记，await 本函数即等到收尾（含频道消息落盘）完成。
 */
export async function waitForReviewPassSettled(): Promise<void> {
  await reviewPassTracker.waitForSettled();
}

export interface WorkUnitMergeSettlement {
  receipt: WorkUnitMergeReceipt;
  outcome: 'in_review' | 'blocked' | 'done';
  blockReason?: string;
  conflictFiles?: string[];
  mergeConflict?: boolean;
}

export interface WorkUnitReview {
  reviewPassed(id: string, attestation?: ReviewAttestationSource, options?: { defaultTaskAssigneeId?: string; analysisTasks?: string[]; analysisTaskDetails?: WorkUnitMetadata['analysisTaskDetails'] }): Promise<WorkUnitData>;
  reviewRejected(id: string, reason?: string, attestation?: ReviewAttestationSource): Promise<WorkUnitData>;
  recordMergeProgress(id: string, intent: WorkUnitMergeIntent): Promise<WorkUnitData>;
  settleMerge(id: string, settlement: WorkUnitMergeSettlement): Promise<WorkUnitData>;
  recordL1Verification(id: string, input: {
    by: string;
    ran: string[];
    source: 'override' | 'convention';
    failure?: { command: string; tail: string };
  }): Promise<WorkUnitData>;
  verifyManually(id: string, opts: { by: string }): Promise<ManualVerifyResult>;
  blockForMergeFailure(id: string, conflictFiles: string[], opts?: { blockReason?: string; mergeConflict?: boolean }): Promise<WorkUnitData>;
  blockForManualRelease(id: string, reason: string): Promise<WorkUnitData>;
  blockForAllUnfit(id: string, reason: string): Promise<WorkUnitData | null>;
}

export class WorkUnitReviewService implements WorkUnitReview {
  constructor(
    private readonly lifecycle: WorkUnitLifecyclePersistence,
    private readonly query: WorkUnitQuery,
    private readonly repository: WorkUnitRepository,
    private readonly fileStore: FileStore = getStore(),
  ) {}

  private readonly persistSnapshot: WorkUnitLifecyclePersistence['persistSnapshot'] =
    (current, metadata, opts) => this.lifecycle.persistSnapshot(current, metadata, opts);

  private readonly getById: WorkUnitQuery['getById'] = id => this.query.getById(id);

  /**
   * Review passed：非代码 WU in_review → done；有 worktree 的代码 WU 先落 mergeIntent，
   * 保持 in_review，merge receipt 与目标验证接受后才 done。
   * Resets consecutive rejection counter.
   * F6（决策 1）：attestation 入参带来源时写台账——agent-review → l2，human-confirm → l3。
   * F6-b：human-confirm 且当前已是 done → 幂等补写 l3（agent 评审通过的 WU 等人工确认，
   * 人类待办 = done ∧ ¬l3 必须有确认出口），不改状态、不重复触发合并。
   * F6-c（断点 3）：agent-review 且当前已是 done 且 l2 缺失 → 幂等补写 l2
   * （人工直推 done 抢跑评审链，迟到的评审结论无处落账的补票口），同不改状态、不触发合并。
   */
  async reviewPassed(id: string, attestation?: ReviewAttestationSource, options?: { defaultTaskAssigneeId?: string; analysisTasks?: string[]; analysisTaskDetails?: WorkUnitMetadata['analysisTaskDetails'] }): Promise<WorkUnitData> {
    const current = (await this.fileStore.getIndex({ id }))[0];
    if (!current) throw new Error('WorkUnit not found');
    if (current.status !== 'in_review') {
      if (current.status === 'done' && attestation?.kind === 'human-confirm') {
        return this.writeHumanConfirmation(current, attestation);
      }
      if (current.status === 'done' && attestation?.kind === 'agent-review'
        && !deriveDisplayState({ status: current.status, metadata: current.metadata }).evidence.l2) {
        return this.writeAgentReviewAttestation(current, attestation);
      }
      throw new Error(`Cannot review: current status is ${current.status}, expected in_review`);
    }

    const existing = parseWuMetadata(current.metadata);
    const mergeInFlight = existing.mergeIntent?.state === 'queued' || existing.mergeIntent?.state === 'running';
    const awaitingUnavailableConfirmation = existing.mergeReceipt?.merged === true
      && existing.mergeReceipt.verification.status === 'unavailable'
      && attestation?.kind === 'human-confirm';
    if (mergeInFlight && !awaitingUnavailableConfirmation) return snapshotToData(current);

    const metadata: WorkUnitMetadata = existing;
    delete metadata._consecutiveReviewRejections;
    if (options?.defaultTaskAssigneeId) metadata.defaultTaskAssigneeId = options.defaultTaskAssigneeId;
    if (options?.analysisTasks !== undefined) metadata.analysisTasks = options.analysisTasks;
    if (options?.analysisTaskDetails !== undefined) metadata.analysisTaskDetails = options.analysisTaskDetails;
    if (attestation) {
      const level = attestation.kind === 'agent-review' ? 'l2' : 'l3';
      metadata.attestations = withAttestation(metadata.attestations, level, this.buildAttestationEntry({
        verdict: 'approved',
        by: attestation.by,
        kind: attestation.kind,
        summary: attestation.summary,
        selfReview: attestation.selfReview,
        ref: attestation.ref,
      }));
    }

    const requiresMerge = ['task', 'bug', 'feature', 'refactor'].includes(current.type)
      && Boolean(metadata.worktreeBranch && metadata.worktreeBaseRepo && metadata.worktreeBaseBranch);
    if (requiresMerge && !metadata.mergeReceipt) {
      const now = new Date().toISOString();
      metadata.mergeIntent = {
        id: metadata.mergeIntent?.id ?? `merge:${id}`,
        state: 'queued',
        requestedAt: metadata.mergeIntent?.requestedAt ?? now,
        sourceBranch: metadata.worktreeBranch!,
        targetBranch: metadata.pmoBranch ?? metadata.worktreeBaseBranch!,
      };
    }

    const updated = await this.persistSnapshot(current, metadata, requiresMerge
      ? { eventType: 'updated', auditActor: attestationActor(attestation) }
      : { eventType: 'completed', status: 'done', markCompleted: true, auditActor: attestationActor(attestation) });

    const updatedData = snapshotToData(updated);
    if (updatedData.type === 'analysis') {
      trackReviewPassEffect(cleanupPrototypeWorktreeOnReviewPass(updatedData).catch(err =>
        logger.warn('[WorkUnit] prototype worktree cleanup failed (non-blocking)', { workUnitId: id, error: String(err) })
      ));
    } else if (!metadata.mergeReceipt) {
      const mergePort = {
        getById: (wuId: string) => this.query.getById(wuId),
        update: (wuId: string, input: Parameters<WorkUnitRepository['update']>[1]) => this.repository.update(wuId, input),
        blockForMergeFailure: (wuId: string, files: string[], opts?: { blockReason?: string }) => this.blockForMergeFailure(wuId, files, opts),
        recordMergeProgress: (wuId: string, intent: WorkUnitMergeIntent) => this.recordMergeProgress(wuId, intent),
        settleMerge: (wuId: string, settlement: WorkUnitMergeSettlement) => this.settleMerge(wuId, settlement),
      };
      const existingEffect = reviewPassMergeEffects.get(id);
      const effect = existingEffect ?? mergeWorktreeBranchOnReviewPass(mergePort, updatedData, this.fileStore)
        .catch(async err => {
          logger.warn('[WorkUnit] merge-on-review-pass failed; blocking WorkUnit', { workUnitId: id, error: String(err) });
          await this.blockForMergeFailure(id, [], {
            blockReason: `merge-effect-failed: ${String(err).slice(0, 240)}`,
            mergeConflict: false,
          }).catch(fallback => logger.warn('[WorkUnit] merge failure fallback blocked write failed', { workUnitId: id, error: String(fallback) }));
        })
        .then(() => undefined)
        .finally(() => {
          if (reviewPassMergeEffects.get(id) === effect) reviewPassMergeEffects.delete(id);
        });
      if (!existingEffect) reviewPassMergeEffects.set(id, effect);
      trackReviewPassEffect(effect);
    }

    if (awaitingUnavailableConfirmation) {
      return this.settleMerge(id, { receipt: metadata.mergeReceipt!, outcome: 'done' });
    }
    return snapshotToData(updated);
  }

  async recordMergeProgress(id: string, intent: WorkUnitMergeIntent): Promise<WorkUnitData> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = (await this.fileStore.getIndex({ id }))[0];
      if (!current) throw new Error('WorkUnit not found');
      if (current.status === 'done' || current.status === 'closed') return snapshotToData(current);
      const metadata = parseWuMetadata(current.metadata);
      metadata.mergeIntent = intent;
      try {
        const updated = await this.persistSnapshot(current, metadata, { eventType: 'updated', expectedUpdatedAt: current.updatedAt });
        return snapshotToData(updated);
      } catch (err) {
        const conflict = err instanceof WorkUnitSnapshotConflictError;
        if (!conflict || attempt === 2) throw err;
      }
    }
    throw new Error('Unreachable merge progress');
  }

  async settleMerge(id: string, settlement: WorkUnitMergeSettlement): Promise<WorkUnitData> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = (await this.fileStore.getIndex({ id }))[0];
      if (!current) throw new Error('WorkUnit not found');
      if (current.status === 'done' || current.status === 'closed') return snapshotToData(current);

      const metadata = parseWuMetadata(current.metadata);
      const { receipt } = settlement;
      metadata.mergeReceipt = receipt;
      if (receipt.merged) {
        metadata.mergedAt = receipt.mergedAt ?? new Date().toISOString();
        if (receipt.mergeCommit) metadata.mergeCommit = receipt.mergeCommit;
      }
      delete metadata.mergeConflict;
      delete metadata.conflictFiles;

      let outcome = settlement.outcome;
      if (outcome === 'done' && !isAcceptedMergeReceipt(metadata)) outcome = 'in_review';

      if (outcome === 'done' && receipt.verification.status === 'passed') {
        const now = new Date().toISOString();
        metadata.attestations = withAttestation(metadata.attestations, 'l1', {
          verdict: 'approved',
          by: 'merge-target',
          at: now,
          kind: 'verify',
          summary: receipt.verification.ran.join('；').slice(0, 300),
          ...(receipt.mergeCommit ? { ref: receipt.mergeCommit } : {}),
        });
        metadata.verifyReport = { commands: receipt.verification.ran, source: 'convention', passedAt: now };
      }
      if (settlement.mergeConflict) {
        metadata.mergeConflict = true;
        metadata.conflictFiles = settlement.conflictFiles ?? [];
      }
      if (outcome === 'blocked') {
        metadata.blockReason = settlement.blockReason ?? 'merge-failed: 自动合并失败';
        metadata.blockedAt = new Date().toISOString();
      }

      try {
        const updated = await this.persistSnapshot(current, metadata, {
          eventType: outcome === 'done' ? 'completed' : outcome === 'blocked' ? 'blocked' : 'updated',
          status: outcome,
          markCompleted: outcome === 'done',
          expectedUpdatedAt: current.updatedAt,
        });
        return snapshotToData(updated);
      } catch (err) {
        const conflict = err instanceof WorkUnitSnapshotConflictError;
        if (!conflict || attempt === 2) throw err;
      }
    }
    throw new Error('Unreachable merge settlement');
  }

  /**
   * F6-b：done WU 的人工确认（l3 补写）——只更新台账，不动状态/.completedAt，不触发合并。
   * 幂等：重复确认覆盖 l3 最新值。
   * 2026-07-30 起补写后发 status_changed（状态值不变也发）——pmo progress-rollup 已改为
   * 证据感知（证据不齐置 in_review），l3 常是最后一块证据，不发事件项目状态无法即时翻转。
   */
  private async writeHumanConfirmation(
    current: WorkUnitSnapshot,
    attestation: ReviewAttestationSource,
  ): Promise<WorkUnitData> {
    const metadata: WorkUnitMetadata = parseWuMetadata(current.metadata);
    metadata.attestations = withAttestation(metadata.attestations, 'l3', this.buildAttestationEntry({
      verdict: 'approved',
      by: attestation.by,
      kind: 'human-confirm',
      summary: attestation.summary,
    }));

    // 状态值不变也发 status_changed（persistSnapshot 尾部）：让 pmo rollup 即时重估交付证据
    const updated = await this.persistSnapshot(current, metadata, { eventType: 'updated' });
    return snapshotToData(updated);
  }

  /**
   * F6-c（断点 3）：done WU 的迟到 agent 评审（l2 补写）——与 writeHumanConfirmation 同模式：
   * 只更新台账，不动状态/completedAt，不触发合并。幂等：l2 缺失（含 stale rejected）时补写/覆盖。
   * 与 l3 路径的差异：补写完发 status_changed（状态值不变也发）——
   * pmo/progress-rollup 按证据齐备度重估项目状态，缺事件则永远按缺 l2 的旧口径。
   */
  private async writeAgentReviewAttestation(
    current: WorkUnitSnapshot,
    attestation: ReviewAttestationSource,
  ): Promise<WorkUnitData> {
    const metadata: WorkUnitMetadata = parseWuMetadata(current.metadata);
    metadata.attestations = withAttestation(metadata.attestations, 'l2', this.buildAttestationEntry({
      verdict: 'approved',
      by: attestation.by,
      kind: 'agent-review',
      summary: attestation.summary,
      selfReview: attestation.selfReview,
      ref: attestation.ref,
    }));

    const updated = await this.persistSnapshot(current, metadata, { eventType: 'updated' });
    return snapshotToData(updated);
  }

  /**
   * F6-c（断点 2）：人工触发 L1 验证（POST /:id/verify）的结果落台账——
   * 只补写 l1（approved/rejected 留痕），全绿时同写 verifyReport（与 agent-loop 守卫同结构；
   * 失败不写——verifyReport 语义是全绿摘要，metrics 按存在计通过），
   * 不动状态机/verifyFailCount。写完发 status_changed（状态值不变也发）让 pmo rollup 重估。
   */
  async recordL1Verification(id: string, input: {
    by: string;
    ran: string[];
    source: 'override' | 'convention';
    failure?: { command: string; tail: string };
  }): Promise<WorkUnitData> {
    const current = (await this.fileStore.getIndex({ id }))[0];
    if (!current) throw new Error('WorkUnit not found');

    const now = new Date().toISOString();
    const metadata: WorkUnitMetadata = parseWuMetadata(current.metadata);
    metadata.attestations = withAttestation(metadata.attestations, 'l1', input.failure
      ? {
          verdict: 'rejected',
          by: input.by,
          at: now,
          kind: 'verify',
          summary: `失败命令: ${input.failure.command}`.slice(0, 300),
        }
      : {
          verdict: 'approved',
          by: input.by,
          at: now,
          kind: 'verify',
          summary: input.ran.join('；').slice(0, 300),
        });
    if (!input.failure) {
      metadata.verifyReport = { commands: input.ran, source: input.source, passedAt: now };
    }

    const updated = await this.persistSnapshot(current, metadata, { eventType: 'updated' });
    return snapshotToData(updated);
  }

  /**
   * #551：POST /:id/verify 的业务下沉（F6-c 断点 2，人工重跑 L1，脱 HTTP 可直测）。
   * 守卫链：存在性 → 代码类 type → worktree 落档 → 有可跑命令，失败以判别联合 kind
   * 返回（不抛错、不携带 HTTP 语义，状态码由路由层映射）；命令实际执行后无论成败
   * 都经 recordL1Verification 落台账 l1（失败= rejected，全绿= approved + verifyReport）。
   * 只运行服务端固定模板；worktree provenance 在校验命令前 fail-closed。
   * ARCH-02：独立验证实现经 verification 端口注入，不反向加载 AgentLoop。
   */
  async verifyManually(id: string, opts: { by: string }): Promise<ManualVerifyResult> {
    const wu = await this.getById(id);
    if (!wu) return { kind: 'not-found' };

    const verification = await workUnitPort('verification');
    if (!verification.isCodeWorktreeType(wu.type)) return { kind: 'not-code-type', wuType: wu.type };

    const metadata: WorkUnitMetadata = parseWuMetadata(wu.metadata);
    const worktreePath = typeof metadata.worktreePath === 'string' && metadata.worktreePath.length > 0
      ? metadata.worktreePath
      : null;
    if (!worktreePath) return { kind: 'no-worktree' };

    let outcome;
    try {
      outcome = await verification.run(wu, metadata, worktreePath);
    } catch (error) {
      if (error instanceof HostExecutionPolicyError) return { kind: 'invalid-worktree' };
      throw error;
    }
    if (outcome.ran.length === 0 && !outcome.failure) return { kind: 'no-commands' };

    const updated = await this.recordL1Verification(wu.id, {
      by: opts.by,
      ran: outcome.ran,
      source: outcome.source,
      failure: outcome.failure,
    });

    if (outcome.failure) return { kind: 'failed', failure: outcome.failure };
    const report = parseWuMetadata(updated.metadata).verifyReport
      ?? { commands: outcome.ran, source: outcome.source };
    return { kind: 'verified', report };
  }

  async blockForMergeFailure(id: string, conflictFiles: string[], opts?: { blockReason?: string; mergeConflict?: boolean }): Promise<WorkUnitData> {
    const current = (await this.fileStore.getIndex({ id }))[0];
    if (!current) throw new Error('WorkUnit not found');
    if (current.status === 'done' || current.status === 'closed') return snapshotToData(current);

    const metadata: WorkUnitMetadata = parseWuMetadata(current.metadata);
    if (opts?.mergeConflict === false) {
      delete metadata.mergeConflict;
      delete metadata.conflictFiles;
    } else {
      metadata.mergeConflict = true;
      metadata.conflictFiles = conflictFiles;
    }
    if (metadata.mergeReceipt) {
      metadata.mergeReceipt = {
        ...metadata.mergeReceipt,
        failure: { kind: 'merge-error', detail: opts?.blockReason, conflictFiles },
      };
    } else if (metadata.mergeIntent) {
      metadata.mergeReceipt = {
        id: metadata.mergeIntent.id,
        merged: false,
        targetBranch: metadata.mergeIntent.targetBranch,
        verification: { status: 'not-run', ran: [] },
        failure: { kind: 'conflict', conflictFiles },
      };
    }
    // B4: blocked 原因落盘（2026-08-03 token-burn issue P0-2）；
    // opts.blockReason 覆盖默认文案（如合并后 verify 失败走同路径但前缀区分 merge-verify-failed）
    metadata.blockReason = opts?.blockReason ?? `merge-conflict: 自动合并冲突（${conflictFiles.length} 个文件）`;

    metadata.blockedAt = new Date().toISOString(); // #176（决策 #57 D4）：死信计时基准
    const updated = await this.persistSnapshot(current, metadata, { eventType: 'blocked', status: 'blocked' });
    return snapshotToData(updated);
  }

  /**
   * 2026-07 PMO-flow UX（§4 terminate 语义修正）：强制释放转人工——
   * AgentInstanceService.terminate 在 unclaim 之后调用，WU 直接置 blocked
   * （unassigned → blocked 不在 VALID_TRANSITIONS，活 loop 不认领 blocked WU，
   * 避免 terminate 后 ≤15s 被同一 loop 重新认领回弹；事件溯源形态同 blockForMergeFailure）。
   * assigneeId/claimedAt 清空 + metadata.manualRelease 留痕（语义同 mergeConflict 审计字段）。
   * 终态（done/closed）WU 不动——工作已收口，无可释放（terminate 与完成的竞态防护）。
   */
  async blockForManualRelease(id: string, reason: string): Promise<WorkUnitData> {
    const current = (await this.fileStore.getIndex({ id }))[0];
    if (!current) throw new Error('WorkUnit not found');

    if (current.status === 'done' || current.status === 'closed') {
      return snapshotToData(current);
    }

    const metadata: WorkUnitMetadata = parseWuMetadata(current.metadata);
    metadata.manualRelease = true;
    metadata.manualReleaseReason = reason;
    // B4: blocked 原因落盘（2026-08-03 token-burn issue P0-2）
    metadata.blockReason = `manual-release: ${reason}`;
    metadata.blockedAt = new Date().toISOString(); // #176（决策 #57 D4）：死信计时基准

    const updated = await this.persistSnapshot(current, metadata, {
      eventType: 'blocked',
      status: 'blocked',
      patch: { assigneeId: null, claimedAt: null },
    });
    return snapshotToData(updated);
  }

  /**
   * 决策 14 认领前适任判断：全员不适任转人工——频道全部 active 成员都被判不适任，
   * unassigned WU 直接置 blocked（unassigned → blocked 不在 VALID_TRANSITIONS，
   * 语义方法直写，形态同 blockForManualRelease/blockForMergeFailure 先例）。
   * 仅 unassigned 可转（active/blocked 各有既有出口）；metadata 只补 blockReason/blockedAt，
   * unfitRoles 已由调用方（agent-loop recordClaimUnfit）先行落档。
   */
  async blockForAllUnfit(id: string, reason: string): Promise<WorkUnitData | null> {
    const current = (await this.fileStore.getIndex({ id }))[0];
    if (!current) throw new Error('WorkUnit not found');
    if (current.status !== 'unassigned') return null;

    const metadata: WorkUnitMetadata = parseWuMetadata(current.metadata);
    // B4: blocked 原因落盘（2026-08-03 token-burn issue P0-2）
    metadata.blockReason = reason;
    metadata.blockedAt = new Date().toISOString(); // #176（决策 #57 D4）：死信计时基准

    const updated = await this.persistSnapshot(current, metadata, { eventType: 'blocked', status: 'blocked' });
    return snapshotToData(updated);
  }

  /**
   * Review rejected: in_review → active (or → blocked after 3 consecutive rejections).
   * Emits workunit.review.rejected.
   * F6（决策 1）：attestation 入参带来源时写台账（verdict=rejected 留痕；返工后重审 approved 覆盖）。
   */
  async reviewRejected(id: string, reason?: string, attestation?: ReviewAttestationSource): Promise<WorkUnitData> {
    const current = (await this.fileStore.getIndex({ id }))[0];
    if (!current) throw new Error('WorkUnit not found');
    if (current.status !== 'in_review') {
      throw new Error(`Cannot review: current status is ${current.status}, expected in_review`);
    }

    const metadata: WorkUnitMetadata = parseWuMetadata(current.metadata);
    if (metadata.mergeIntent?.state === 'queued' || metadata.mergeIntent?.state === 'running') {
      throw new Error('Cannot reject while merge is queued or running');
    }
    const rejections = (metadata._consecutiveReviewRejections ?? 0) + 1;
    metadata._consecutiveReviewRejections = rejections;
    if (reason) metadata._lastRejectionReason = reason;
    if (attestation) {
      const level = attestation.kind === 'agent-review' ? 'l2' : 'l3';
      metadata.attestations = withAttestation(metadata.attestations, level, this.buildAttestationEntry({
        verdict: 'rejected',
        by: attestation.by,
        kind: attestation.kind,
        summary: attestation.summary ?? reason,
        selfReview: attestation.selfReview,
        ref: attestation.ref,
      }));
    }

    // 3 consecutive rejections → auto-block
    const newStatus = rejections >= 3 ? 'blocked' : 'active';
    if (newStatus === 'blocked') {
      // B4: blocked 原因落盘（2026-08-03 token-burn issue P0-2）
      metadata.blockReason = `review-rejected x${rejections}: ${reason ?? metadata._lastRejectionReason ?? '连续评审拒绝'}`.slice(0, 300);
      metadata.blockedAt = new Date().toISOString(); // #176（决策 #57 D4）：死信计时基准
    }

    // in_review → active/blocked 也是状态变化：status_changed 由 persistSnapshot 尾部补发（列表实时刷新）。
    // 本方法历史口径不做父聚合（aggregateParent: false 保留原行为，勿顺手改）
    const eventType: WorkUnitEvent['type'] = newStatus === 'blocked' ? 'blocked' : 'updated';
    const updated = await this.persistSnapshot(current, metadata, { eventType, status: newStatus, aggregateParent: false, auditActor: attestationActor(attestation) });

    if (newStatus === 'blocked') {
      logger.warn('[WorkUnit] Auto-blocked after 3 consecutive review rejections', { workUnitId: id });
    }

    return snapshotToData(updated);
  }

  /**
   * F6 台账条目构建（评审/验证写入共用的 spread 规则收敛）：
   * summary 有值才带；selfReview 仅 === true 才带；ref 有值才带。
   * at 在条目构建时取当前时间（与原各写入点实现一致，独立于快照 updatedAt）。
   * recordL1Verification 不用本 helper——其 summary 恒写（含空串截断规则），属该方法的策略。
   */
  private buildAttestationEntry(input: {
    verdict: 'approved' | 'rejected';
    by: string;
    kind: string;
    summary?: string;
    selfReview?: boolean;
    ref?: string;
  }): AttestationEntry {
    return {
      verdict: input.verdict,
      by: input.by,
      at: new Date().toISOString(),
      kind: input.kind,
      ...(input.summary ? { summary: input.summary } : {}),
      ...(input.selfReview === true ? { selfReview: true } : {}),
      ...(input.ref ? { ref: input.ref } : {}),
    };
  }
}

/** ARCH-05 兼容门面：只组合并委托用例 owner，不承载状态机或评审实现。 */
export class WorkUnitService implements WorkUnitRepository, WorkUnitQuery, WorkUnitLifecycle, WorkUnitReview {
  private readonly repository: WorkUnitRepository & WorkUnitLifecycleRepository;
  private readonly query: WorkUnitQuery;
  private readonly lifecycle: WorkUnitLifecycle & WorkUnitLifecyclePersistence;
  private readonly review: WorkUnitReview;
  private readonly mandates: MandateService;

  constructor(fileStore?: FileStore, messageService?: ConstructorParameters<typeof WorkUnitCrudService>[1]) {
    const store = fileStore ?? getStore();
    this.repository = new WorkUnitCrudService(store, messageService);
    this.query = new WorkUnitQueryService(store);
    this.lifecycle = new WorkUnitLifecycleService(store, this.repository);
    this.review = new WorkUnitReviewService(this.lifecycle, this.query, this.repository, store);
    this.mandates = new MandateService(store);
  }

  create(...args: Parameters<WorkUnitRepository['create']>) { return this.repository.create(...args); }
  createGuarded(...args: Parameters<WorkUnitRepository['createGuarded']>) { return this.repository.createGuarded(...args); }
  createFromMessage(...args: Parameters<WorkUnitRepository['createFromMessage']>) { return this.repository.createFromMessage(...args); }
  update(...args: Parameters<WorkUnitRepository['update']>) { return this.repository.update(...args); }
  updateMetadata(...args: Parameters<WorkUnitRepository['updateMetadata']>) { return this.repository.updateMetadata(...args); }
  delete(...args: Parameters<WorkUnitRepository['delete']>) { return this.repository.delete(...args); }
  claim(...args: Parameters<WorkUnitRepository['claim']>) { return this.repository.claim(...args); }
  unclaim(...args: Parameters<WorkUnitRepository['unclaim']>) { return this.repository.unclaim(...args); }
  aggregateParentStatus(...args: Parameters<WorkUnitRepository['aggregateParentStatus']>) { return this.repository.aggregateParentStatus(...args); }

  getById(...args: Parameters<WorkUnitQuery['getById']>) { return this.query.getById(...args); }
  list(...args: Parameters<WorkUnitQuery['list']>) { return this.query.list(...args); }
  lastDoneByAssignee(...args: Parameters<WorkUnitQuery['lastDoneByAssignee']>) { return this.query.lastDoneByAssignee(...args); }

  transitionStatus(...args: Parameters<WorkUnitLifecycle['transitionStatus']>) { return this.lifecycle.transitionStatus(...args); }
  close(...args: Parameters<WorkUnitLifecycle['close']>) { return this.lifecycle.close(...args); }
  rebindSourceChannel(...args: Parameters<WorkUnitLifecycle['rebindSourceChannel']>) { return this.lifecycle.rebindSourceChannel(...args); }

  reviewPassed(...args: Parameters<WorkUnitReview['reviewPassed']>) { return this.review.reviewPassed(...args); }
  reviewRejected(...args: Parameters<WorkUnitReview['reviewRejected']>) { return this.review.reviewRejected(...args); }
  recordMergeProgress(...args: Parameters<WorkUnitReview['recordMergeProgress']>) { return this.review.recordMergeProgress(...args); }
  settleMerge(...args: Parameters<WorkUnitReview['settleMerge']>) { return this.review.settleMerge(...args); }
  recordL1Verification(...args: Parameters<WorkUnitReview['recordL1Verification']>) { return this.review.recordL1Verification(...args); }
  verifyManually(...args: Parameters<WorkUnitReview['verifyManually']>) { return this.review.verifyManually(...args); }
  blockForMergeFailure(...args: Parameters<WorkUnitReview['blockForMergeFailure']>) { return this.review.blockForMergeFailure(...args); }
  blockForManualRelease(...args: Parameters<WorkUnitReview['blockForManualRelease']>) { return this.review.blockForManualRelease(...args); }
  blockForAllUnfit(...args: Parameters<WorkUnitReview['blockForAllUnfit']>) { return this.review.blockForAllUnfit(...args); }

  async authorizeMandate(id: string, actor: MandatePrincipal, patch: MandateExpansion): Promise<WorkUnitData> {
    return snapshotToData(await this.mandates.authorize(id, actor, patch));
  }
  async revokeMandate(id: string, actor: MandatePrincipal, reason?: string): Promise<WorkUnitData> {
    return snapshotToData(await this.mandates.revoke(id, actor, reason));
  }
}
