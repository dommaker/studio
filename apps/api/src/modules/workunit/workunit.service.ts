/**
 * WorkUnit Service — 工作单元 CRUD + Claim + 状态机
 *
 * AS-025 §3.28c-1 Task 2-4
 */

import { Prisma, type WorkUnit } from '@prisma/client';
import type { ExtendedPrismaClient } from '@dommaker/studio-prisma';
import { logger, eventBus } from '@dommaker/studio-shared';
import { loadManifest } from '../skills/manifest-loader.js';
import { selectSkills } from '../skills/skill-selector.js';
import { skillLoaderService } from '../skills/skill-loader.js';

/** Metadata JSON schema — fields that don't warrant first-class columns */
export interface WorkUnitMetadata {
  files?: string[];              // 文件路径列表（文件冲突检查用）
  priority?: 'low' | 'normal' | 'high' | 'critical';
  createdBy?: string;
  description?: string;       // 从 WorkUnit.description 降级
  constraints?: string;       // 从 WorkUnit.constraints 降级
  context?: string;           // 从 WorkUnit.context 降级
  planVersion?: number;       // 从 WorkUnit.planVersion 降级
  planReasoning?: string;     // 从 WorkUnit.planReasoning 降级
  error?: string;             // 从 WorkUnit.error 降级
  input?: string;             // 从 WorkUnit.input 降级
  output?: string;            // 从 WorkUnit.output 降级
  goalId?: string;            // 从 WorkUnit.goalId 降级（Phase 3 迁移）
  title?: string;             // 从 WorkUnit.title 降级（Phase 3 迁移）
  _consecutiveReviewRejections?: number;  // 连续 review reject 计数（3x → auto-block）
  sourceMessageId?: string;   // createFromMessage 涌现路径来源
  creationMode?: string;      // 创建模式：from-message / manual
  _cumulativeTokens?: number; // 内部 token 累计追踪
  // Agent Loop session 追踪（AS-025 Agent Loop 重写）
  sessionId?: string;         // 当前关联的 Claude session
  stepCount?: number;         // 已执行步骤数
  startedAt?: string;         // 首次执行时间
  consecutiveStuck?: number;  // 连续无进展步数
  sessionResumes?: number;    // session 恢复次数
  [key: string]: unknown;     // 允许扩展字段
}

export interface CreateWorkUnitInput {
  type?: string;
  scope: string;
  assigneeId?: string;
  status?: string;
  channelId?: string | null;
  parentId?: string | null;
  projectPath?: string | null;
  failureType?: string;
  retryCount?: number;
  timeoutAt?: Date | null;
  completedAt?: Date | null;
  metadata?: WorkUnitMetadata;
}

export interface UpdateWorkUnitInput {
  type?: string;
  scope?: string;
  assigneeId?: string | null;
  channelId?: string | null;
  parentId?: string | null;
  projectPath?: string | null;
  failureType?: string | null;
  retryCount?: number;
  timeoutAt?: Date | null;
  completedAt?: Date | null;
  metadata?: WorkUnitMetadata;
}

/** Valid status transitions map */
const VALID_TRANSITIONS: Record<string, string[]> = {
  unassigned: ['active', 'closed'],
  active: ['in_review', 'closed', 'blocked'],
  in_review: ['done', 'active', 'closed'],
  done: ['closed'],
  blocked: ['active', 'closed', 'unassigned'],
  closed: ['unassigned'],
};

export class WorkUnitService {
  constructor(private prisma: ExtendedPrismaClient) {}

  /**
   * Create a new WorkUnit.
   */
  async create(input: CreateWorkUnitInput): Promise<WorkUnit> {
    const wu = await this.prisma.workUnit.create({
      data: {
        type: input.type ?? 'task',
        scope: input.scope,
        assigneeId: input.assigneeId ?? null,
        status: input.status ?? 'unassigned',
        channelId: input.channelId ?? null,
        parentId: input.parentId ?? null,
        projectPath: input.projectPath ?? null,
        failureType: input.failureType ?? null,
        retryCount: input.retryCount ?? 0,
        timeoutAt: input.timeoutAt ?? null,
        completedAt: input.completedAt ?? null,
        metadata: input.metadata ? JSON.stringify(input.metadata) : null,
      },
    });

    // Publish event for EVENT trigger consumers (AgentLoop, etc.)
    try {
      eventBus.publish('workunit.created', { workunit: wu });
    } catch (err) {
      logger.warn('[WorkUnit] Failed to publish workunit.created (non-blocking)', {
        workUnitId: wu.id,
        error: String(err),
      });
    }

    return wu;
  }

