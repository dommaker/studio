/**
 * WorkUnit Service — 工作单元 CRUD + Claim + 状态机
 *
 * AS-025 §3.28c-1 Task 2-4
 */

import { Prisma, type WorkUnit } from '@prisma/client';
import type { ExtendedPrismaClient } from '@dommaker/studio-prisma';
import { logger } from '@dommaker/studio-shared';
import { loadManifest } from '../skills/manifest-loader.js';
import { selectSkills } from '../skills/skill-selector.js';
import { skillLoaderService } from '../skills/skill-loader.js';
import { emitWorkUnitCreated, emitWorkUnitClaimed, emitWorkUnitStatusChanged, emitWorkUnitDone } from './workunit-events.js';

/** Metadata JSON schema — fields that don't warrant first-class columns */
export interface WorkUnitMetadata {
  priority?: 'low' | 'normal' | 'high' | 'critical';
  createdBy?: string;
  description?: string;       // 从 Goal.description 降级
  constraints?: string;       // 从 Goal.constraints 降级
  context?: string;           // 从 Goal.context 降级
  planVersion?: number;       // 从 GoalPlan.version 降级
  planReasoning?: string;     // 从 GoalPlan.reasoning 降级
  error?: string;             // 从 GoalExecution.error 降级
  input?: string;             // 从 GoalExecution.input 降级
  output?: string;            // 从 GoalExecution.output 降级
  goalId?: string;            // 从 GoalExecution.goalId 降级（Phase 3 迁移）
  title?: string;             // 从 Goal.title 降级（Phase 3 迁移）
  _cumulativeTokens?: number; // 内部 token 累计追踪
  [key: string]: unknown;     // 允许扩展字段
}

export interface CreateWorkUnitInput {
  type?: string;
  scope: string;
  assigneeId?: string;
  status?: string;
  channelId?: string | null;
  parentId?: string | null;
  dependsOn?: string[];
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
  dependsOn?: string[];
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
        dependsOn: input.dependsOn ? JSON.stringify(input.dependsOn) : '[]',
        failureType: input.failureType ?? null,
        retryCount: input.retryCount ?? 0,
        timeoutAt: input.timeoutAt ?? null,
        completedAt: input.completedAt ?? null,
        metadata: input.metadata ? JSON.stringify(input.metadata) : null,
      },
    });

    emitWorkUnitCreated({
      workUnitId: wu.id,
      type: wu.type,
      scope: wu.scope,
      channelId: wu.channelId,
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
    if (input.dependsOn !== undefined) data.dependsOn = JSON.stringify(input.dependsOn);
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
   * Claim a WorkUnit (optimistic lock).
   * Only succeeds when assigneeId is null and status is 'unassigned'.
   * AS-025 §3.28c-5: After claim, auto-loads matching skills for the agent session.
   * @throws Error if claim fails (already claimed or invalid state)
   */
  async claim(id: string, agentId: string): Promise<WorkUnit> {
    const result = await this.prisma.workUnit.updateMany({
      where: { id, assigneeId: null, status: 'unassigned' },
      data: { assigneeId: agentId, status: 'active', claimedAt: new Date() },
    });

    if (result.count === 0) {
      throw new Error('Claim failed');
    }

    const wu = await this.prisma.workUnit.findUnique({ where: { id } });
    if (!wu) throw new Error('WorkUnit not found');

    emitWorkUnitClaimed({ workUnitId: id, agentId, scope: wu.scope });

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

    emitWorkUnitStatusChanged({ workUnitId: id, oldStatus: current.status, newStatus });

    if (newStatus === 'done') {
      emitWorkUnitDone({ workUnitId: id, scope: current.scope });
    }

    return updated;
  }
}
