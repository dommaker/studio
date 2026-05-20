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
import { logger } from '@dommaker/studio-shared';
import { agentExecutor } from '@dommaker/studio-agent';
import { goalService, GoalStep, parseJsonField } from './goal.service.js';
import { beforeAgentDispatch } from '@dommaker/studio-shared/harness/hooks';
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
  private runtimeConstraints = new Map<string, string[]>(); // 🆕 BP-018: goalId → runtime constraints
  // INF-004: failure rate tracking for strategy switching
  private recentFailures: number = 0;
  private recentTotal: number = 0;
  // G5: 路由决策记录（含 outcome 用于进化反馈）
  private recentClassifications: Array<{
    time: string; executionId: string; taskType: string;
    acCount: number; fileCount: number; classified: string; final: string;
    outcome?: 'success' | 'failure'; durationMs?: number;
  }> = [];

  private runtimeConstraintSub: typeof eventStore | null = null;

  start(): void {
    if (this.interval) return;

    // Step 6: 服务重启恢复
    this.recoverStaleExecutions().catch(e => {
      logger.error('[GoalScheduler] Recovery failed', { error: String(e) });
    });

    // 🆕 BP-018: 订阅运行时约束
    this.startRuntimeConstraintSub();

    this.interval = setInterval(() => this.tick(), POLL_INTERVAL);
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

      // 并行 dispatch（用 Promise.allSettled 替代串行 await）
      const toDispatch = executableSteps.slice(0, availableSlots);
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

    if (freeMemPct < 0.15) return 1;
    if (freeMemPct < 0.30) return 2;
    if (load > 0.90) return 2;
    return MAX_CONCURRENT;
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
  analyzeRoutingFeedback(): Array<{ type: string; message: string; evidence: string }> {
    const suggestions: Array<{ type: string; message: string; evidence: string }> = [];
    const completed = this.recentClassifications.filter(c => c.outcome);
    if (completed.length < 10) return suggestions; // 需要足够样本

    // 按 classified tier 分组统计成功率
    const byTier = new Map<string, { total: number; success: number }>();
    for (const c of completed) {
      const key = c.classified;
      if (!byTier.has(key)) byTier.set(key, { total: 0, success: 0 });
      const entry = byTier.get(key)!;
      entry.total++;
      if (c.outcome === 'success') entry.success++;
    }

    // 发现误分类：standard 失败率 > 50% → 应该用 premium
    const standard = byTier.get('standard');
    if (standard && standard.total >= 3) {
      const failRate = 1 - standard.success / standard.total;
      if (failRate > 0.5) {
        suggestions.push({
          type: 'routing.standard_misclassified',
          message: `standard tier failure rate ${Math.round(failRate * 100)}% (${standard.total} tasks)`,
          evidence: completed.filter(c => c.classified === 'standard' && c.outcome === 'failure')
            .map(c => `${c.taskType} (AC=${c.acCount}, files=${c.fileCount})`).join(', '),
        });
      }
    }

    // 发现误分类：fast 失败 → 至少应该是 standard
    const fast = byTier.get('fast');
    if (fast && fast.total >= 2 && fast.success === 0) {
      suggestions.push({
        type: 'routing.fast_misclassified',
        message: `fast tier 0% success (${fast.total} tasks) — should use standard or premium`,
        evidence: completed.filter(c => c.classified === 'fast' && c.outcome === 'failure')
          .map(c => c.taskType).join(', '),
      });
    }

    return suggestions;
  }

  // G5: 动态模型路由 — 根据任务特征自动选择 tier
  private classifyTaskComplexity(input: Record<string, any> | null, prompt: string): string {
    const acs = input?.acGroup?.acs ? JSON.stringify(input.acGroup.acs) : '';
    const taskDesc = (input?.taskDescription as string) || prompt || '';
    const combined = `${taskDesc} ${acs}`.toLowerCase();

    // Layer 1: 关键词（domain risk）
    const isHighRiskDomain = /schema|migration|migrate|auth|authentication|security|financial|payment|encrypt|crypto/.test(combined);
    const isLowRiskDomain = /style|typo|rename|format|lint|comment|doc|readme|spelling|refactor.*simple/.test(combined);

    // Layer 2: AC 组数量（task breadth）
    const acCount = input?.acGroup?.acs?.length || 1;

    // Layer 3: 文件范围（impact scope）
    const files: string[] = input?.acGroup?.files || [];
    const fileCount = files.length;

    // 高复杂度 = 高风险域 OR (多 AC 组 + 多文件)
    if (isHighRiskDomain || acCount >= 4 || fileCount >= 5) {
      return 'premium';
    }
    // 低复杂度 = 低风险域 AND (单 AC + 少文件)
    if (isLowRiskDomain && acCount <= 1 && fileCount <= 2) {
      return 'fast';
    }
    // 默认
    return 'standard';
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
    const { id: executionId, stepIndex } = execWithStep;
    const input = parseJsonField<Record<string, any> | null>(execWithStep.input, null);

    // Phase 3: dispatch 前 harness 检查（Goal 阶段 hook）
    try {
      await beforeAgentDispatch({
        operation: 'code_implementation',
        taskDescription: input?.taskType === 'integration' ? 'Integration step' : (input?.acGroup?.acs?.join('; ') || ''),
        projectPath: await this.getProjectRepoPath(goal),
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

    // G5: 动态模型路由 — 根据任务复杂度自动选择 tier
    const autoTier = this.classifyTaskComplexity(input, prompt);
    const tier = (input?.model as string) || autoTier;

    // G5: 记录路由决策（含 outcome 用于进化反馈）
    this.recentClassifications.push({
      time: new Date().toISOString(),
      executionId,
      taskType: input?.taskType || 'sub-agent',
      acCount: input?.acGroup?.acs?.length || 1,
      fileCount: (input?.acGroup?.files || []).length,
      classified: autoTier,
      final: tier,
    });
    if (this.recentClassifications.length > 50) this.recentClassifications.shift();
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
      hasCompanyKnowledge: !!companyKnowledge,
    });

    // G-001~003: 注入知识上下文（偏好 + 规则 + 环境）
    // 通过 parameters.knowledgeContext 传递，agent-executor 的 buildPrompt 在 session 1/2+ 都会注入
    let knowledgeContext = '';
    try {
      const { knowledgeQuery } = await import('../knowledge/knowledge-query.service.js');
      knowledgeContext = await knowledgeQuery.formatCompactForPrompt('executor');
    } catch { /* best-effort */ }

    // 直接调用 AgentExecutor
    try {
      const result = await agentExecutor.execute({
        id: executionId,
        executionId,
        agentType: 'claude',
        ...(input?.model ? { model: input.model as string } : {}),
        prompt,
        parameters: {
          goalExecutionId: executionId,
          goalId: goal.id,
          acGroup: input?.acGroup || undefined,
          hasWorktree: true,
          repoDir: await this.getProjectRepoPath(goal),
          knowledgeContext,
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
      }
      // G-001: 异步更新用户模型偏好
      preferenceObserver.updateFromRoutingFeedback(this.recentClassifications.map(c => ({
        taskId: c.executionId,
        tier: c.final as 'premium' | 'standard' | 'fast',
        result: c.outcome as 'success' | 'failure',
        duration: c.durationMs || 0,
        timestamp: Date.now(),
      }))).catch(() => { /* non-blocking */ });
      if (result.success) {
        // 直接标记成功（不依赖 Redis 事件链保证可靠性）
        await goalService.updateStepExecution(executionId, { status: 'succeeded' });
        // M1: agent 冷启动到完成的全链路耗时
        logger.info('[GoalScheduler] Agent succeeded', {
          executionId,
          sessionCount: result.sessionCount,
          dispatchDurationMs: dispatchDuration,
          tier,
          strategy,
        });
      } else {
        await goalService.updateStepExecution(executionId, {
          status: 'failed',
          error: result.error || 'Agent execution failed',
        });
        logger.warn('[GoalScheduler] Agent failed', {
          executionId,
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
      '## TDD 工作流',
      '1. 读 AC → 写失败测试 → 运行确认失败',
      '2. 最小实现让测试通过',
      '3. 重构优化',
      '4. 重复直到所有 AC 满足',
      '5. 运行 npm test + type check + lint',
      '6. 更新 .progress.json',
      '7. 全部完成后设置 allComplete: true',
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
      const output = e.output as Record<string, any> | null;
      return [
        `### AC 组 ${e.stepIndex + 1}`,
        `  - 执行 ID: ${e.id}`,
        `  - 摘要: ${output?.summary || '无'}`,
        `  - 改动文件: ${(output?.changedFiles || []).join(', ') || '未知'}`,
      ].join('\n');
    }).join('\n\n');

    return [
      '## 集成验证任务',
      '',
      '你的工作是验证以下并行完成的 sub-agent 的代码能否正确集成。',
      '',
      '## 各 AC 组完成情况',
      groupList,
      '',
      '## 验证流程',
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
}

export const goalScheduler = new GoalScheduler();