  /**
   * Convert a ChannelMessage to a WorkUnit (emergence path).
   * Links the source message to the new WorkUnit via workUnitId.
   * @throws Error if message not found or already converted
   */
  async createFromMessage(
    messageId: string,
    options?: { type?: string; metadata?: WorkUnitMetadata },
  ): Promise<WorkUnit> {
    const message = await this.prisma.channelMessage.findUnique({ where: { id: messageId } });
    if (!message) throw new Error(`Message ${messageId} not found`);
    if (message.workUnitId) throw new Error(`Message already linked to WorkUnit ${message.workUnitId}`);

    const wu = await this.create({
      scope: message.content.slice(0, 500),
      type: options?.type ?? 'task',
      channelId: message.channelId,
      metadata: {
        ...options?.metadata,
        sourceMessageId: messageId,
        creationMode: 'from-message',
      },
    });

    // Link message to WorkUnit
    await this.prisma.channelMessage.update({
      where: { id: messageId },
      data: { workUnitId: wu.id },
    });

    return wu;
  }

  /**
   * Get a WorkUnit by id. Returns null if not found.
   */
  async getById(id: string): Promise<WorkUnit | null> {
    return this.prisma.workUnit.findUnique({ where: { id } });
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
  }): Promise<{ data: WorkUnit[]; total: number }> {
    const { type, status, assigneeId, channelId, parentId, failureType, timedOutBefore, page = 1, limit = 20 } = options ?? {};

    const where: Prisma.WorkUnitWhereInput = {};
    if (type) where.type = type;
    if (status) where.status = status;
    if (assigneeId) where.assigneeId = assigneeId;
    if (channelId) where.channelId = channelId;
    if (parentId) where.parentId = parentId;
    if (failureType) where.failureType = failureType;
    if (timedOutBefore) where.timeoutAt = { lte: timedOutBefore };

    const [data, total] = await Promise.all([
      this.prisma.workUnit.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.workUnit.count({ where }),
    ]);

    return { data, total };
  }

  /**
   * Update a WorkUnit.
   */
  async update(id: string, input: UpdateWorkUnitInput): Promise<WorkUnit> {
    const data: Prisma.WorkUnitUncheckedUpdateInput = {};
    if (input.type !== undefined) data.type = input.type;
    if (input.scope !== undefined) data.scope = input.scope;
    if (input.assigneeId !== undefined) data.assigneeId = input.assigneeId;
    if (input.channelId !== undefined) data.channelId = input.channelId;
    if (input.parentId !== undefined) data.parentId = input.parentId;
    if (input.projectPath !== undefined) data.projectPath = input.projectPath;
    if (input.failureType !== undefined) data.failureType = input.failureType;
    if (input.retryCount !== undefined) data.retryCount = input.retryCount;
    if (input.timeoutAt !== undefined) data.timeoutAt = input.timeoutAt;
    if (input.completedAt !== undefined) data.completedAt = input.completedAt;
    if (input.metadata !== undefined) data.metadata = JSON.stringify(input.metadata);

    return this.prisma.workUnit.update({ where: { id }, data });
  }

  /**
   * Delete a WorkUnit.
   */
  async delete(id: string): Promise<void> {
    await this.prisma.workUnit.delete({ where: { id } });
  }

  /**
   * Check if the WorkUnit's files overlap with any active WorkUnit's files.
   * Files stored in metadata.files (string[]).
   * @returns array of conflicting WorkUnit IDs (empty if no conflict)
   */
  private async checkFileConflicts(id: string, metadataRaw: string | null): Promise<string[]> {
    if (!metadataRaw) return [];
    const metadata: WorkUnitMetadata = JSON.parse(metadataRaw);
    const files = metadata.files;
    if (!files || !Array.isArray(files) || files.length === 0) return [];

    const fileSet = new Set(files);
    const activeWorkUnits = await this.prisma.workUnit.findMany({
      where: { status: { in: ['active', 'in_review'] }, id: { not: id } },
      select: { id: true, metadata: true },
    });

    const conflicts: string[] = [];
    for (const wu of activeWorkUnits) {
      if (!wu.metadata) continue;
      const wuMeta: WorkUnitMetadata = JSON.parse(wu.metadata);
      const wuFiles = wuMeta.files;
      if (!Array.isArray(wuFiles)) continue;
      const hasOverlap = wuFiles.some(f => fileSet.has(f));
      if (hasOverlap) conflicts.push(wu.id);
    }
    return conflicts;
  }

  /**
   * Claim a WorkUnit (optimistic lock).
   * Only succeeds when assigneeId is null and status is 'unassigned'.
   * AS-025 §3.28c-5: After claim, auto-loads matching skills for the agent session.
   * @throws Error if claim fails (already claimed or invalid state)
   */
  async claim(id: string, agentId: string): Promise<WorkUnit> {
    logger.info(`[WorkUnit] Claiming WorkUnit: ${id} by agent ${agentId}`);

    // File conflict check before claiming
    const wuToClaim = await this.prisma.workUnit.findUnique({ where: { id } });
    if (!wuToClaim) throw new Error('WorkUnit not found');

    const conflicts = await this.checkFileConflicts(id, wuToClaim.metadata);
    if (conflicts.length > 0) {
      throw new Error(`File conflict with WorkUnit(s): ${conflicts.join(', ')}`);
    }

    const result = await this.prisma.workUnit.updateMany({
      where: { id, assigneeId: null, status: 'unassigned' },
      data: { assigneeId: agentId, status: 'active', claimedAt: new Date() },
    });

    if (result.count === 0) {
      throw new Error('Claim failed');
    }

    const wu = await this.prisma.workUnit.findUnique({ where: { id } });
    if (!wu) throw new Error('WorkUnit not found');

    // AC4: auto-load matching skills based on scope (best-effort, non-blocking)
    this.autoLoadSkillsForAgent(agentId, wu.scope).catch((err) => {
      logger.warn('[WorkUnit] Skill auto-load failed (non-blocking)', {
        workUnitId: id,
        agentId,
        error: String(err),
      });
    });

    return wu;
  }

  /**
   * AS-025 §3.28c-5: Select and load skills matching the WorkUnit scope.
   * Uses agentId as session key for SkillLoaderService.
   */
  private async autoLoadSkillsForAgent(agentId: string, scope: string): Promise<void> {
    const manifest = loadManifest();
    if (manifest.length === 0) return;

    const matched = selectSkills(scope, manifest);
    if (matched.length === 0) return;

    for (const entry of matched) {
      await skillLoaderService.loadSkill({
        sessionId: agentId,
        skillName: entry.name,
      });
    }

    logger.info('[WorkUnit] Auto-loaded skills for agent', {
      agentId,
      scope,
      skills: matched.map(e => e.name),
    });
  }

  /**
   * Unclaim a WorkUnit. Resets to unassigned state.
   */
  async unclaim(id: string): Promise<WorkUnit> {
    return this.prisma.workUnit.update({
      where: { id },
      data: { assigneeId: null, status: 'unassigned', claimedAt: null },
    });
  }

  /**
   * Transition WorkUnit status with state machine validation.
   * @throws Error if transition is not allowed
   */
  async transitionStatus(id: string, newStatus: string): Promise<WorkUnit> {
    const current = await this.prisma.workUnit.findUnique({ where: { id } });
    if (!current) {
      throw new Error('WorkUnit not found');
    }

    const allowed = VALID_TRANSITIONS[current.status];
    if (!allowed || !allowed.includes(newStatus)) {
      throw new Error(
        `Invalid status transition: ${current.status} → ${newStatus}`
      );
    }

    const updateData: Prisma.WorkUnitUncheckedUpdateInput = { status: newStatus };
    // 终态自动写入 completedAt
    if (newStatus === 'done' || newStatus === 'closed') {
      updateData.completedAt = new Date();
    }

    const updated = await this.prisma.workUnit.update({
      where: { id },
      data: updateData,
    });

    // Cascade: parent status aggregation on any status change that affects parent
    if (['active', 'blocked', 'done', 'closed'].includes(newStatus)) {
      this.aggregateParentStatus(id).catch(err =>
        logger.warn('[WorkUnit] aggregateParentStatus failed', { workUnitId: id, error: String(err) })
      );
    }

    return updated;
  }

  /**
   * Review passed: in_review → done. Emits workunit.review.passed.
   * Resets consecutive rejection counter.
   */
  async reviewPassed(id: string): Promise<WorkUnit> {
    const current = await this.prisma.workUnit.findUnique({ where: { id } });
    if (!current) throw new Error('WorkUnit not found');
    if (current.status !== 'in_review') {
      throw new Error(`Cannot review: current status is ${current.status}, expected in_review`);
    }

    const metadata: WorkUnitMetadata = current.metadata ? JSON.parse(current.metadata) : {};
    delete metadata._consecutiveReviewRejections;

    const updated = await this.prisma.workUnit.update({
      where: { id },
      data: { status: 'done', completedAt: new Date(), metadata: JSON.stringify(metadata) },
    });

    // Cascade: parent aggregation (best-effort)
    this.aggregateParentStatus(id).catch(err =>
      logger.warn('[WorkUnit] aggregateParentStatus failed', { workUnitId: id, error: String(err) })
    );

    return updated;
  }

  /**
   * Review rejected: in_review → active (or → blocked after 3 consecutive rejections).
   * Emits workunit.review.rejected.
   */
  async reviewRejected(id: string, reason?: string): Promise<WorkUnit> {
    const current = await this.prisma.workUnit.findUnique({ where: { id } });
    if (!current) throw new Error('WorkUnit not found');
    if (current.status !== 'in_review') {
      throw new Error(`Cannot review: current status is ${current.status}, expected in_review`);
    }

    const metadata: WorkUnitMetadata = current.metadata ? JSON.parse(current.metadata) : {};
    const rejections = (metadata._consecutiveReviewRejections ?? 0) + 1;
    metadata._consecutiveReviewRejections = rejections;
    if (reason) metadata._lastRejectionReason = reason;

    // 3 consecutive rejections → auto-block
    const newStatus = rejections >= 3 ? 'blocked' : 'active';

    const updated = await this.prisma.workUnit.update({
      where: { id },
      data: { status: newStatus, metadata: JSON.stringify(metadata) },
    });

    if (newStatus === 'blocked') {
      logger.warn('[WorkUnit] Auto-blocked after 3 consecutive review rejections', { workUnitId: id });
    }

    return updated;
  }

  /**
   * Compute aggregated parent status from children statuses.
   * Returns null if no change needed.
   */
  private computeAggregatedStatus(statuses: string[]): string | null {
    if (statuses.every(s => s === 'unassigned')) return 'unassigned';
    if (statuses.some(s => s === 'blocked')) return 'blocked';
    if (statuses.some(s => s === 'active')) return 'active';
    if (statuses.every(s => s === 'done' || s === 'closed') && statuses.some(s => s === 'done')) return 'in_review';
    if (statuses.every(s => s === 'closed')) return 'closed';
    return null;
  }

  /**
   * Cascade: aggregate parent WorkUnit status from children.
   * Called after a child's status changes.
   *
   * Aggregation rules (ordered):
   *  - All children unassigned → parent unassigned
   *  - Any child blocked → parent blocked
   *  - Any child active → parent active
   *  - All done/closed (≥1 done) → parent in_review
   *  - All closed → parent closed
   *
   * Only applies to organizational parents (children exist).
   * Skips if parent doesn't exist.
   */
  async aggregateParentStatus(childId: string): Promise<void> {
    const child = await this.prisma.workUnit.findUnique({
      where: { id: childId },
      select: { parentId: true },
    });
    if (!child?.parentId) return;

    // Re-read children right before update to avoid stale overwrites from concurrent cascades
    const siblings = await this.prisma.workUnit.findMany({
      where: { parentId: child.parentId },
      select: { status: true },
    });
    if (siblings.length === 0) return;

    const newStatus = this.computeAggregatedStatus(siblings.map(s => s.status));
    if (!newStatus) return;

    const parent = await this.prisma.workUnit.findUnique({
      where: { id: child.parentId },
      select: { status: true },
    });
    if (!parent || parent.status === newStatus) return;

    // State ordering guard: don't overwrite a parent that's already at a "later" state.
    // Prevents concurrent cascades (e.g. c1→active then c1→done) from racing.
    const ORDER: Record<string, number> = { unassigned: 0, active: 1, blocked: 2, in_review: 3, done: 4, closed: 5 };
    if ((ORDER[parent.status] ?? 0) >= (ORDER[newStatus] ?? 0)) return;

    await this.prisma.workUnit.update({
      where: { id: child.parentId },
      data: { status: newStatus },
    });

    logger.info('[WorkUnit] Parent status aggregated', {
      parentId: child.parentId,
      newStatus,
      childCount: siblings.length,
    });
  }

}
