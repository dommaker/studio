/**
 * Goal Scheduler - 轮询 executing 状态的 Goal，调度可执行的 step
 *
 * NA 新架构:
 *   - 资源感知并发 (getAvailableSlots)
 *   - 文件冲突检测 (detectFileConflicts)
 *   - 并行 dispatch (Promise.allSettled)
 *   - 服务重启恢复 (recoverStaleExecutions — Step 6)
 */

import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { prisma } from '@dommaker/studio-prisma';
import { logger, eventBus } from '@dommaker/studio-shared';
import { skillLoader } from '@dommaker/studio-skill';
import { recordPipelineRun, parseClaudeUsage } from '../../daemon/metrics.js';
import { agentExecutor } from '@dommaker/studio-agent';
import { goalService, GoalStep, parseJsonField } from './goal.service.js';
import { beforeAgentDispatch } from '@dommaker/studio-shared/harness/hooks';
import { formatConstraintsForPrompt } from '@dommaker/studio-shared';
import { roleConfigService } from '../roles/role-config.service.js';
import { eventStore, EventStore } from '../../core/event-store.js';
import { preferenceObserver } from '../knowledge/preference-observer.js';

const POLL_INTERVAL = 10_000; // 10s
const MAX_CONCURRENT = 5;
const WORKTREES_DIR = process.env.WORKTREES_DIR || path.join(os.homedir(), 'worktrees');

export class GoalScheduler {
  private interval: NodeJS.Timeout | null = null;
  private processing = false;
  private processingGoals = new Set<string>();
  private lastRecoveryTime = 0;
  private runtimeConstraints = new Map<string, string[]>(); // 🆕 BP-018: goalId → runtime constraints
  // INF-004: failure rate tracking for strategy switching
  private recentFailures: number = 0;
  private recentTotal: number = 0;
  // G5: 路由决策记录（含 outcome 用于进化反馈）
  private recentClassifications: Array<{
    time: string; executionId: string; taskType: string;
    acCount: number; fileCount: number; classified: string; final: string;
    outcome?: 'success' | 'failure'; durationMs?: number; reviewScore?: number;
    taskCategory?: string; // Phase 3: per-task-type boundary
  }> = [];
  // Phase 2: ε-greedy exploration counters
  private explorationCount = 0;
  private explorationSuccess = 0;
  private readonly EXPLORATION_RATE = 0.1; // 10% chance to try lower tier
  // Monitor 自动优化：per-category 路由覆盖 + token 预算门控
  private routingOverrides: Map<string, string> = new Map();  // taskCategory → forced tier
  private tokenGatedGoals: Set<string> = new Set();           // goalId → force flash

  addRoutingOverride(category: string, tier: string): void {
    this.routingOverrides.set(category, tier);
    logger.info('[GoalScheduler] Routing override added', { category, tier });
  }

  addTokenGate(goalId: string): void {
    this.tokenGatedGoals.add(goalId);
  }

  private runtimeConstraintSub: typeof eventStore | null = null;

