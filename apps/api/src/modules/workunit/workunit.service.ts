/**
 * WorkUnit Service — 状态机流转 + 查询 + 评审验收收口（继承 WorkUnitCrudService 的 CRUD + Claim）
 *
 * AS-025 §3.28c-1 Task 2-4
 * 存储迁移: 已从 Prisma 迁移到 FileStore (Event Sourcing)
 *
 * 拆分说明（纯代码移动，行为不变）：create/update/delete、claim/unclaim、
 * workunit.created/status_changed 事件发布与父状态聚合已迁至 workunit-crud.ts
 * （WorkUnitCrudService 基类）；头部类型/常量/转换层已抽至 workunit.types.ts /
 * workunit.mappers.ts（工单 30）。本文件保留查询（getById/list）、状态机迁移
 * （transitionStatus）与评审验收（reviewPassed/reviewRejected/attestation 补写/
 * recordL1Verification/markMergeConflict/blockForManualRelease/rebindSourceChannel），
 * 并 re-export 全部迁出符号，导入面不变。
 */

import { logger, withAttestation, deriveDisplayState, type AttestationEntry, type WorkUnitSnapshot, type WorkUnitEvent } from '@dommaker/studio-shared';
import { mergeWorktreeBranchOnReviewPass } from './merge-on-review-pass.js';
import { parseWuMetadata } from './wu-metadata.js';
import { resolveValidTransitions, type WorkUnitMetadata, type ReviewAttestationSource } from './workunit.types.js';
import { snapshotToData } from './workunit.mappers.js';
import { WorkUnitCrudService, type WorkUnitData } from './workunit-crud.js';

// re-export：保持既有消费方（agent-loop / routes / 测试等）从 workunit.service 导入的路径不变
export { snapshotToData } from './workunit.mappers.js';
export { ANALYSIS_TASKS_MAX } from './workunit.types.js';
export type { WorkUnitMetadata, ReviewAttestationSource } from './workunit.types.js';

export class WorkUnitService extends WorkUnitCrudService {

  /**
   * Get a WorkUnit by id. Returns null if not found.
   */
  async getById(id: string): Promise<WorkUnitData | null> {
    const snapshots = await this.fileStore.getIndex();
    const found = snapshots.find(s => s.id === id);
    return found ? snapshotToData(found) : null;
  }

  /**
   * List WorkUnits with optional filters and pagination.
   */
  async list(options?: {
    type?: string;
    status?: string;
    assigneeId?: string;
    channelId?: string;
    parentId?: string;
    failureType?: string;
    timedOutBefore?: Date;
    page?: number;
    limit?: number;
  }): Promise<{ data: WorkUnitData[]; total: number }> {
    const { type, status, assigneeId, channelId, parentId, failureType, timedOutBefore, page = 1, limit = 20 } = options ?? {};

    let snapshots = await this.fileStore.getIndex();

    // In-memory filter
    if (type) snapshots = snapshots.filter(s => s.type === type);
    if (status) snapshots = snapshots.filter(s => s.status === status);
    if (assigneeId) snapshots = snapshots.filter(s => s.assigneeId === assigneeId);
    if (channelId) snapshots = snapshots.filter(s => s.channelId === channelId);
    if (parentId) snapshots = snapshots.filter(s => s.parentId === parentId);
    if (failureType) snapshots = snapshots.filter(s => s.failureType === failureType);
    if (timedOutBefore) {
      const cutoff = timedOutBefore.getTime();
      snapshots = snapshots.filter(s => s.timeoutAt && new Date(s.timeoutAt).getTime() <= cutoff);
    }

    // Sort by createdAt desc
    snapshots.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const total = snapshots.length;

    // Paginate
    const start = (page - 1) * limit;
    const paged = snapshots.slice(start, start + limit);

    return { data: paged.map(snapshotToData), total };
  }

