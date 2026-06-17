/**
 * Scheduler Integration — GoalScheduler 类的生命周期和调度循环
 *
 * 从 goal-scheduler.ts 提取。
 */

import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { prisma } from '@dommaker/studio-prisma';
import { logger, eventBus } from '@dommaker/studio-shared';
import { goalService, parseJsonField } from './goal.service.js';
import { expireStaleBlockedGoals } from './goal-lifecycle.js';
import { eventStore } from '../../core/event-store.js';

import {
  getAvailableSlots,
  getDispatchStrategy,
  analyzeRoutingFeedback,
  restoreRoutingStats,
  type ClassificationRecord,
  DEFAULT_TIER_ROUTING,
} from './scheduler-queue.js';

import { dispatchStep, type DispatchContext } from './scheduler-dispatch.js';

const POLL_INTERVAL = 30_000; // 30s — event-driven primary, poll as safety net
const WORKTREES_DIR = process.env.WORKTREES_DIR || path.join(os.homedir(), 'worktrees');

export class GoalScheduler {
  private interval: NodeJS.Timeout | null = null;
  private processing = false;
  private processingGoals = new Set<string>();
  private lastRecoveryTime = 0;
  private runtimeConstraints = new Map<string, string[]>();
  private recentFailures: number = 0;
  private recentTotal: number = 0;
  private recentClassifications: ClassificationRecord[] = [];
  private explorationCount = 0;
  private explorationSuccess = 0;
  private routingOverrides: Map<string, string> = new Map();
  private tokenGatedGoals: Set<string> = new Set();
  private runtimeConstraintSub: typeof eventStore | null = null;

  /** 构建 dispatchStep 所需的上下文对象 */
  private getDispatchContext(): DispatchContext {
    return {
      runtimeConstraints: this.runtimeConstraints,
      recentFailures: this.recentFailures,
      recentTotal: this.recentTotal,
    };
  }

  addRoutingOverride(category: string, tier: string): void {
    this.routingOverrides.set(category, tier);
    logger.info('[GoalScheduler] Routing override added', { category, tier });
  }

  addTokenGate(goalId: string): void {
    this.tokenGatedGoals.add(goalId);
  }