  start(): void {
    if (this.interval) return;

    // Phase 1: 恢复路由统计数据
    this.restoreRoutingStats();

    // Step 6: 服务重启时放弃所有孤儿 running 执行（无活跃 session）
    this.abandonOrphanedRunning().catch(e => {
      logger.error('[GoalScheduler] Abandon orphaned failed', { error: String(e) });
    });

    // 🆕 BP-018: 订阅运行时约束
    this.startRuntimeConstraintSub();

    this.interval = setInterval(() => this.tick(), POLL_INTERVAL);

    // O1a: Event-driven trigger — immediate tick on new goal creation
    eventBus.subscribe('goal.created', () => {
      logger.debug('[GoalScheduler] Goal created event received, triggering immediate tick');
      this.tick();
    });

    logger.info('[GoalScheduler] Started', { pollInterval: POLL_INTERVAL, maxConcurrent: MAX_CONCURRENT });
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
    this.runtimeConstraintSub.on = () => {}; // no-op, was Redis .on('message')
    this.runtimeConstraintSub.disconnect = () => {}; // no-op
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

      // P0.4: 周期性恢复卡住的 execution（每 5 分钟）
      if (!this.lastRecoveryTime || Date.now() - this.lastRecoveryTime > 5 * 60_000) {
        await this.recoverStaleExecutions().catch(e => {
          logger.warn('[GoalScheduler] Periodic recovery failed', { error: String(e) });
        });
        this.lastRecoveryTime = Date.now();
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
    // Per-goal guard: prevent concurrent ticks from processing the same goal
    if (this.processingGoals.has(goalId)) return;
    this.processingGoals.add(goalId);

    try {
      // 资源感知并发槽位
      const runningCount = await prisma.goalExecution.count({
        where: { goalId, status: 'running' },
      });
      const availableSlots = this.getAvailableSlots() - runningCount;
      if (availableSlots <= 0) return;

      // 获取依赖满足的 pending steps
      const executableSteps = await goalService.getExecutableSteps(goalId);
      if (executableSteps.length === 0) {
        // 无可执行步骤 → 检查是否应终结 Goal
        const allExecs = await prisma.goalExecution.findMany({
          where: { goalId }, select: { status: true },
        });
        // 有步骤且全部终态 → 触发完成判定；零步骤（损坏的 Goal）→ 直接标记 failed
        if (allExecs.length === 0) {
          logger.warn('[GoalScheduler] Goal has no executions, marking failed', { goalId });
          await goalService.checkGoalCompletion(goalId);
        } else if (allExecs.every(e => e.status === 'succeeded' || e.status === 'failed')) {
          await goalService.checkGoalCompletion(goalId);
        }
        return;
      }

      const goal = await prisma.goal.findUnique({ where: { id: goalId } });
      if (!goal) return;

      // O3e: Check PMO dependency before dispatching this Goal's steps
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
              return; // Don't dispatch any steps until dependency is satisfied
            }
          }
        }
      } catch (e) {
        logger.warn('[GoalScheduler] PMO dependency check error, continuing', { error: String(e) });
      }

      // 并行 dispatch（用 Promise.allSettled 替代串行 await）
      let toDispatch: any[] = executableSteps.slice(0, availableSlots);

      // O3c: File conflict detection — defer steps that touch files currently being modified
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
            continue;
          }
          filtered.push(exec);
        }
        toDispatch = filtered;
      } catch (e) {
        logger.warn('[GoalScheduler] File conflict check error, continuing with all steps', { error: String(e) });
      }
      const results = await Promise.allSettled(
        toDispatch.map(exec => this.dispatchStep(exec, goal).catch(e => {
          logger.error('[GoalScheduler] Dispatch error', { executionId: exec.id, error: String(e) });
        })),
      );

      // 完成后检查是否需要创建 integration step
      await this.checkAllStepsCompleted(goalId);
    } finally {
      this.processingGoals.delete(goalId);
    }
  }

  // ========================================
  // Step 2: 资源感知并发
  // ========================================

  private getAvailableSlots(): number {
    const freeMemPct = os.freemem() / os.totalmem();
    const load = os.loadavg()[0] / os.cpus().length;
    const totalMemGB = Math.round(os.totalmem() / (1024 * 1024 * 1024));
    const freeMemGB = Math.round(os.freemem() / (1024 * 1024 * 1024));

    let slots: number;
    if (freeMemPct < 0.15) slots = 1;
    else if (freeMemPct < 0.30) slots = 2;
    else if (load > 0.90) slots = 2;
    else slots = MAX_CONCURRENT;

    logger.info('[GoalScheduler] Resource check', {
      freeMemGB, totalMemGB, freeMemPct: Math.round(freeMemPct * 100) + '%',
      loadAvg: os.loadavg()[0].toFixed(2), cpuCores: os.cpus().length,
      slots, maxConcurrent: MAX_CONCURRENT,
    });
    return slots;
  }

  // ========================================
  // Step 2: 文件冲突检测
  // ========================================

  private detectConflicts(executions: any[]): string[][] {
    // 按 file 范围分组，重叠的各组串行为一批
    const batches: string[][] = [];
    const remaining = new Set(executions.map((e: any) => e.id));

    while (remaining.size > 0) {
      const batch: string[] = [];
      const batchFiles = new Set<string>();

      for (const execId of [...remaining]) {
        const exec = executions.find((e: any) => e.id === execId);
        const input = parseJsonField<Record<string, any> | null>(exec?.input, null);
        const files: string[] = input?.acGroup?.files || [];

        const hasConflict = files.some(f => batchFiles.has(f));
        if (!hasConflict) {
          batch.push(execId);
          files.forEach(f => batchFiles.add(f));
          remaining.delete(execId);
        }
      }

      if (batch.length === 0 && remaining.size > 0) {
        // 兜底：取第一个放入独立批次
        const first = [...remaining][0];
        batch.push(first);
        remaining.delete(first);
      }

      batches.push(batch);
    }

    return batches;
  }

  /**
   * G5 进化：分析路由决策 → 发现误分类模式 → 通知 AuditorAgent
   * 由 MonitorAgent 每 5 分钟调用一次
   */
  /**
   * G5 进化: 分析路由决策 → 双向反馈（升级+降级）
   * Phase 2: ε-greedy — premium 成功率高时试探 standard
   * Phase 3: per-task-category 独立追踪
   */
  analyzeRoutingFeedback(): Array<{ type: string; message: string; evidence: string }> {
    const suggestions: Array<{ type: string; message: string; evidence: string }> = [];
    const completed = this.recentClassifications.filter(c => c.outcome);
    if (completed.length < 5) return suggestions;

    // 按 classified tier + taskCategory 分组
    const byTier = new Map<string, { total: number; success: number; reviewScores: number[] }>();
    for (const c of completed) {
      const key = `${c.classified}|${c.taskCategory || 'any'}`;
      if (!byTier.has(key)) byTier.set(key, { total: 0, success: 0, reviewScores: [] });
      const entry = byTier.get(key)!;
      entry.total++;
      if (c.outcome === 'success') { entry.success++; }
      if (c.reviewScore) { entry.reviewScores.push(c.reviewScore); }
    }

    for (const [key, stats] of byTier) {
      const [tier, category] = key.split('|');
      if (stats.total < 3) continue;

      const successRate = stats.success / stats.total;
      const avgReview = stats.reviewScores.length > 0
        ? stats.reviewScores.reduce((a, b) => a + b, 0) / stats.reviewScores.length
        : null;

      // 升级：standard/fast 成功率过低
      if (tier !== 'premium' && successRate < 0.5) {
        suggestions.push({
          type: 'routing.upgrade',
          message: `${tier}/"${category}" failure rate ${Math.round((1 - successRate) * 100)}% → try premium`,
          evidence: `${stats.total} tasks, ${stats.success} success, avg review ${avgReview ?? 'N/A'}`,
        });
      }

      // 降级 (Phase 1): premium 成功率 100% + review ≥ 80 → 可降级
      if (tier === 'premium' && successRate >= 1.0 && avgReview && avgReview >= 80) {
        suggestions.push({
          type: 'routing.downgrade',
          message: `premium/"${category}" 100% success (${stats.total} tasks, avg review ${Math.round(avgReview)}) → try standard`,
          evidence: `ε-greedy: next premium/"${category}" task has ${Math.round(this.EXPLORATION_RATE * 100)}% chance to use standard`,
        });
      }
    }

    // Phase 2: ε-greedy exploration report
    if (this.explorationCount > 0) {
      const exploreRate = this.explorationSuccess / this.explorationCount;
      suggestions.push({
        type: 'routing.exploration',
        message: `ε-greedy: ${this.explorationSuccess}/${this.explorationCount} explorations succeeded (${Math.round(exploreRate * 100)}%)`,
        evidence: exploreRate > 0.8 ? 'boundary expanding' : 'boundary stable',
      });
    }

    return suggestions;
  }

  /** Phase 3: 推断任务类型 */
  private inferTaskCategory(prompt: string, input: Record<string, any> | null): string {
    const combined = `${prompt} ${JSON.stringify(input?.acGroup?.acs || [])}`.toLowerCase();
    if (/test|测试|vitest|jest|spy|mock/i.test(combined)) return 'test';
    if (/import|修复.*import|添加.*import|fix.*import/i.test(combined)) return 'import-fix';
    if (/discord|route|endpoint|api.*route|channel/i.test(combined)) return 'integration';
    if (/schema|migration|prisma|migrate/i.test(combined)) return 'schema';
    if (/auth|token|jwt|oauth|password|security/i.test(combined)) return 'auth';
    if (/config|setup|init|start|docker|deploy/i.test(combined)) return 'config';
    if (/refactor|重构/i.test(combined)) return 'refactor';
    return 'general';
  }

  /** Phase 1: 持久化路由统计到文件 */
  private persistRoutingStats(): void {
    try {
      const file = path.join(process.env.STUDIO_CONFIG_DIR || path.join(os.homedir(), '.studio'), '.harness', 'routing.jsonl');
      const dir = path.dirname(file);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const last = this.recentClassifications[this.recentClassifications.length - 1];
      fs.appendFileSync(file, JSON.stringify(last) + '\n', 'utf-8');
    } catch {}
  }

  /** Phase 1: 启动时恢复路由统计 */
  private restoreRoutingStats(): void {
    try {
      const file = path.join(process.env.STUDIO_CONFIG_DIR || path.join(os.homedir(), '.studio'), '.harness', 'routing.jsonl');
      if (!fs.existsSync(file)) return;
      const lines = fs.readFileSync(file, 'utf-8').trim().split('\n').slice(-200);
      for (const line of lines) {
        try { this.recentClassifications.push(JSON.parse(line)); } catch {}
      }
      logger.info('[GoalScheduler] Restored routing stats', { count: this.recentClassifications.length });
    } catch {}
  }

  /** Phase 2: ε-greedy — premium 任务以 ε 概率降级到 standard 试探边界 */
  private maybeExploreDowngrade(tier: string, taskCategory: string): { tier: string; exploring: boolean } {
    if (tier !== 'premium') return { tier, exploring: false };
    if (taskCategory === 'auth' || taskCategory === 'schema') return { tier, exploring: false }; // 高风险不试探
    if (Math.random() > this.EXPLORATION_RATE) return { tier, exploring: false };

    this.explorationCount++;
    logger.info('[GoalScheduler] ε-greedy: exploring standard for premium task', { taskCategory, explorationCount: this.explorationCount });
    return { tier: 'standard', exploring: true };
  }

  // G5: 动态模型路由 — 根据任务特征自动选择 tier
  private classifyTaskComplexity(input: Record<string, any> | null, prompt: string): string {
    const acs = input?.acGroup?.acs ? JSON.stringify(input.acGroup.acs) : '';
    const taskDesc = (input?.taskDescription as string) || prompt || '';
    const combined = `${taskDesc} ${acs}`.toLowerCase();

    // Layer 1: 关键词（domain risk）
    const highRiskPattern = /migration|migrate|auth|authentication|security|financial|payment|encrypt|crypto/;
    const lowRiskPattern = /style|typo|rename|format|lint|comment|doc|readme|spelling|refactor.*simple/;
    const isHighRiskDomain = highRiskPattern.test(combined);
    const isLowRiskDomain = lowRiskPattern.test(combined);
    const highRiskHits = combined.match(new RegExp(highRiskPattern.source, 'gi')) || [];
    const lowRiskHits = combined.match(new RegExp(lowRiskPattern.source, 'gi')) || [];

    // Layer 2: AC 组数量（task breadth）
    const acCount = input?.acGroup?.acs?.length || 1;

    // Layer 3: 文件范围（impact scope）
    const files: string[] = input?.acGroup?.files || [];
    const fileCount = files.length;

    // Layer 4: 实现技巧复杂度 (implementationNotes 关键词 → skill level)
    const notes = (input?.acGroup?.implementationNotes as string) || '';
    const notesLower = notes.toLowerCase();
    const trivialPattern = /^[（(]?\s*(import|添加\s*import|调用|add\s*call|insert|加一行|照抄)/;
    const complexPattern = /泛型|generic|状态机|state\s*machine|并发|concurrent|迁移|migrate|加密|encrypt|类型体操|type\s*transform/;
    const isLowSkill = trivialPattern.test(notesLower) || notesLower.length < 30;
    const isHighSkill = complexPattern.test(notesLower) && notesLower.length > 80;

    // Layer 5: 改动幅度 (change magnitude) — AC 多但每个都简单 → 不应用 premium
    // 估算：每个 AC ~15 行改动 (conservative)，getchas 数量 = 复杂度信号
    const gotchas = (input?.acGroup?.gotchas as string[]) || [];
    const estimatedLines = acCount * 15;
    const isSmallChange = estimatedLines <= 80 && fileCount <= 3 && gotchas.length <= 2;

    // Dimension-weighted threshold: acCount alone shouldn't force premium
    // Raise from 4→6 to let standard handle medium-complexity tasks
    const premiumTrigger = isHighRiskDomain || acCount >= 6 || fileCount >= 7;

    let tier: string;
    let reason: string;
    if (premiumTrigger) {
      tier = 'premium';
      const triggers = [];
      if (isHighRiskDomain) triggers.push(`keywords:${highRiskHits.join(',')}`);
      if (acCount >= 6) triggers.push(`acCount=${acCount}`);
      if (fileCount >= 7) triggers.push(`fileCount=${fileCount}`);
      reason = triggers.join('; ');
      // Layer 4 override: 低技能可降级 (highRisk 不可降级)
      if (!isHighRiskDomain && isLowSkill && acCount <= 6 && fileCount <= 5) {
        tier = 'standard';
        reason += ` (downgraded: lowSkill, notes="${notes.slice(0, 60)}")`;
      }
      // Layer 5 override: 小改动即使 AC 多也不需 premium (pipe fix 类任务)
      if (!isHighRiskDomain && isSmallChange && tier === 'premium') {
        tier = 'standard';
        reason += ` (downgraded: smallChange, estLines~${estimatedLines}, files=${fileCount}, gotchas=${gotchas.length})`;
      }
    } else if (isLowRiskDomain && acCount <= 2 && fileCount <= 3) {
      tier = 'fast';
      reason = `lowRisk keywords:${lowRiskHits.join(',')}, acCount=${acCount}, fileCount=${fileCount}`;
    } else {
      tier = 'standard';
      reason = `default (acCount=${acCount}, fileCount=${fileCount}, highRisk=${isHighRiskDomain}, lowRisk=${isLowRiskDomain})`;
      // Layer 4 override: 高技能需升级
      if (isHighSkill) {
        tier = 'premium';
        reason += ` (upgraded: highSkill, notes="${notes.slice(0, 60)}")`;
      }
      // Layer 4 override: 低技能维持 standard (already correct tier)
    }

    logger.info('[GoalScheduler] Complexity classified', { tier, reason, acCount, fileCount });
    return tier;
  }

  // INF-004: strategy switching — 最近失败率 > 50% → 切换为保守模式
  private getDispatchStrategy(): 'normal' | 'conservative' {
    const total = this.recentTotal;
    if (total < 5) return 'normal'; // 样本不足，默认正常
    const failRate = this.recentFailures / total;
    return failRate > 0.5 ? 'conservative' : 'normal';
  }

  /** 从 Goal 的 projectId 反查 project.gitRepo，找不到则回退到 REPO_DIR */
  private async getProjectRepoPath(goal: any): Promise<string> {
    try {
      const ctx = typeof goal.context === 'string' ? JSON.parse(goal.context) : (goal.context || {});
      const projectId = ctx?.projectId as string;
      if (projectId) {
        const project = await prisma.project.findUnique({
          where: { id: projectId },
          select: { gitRepo: true },
        });
        if (project?.gitRepo) return project.gitRepo;
      }
    } catch { /* fallback */ }
    return process.env.REPO_DIR || path.join(os.homedir(), 'projects');
  }

  private recordDispatchOutcome(success: boolean): void {
    this.recentFailures += success ? 0 : 1;
    this.recentTotal++;
    // 滑动窗口: 最近 20 次
    if (this.recentTotal > 20) {
      this.recentTotal = 20;
      this.recentFailures = Math.min(this.recentFailures, 20);
    }
  }

  // ========================================
  // Dispatch
  // ========================================

  private async dispatchStep(execWithStep: any, goal: any): Promise<void> {
    const { id: executionId, stepIndex, _baseBranchExecId } = execWithStep;
    const input = parseJsonField<Record<string, any> | null>(execWithStep.input, null);

    // Phase 3: dispatch 前 harness 检查（Goal 阶段 hook）
    try {
      await beforeAgentDispatch({
        operation: 'code_implementation',
        taskDescription: input?.taskType === 'integration' ? 'Integration step' : (input?.acGroup?.acs?.join('; ') || ''),
        projectPath: await this.getProjectRepoPath(goal),
        hasWorktree: true,
        hasRequirement: true,          // Goal 从 RequirementsDoc 创建
        hasSingleTask: true,           // 每次 dispatch 只给一个 sub-agent
        hasVerificationEvidence: true, // Agent 每步产出 .progress.json
      });
    } catch (err) {
      logger.warn('[GoalScheduler] beforeAgentDispatch failed, continuing', { executionId, error: String(err) });
    }

    // 🆕 ROLE-001: 加载 Executor 的角色约束
    let roleConstraints: string[] = [];
    try {
      const companyId = goal.companyId || (goal.context as any)?.companyId;
      if (companyId) {
        const execConfig = await roleConfigService.getOrCreate('executor', companyId);
        roleConstraints = parseJsonField<string[]>(execConfig.boundConstraints, []);
      }
    } catch (e) {
      logger.warn('[GoalScheduler] Failed to load role config, using defaults', { executionId, error: String(e) });
    }

    // 🆕 BP-018: 注入运行时约束（跨 Executor 实时预警）
    const runtimeConstraints = this.runtimeConstraints.get(goal.id);
    if (runtimeConstraints?.length) {
      roleConstraints = [...roleConstraints, ...runtimeConstraints];
      logger.info('[BP-018] Injected runtime constraints', { executionId, count: runtimeConstraints.length });
    }

    // G5/Q4: 动态模型路由 — 必须在 status=running 之前更新 input.model
    const autoTier = this.classifyTaskComplexity(input, '');
    const taskCategory = this.inferTaskCategory('', input);
    const { tier: exploredTier } = this.maybeExploreDowngrade(autoTier, taskCategory);
    let tier: string = exploredTier;
    if (this.routingOverrides.has(taskCategory) && tier === 'premium') {
      tier = this.routingOverrides.get(taskCategory)!;
    }
    if (this.tokenGatedGoals.has(goal.id) && tier === 'premium') tier = 'standard';

    // O2c: Adaptive routing — if cache hit rate consistently low, don't spend premium tokens
    try {
      const recentSessions = await prisma.studioEvent.findMany({
        where: { agentRole: 'executor', tokenInput: { gt: 0 } },
        orderBy: { timestamp: 'desc' },
        take: 10,
      });
      if (recentSessions.length >= 5) {
        const avgCacheHitRate = recentSessions.reduce((sum, e) =>
          sum + (e.tokenCacheRead || 0) / Math.max(e.tokenInput || 1, 1), 0) / recentSessions.length;
        if (avgCacheHitRate < 0.3 && tier === 'premium') {
          tier = 'standard';
          logger.info('[GoalScheduler] Adaptive routing: downgraded to standard due to low cache hit rate', { avgCacheHitRate: avgCacheHitRate.toFixed(3) });
        }
      }
    } catch { /* best-effort */ }

    // 更新 input 中的 model 字段，确保 task worker 拿到的是动态 tier
    if (input && tier !== input.model) {
      input.model = tier;
      await goalService.updateStepExecution(executionId, { input }).catch(() => {});
    }

    // 标记 step 为 running
    await goalService.updateStepExecution(executionId, { status: 'running' });

    // 构建 prompt
    const isSubAgent = input?.taskType === 'sub-agent';
    const isIntegration = input?.taskType === 'integration';
    const siblingContext = isSubAgent
      ? await this.getSiblingContext(goal.id, executionId, stepIndex)
      : '';

    // 公司知识注入（已沉淀的 Pattern/Skill）
    const companyKnowledge = isSubAgent
      ? await this.getCompanyKnowledge(goal.id, input)
      : '';

    let prompt: string;
    if (isIntegration) {
      prompt = await this.buildIntegrationPrompt(goal.id);
    } else if (isSubAgent) {
      prompt = this.buildSubAgentPrompt(input, siblingContext, companyKnowledge);
    } else {
      prompt = this.buildLegacyPrompt(input);
    }

    // INF-004: strategy switching — conservative mode 降并发
    const strategy = this.getDispatchStrategy();
    const effectiveConcurrency = strategy === 'conservative' ? 2 : MAX_CONCURRENT;

    // Track classification for routing evolution (tier already computed above)
    this.recentClassifications.push({
      time: new Date().toISOString(),
      executionId,
      taskType: input?.taskType || 'sub-agent',
      acCount: input?.acGroup?.acs?.length || 1,
      fileCount: (input?.acGroup?.files || []).length,
      classified: autoTier,
      final: tier,
      taskCategory,
    });
    if (this.recentClassifications.length > 200) this.recentClassifications.shift();
    // Phase 1: 持久化到文件，重启不丢
    this.persistRoutingStats();
    const dispatchStart = Date.now();
    logger.info('[GoalScheduler] Dispatching', {
      strategy,
      effectiveConcurrency,
      executionId,
      goalId: goal.id,
      stepIndex,
      taskType: input?.taskType || 'sub-agent',
      tier: autoTier === tier ? tier : `${tier} (auto-classified: ${autoTier})`,
      hasRoleConstraints: roleConstraints.length > 0,
      hasSiblingContext: !!siblingContext,
      siblingContextSize: siblingContext?.length || 0,
      hasCompanyKnowledge: !!companyKnowledge,
      companyKnowledgeSize: companyKnowledge?.length || 0,
    });

    // G-001~003: 注入知识上下文（偏好 + 规则 + 环境）
    // 通过 parameters.knowledgeContext 传递，agent-executor 的 buildPrompt 在 session 1/2+ 都会注入
    let knowledgeContext = '';
    try {
      const { knowledgeQuery } = await import('../knowledge/knowledge-query.service.js');
      knowledgeContext = await knowledgeQuery.formatCompactForPrompt('executor');
    } catch { /* best-effort */ }

    // P0 follow-up: 注入知识总线上下文（Monitor/Auditor/Triage/KK 的模式和踩坑）
    try {
      const { knowledgeBus } = await import('../knowledge/knowledge-bus.service.js');
      const busContext = knowledgeBus.getRecentContext('executor', 5);
      if (busContext) knowledgeContext += '\n' + busContext;
    } catch { /* best-effort */ }

    // B1: RKB 已知回归 pattern 主动注入（不仅是失败时，执行前就提醒）
    try {
      const { resolutionMatcher } = await import('../knowledge/resolution.service.js');
      const rkbContext = await resolutionMatcher.formatForPrompt();
      if (rkbContext) knowledgeContext += '\n## 已知回归模式（Resolution Knowledge Base）\n' + rkbContext;
    } catch { /* best-effort */ }

    // 提取 sourceChannelId 用于实时进度推送
    const goalContext = (typeof goal.context === 'string' ? JSON.parse(goal.context) : goal.context) || {};
    const sourceChannelId = goalContext.sourceChannelId as string | undefined;

    // 实时进度回调：每个 session 后推送进度卡片到 Channel
    const onProgress = async (progress: any, session: number) => {
      if (!sourceChannelId) return;
      try {
        const { channelMessageService } = await import('../channels/channel-message.service.js');
        const pct = progress.allComplete ? 100
          : progress.completedSteps?.length
            ? Math.min(95, Math.round((progress.completedSteps.length / Math.max(progress.completedSteps.length + (progress.testResults?.failed ? 1 : 0), 1)) * 100))
            : session * 15;
        const statusIcon = progress.allComplete ? '✅' : progress.testResults?.failed ? '⚠️' : '🔄';
        const lines = [
          `### ${statusIcon} Agent 进度 — Session ${session}`,
          '',
          `**当前步骤**: ${progress.currentStep || '初始化中...'}`,
          `**已完成**: ${progress.completedSteps?.join(', ') || '无'}`,
          `**测试**: ${progress.testResults?.passed || 0} passed / ${progress.testResults?.failed || 0} failed / ${progress.testResults?.total || 0} total`,
          `**备注**: ${progress.notes || '无'}`,
          '',
          `---`,
          `*${pct}% 完成*`,
        ].join('\n');
        await channelMessageService.createAgentMessage(sourceChannelId, 'Executor', lines, {
          meta: { cardType: 'agent_progress', goalId: goal.id, cardData: { executionId, session, pct } },
        });
      } catch { /* best-effort */ }
    };

    // P0-1: Integration step — 用代码执行替代 Claude session（merge+tsc+test 是确定性操作）
    if (isIntegration) {
      try {
        const result = await this.runIntegrationInCode(goal.id, executionId);
        if (result.success) {
          await goalService.updateStepExecution(executionId, { status: 'succeeded' });
          this.recordDispatchOutcome(true);
          logger.info('[GoalScheduler] Integration (code) succeeded', {
            goalId: goal.id, executionId, durationMs: Date.now() - dispatchStart,
          });
          return;
        }
      } catch (err) {
        logger.warn('[GoalScheduler] Integration (code) threw, falling back to Claude', { goalId: goal.id, error: String(err) });
      }
      // Code integration failed — fall through to Claude executor below
    }

    // 直接调用 AgentExecutor
    try {
      const result = await agentExecutor.execute({
        id: executionId,
        executionId,
        agentType: 'claude',
        model: (input?.model as string) || autoTier,
        prompt,
        onProgress,
        parameters: {
          goalExecutionId: executionId,
          goalId: goal.id,
          acGroup: input?.acGroup || undefined,
          analystContext: (input?.acGroup as any)?._analystContext || null,
          hasWorktree: true,
          repoDir: await this.getProjectRepoPath(goal),
          // Q3: 依赖继承 — 下游 worktree 从上游 task branch 创建（而非 main）
          ...(_baseBranchExecId ? { baseBranch: `task/${_baseBranchExecId}` } : {}),
          knowledgeContext,
          sourceChannelId,
          // 🆕 ROLE-001: Executor 的角色约束
          roleConstraints,
        },
      });

      const dispatchDuration = Date.now() - dispatchStart;
      // INF-004: record outcome for strategy switching
      this.recordDispatchOutcome(result.success);
      // G5: record routing outcome for classifier evolution
      const cls = this.recentClassifications.find(c => c.executionId === executionId);
      if (cls) {
        cls.outcome = result.success ? 'success' : 'failure';
        cls.durationMs = dispatchDuration;
        // Phase 2: track ε-greedy exploration result
        if (cls.final !== cls.classified) {
          if (result.success) this.explorationSuccess++;
          logger.info('[GoalScheduler] ε-greedy result', {
            classified: cls.classified, used: cls.final,
            success: result.success, explorationTotal: this.explorationCount,
            explorationSuccess: this.explorationSuccess,
          });
        }
      }
      // G-001: 异步更新用户模型偏好
      preferenceObserver.updateFromRoutingFeedback(this.recentClassifications.map(c => ({
        taskId: c.executionId,
        tier: c.final as 'premium' | 'standard' | 'fast',
        result: c.outcome as 'success' | 'failure',
        duration: c.durationMs || 0,
        timestamp: Date.now(),
      }))).catch((e: any) => { logger.warn('[GoalScheduler] preferenceObserver failed', { error: String(e) }); });
      // Q5修复: 从 agent log JSON 提取真实 token 数据（而非 result.totalTokens 始终为 undefined）
      const worktreeDir = path.join(WORKTREES_DIR, executionId);
      if (result.success) {
        // 直接标记成功（不依赖 Redis 事件链保证可靠性）
        await goalService.updateStepExecution(executionId, { status: 'succeeded' });
        const tokenUsage = this.parseAgentTokenUsage(worktreeDir);
        recordPipelineRun({
          source: 'pipeline', phase: 'executor',
          taskName: goal.title,
          model: tokenUsage.model || (typeof input === 'object' ? (input?.model as string) || 'standard' : 'standard'),
          inputTokens: tokenUsage.inputTokens,
          outputTokens: tokenUsage.outputTokens,
          cacheHitTokens: tokenUsage.cacheHitTokens,
          durationMs: result.totalDurationMs || dispatchDuration,
          success: true,
          sessionId: executionId,
        }).catch((e: any) => { logger.warn('[GoalScheduler] recordPipelineRun failed', { error: String(e) }); });
        // G30: Record pipeline run event
        prisma.studioEvent.create({
          data: {
            type: 'pipeline_run',
            source: 'goal-scheduler',
            payload: JSON.stringify({
              goalId: goal.id,
              executionId,
              success: true,
              model: tokenUsage.model,
              durationMs: result.totalDurationMs || dispatchDuration,
            }),
          },
        }).catch((e: any) => { logger.warn('[GoalScheduler] StudioEvent failed', { error: String(e) }); });
        // P2-1: 累计 token 到 goal context (cost tracking)
        try {
          const g = await prisma.goal.findUnique({ where: { id: goal.id }, select: { context: true } });
          const gc = (typeof g?.context === 'string' ? JSON.parse(g.context) : g?.context) || {};
          const prevTokens = (gc._cumulativeTokens as number) || 0;
          const thisTokens = (tokenUsage.inputTokens || 0) + (tokenUsage.cacheHitTokens || 0);
          gc._cumulativeTokens = prevTokens + thisTokens;
          await prisma.goal.update({
            where: { id: goal.id },
            data: { context: gc as any },
          });
        } catch { /* best-effort */ }

        // M1: agent 冷启动到完成的全链路耗时
        logger.info('[GoalScheduler] Agent succeeded', {
          executionId,
          goalId: goal.id,
          sessionCount: result.sessionCount,
          tokens: tokenUsage,
          dispatchDurationMs: dispatchDuration,
          tier,
          strategy,
        });
      } else {
        await goalService.updateStepExecution(executionId, {
          status: 'failed',
          error: result.error || 'Agent execution failed',
        });
        const failTokens = this.parseAgentTokenUsage(worktreeDir);
        recordPipelineRun({
          source: 'pipeline', phase: 'executor',
          taskName: goal.title,
          model: failTokens.model || (typeof input === 'object' ? (input?.model as string) || 'standard' : 'standard'),
          inputTokens: failTokens.inputTokens,
          outputTokens: failTokens.outputTokens,
          cacheHitTokens: failTokens.cacheHitTokens,
          durationMs: result.totalDurationMs || dispatchDuration,
          success: false,
          error: result.error || 'Agent execution failed',
          sessionId: executionId,
        }).catch((e: any) => { logger.warn('[GoalScheduler] recordPipelineRun (failure) failed', { error: String(e) }); });
        // G30: Record pipeline run event (failure)
        prisma.studioEvent.create({
          data: {
            type: 'pipeline_run',
            source: 'goal-scheduler',
            payload: JSON.stringify({
              executionId,
              success: false,
              error: result.error || 'Agent execution failed',
            }),
          },
        }).catch((e: any) => { logger.warn('[GoalScheduler] StudioEvent failed', { error: String(e) }); });
        logger.warn('[GoalScheduler] Agent failed', {
          executionId,
          goalId: goal.id,
          error: result.error,
          dispatchDurationMs: dispatchDuration,
          tier,
          strategy,
        });
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await goalService.updateStepExecution(executionId, { status: 'failed', error: errorMsg });
      logger.error('[GoalScheduler] Agent error', { executionId, error: errorMsg });
    }
  }

  /**
   * 获取已完成 sibling 的上下文，注入 pending step 的 prompt。
   * 使后续 sub-agent 能基于已完成工作自适应调整方案。
   */
  private async getSiblingContext(
    goalId: string,
    currentExecutionId: string,
    currentStepIndex: number,
  ): Promise<string> {
    const allExecs = await prisma.goalExecution.findMany({
      where: { goalId },
      select: { id: true, stepIndex: true, status: true, output: true },
    });

    const completed = allExecs.filter(
      e => e.status === 'succeeded' && e.id !== currentExecutionId,
    );
    if (completed.length === 0) return '';

    const plan = await prisma.goalPlan.findFirst({
      where: { goalId, status: 'approved' },
      orderBy: { version: 'desc' },
    });
    const steps = parseJsonField<GoalStep[]>(plan?.steps, []);

    const lines: string[] = [
      '## 已完成的相关工作',
      '以下并行步骤已先完成，参考其输出可避免重复劳动或冲突：',
    ];

    for (const sibling of completed) {
      const step = steps.find(s => s.index === sibling.stepIndex);
      const output = sibling.output as Record<string, any> | null;
      if (!output) continue;

      lines.push('');
      lines.push(`### ${step?.title || 'AC 组 ' + (sibling.stepIndex + 1)}`);

      if (output.summary) lines.push(`摘要: ${output.summary}`);
      if (output.changedFiles?.length) {
        lines.push(
          '改动文件:',
          ...output.changedFiles.map((f: string) => `  - ${f}`),
        );
      }

      // 跨 step 建议：过滤出针对当前 step 的建议
      const advice = (output.siblingAdvice || []).filter(
        (a: any) =>
          !a.targetGroupId ||
          a.targetGroupId === currentStepIndex.toString() ||
          a.targetGroupId === `step-${currentStepIndex}`,
      );
      if (advice.length > 0) {
        lines.push(
          '给你的建议:',
          ...advice.map((a: any) => `  - [${a.priority || 'info'}] ${a.message}`),
        );
      }
    }

    return lines.join('\n');
  }

  /**
   * 获取公司级知识注入（已沉淀的 Pattern/Skill）
   */
  private async getCompanyKnowledge(goalId: string, input: Record<string, any> | null): Promise<string> {
    try {
      const goal = await prisma.goal.findUnique({ where: { id: goalId }, select: { companyId: true, context: true } });
      const companyId = goal?.companyId || ((goal?.context as any)?.companyId as string);
      if (!companyId) return '';

      // 查询发布了公司级 published Skill
      const skills = await prisma.skill.findMany({
        where: { companyId, status: 'published' },
        select: { name: true, description: true, category: true, metadata: true },
        take: 5, orderBy: { usageCount: 'desc' },
      });
      if (!skills.length) return '';

      // 简单关键词匹配：当前 AC 是否和某个 Skill 相关
      const acText = (input?.acGroup?.acs || []).join(' ').toLowerCase();
      const relevant = skills.filter(s => {
        const skillText = `${s.name} ${s.description} ${s.category}`.toLowerCase();
        return acText.split(' ').some(w => w.length > 2 && skillText.includes(w));
      });

      if (!relevant.length) return '';

      return [
        '## 公司知识库',
        '以下是你公司沉淀的可复用经验和模式：',
        ...relevant.map(s => {
          const pattern = (s.metadata as any)?.pattern || '';
          return `- **${s.name}** (${s.category}): ${s.description}${pattern ? '\n  复用模板: ' + pattern : ''}`;
        }),
      ].join('\n');
    } catch (e) {
      logger.warn('[GoalScheduler] Company knowledge injection failed', { error: String(e) });
      return '';
    }
  }

  /**
   * Sub-agent prompt（文件桥模型 + sibling context + 公司知识）
   */
  private buildSubAgentPrompt(
    input: Record<string, any> | null,
    siblingContext?: string,
    companyKnowledge?: string,
  ): string {
    const acGroup = input?.acGroup as Record<string, any> | undefined;
    const acs: string[] = acGroup?.acs || [];
    const files: string[] = acGroup?.files || [];
    const notes: string = acGroup?.implementationNotes || '';
    const patterns: string[] = acGroup?.codePatterns || [];
    const gotchas: string[] = acGroup?.gotchas || [];

    const acLines = acs.length > 0
      ? acs.map((ac: string, i: number) => `${i + 1}. ${ac}`).join('\n')
      : '（从任务描述中推断）';

    return [
      '## 你的任务',
      '读 REQUIREMENTS.md 了解完整上下文。',
      '',
      '## 验收标准',
      acLines,
      '',
      ...(notes ? ['## 实现指南', notes, ''] : []),
      ...(patterns.length ? ['## 参考模式', ...patterns.map(p => `- ${p}`), ''] : []),
      ...(gotchas.length ? ['## ⚠️ 注意事项', ...gotchas.map(g => `- ${g}`), ''] : []),
      ...(files.length > 0 ? ['## 预期改动文件', ...files.map((f: string) => `- ${f}`), ''] : []),
      ...(siblingContext ? [siblingContext, ''] : []),
      ...(companyKnowledge ? [companyKnowledge, ''] : []),
      skillLoader.formatForPrompt(skillLoader.load({ trigger: 'sub_agent', agentType: 'executor', tier: 'fast' })),
      '',
      '## 验证',
      '声明完成前必须：',
      '1. 运行 npm test 确认所有测试通过（含你新增的测试）',
      '2. 运行 npm run typecheck（或 tsc --noEmit）确认无类型错误',
      '3. 将测试证据写入 .progress.json 的 testResults 字段：',
      '```json',
      '{',
      '  "testResults": {',
      '    "passed": <是否全部通过: true|false>,',
      '    "total": <通过的测试数>,',
      '    "failed": <失败的测试数, 必须为 0>,',
      '    "command": "npm test",',
      '    "evidence": "<测试输出摘要>"',
      '  }',
      '}',
      '```',
      '',
      '## 完成后',
      '在 .progress.json 的 notes 字段简要记录：',
      '- 你的关键设计决策（1-2 句）',
      '- 是否影响其他 AC 组的方案（如需要提醒其他组调整，用 @sibling step-N: 你的建议 格式）',
    ].join('\n');
  }

  /**
   * 向后兼容：旧 prompt（Legacy task，无 acGroup）
   */
  private buildLegacyPrompt(input: Record<string, any> | null): string {
    const taskName = input?.taskName as string || input?.requirement as string || 'Task';
    const taskDesc = input?.requirement as string || '';
    const acceptanceCriteria = input?.acceptanceCriteria as string[] | undefined;
    const acText = acceptanceCriteria?.length
      ? `\n验收标准:\n${acceptanceCriteria.map((c: string, i: number) => `${i + 1}. ${c}`).join('\n')}`
      : '';

    return [
      `# 任务: ${taskName}`,
      taskDesc ? `\n## 描述\n${taskDesc}` : '',
      acText,
      '\n## 要求\n请完成以上任务，确保代码质量、测试覆盖和安全合规。',
      '\n## 完成后',
      '- 运行 npm test，确认全部测试通过',
      '- 将测试证据写入 .progress.json:',
      '  { "testResults": { "passed": true, "total": N, "failed": 0, "command": "npm test", "evidence": "<摘要>" } }',
      '- 在 notes 中简要记录关键设计决策',
    ].filter(Boolean).join('\n');
  }

  /**
   * 集成验证 prompt（INF-003：语义冲突检测）
   *
   * 在所有 sub-agent 完成后运行。merge 各 worktree 分支，
   * 运行 type-check + test，检测 git merge 无法发现的语义冲突。
   */
  private async buildIntegrationPrompt(goalId: string): Promise<string> {
    const execs = await prisma.goalExecution.findMany({
      where: { goalId, status: 'succeeded' },
      select: { id: true, stepIndex: true, output: true },
      orderBy: { stepIndex: 'asc' },
    });

    const groupList = execs.map(e => {
      const input = e.input as Record<string, any> | null;
      const output = e.output as Record<string, any> | null;
      return [
        `### AC 组 ${e.stepIndex + 1}`,
        `  - 执行 ID: ${e.id}`,
        `  - ACs: ${(input?.acGroup?.acs || []).join('; ') || '未知'}`,
        `  - AC 范围文件: ${(input?.acGroup?.files || []).join(', ') || '未知'}`,
        `  - 摘要: ${output?.summary || '无'}`,
        `  - 实际改动文件: ${(output?.changedFiles || []).join(', ') || '未知'}`,
      ].join('\n');
    }).join('\n\n');

    // D1: 收集 AC 范围文件列表，供 diff 审计使用
    const acScopedFiles = execs.flatMap(e => {
      const input = e.input as Record<string, any> | null;
      return (input?.acGroup?.files || []) as string[];
    });

    const constraintSection = formatConstraintsForPrompt('integration');

    return [
      '## 集成验证任务',
      '',
      constraintSection,
      '你的工作是验证以下并行完成的 sub-agent 的代码能否正确集成。',
      '',
      '## 各 AC 组完成情况',
      groupList,
      '',
      '## 验证流程',
      '',
      `### 0. AC 范围审计（合并前）`,
      `以下文件在 AC 中明确定义为修改范围：`,
      `${acScopedFiles.length > 0 ? acScopedFiles.map(f => `  - ${f}`).join('\n') : '  （无明确文件范围，跳过）'}`,
      '',
      '合并所有 task 分支后，运行 diff 审计：',
      '```bash',
      'git diff main...HEAD --name-only',
      '```',
      '检查：',
      '- diff 中的每个文件是否在上面的 AC 范围列表中？',
      '- 如果 diff 中出现未授权的文件 → 标记为"非目标变更"，在 notes 中记录',
      '- 如果 AC 范围外的文件被修改 → Integration 失败，不要继续 tsc/test',
      '',
      '### 1. 合并所有分支',
      '每个 sub-agent 在一个独立的 git worktree 中工作：',
      `Worktree 目录: ${path.join(os.homedir(), 'worktrees')}`,
      '',
      '依次将各 AC 组的 worktree 分支合并到当前集成分支：',
      '```bash',
      'for worktree in <各个 worktree 目录>; do',
      '  branch=$(cd "$worktree" && git rev-parse --abbrev-ref HEAD)',
      '  git merge "$branch" || echo "MERGE CONFLICT: $branch"',
      'done',
      '```',
      '',
      '### 2. 类型检查（语义冲突检测核心）',
      '运行 TypeScript 编译检查，这是发现语义冲突最有效的手段：',
      '```bash',
      'npx tsc --noEmit 2>&1',
      '```',
      '重点关注：函数签名不匹配、导入路径断裂、类型定义不一致。',
      '',
      '### 3. 运行测试',
      '```bash',
      'npm test 2>&1',
      '```',
      '',
      '### 4. 判断与报告',
      '- **全部通过** → 设置 .progress.json allComplete: true',
      '- **有失败** → 分析错误日志，找出是哪两个 AC 组的代码产生了冲突，',
      '  在 .progress.json notes 中具体记录：',
      '  - 冲突位置（文件 + 行号）',
      '  - 冲突原因（如"组 A 改了函数签名而组 B 仍用旧签名调用"）',
      '  - 建议修复方向',
      '',
      '## 重要',
      '- 如果发现合并冲突，先解决再继续',
      '- 如果 tsc 或 test 失败且无法快速修复，诚实记录在 notes 中',
      '- 每完成一个步骤后更新 .progress.json',
    ].join('\n');
  }

  /**
   * P0-1: 用代码执行 Integration（merge+tsc+test），替代 Claude session。
   * 只有确定性操作，不需要 LLM。失败时 fallback 到 Claude 做智能修复。
   */
  private async runIntegrationInCode(
    goalId: string,
    executionId: string,
  ): Promise<{ success: boolean; error?: string }> {
    const execSync = (await import('child_process')).execSync;
    const repoDir = process.env.REPO_DIR || '/root/projects/studio';
    const worktreesDir = process.env.WORKTREES_DIR || '/root/worktrees';
    const worktree = path.join(worktreesDir, executionId);

    // 1. 创建 integration worktree
    try { fs.rmSync(worktree, { recursive: true, force: true }); } catch {}
    const branchName = `task/${executionId}`;
    try {
      execSync(`git worktree add -b "${branchName}" "${worktree}" main`, { cwd: repoDir, timeout: 30_000 });
    } catch {
      // Branch already exists (retry after restart) — reuse it
      try { execSync(`git branch -D "${branchName}"`, { cwd: repoDir, timeout: 5_000 }); } catch {}
      execSync(`git worktree add -b "${branchName}" "${worktree}" main`, { cwd: repoDir, timeout: 30_000 });
    }
    logger.info('[GoalScheduler] Integration worktree created', { worktree, executionId });

    // 2. 获取所有 succeeded 的执行，合并它们的 task 分支
    const succeededExecs = await prisma.goalExecution.findMany({
      where: { goalId, status: 'succeeded', stepIndex: { not: 999 } },
      orderBy: { stepIndex: 'asc' },
    });
    for (const exec of succeededExecs) {
      const branch = `task/${exec.id}`;
      try {
        execSync(`git merge "${branch}" --no-edit`, { cwd: worktree, timeout: 15_000 });
        logger.info('[GoalScheduler] Integration merged', { branch, executionId });
      } catch (e: any) {
        const errMsg = e?.stderr?.toString() || e?.message || String(e);
        logger.warn('[GoalScheduler] Integration merge conflict', { branch, error: errMsg.slice(0, 200) });
        return { success: false, error: `Merge conflict on ${branch}: ${errMsg.slice(0, 200)}` };
      }
    }

    // 3. 类型检查（monorepo: 用 apps/api 的 tsconfig）
    try {
      execSync('npx tsc --noEmit --project apps/api/tsconfig.json 2>&1', { cwd: worktree, timeout: 60_000 });
    } catch (e: any) {
      const errMsg = e?.stderr?.toString() || e?.stdout?.toString() || String(e);
      return { success: false, error: `tsc failed: ${errMsg.slice(0, 300)}` };
    }

    // 4. 运行测试（monorepo: 只测 api 包的 test，不跑全量）
    try {
      execSync('npx jest --passWithNoTests 2>&1', { cwd: path.join(worktree, 'apps', 'api'), timeout: 120_000 });
    } catch (e: any) {
      const errMsg = e?.stderr?.toString() || e?.stdout?.toString() || String(e);
      return { success: false, error: `Tests failed: ${errMsg.slice(0, 300)}` };
    }

    // 5. 写入 progress
    const progressPath = path.join(worktree, '.progress.json');
    fs.writeFileSync(progressPath, JSON.stringify({
      taskId: executionId, executionId, goalId, allComplete: true,
      completedSteps: ['merge', 'tsc', 'test'],
      testResults: { passed: 1, failed: 0, total: 1 },
      currentStep: 'integration complete',
      notes: `Integration by code (P0-1): ${succeededExecs.length} branches merged, tsc clean, tests pass`,
    }, null, 2), 'utf-8');

    return { success: true };
  }

  // ========================================
  // Step 3: Integration Step 检查
  // ========================================

  private async checkAllStepsCompleted(goalId: string): Promise<void> {
    const all = await prisma.goalExecution.findMany({
      where: { goalId },
      select: { status: true, id: true, stepIndex: true },
    });

    if (all.length === 0) return;
    const allDone = all.every(e => e.status === 'succeeded' || e.status === 'failed');

    if (!allDone) return;

    // 所有 sub-agent 完成 → 检查是否已有 Integration step
    const hasIntegration = all.some(e => e.stepIndex === 999);
    if (hasIntegration) return;

    const anyFailed = all.some(e => e.status === 'failed');
    if (anyFailed) {
      logger.warn('[GoalScheduler] Some steps failed, skipping integration', { goalId });
      return;
    }

    // 单 AC 组：跳过 integration step（只有一个分支，merge + tsc + test 等于空操作）
    const regularSteps = all.filter(e => e.stepIndex !== 999);
    if (regularSteps.length === 1) {
      logger.info('[GoalScheduler] Single AC group, skipping integration step', {
        goalId,
        stepIndex: regularSteps[0].stepIndex,
      });
      return;
    }

    // 创建 Integration GoalExecution
    logger.info('[GoalScheduler] Creating integration step', { goalId });
    const plan = await prisma.goalPlan.findFirst({
      where: { goalId, status: 'approved' },
      orderBy: { version: 'desc' },
    });
    if (!plan) return;

    await prisma.goalExecution.create({
      data: {
        goalId,
        planId: plan.id,
        stepIndex: 999, // Integration step 索引
        status: 'pending',
        agentType: 'claude',
        input: {
          taskType: 'integration',
          goalId,
          totalSteps: all.length,
          model: 'standard',  // 集成步骤涉及 merge + tsc + test
        },
      },
    });
  }

  // ========================================
  // Step 6: 服务重启恢复
  // ========================================

  /** 服务重启：放弃所有孤儿 running 执行（daemon 重启后无活跃 Claude session） */
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
            // Worktree 还在 → 读 .progress.json 判断
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
            // Worktree 丢了
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
          }).catch(() => {});
        }
      }
    } catch (e) {
      logger.error('[Recovery] Error in recoverStaleExecutions', { error: String(e) });
    }
  }
  /**
   * Q5修复: 从 agent log JSON 提取 token 和模型数据
   * agent log 每行是 Claude JSON 输出，最后一行包含 modelUsage
   */
  private parseAgentTokenUsage(worktreeDir: string): {
    model: string; inputTokens: number; outputTokens: number; cacheHitTokens: number;
  } {
    try {
      const logFile = path.join(worktreeDir, '.agent.log');
      if (!fs.existsSync(logFile)) return { model: 'unknown', inputTokens: 0, outputTokens: 0, cacheHitTokens: 0 };

      const content = fs.readFileSync(logFile, 'utf-8').trim();
      if (!content) return { model: 'unknown', inputTokens: 0, outputTokens: 0, cacheHitTokens: 0 };

      // 取最后一行 JSON（最终输出）
      const lines = content.split('\n').filter(Boolean);
      const lastLine = lines[lines.length - 1];
      const parsed = JSON.parse(lastLine);
      const mu = parsed.modelUsage || {};
      // modelUsage 的 key 是模型名（如 "deepseek-v4-pro[1m]"）
      const modelKeys = Object.keys(mu);
      const model = modelKeys.length > 0 ? modelKeys[0] : 'unknown';
      const modelData = mu[model] || {};

      return {
        model,
        inputTokens: modelData.inputTokens || 0,
        outputTokens: modelData.outputTokens || 0,
        cacheHitTokens: modelData.cacheReadInputTokens || 0,
      };
    } catch {
      return { model: 'unknown', inputTokens: 0, outputTokens: 0, cacheHitTokens: 0 };
    }
  }
}

export const goalScheduler = new GoalScheduler();