  /**
   * Transition WorkUnit status with state machine validation.
   * @throws Error if transition is not allowed
   */
  async transitionStatus(id: string, newStatus: string): Promise<WorkUnitData> {
    const snapshots = await this.fileStore.getIndex();
    const current = snapshots.find(s => s.id === id);
    if (!current) {
      throw new Error('WorkUnit not found');
    }

    // #108：decision/spec 走裁剪状态机（TYPE_VALID_TRANSITIONS 覆盖），其余 type 用全局表
    const allowed = resolveValidTransitions(current.type, current.status);
    if (!allowed || !allowed.includes(newStatus)) {
      throw new Error(
        `Invalid status transition: ${current.status} → ${newStatus}`
      );
    }

    const now = new Date();
    const isoNow = now.toISOString();

    const eventType: WorkUnitEvent['type'] =
      newStatus === 'done' || newStatus === 'closed' ? 'completed' :
      newStatus === 'blocked' ? 'blocked' : 'updated';

    const updated: WorkUnitSnapshot = {
      ...current,
      status: newStatus,
      completedAt: (newStatus === 'done' || newStatus === 'closed') ? isoNow : current.completedAt,
      // #176（决策 #57 D4）：转入 blocked 统一落死信计时基准 metadata.blockedAt
      // （24h 自动关闭与 30min 提醒均以此为锚；复活后再次 blocked 刷新）
      metadata: newStatus === 'blocked'
        ? JSON.stringify({ ...parseWuMetadata(current.metadata), blockedAt: isoNow })
        : current.metadata,
      updatedAt: isoNow,
    };

    const event: WorkUnitEvent = {
      type: eventType,
      wuId: id,
      timestamp: isoNow,
      data: updated as unknown as Record<string, unknown>,
    };
    await this.fileStore.commitSnapshot(event, updated);

    // Publish status-change event（REQ roll-up 等订阅消费，best-effort）
    this.publishStatusChanged(updated);

    // #126（T4）：人工确认（pending → unassigned）解除人闸——feature 单此时补展开
    // 频道默认管线第一跳（创建时落 pending 跳过展开；expandDefaultPipelineHead 幂等）。
    if (current.status === 'pending' && newStatus === 'unassigned'
      && updated.type === 'feature' && updated.channelId) {
      await this.expandDefaultPipelineHead(snapshotToData(updated)).catch(err =>
        logger.warn('[WorkUnit] defaultPipeline expansion on confirm failed (non-blocking)', {
          parentId: updated.id,
          error: String(err),
        }),
      );
    }

    // Cascade: parent status aggregation on any status change that affects parent
    if (['active', 'blocked', 'done', 'closed'].includes(newStatus)) {
      this.aggregateParentStatus(id).catch(err =>
        logger.warn('[WorkUnit] aggregateParentStatus failed', { workUnitId: id, error: String(err) })
      );
    }

    return snapshotToData(updated);
  }