  start(): void {
    if (this.interval) return;

    this.recentClassifications = restoreRoutingStats();

    this.startRuntimeConstraintSub();

    this.interval = setInterval(() => this.tick(), POLL_INTERVAL);

    eventBus.subscribe('goal.created', () => {
      logger.debug('[GoalScheduler] Goal created event received, triggering immediate tick');
      this.tick();
    });

    eventBus.subscribe('goal.stepCompleted', (data: { goalId?: string }) => {
      logger.debug('[GoalScheduler] Step completed event received, triggering tick', { goalId: data?.goalId });
      this.tick();
    });

    logger.info('[GoalScheduler] Started', { pollInterval: POLL_INTERVAL, maxConcurrent: 5 });
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.runtimeConstraintSub) {
      this.runtimeConstraintSub.disconnect();
      this.runtimeConstraintSub = null;
    }
    logger.info('[GoalScheduler] Stopped');
  }

  private startRuntimeConstraintSub(): void {
    this.runtimeConstraintSub = eventStore;
    this.runtimeConstraintSub.subscribe('events:goal', (message: string) => {
      try {
        const event = JSON.parse(message);
        if (event.event_type === 'goal.runtime_constraints') {
          const existing = this.runtimeConstraints.get(event.goalId) || [];
          const newConstraints = (event.constraints as string[]).filter((c: string) => !existing.includes(c));
          if (newConstraints.length > 0) {
            this.runtimeConstraints.set(event.goalId, [...existing, ...newConstraints]);
            logger.info('[BP-018] Runtime constraints added', {
              goalId: event.goalId,
              constraints: newConstraints,
              source: event.sourceExecutionId,
            });
          }
        }
      } catch (e) {
        logger.warn('[GoalScheduler] Ignoring malformed event', { error: String(e) });
      }
    });
    (this.runtimeConstraintSub as any).on = () => {};
    (this.runtimeConstraintSub as any).disconnect = () => {};
  }

  // ========================================
  // Tick / Poll
  // ========================================

  private async tick(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      const executingGoals = await prisma.goal.findMany({
        where: { status: 'executing' },
        select: { id: true },
      });

      for (const goal of executingGoals) {
        await this.processGoal(goal.id).catch(e => {
          logger.error('[GoalScheduler] Error processing goal', { goalId: goal.id, error: String(e) });
        });
      }

      if (!this.lastRecoveryTime || Date.now() - this.lastRecoveryTime > 5 * 60_000) {
        await this.recoverStaleExecutions().catch(e => {
          logger.warn('[GoalScheduler] Periodic recovery failed', { error: String(e) });
        });
        this.lastRecoveryTime = Date.now();

        // Auto-fail stale blocked goals (> 7 days)
        await expireStaleBlockedGoals().catch(e => {
          logger.warn('[GoalScheduler] expireStaleBlockedGoals failed', { error: String(e) });
        });
      }
    } catch (e) {
      logger.error('[GoalScheduler] Tick error', { error: String(e) });
    } finally {
      this.processing = false;
    }
  }

  // ========================================
  // Goal Processing
  // ========================================

  private async processGoal(goalId: string): Promise<void> {
    if (this.processingGoals.has(goalId)) return;
    this.processingGoals.add(goalId);

    try {
      const runningCount = await prisma.goalExecution.count({
        where: { goalId, status: 'running' },
      });
      const strategy = getDispatchStrategy(this.recentFailures, this.recentTotal);
      const maxCap = strategy === 'conservative' ? 2 : undefined;
      const availableSlots = getAvailableSlots(maxCap) - runningCount;
      if (availableSlots <= 0) return;

      const executableSteps = await goalService.getExecutableSteps(goalId);
      if (executableSteps.length === 0) {
        const allExecs = await prisma.goalExecution.findMany({
          where: { goalId }, select: { status: true },
        });
        if (allExecs.length === 0) {
          logger.warn('[GoalScheduler] Goal has no executions, marking failed', { goalId });
          await goalService.checkGoalCompletion(goalId);
        } else if (allExecs.every(e => ['succeeded', 'failed', 'blocked_by_dependency'].includes(e.status))) {
          await goalService.checkGoalCompletion(goalId);
        } else if (allExecs.some(e => e.status === 'failed')) {
          // Has failed steps + pending dependents — trigger cascade
          await goalService.checkGoalCompletion(goalId);
        }
        return;
      }

      const goal = await prisma.goal.findUnique({ where: { id: goalId } });
      if (!goal) return;

      // O3e: PMO dependency check
      try {
        const ctx = typeof goal.context === 'string' ? JSON.parse(goal.context) : (goal.context || {});
        const projectId = ctx?.projectId as string | undefined;
        if (projectId) {
          const project = await prisma.project.findUnique({ where: { id: projectId } });
          if (project?.dependsOnPmoId) {
            const depProject = await prisma.project.findFirst({
              where: { pmoNumber: project.dependsOnPmoId, companyId: goal.companyId },
            });
            if (depProject && depProject.status !== 'completed') {
              logger.info('[GoalScheduler] PMO dependency not met, deferring Goal', {
                goalId, projectId, dependsOn: project.dependsOnPmoId,
                depStatus: depProject.status,
              });
              return;
            }
          }
        }
      } catch (e) {
        logger.warn('[GoalScheduler] PMO dependency check error, continuing', { error: String(e) });
      }

      let toDispatch: any[] = executableSteps.slice(0, availableSlots);

      // O3c: File conflict detection
      try {
        const currentlyRunning = await prisma.goalExecution.findMany({
          where: { status: 'running' },
          select: { id: true, goalId: true },
        });
        const activeFiles = new Set<string>();
        for (const running of currentlyRunning) {
          const exec = await prisma.goalExecution.findUnique({ where: { id: running.id } });
          const input = parseJsonField<Record<string, any> | null>(exec?.input, null);
          const files = (input?.acGroup?.files as string[]) || [];
          files.forEach(f => activeFiles.add(f));
        }
        const filtered: typeof toDispatch = [];
        for (const exec of toDispatch) {
          const stepInput = parseJsonField<Record<string, any> | null>(exec.input, null);
          const stepFiles = (stepInput?.acGroup?.files as string[]) || [];
          const conflicts = stepFiles.filter(f => activeFiles.has(f));
          if (conflicts.length > 0) {
            logger.warn('[GoalScheduler] File conflict detected, deferring step', {
              executionId: exec.id, conflicts,
              conflictingWith: currentlyRunning.filter(r => r.goalId !== goalId).map(r => r.id),
            });
            // O4-KR2: Record conflict event for OKR metric
            prisma.studioEvent.create({
              data: {
                type: 'scheduler:conflict',
                source: 'goal-scheduler',
                executionId: exec.id,
                payload: JSON.stringify({ conflicts, goalId, executionId: exec.id }),
              },
            }).catch(() => {});
            continue;
          }
          filtered.push(exec);
        }
        toDispatch = filtered;
      } catch (e) {
        logger.warn('[GoalScheduler] File conflict check error, continuing with all steps', { error: String(e) });
      }

      // Point 11: Actual dispatch logging (O4-KR1 parallelism measurement)
      logger.info('[GoalScheduler] Actual dispatch', {
        goalId,
        executableSteps: executableSteps.length,
        dispatched: toDispatch.length,
        deferredByConflict: executableSteps.length - toDispatch.length,
        runningAfterDispatch: runningCount + toDispatch.length,
        concurrencyLimit: getAvailableSlots(maxCap),
        strategy,
      });

      const ctx = this.getDispatchContext();
      const results = await Promise.allSettled(
        toDispatch.map(exec => dispatchStep(exec, goal, ctx).catch(e => {
          logger.error('[GoalScheduler] Dispatch error', { executionId: exec.id, error: String(e) });
        })),
      );

      // O4-KR1: Record parallel execution count for OKR metric
      if (toDispatch.length > 0) {
        const totalRunning = await prisma.goalExecution.count({ where: { status: 'running' } });
        prisma.studioEvent.create({
          data: {
            type: 'scheduler:parallel',
            source: 'goal-scheduler',
            payload: JSON.stringify({ concurrent: totalRunning, dispatched: toDispatch.length, goalId }),
          },
        }).catch(() => {});
      }

      // 同步 mutable state 回 class
      this.recentFailures = ctx.recentFailures;
      this.recentTotal = ctx.recentTotal;

      await this.checkAllStepsCompleted(goalId);
    } finally {
      this.processingGoals.delete(goalId);
    }
  }

  /** dispatchStep wrapper — 委托给 scheduler-dispatch.dispatchStep */
  private async dispatchStepFn(execWithStep: any, goal: any): Promise<void> {
    const ctx = this.getDispatchContext();
    await dispatchStep(execWithStep, goal, ctx);
    // 同步 mutable state 回 class
    this.recentFailures = ctx.recentFailures;
    this.recentTotal = ctx.recentTotal;
  }

  // ========================================
  // Integration Step 检查
  // ========================================

  private async checkAllStepsCompleted(goalId: string): Promise<void> {
    const all = await prisma.goalExecution.findMany({
      where: { goalId },
      select: { status: true, id: true, stepIndex: true },
    });

    if (all.length === 0) return;
    const allDone = all.every(e => e.status === 'succeeded' || e.status === 'failed');

    if (!allDone) return;

    const hasIntegration = all.some(e => e.stepIndex === 999);
    if (hasIntegration) return;

    const anyFailed = all.some(e => e.status === 'failed');
    if (anyFailed) {
      logger.warn('[GoalScheduler] Some steps failed, skipping integration', { goalId });
      return;
    }

    const regularSteps = all.filter(e => e.stepIndex !== 999);
    if (regularSteps.length === 1) {
      logger.info('[GoalScheduler] Single AC group, skipping integration step', {
        goalId,
        stepIndex: regularSteps[0].stepIndex,
      });
      return;
    }

    logger.info('[GoalScheduler] Creating integration step', { goalId });

    try {
      await prisma.goalExecution.create({
        data: {
          goalId,
          stepIndex: 999,
          status: 'pending',
          agentType: 'claude',
          input: JSON.stringify({
            taskType: 'integration',
            goalId,
            totalSteps: all.length,
            model: 'standard',
          }),
        },
      });
    } catch (err) {
      logger.error('[GoalScheduler] Failed to create integration step', { goalId, error: String(err) });
    }
  }

  // ========================================
  // 服务重启恢复
  // ========================================

  private async abandonOrphanedRunning(): Promise<void> {
    try {
      const orphaned = await prisma.goalExecution.findMany({
        where: { status: { in: ['running', 'pending'] } },
        select: { id: true },
      });
      if (orphaned.length === 0) return;

      logger.info('[GoalScheduler] Abandoning orphaned executions after restart', { count: orphaned.length });
      for (const exec of orphaned) {
        try {
          await goalService.updateStepExecution(exec.id, {
            status: 'failed',
            error: 'Daemon restarted — active Claude session lost',
          });
        } catch (e) {
          logger.error('[GoalScheduler] Failed to abandon orphaned', { executionId: exec.id, error: String(e) });
        }
      }
    } catch (e) {
      logger.error('[GoalScheduler] Error in abandonOrphanedRunning', { error: String(e) });
    }
  }

  private async recoverStaleExecutions(): Promise<void> {
    try {
      const stale = await prisma.goalExecution.findMany({
        where: { status: 'running' },
      });

      if (stale.length === 0) return;

      logger.info('[GoalScheduler] Recovering stale executions', { count: stale.length });

      for (const exec of stale) {
        const worktree = path.join(WORKTREES_DIR, exec.id);
        try {
          if (fs.existsSync(worktree)) {
            const progressPath = path.join(worktree, '.progress.json');
            let allComplete = false;
            if (fs.existsSync(progressPath)) {
              const progress = JSON.parse(fs.readFileSync(progressPath, 'utf-8'));
              allComplete = progress.allComplete === true;
            }

            if (allComplete) {
              await goalService.updateStepExecution(exec.id, { status: 'succeeded' });
              logger.info('[Recovery] Marked succeeded', { executionId: exec.id });
            } else {
              let parsedInput: Record<string, unknown> = {};
              if (typeof exec.input === 'string') {
                try { parsedInput = JSON.parse(exec.input); } catch { parsedInput = {}; }
              } else {
                parsedInput = (exec.input as Record<string, unknown>) || {};
              }
              await goalService.updateStepExecution(exec.id, {
                status: 'pending',
                input: JSON.stringify({
                  ...(parsedInput as Record<string, unknown>),
                  resumeAfterRestart: true,
                }),
              });
              logger.info('[Recovery] Re-queued for retry', { executionId: exec.id });
            }
          } else {
            await goalService.updateStepExecution(exec.id, {
              status: 'failed',
              error: 'Worktree lost after service restart',
            });
            logger.warn('[Recovery] Worktree lost, marked failed', { executionId: exec.id });
          }
        } catch (e) {
          logger.error('[Recovery] Error recovering execution', { executionId: exec.id, error: String(e) });
          await goalService.updateStepExecution(exec.id, {
            status: 'failed',
            error: `Recovery error: ${String(e)}`,
          }).catch((dbErr) => {
            logger.error('[Recovery] Failed to persist failed status — execution stuck', {
              executionId: exec.id, dbError: String(dbErr),
            });
          });
        }
      }
    } catch (e) {
      logger.error('[Recovery] Error in recoverStaleExecutions', { error: String(e) });
    }
  }

  // ─── Public API for Monitor ───

  /** G5 进化: 分析路由决策 → 双向反馈 */
  analyzeRoutingFeedback(): Array<{ type: string; message: string; evidence: string }> {
    return analyzeRoutingFeedback(this.recentClassifications, this.explorationCount, this.explorationSuccess);
  }
}

export const goalScheduler = new GoalScheduler();