  /**
   * Review passed: in_review → done. Emits workunit.review.passed.
   * Resets consecutive rejection counter.
   * B3b-ii：收口处触发 worktree 分支自动合并（best-effort，不阻断 done 迁移）。
   * F6（决策 1）：attestation 入参带来源时写台账——agent-review → l2，human-confirm → l3。
   * F6-b：human-confirm 且当前已是 done → 幂等补写 l3（agent 评审通过的 WU 等人工确认，
   * 人类待办 = done ∧ ¬l3 必须有确认出口），不改状态、不重复触发合并。
   * F6-c（断点 3）：agent-review 且当前已是 done 且 l2 缺失 → 幂等补写 l2
   * （人工直推 done 抢跑评审链，迟到的评审结论无处落账的补票口），同不改状态、不触发合并。
   */
  async reviewPassed(id: string, attestation?: ReviewAttestationSource, options?: { defaultTaskAssigneeId?: string }): Promise<WorkUnitData> {
    const snapshots = await this.fileStore.getIndex();
    const current = snapshots.find(s => s.id === id);
    if (!current) throw new Error('WorkUnit not found');
    if (current.status !== 'in_review') {
      // F6-b 豁免：done + human-confirm → 只补台账 l3
      if (current.status === 'done' && attestation?.kind === 'human-confirm') {
        return this.writeHumanConfirmation(current, attestation);
      }
      // F6-c 豁免：done + agent-review + l2 缺失（approved 口径，同 deriveDisplayState）→ 只补台账 l2；
      // l2 已达成时重复回传仍是非法迁移（不放宽状态机）
      if (current.status === 'done' && attestation?.kind === 'agent-review'
        && !deriveDisplayState({ status: current.status, metadata: current.metadata }).evidence.l2) {
        return this.writeAgentReviewAttestation(current, attestation);
      }
      throw new Error(`Cannot review: current status is ${current.status}, expected in_review`);
    }

    const metadata: WorkUnitMetadata = parseWuMetadata(current.metadata);
    delete metadata._consecutiveReviewRejections;
    // #177：analysis 确认处可选「默认执行角色」落档（analysis-handoff 派生 task 子 WU 时消费）
    if (options?.defaultTaskAssigneeId) {
      metadata.defaultTaskAssigneeId = options.defaultTaskAssigneeId;
    }
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

    const updated = await this.persistSnapshot(current, metadata, {
      eventType: 'completed',
      status: 'done',
      markCompleted: true,
    });

    // Cascade: parent aggregation (best-effort)
    this.aggregateParentStatus(id).catch(err =>
      logger.warn('[WorkUnit] aggregateParentStatus failed', { workUnitId: id, error: String(err) })
    );

    // B3b-ii（决策 D1/D3 后半）：评审通过 → task 分支自动合并回 base 分支。
    // best-effort：无 worktree 落档的 WU 在 merge 模块内旁路；冲突由模块自行置 blocked 转人工；
    // 任何失败只记日志，不阻断本方法的 done 迁移。
    mergeWorktreeBranchOnReviewPass(this, snapshotToData(updated), this.fileStore).catch(err =>
      logger.warn('[WorkUnit] merge-on-review-pass failed (non-blocking)', { workUnitId: id, error: String(err) })
    );

    return snapshotToData(updated);
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
    const snapshots = await this.fileStore.getIndex();
    const current = snapshots.find(s => s.id === id);
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
  async markMergeConflict(id: string, conflictFiles: string[]): Promise<WorkUnitData> {
    const snapshots = await this.fileStore.getIndex();
    const current = snapshots.find(s => s.id === id);
    if (!current) throw new Error('WorkUnit not found');

    const metadata: WorkUnitMetadata = parseWuMetadata(current.metadata);
    metadata.mergeConflict = true;
    metadata.conflictFiles = conflictFiles;
    // B4: blocked 原因落盘（2026-08-03 token-burn issue P0-2）
    metadata.blockReason = `merge-conflict: 自动合并冲突（${conflictFiles.length} 个文件）`;

    const now = new Date();
    const isoNow = now.toISOString();
    metadata.blockedAt = isoNow; // #176（决策 #57 D4）：死信计时基准
    const updated: WorkUnitSnapshot = {
      ...current,
      status: 'blocked',
      metadata: JSON.stringify(metadata),
      updatedAt: isoNow,
    };

    const event: WorkUnitEvent = {
      type: 'blocked',
      wuId: id,
      timestamp: isoNow,
      data: updated as unknown as Record<string, unknown>,
    };
    await this.fileStore.commitSnapshot(event, updated);

    this.publishStatusChanged(updated);

    this.aggregateParentStatus(id).catch(err =>
      logger.warn('[WorkUnit] aggregateParentStatus failed', { workUnitId: id, error: String(err) })
    );

    return snapshotToData(updated);
  }

  /**
   * 2026-07 PMO-flow UX（§4 terminate 语义修正）：强制释放转人工——
   * AgentInstanceService.terminate 在 unclaim 之后调用，WU 直接置 blocked
   * （unassigned → blocked 不在 VALID_TRANSITIONS，活 loop 不认领 blocked WU，
   * 避免 terminate 后 ≤15s 被同一 loop 重新认领回弹；事件溯源形态同 markMergeConflict）。
   * assigneeId/claimedAt 清空 + metadata.manualRelease 留痕（语义同 mergeConflict 审计字段）。
   * 终态（done/closed）WU 不动——工作已收口，无可释放（terminate 与完成的竞态防护）。
   */
  async blockForManualRelease(id: string, reason: string): Promise<WorkUnitData> {
    const snapshots = await this.fileStore.getIndex();
    const current = snapshots.find(s => s.id === id);
    if (!current) throw new Error('WorkUnit not found');

    if (current.status === 'done' || current.status === 'closed') {
      return snapshotToData(current);
    }

    const metadata: WorkUnitMetadata = parseWuMetadata(current.metadata);
    metadata.manualRelease = true;
    metadata.manualReleaseReason = reason;
    // B4: blocked 原因落盘（2026-08-03 token-burn issue P0-2）
    metadata.blockReason = `manual-release: ${reason}`;

    const now = new Date();
    const isoNow = now.toISOString();
    metadata.blockedAt = isoNow; // #176（决策 #57 D4）：死信计时基准
    const updated: WorkUnitSnapshot = {
      ...current,
      status: 'blocked',
      assigneeId: null,
      claimedAt: null,
      metadata: JSON.stringify(metadata),
      updatedAt: isoNow,
    };

    const event: WorkUnitEvent = {
      type: 'blocked',
      wuId: id,
      timestamp: isoNow,
      data: updated as unknown as Record<string, unknown>,
    };
    await this.fileStore.commitSnapshot(event, updated);

    this.publishStatusChanged(updated);

    this.aggregateParentStatus(id).catch(err =>
      logger.warn('[WorkUnit] aggregateParentStatus failed', { workUnitId: id, error: String(err) })
    );

    return snapshotToData(updated);
  }

  /**
   * Review rejected: in_review → active (or → blocked after 3 consecutive rejections).
   * Emits workunit.review.rejected.
   * F6（决策 1）：attestation 入参带来源时写台账（verdict=rejected 留痕；返工后重审 approved 覆盖）。
   */
  async reviewRejected(id: string, reason?: string, attestation?: ReviewAttestationSource): Promise<WorkUnitData> {
    const snapshots = await this.fileStore.getIndex();
    const current = snapshots.find(s => s.id === id);
    if (!current) throw new Error('WorkUnit not found');
    if (current.status !== 'in_review') {
      throw new Error(`Cannot review: current status is ${current.status}, expected in_review`);
    }

    const metadata: WorkUnitMetadata = parseWuMetadata(current.metadata);
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

    // in_review → active/blocked 也是状态变化：status_changed 由 persistSnapshot 尾部补发（列表实时刷新）
    const eventType: WorkUnitEvent['type'] = newStatus === 'blocked' ? 'blocked' : 'updated';
    const updated = await this.persistSnapshot(current, metadata, { eventType, status: newStatus });

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

  /**
   * 评审/验证写入的共用落库尾部：构建 updated 快照（updatedAt=now，可选 status 覆盖 /
   * markCompleted 置 completedAt=同一此刻）→ commitSnapshot（#170：appendEvent +
   * upsertSnapshot 同锁成对）+ publishStatusChanged。
   * 各调用方只保留自身策略：守卫、metadata 变更、事件类型、后续级联（父状态聚合/合并触发）。
   */
  private async persistSnapshot(
    current: WorkUnitSnapshot,
    metadata: WorkUnitMetadata,
    opts: { eventType: WorkUnitEvent['type']; status?: string; markCompleted?: boolean },
  ): Promise<WorkUnitSnapshot> {
    const isoNow = new Date().toISOString();
    const updated: WorkUnitSnapshot = {
      ...current,
      ...(opts.status !== undefined ? { status: opts.status } : {}),
      metadata: JSON.stringify(metadata),
      ...(opts.markCompleted ? { completedAt: isoNow } : {}),
      updatedAt: isoNow,
    };
    const event: WorkUnitEvent = {
      type: opts.eventType,
      wuId: current.id,
      timestamp: isoNow,
      data: updated as unknown as Record<string, unknown>,
    };
    await this.fileStore.commitSnapshot(event, updated);
    this.publishStatusChanged(updated);
    return updated;
  }

  /**
   * 频道删除兜底（B2-012）：把 context.sourceChannelId === fromChannelId 的顶层 task WU
   * 重挂到 toChannelId，返回重绑数量。
   * 字段相等匹配（解析 metadata 后比对 context.sourceChannelId）——不做 raw JSON 子串匹配
   * （`metadata.includes(channelId)` 会误中其它字段恰好含同 id 的 WU）。
   * 空/损坏 metadata 跳过。metadata-only 更新沿用 update() 惯例：appendEvent('updated') +
   * upsertSnapshot，不发 status_changed（状态与证据均未变，无需 rollup 重估）。
   */
  async rebindSourceChannel(fromChannelId: string, toChannelId: string): Promise<number> {
    const snapshots = await this.fileStore.getIndex();
    let rebound = 0;
    for (const s of snapshots) {
      if (s.type !== 'task' || s.parentId !== null || !s.metadata) continue;
      // 损坏 metadata → {} → context 缺失自然不匹配（按无匹配处理）
      const meta = parseWuMetadata(s.metadata);
      // context 在 metadata 接口里声明为 legacy string 降级字段，但频道来源链路实际落的是对象
      // （{ sourceChannelId }，见原 channel delete 路由口径）——按运行时形态松散取值
      const raw = meta as Record<string, unknown>;
      const ctx = (raw.context ?? {}) as Record<string, unknown>;
      if (ctx.sourceChannelId !== fromChannelId) continue;
      ctx.sourceChannelId = toChannelId;
      raw.context = ctx;

      const now = new Date().toISOString();
      const updated: WorkUnitSnapshot = { ...s, metadata: JSON.stringify(meta), updatedAt: now };
      const event: WorkUnitEvent = {
        type: 'updated',
        wuId: s.id,
        timestamp: now,
        data: updated as unknown as Record<string, unknown>,
      };
      await this.fileStore.commitSnapshot(event, updated);
      rebound++;
    }
    if (rebound > 0) {
      logger.info('[WorkUnit] Rebound sourceChannelId', { fromChannelId, toChannelId, count: rebound });
    }
    return rebound;
  }
}

// 拆分后兼容 re-export（原导入方零改动）：以下符号已迁至 workunit-crud.ts
export { WU_TIMEOUT_MINUTES, WU_DEFAULT_TIMEOUT_MINUTES } from './workunit-crud.js';
export type { CreateWorkUnitInput, UpdateWorkUnitInput, WorkUnitData } from './workunit-crud.js';

export type { WorkUnitSnapshot, WorkUnitFilter } from '@dommaker/studio-shared';
