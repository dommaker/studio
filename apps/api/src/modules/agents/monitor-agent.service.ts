/**
 * Monitor Agent - 健康监控 + NA Step 7 渐进告警
 *
 * 每 5 分钟轮询：
 *   - 失败趋势
 *   - 进度停滞（.progress.json completedSteps 无变化）
 *   - 会话计数超阈值
 *   - 总执行时间超阈值
 *   - 心跳丢失
 *   - blocked 24h 自动放弃
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { prisma } from '@dommaker/studio-prisma';
import { logger, modelGateway } from '@dommaker/studio-shared';
import { knowledgeBus } from '../knowledge/knowledge-bus.service.js';
import type { MonitorAlert, TriageIncidentInput } from './types.js';
import { triageAgent } from './triage-agent.service.js';
import { KnowledgeLinter, KnowledgeHealthScorer, ReferenceTracker } from '@dommaker/harness';
import { sharedStore, sharedLifecycle } from '../knowledge/knowledge-bus.service.js';
import { knowledgeSync } from '../knowledge/knowledge-sync.service.js';
import { preferenceObserver } from '../knowledge/preference-observer.js';

const CHECK_INTERVAL = 5 * 60_000; // 5 min
const FAILURE_THRESHOLD = 3;
const WORKTREES_DIR = process.env.WORKTREES_DIR || path.join(os.homedir(), 'worktrees');
const HEARTBEAT_FILE = path.join(os.homedir(), '.studio', 'heartbeats.json');

// NA Step 7: 告警阈值
const PROGRESS_STAGNATION_WARN = 3;  // 连续 3 次无进展 → Level 1
const PROGRESS_STAGNATION_CRIT = 6;  // 连续 6 次无进展 → Level 2
const SESSION_WARN = 3;              // session ≥ 3 → Level 1
const SESSION_ESCALATE = 5;          // session ≥ 5 → Level 3
const TIME_WARN_MS = 60 * 60 * 1000;       // 1h → Level 1
const TIME_ESCALATE_MS = 2 * 60 * 60 * 1000; // 2h → Level 2
const TIME_CRITICAL_MS = 2.5 * 60 * 60 * 1000; // 2.5h → Level 3
const HEARTBEAT_LOST_MS = 15 * 60 * 1000;  // 15min 无心跳 → Level 2
const BLOCKED_AUTO_ABANDON_MS = 24 * 60 * 60 * 1000; // 24h

// 上次检查时的进度快照（用于停滞检测）
const progressSnapshots = new Map<string, { completedCount: number; unchangedCount: number; lastHeartbeat: number }>();

// 系统健康确认窗口计数器（3 checks × 60s window）
const systemHealthCounters = new Map<string, { count: number; firstSeen: number }>();
const SYSTEM_HEALTH_CONFIRM_COUNT = 3;
const SYSTEM_HEALTH_CONFIRM_WINDOW_MS = 60 * 1000; // 60s between checks (Monitor polls every 5 min, so this is per-check, not per-second)

export class MonitorAgent {
  private interval: NodeJS.Timeout | null = null;
  private circuitCheckInterval: NodeJS.Timeout | null = null;
  private lastDecayRun = 0;
  private lastUserModelRun = 0;
  private lastDailyReflection = '';

  start(): void {
    if (this.interval) return;
    this.loadPersistedHeartbeats();
    this.interval = setInterval(() => this.check().catch(e => {
      logger.error('[MonitorAgent] Check failed', { error: String(e) });
    }), CHECK_INTERVAL);

    // Circuit self-check at startup — detect + auto-repair + write meta-knowledge
    this.runCircuitCheckAndRepair();

    // Periodic circuit check (hourly)
    this.circuitCheckInterval = setInterval(() => this.runCircuitCheckAndRepair(), 60 * 60 * 1000);

    logger.info('[MonitorAgent] Started', { checkInterval: CHECK_INTERVAL });
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.circuitCheckInterval) {
      clearInterval(this.circuitCheckInterval);
      this.circuitCheckInterval = null;
    }
    logger.info('[MonitorAgent] Stopped');
  }

  private async check(): Promise<void> {
    const alerts: MonitorAlert[] = [];

    alerts.push(...await this.checkFailureTrend());
    alerts.push(...await this.checkStuckGoals());
    alerts.push(...await this.checkProgressStagnation());
    alerts.push(...await this.checkSessionEscalation());
    await this.autoAbandonStaleRunning(); // 先清理僵尸，再检查执行时间告警
    alerts.push(...await this.checkTotalExecutionTime());
    alerts.push(...await this.checkHeartbeatLoss());
    alerts.push(...await this.checkPipelineLatency());
    alerts.push(...await this.checkToolPatterns());
    await this.evaluateTrajectory();  // G4
    await this.analyzeRoutingEvolution();  // G5 evolution
    await this.autoAbandonStaleBlocked();
    await this.systemTriageCheck();
    await this.gcStaleWorktrees();
    await this.checkKnowledgeHealth();
    alerts.push(...await this.checkSessionFileHealth());
    alerts.push(...await this.checkReviewQuality());
    alerts.push(...await this.checkTokenBudget());
    alerts.push(...await this.checkDeployPushFailed());
    alerts.push(...await this.checkProxyRestartExhausted());
    // DailyReflection: 每天 23:50 聚合一次每日洞察
    await this.dailyReflection();

    // G31: Data lifecycle TTL — 每天 23:55 清理过期数据
    await this.dataLifecycle();

    // ── 自动优化执行 ──
    await this.applyRoutingOptimizations();
    await this.applyTokenBudgetGate();

    // Log all alerts
    for (const alert of alerts) {
      if (alert.level === 'critical') {
        logger.error('[MonitorAgent] CRITICAL', alert);
      } else if (alert.level === 'warning') {
        logger.warn('[MonitorAgent] WARNING', alert);
      } else {
        logger.info('[MonitorAgent] INFO', alert);
      }
      // Emit to studio events file for Discord notification
      if (alert.level === 'critical' || alert.level === 'warning') {
        try {
          this.emitEvent({ type: 'monitor:alert', ...alert, timestamp: Date.now() });
        } catch { /* non-blocking */ }
      }
    }

    // B11-010: LLM 根因分析 — 多告警关联时调 LLM 诊断
    const significantAlerts = alerts.filter(a => a.level === 'critical' || a.level === 'warning');
    if (significantAlerts.length >= 2) {
      try {
        const { modelGateway } = await import('@dommaker/studio-shared');
        const alertSummary = significantAlerts.map(a => `[${a.level}] ${a.source}: ${a.message}`).join('\n');
        const rootCause = await modelGateway.prompt(
          `以下是监控系统同时检测到的 ${significantAlerts.length} 条告警：\n${alertSummary}\n\n分析这些告警的关联性，指出可能的根因（1-3 句话）。`,
          '你是 SRE 根因分析专家。简短回答，指出最可能的共同根因。',
        );
        if (rootCause) {
          logger.warn('[MonitorAgent] LLM root cause analysis', { rootCause: rootCause.slice(0, 300) });
          // Record root cause as a pattern for future reference
          knowledgeBus.recordPattern({
            source: 'monitor',
            type: 'pattern',
            title: `[Monitor RCA] ${significantAlerts.length} alerts correlated`,
            content: `告警: ${alertSummary}\n根因分析: ${rootCause}`,
            severity: 'warning',
            timestamp: Date.now(),
          }).catch(() => { /* non-blocking */ });
        }
      } catch { /* LLM unavailable — non-blocking */ }
    }

    // Phase 1 (FL-037): Escalate critical execution-level alerts to Triage
    this.escalateToTriage(alerts);

    // H3: Write patterns to KnowledgeBus (Monitor→Auditor/KK→Analyst)
    for (const alert of alerts) {
      if (alert.level === 'critical' || alert.level === 'warning') {
        knowledgeBus.recordPattern({
          source: 'monitor',
          type: alert.source.includes('tool') ? 'failure' : 'pattern',
          title: `[Monitor] ${alert.source}: ${alert.message.slice(0, 80)}`,
          content: alert.message,
          severity: alert.level === 'critical' ? 'critical' : 'warning',
          timestamp: Date.now(),
        }).catch(() => { /* non-blocking */ });
      }
    }
  }

  /**
   * FL-037: Map MonitorAlert.source → TriageIncidentInput.type
   * Only critical alerts are escalated. Fire-and-forget, does not block check loop.
   */
  private escalateToTriage(alerts: MonitorAlert[]): void {
    const sourceToType: Record<MonitorAlert['source'], import('./types.js').TriageIncidentType | null> = {
      failure_trend: 'execution_repeated_failure',
      session_escalation: 'execution_session_exhausted',
      total_time: 'execution_timeout',
      heartbeat_loss: 'execution_heartbeat_lost',
      stuck_goals: 'execution_stuck',
      progress_stagnation: 'execution_progress_stagnation',
      tool_error_rate: null,
      tool_zero_success: null,
      session_file_size: null,
      review_quality: null,
      deploy_push_failed: 'ext_dependency',
      proxy_restart_exhausted: 'ext_dependency',
    };

    for (const alert of alerts) {
      if (alert.level !== 'critical') continue;

      const incidentType = sourceToType[alert.source];
      if (!incidentType) continue;

      triageAgent.handleAlert({
        type: incidentType,
        severity: 'critical',
        message: alert.message,
        details: {
          projectId: alert.projectId,
          relatedTaskIds: alert.relatedTaskIds,
          monitorSource: alert.source,
        },
      }).catch(err => {
        logger.error('[MonitorAgent] Triage escalation failed', {
          source: alert.source,
          incidentType,
          error: String(err),
        });
      });
    }
  }

  // ── 已有 ──

  private async checkFailureTrend(): Promise<MonitorAlert[]> {
    const alerts: MonitorAlert[] = [];
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    const recentTasks = await prisma.task.findMany({
      where: { startedAt: { gte: oneHourAgo }, status: { in: ['completed', 'failed'] } },
      select: { id: true, status: true, projectId: true, name: true },
      orderBy: { startedAt: 'desc' },
      take: 20,
    });

    if (recentTasks.length < FAILURE_THRESHOLD) return alerts;

    const failedTasks = recentTasks.filter(t => t.status === 'failed');
    if (failedTasks.length >= FAILURE_THRESHOLD) {
      alerts.push({
        source: 'failure_trend',
        level: 'warning',
        message: `最近 1 小时内有 ${failedTasks.length} 个任务失败`,
        projectId: failedTasks[0].projectId,
        relatedTaskIds: failedTasks.map(t => t.id),
      });
    }

    const failureRate = failedTasks.length / recentTasks.length;
    if (failureRate > 0.5 && recentTasks.length >= 5) {
      alerts.push({
        source: 'failure_trend',
        level: 'critical',
        message: `任务失败率 ${(failureRate * 100).toFixed(0)}%，需要关注`,
      });
    }

    return alerts;
  }

  private async checkStuckGoals(): Promise<MonitorAlert[]> {
    const alerts: MonitorAlert[] = [];
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);

    const stuckExecutions = await prisma.goalExecution.findMany({
      where: { status: 'running', startedAt: { lt: thirtyMinAgo } },
      select: { id: true, goalId: true, startedAt: true },
      take: 5,
    });

    for (const exec of stuckExecutions) {
      const minutesStuck = Math.round((Date.now() - new Date(exec.startedAt).getTime()) / 60_000);
      alerts.push({
        source: 'stuck_goals',
        level: 'warning',
        message: `GoalExecution ${exec.id} 已卡住 ${minutesStuck} 分钟`,
        relatedTaskIds: [exec.id],
      });
    }

    return alerts;
  }

  // ── NA Step 7: 进度停滞检测 ──

  private async checkProgressStagnation(): Promise<MonitorAlert[]> {
    const alerts: MonitorAlert[] = [];
    const running = await prisma.goalExecution.findMany({
      where: { status: 'running' },
      select: { id: true, goalId: true },
      take: 10,
    });

    for (const exec of running) {
      const worktree = path.join(WORKTREES_DIR, exec.id);
      const progressPath = path.join(worktree, '.progress.json');

      let completedCount = 0;
      try {
        if (fs.existsSync(progressPath)) {
          const progress = JSON.parse(fs.readFileSync(progressPath, 'utf-8'));
          completedCount = (progress.completedSteps || []).length;
        }
      } catch { continue; }

      const prev = progressSnapshots.get(exec.id);
      if (prev) {
        if (completedCount === prev.completedCount) {
          prev.unchangedCount++;

          if (prev.unchangedCount >= PROGRESS_STAGNATION_CRIT) {
            alerts.push({
              source: 'progress_stagnation',
              level: 'critical',
              message: `Execution ${exec.id} 进度停滞 ${prev.unchangedCount * 5} 分钟（Level 2）`,
              relatedTaskIds: [exec.id],
            });
          } else if (prev.unchangedCount >= PROGRESS_STAGNATION_WARN) {
            alerts.push({
              source: 'progress_stagnation',
              level: 'info',
              message: `Execution ${exec.id} 进度停滞 ${prev.unchangedCount * 5} 分钟（Level 1）`,
              relatedTaskIds: [exec.id],
            });
          }
        } else {
          prev.completedCount = completedCount;
          prev.unchangedCount = 0;
        }
      } else {
        progressSnapshots.set(exec.id, { completedCount, unchangedCount: 0, lastHeartbeat: Date.now() });
      }
    }

    // Cleanup stale snapshots: remove entries for executions no longer running
    const runningIds = new Set(running.map(e => e.id));
    for (const key of progressSnapshots.keys()) {
      if (!runningIds.has(key)) progressSnapshots.delete(key);
    }

    return alerts;
  }

  // ── NA Step 7: 会话计数告警 ──

  private async checkSessionEscalation(): Promise<MonitorAlert[]> {
    const alerts: MonitorAlert[] = [];
    const running = await prisma.goalExecution.findMany({
      where: { status: { in: ['running', 'pending'] } },
      select: { id: true },
      take: 10,
    });

    for (const exec of running) {
      const worktree = path.join(WORKTREES_DIR, exec.id);
      const progressPath = path.join(worktree, '.progress.json');

      try {
        if (!fs.existsSync(progressPath)) continue;
        const progress = JSON.parse(fs.readFileSync(progressPath, 'utf-8'));
        const sessionCount = progress.sessionCount || 1;

        if (sessionCount >= SESSION_ESCALATE) {
          alerts.push({
            source: 'session_escalation',
            level: 'critical',
            message: `Execution ${exec.id} 会话耗尽（${sessionCount} 次）— 需要人工介入`,
            relatedTaskIds: [exec.id],
          });
        } else if (sessionCount >= SESSION_WARN) {
          alerts.push({
            source: 'session_escalation',
            level: 'warning',
            message: `Execution ${exec.id} 已重试 ${sessionCount} 次（Level 1）`,
            relatedTaskIds: [exec.id],
          });
        }
      } catch { continue; }
    }

    return alerts;
  }

  // ── NA Step 7: 总执行时间告警 ──

  private async checkTotalExecutionTime(): Promise<MonitorAlert[]> {
    const alerts: MonitorAlert[] = [];
    const running = await prisma.goalExecution.findMany({
      where: { status: { in: ['running', 'pending'] } },
      select: { id: true, startedAt: true, createdAt: true },
      take: 10,
    });

    for (const exec of running) {
      const startTime = new Date(exec.startedAt || exec.createdAt).getTime();
      const elapsed = Date.now() - startTime;

      if (elapsed > TIME_CRITICAL_MS) {
        alerts.push({
          source: 'total_time',
          level: 'critical',
          message: `Execution ${exec.id} 执行超过 2.5h — 需要人工介入（Level 3）`,
          relatedTaskIds: [exec.id],
        });
      } else if (elapsed > TIME_ESCALATE_MS) {
        alerts.push({
          source: 'total_time',
          level: 'warning',
          message: `Execution ${exec.id} 执行超过 2h（Level 2）`,
          relatedTaskIds: [exec.id],
        });
      } else if (elapsed > TIME_WARN_MS) {
        alerts.push({
          source: 'total_time',
          level: 'info',
          message: `Execution ${exec.id} 执行超过 1h（Level 1）`,
          relatedTaskIds: [exec.id],
        });
      }
    }

    return alerts;
  }

  // ── NA Step 7: 心跳丢失检测 ──

  private async checkHeartbeatLoss(): Promise<MonitorAlert[]> {
    const alerts: MonitorAlert[] = [];
    const running = await prisma.goalExecution.findMany({
      where: { status: 'running' },
      select: { id: true, startedAt: true },
      take: 10,
    });

    for (const exec of running) {
      const snapshot = progressSnapshots.get(exec.id);
      if (!snapshot) continue;

      const sinceLastHeartbeat = Date.now() - snapshot.lastHeartbeat;

      if (sinceLastHeartbeat > HEARTBEAT_LOST_MS * 2) {
        alerts.push({
          source: 'heartbeat_loss',
          level: 'critical',
          message: `Execution ${exec.id} 心跳丢失超过 30 分钟 — 强制重开`,
          relatedTaskIds: [exec.id],
        });
        // 主动 kill tmux + 触发 re-spawn
        try {
          const { execSync } = await import('child_process');
          const tmuxSession = exec.id.replace(/-/g, '');
          execSync(`tmux kill-session -t ${tmuxSession} 2>/dev/null || true`);
        } catch { /* ignore */ }
      } else if (sinceLastHeartbeat > HEARTBEAT_LOST_MS) {
        alerts.push({
          source: 'heartbeat_loss',
          level: 'warning',
          message: `Execution ${exec.id} 心跳丢失超过 15 分钟（Level 2）`,
          relatedTaskIds: [exec.id],
        });
      }
    }

    return alerts;
  }

  // ── NA Step 7: 24h 自动放弃 ──

  private async autoAbandonStaleBlocked(): Promise<void> {
    const cutoff = new Date(Date.now() - BLOCKED_AUTO_ABANDON_MS);

    const stale = await prisma.goalExecution.findMany({
      where: { status: 'blocked', startedAt: { lt: cutoff } },
      select: { id: true },
      take: 20,
    });

    for (const exec of stale) {
      logger.warn('[MonitorAgent] Auto-abandoning stale blocked execution', { executionId: exec.id });
      try {
        await prisma.goalExecution.update({
          where: { id: exec.id },
          data: { status: 'failed', error: `Auto-abandoned after 24h blocked` },
        });
      } catch (e) {
        logger.error('[MonitorAgent] Failed to auto-abandon', { executionId: exec.id, error: String(e) });
      }
    }

    if (stale.length > 0) {
      logger.info('[MonitorAgent] Auto-abandoned', { count: stale.length });
    }
  }

  // ── Zombie running 自动放弃（2.5h 无活跃 agent session）──

  private async autoAbandonStaleRunning(): Promise<void> {
    const cutoff = new Date(Date.now() - TIME_CRITICAL_MS);

    const stale = await prisma.goalExecution.findMany({
      where: { status: 'running', startedAt: { lt: cutoff } },
      select: { id: true },
      take: 20,
    });

    if (stale.length === 0) return;

    // Check if daemon has an active session for any of these executions
    const activeSessionIds = new Set<string>();
    try {
      const { daemon } = await import('../../daemon/studio-daemon.js');
      const statuses = daemon.getStatus() as Array<{ name: string; sessionId?: string; isBusy: boolean; pid?: number } | null>;
      for (const s of (statuses || [])) {
        if (s?.isBusy && s?.sessionId) activeSessionIds.add(s.sessionId);
      }
    } catch {}

    const abandoned: string[] = [];
    for (const exec of stale) {
      // Don't auto-abandon if daemon still has an active session for this execution
      if (activeSessionIds.has(exec.id)) continue;

      try {
        await prisma.goalExecution.update({
          where: { id: exec.id },
          data: { status: 'failed', error: `Auto-abandoned after 2.5h running — no active agent session` },
        });
        abandoned.push(exec.id);
      } catch (e) {
        logger.error('[MonitorAgent] Failed to auto-abandon stale running', { executionId: exec.id, error: String(e) });
      }
    }

    if (abandoned.length > 0) {
      logger.info('[MonitorAgent] Auto-abandoned stale running', { count: abandoned.length, ids: abandoned.map(id => id.slice(0, 8)) });
    }
  }

  /**
   * GC: clean up stale git worktrees and orphaned task directories.
   * Non-blocking — runs as part of the 5-min check loop.
   */
  private async gcStaleWorktrees(): Promise<void> {
    try {
      // Prune git worktree references that point to deleted directories
      const repoDir = process.env.REPO_DIR || path.join(os.homedir(), 'projects');
      if (fs.existsSync(path.join(repoDir, '.git'))) {
        const { execSync } = await import('child_process');
        execSync('git worktree prune', { cwd: repoDir, timeout: 5000, stdio: 'pipe' });
      }

      // Clean worktree dirs that are older than 24h
      if (fs.existsSync(WORKTREES_DIR)) {
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        const entries = fs.readdirSync(WORKTREES_DIR);
        for (const entry of entries) {
          const wtPath = path.join(WORKTREES_DIR, entry);
          try {
            const stat = fs.statSync(wtPath);
            if (stat.isDirectory() && stat.mtimeMs < cutoff) {
              fs.rmSync(wtPath, { recursive: true, force: true });
              logger.info('[MonitorAgent] GC removed stale worktree', { path: wtPath, age: Math.round((Date.now() - stat.mtimeMs) / 3600000) + 'h' });
            }
          } catch { /* skip */ }
        }
      }
    } catch (e) {
      // Non-blocking — GC failure must not crash the monitor loop, but MUST be logged
      logger.warn('[MonitorAgent] gcStaleWorktrees failed', { error: String(e) });
    }
  }

  /**
   * Check shared session file size and age (optional, env-configurable).
   * Warns at >50MB or >3 days old. Runs every 5 min as part of the GC cycle.
   * Set SESSION_FILE_PATH to enable; skipped if not configured.
   */
  private async checkSessionFileHealth(): Promise<MonitorAlert[]> {
    const alerts: MonitorAlert[] = [];
    try {
      const sessionFile = process.env.SESSION_FILE_PATH;
      if (!sessionFile || !fs.existsSync(sessionFile)) return alerts;

      const stat = fs.statSync(sessionFile);
      const sizeMB = Math.round(stat.size / (1024 * 1024));
      const ageDays = Math.round((Date.now() - stat.mtimeMs) / (24 * 60 * 60 * 1000));

      if (sizeMB > 50) {
        alerts.push({
          level: 'warning',
          source: 'session_file_size',
          message: `Session file is ${sizeMB}MB (>50MB threshold). Consider resetting with a fresh session.`,
          timestamp: Date.now(),
        });
      }

      if (ageDays > 3) {
        alerts.push({
          level: 'warning',
          source: 'session_file_size',
          message: `Session file is ${ageDays}d old (>3d threshold). Consider resetting with a fresh session.`,
          timestamp: Date.now(),
        });
      }
    } catch { /* non-blocking */ }
    return alerts;
  }

  /**
   * I3: Review quality alert — 审查低分但通过的目标
   *
   * score < 75 but goal succeeded → 质量门可能漏过了有问题的代码
   */
  private async checkReviewQuality(): Promise<MonitorAlert[]> {
    const REVIEW_QUALITY_THRESHOLD = 75;
    const alerts: MonitorAlert[] = [];
    try {
      const recentGoals = await prisma.goal.findMany({
        where: {
          status: 'succeeded',
          updatedAt: { gte: new Date(Date.now() - 7 * 24 * 3600_000) },
        },
        select: { id: true, title: true, context: true },
        orderBy: { updatedAt: 'desc' },
        take: 20,
      });

      for (const goal of recentGoals) {
        const ctx = (typeof goal.context === 'string' ? JSON.parse(goal.context) : goal.context) || {};
        const reviewScore = ctx.reviewScore as number | undefined;
        const reviewCycle = (ctx.reviewCycle as number) || 1;

        if (reviewScore !== undefined && reviewScore < REVIEW_QUALITY_THRESHOLD) {
          alerts.push({
            projectId: goal.id.slice(0, 8),
            message: `Goal ${goal.id.slice(0, 8)} review score ${reviewScore} < ${REVIEW_QUALITY_THRESHOLD} but approved. ${reviewCycle > 1 ? `(after ${reviewCycle} cycles)` : '(first cycle)'}. Review may be letting sub-par code through.`,
            source: 'review_quality',
            level: reviewScore < 50 ? 'critical' : 'warning',
            relatedTaskIds: [goal.id],
            timestamp: Date.now(),
          });
        }
      }
    } catch (e) {
      logger.warn('[MonitorAgent] Review quality check failed', { error: String(e) });
    }
    return alerts;
  }

  /**
   * P2-1: Token budget check — goal 累计 token 超阈值告警
   */
  private async checkTokenBudget(): Promise<MonitorAlert[]> {
    const TOKEN_BUDGET_WARN = 500_000;
    const TOKEN_BUDGET_CRIT = 1_000_000;
    const alerts: MonitorAlert[] = [];
    try {
      const goals = await prisma.goal.findMany({
        where: {
          status: { in: ['executing', 'succeeded', 'blocked'] },
          updatedAt: { gte: new Date(Date.now() - 7 * 24 * 3600_000) },
        },
        select: { id: true, title: true, context: true },
        take: 10,
      });

      for (const goal of goals) {
        const ctx = (typeof goal.context === 'string' ? JSON.parse(goal.context) : goal.context) || {};
        const tokens = (ctx._cumulativeTokens as number) || 0;
        if (tokens >= TOKEN_BUDGET_CRIT) {
          alerts.push({
            projectId: goal.id.slice(0, 8),
            message: `Goal ${goal.id.slice(0, 8)} exceeded critical token budget: ${(tokens / 1000).toFixed(0)}K tokens`,
            source: 'total_time',
            level: 'critical',
            relatedTaskIds: [goal.id],
            timestamp: Date.now(),
          });
        } else if (tokens >= TOKEN_BUDGET_WARN) {
          alerts.push({
            projectId: goal.id.slice(0, 8),
            message: `Goal ${goal.id.slice(0, 8)} approaching token budget: ${(tokens / 1000).toFixed(0)}K tokens`,
            source: 'total_time',
            level: 'warning',
            relatedTaskIds: [goal.id],
            timestamp: Date.now(),
          });
        }
      }
    } catch (e) {
      logger.warn('[MonitorAgent] Token budget check failed', { error: String(e) });
    }
    return alerts;
  }

  /**
   * Check recent deploy_push_failed events from DeployAgent.
   * Push failures are critical — code is merged locally but not pushed to remote.
   */
  private async checkDeployPushFailed(): Promise<MonitorAlert[]> {
    const alerts: MonitorAlert[] = [];
    try {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      const events = await prisma.studioEvent.findMany({
        where: { type: 'deploy_push_failed', timestamp: { gte: oneHourAgo } },
        select: { id: true, payload: true, timestamp: true },
        orderBy: { timestamp: 'desc' },
        take: 5,
      });
      for (const event of events) {
        let details: any = {};
        try { details = JSON.parse(event.payload || '{}'); } catch {}
        alerts.push({
          source: 'deploy_push_failed',
          level: 'critical',
          message: `Deploy push failed: ${details.error || 'unknown error'} (branch: ${details.branch || '?'})`,
          timestamp: new Date(event.timestamp).getTime(),
        });
      }
    } catch (e) {
      logger.warn('[MonitorAgent] Deploy push failed check error', { error: String(e) });
    }
    return alerts;
  }

  /**
   * Check recent proxy_restart_exhausted events from OpsAgent.
   * Proxy restart limit reached — external connectivity at risk.
   */
  private async checkProxyRestartExhausted(): Promise<MonitorAlert[]> {
    const alerts: MonitorAlert[] = [];
    try {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      const events = await prisma.studioEvent.findMany({
        where: { type: 'proxy_restart_exhausted', timestamp: { gte: oneHourAgo } },
        select: { id: true, payload: true, timestamp: true },
        orderBy: { timestamp: 'desc' },
        take: 3,
      });
      for (const event of events) {
        let details: any = {};
        try { details = JSON.parse(event.payload || '{}'); } catch {}
        alerts.push({
          source: 'proxy_restart_exhausted',
          level: 'critical',
          message: `Proxy restart limit exhausted (${details.restartsThisHour || '?'} restarts/h, ${details.synSentCount || '?'} SYN-SENT)`,
          timestamp: new Date(event.timestamp).getTime(),
        });
      }
    } catch (e) {
      logger.warn('[MonitorAgent] Proxy restart exhausted check error', { error: String(e) });
    }
    return alerts;
  }

  /**
   * 🆕 记录心跳（由 agent.heartbeat 事件调用）+ 文件持久化
   */
  recordHeartbeat(executionId: string): void {
    const snapshot = progressSnapshots.get(executionId);
    if (snapshot) {
      snapshot.lastHeartbeat = Date.now();
    }
    // Persist to file for restart recovery
    try {
      const dir = path.dirname(HEARTBEAT_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const data: Record<string, number> = {};
      if (fs.existsSync(HEARTBEAT_FILE)) {
        Object.assign(data, JSON.parse(fs.readFileSync(HEARTBEAT_FILE, 'utf-8')));
      }
      data[executionId] = Date.now();
      fs.writeFileSync(HEARTBEAT_FILE, JSON.stringify(data), 'utf-8');
    } catch { /* non-blocking */ }
  }

  /** Restore heartbeat state from persisted file on startup */
  private loadPersistedHeartbeats(): void {
    try {
      if (!fs.existsSync(HEARTBEAT_FILE)) return;
      const data = JSON.parse(fs.readFileSync(HEARTBEAT_FILE, 'utf-8')) as Record<string, number>;
      const stale = Date.now() - 30 * 60 * 1000; // 30 min
      for (const [execId, ts] of Object.entries(data)) {
        if (ts > stale) {
          progressSnapshots.set(execId, {
            completedCount: 0, unchangedCount: 0, lastHeartbeat: ts,
          });
        }
      }
      logger.info('[MonitorAgent] Restored heartbeats', { count: progressSnapshots.size });
      // Clean up stale entries from file
      const fresh: Record<string, number> = {};
      for (const [execId, ts] of Object.entries(data)) {
        if (ts > stale) fresh[execId] = ts;
      }
      fs.writeFileSync(HEARTBEAT_FILE, JSON.stringify(fresh), 'utf-8');
    } catch (e) {
      logger.warn('[MonitorAgent] Failed to load persisted heartbeats', { error: String(e) });
    }
  }

  /**
   * P2a: Knowledge base health check + decay cycle
   * - Health score: every 5 min (Monitor cycle), escalates to Triage if < 60
   * - Decay cycle: once per 24h, runs maturity decay + linter auto-fix
   */

  /**
   * Circuit check → repair → write meta-knowledge to store.
   * Runs at MonitorAgent startup + hourly. Makes knowledge system self-documenting.
   */
  private async runCircuitCheckAndRepair(): Promise<void> {
    try {
      // KnowledgeSync: detect staleness + unmonitored + heal
      const syncResult = await knowledgeSync.runSyncCycle();
      if (syncResult.stale.length > 0 || syncResult.unmonitored.length > 0) {
        logger.warn('[MonitorAgent] KnowledgeSync detected issues', {
          staleScopes: syncResult.stale.map(s => ({ scope: s.scope, changedFiles: s.changedFiles, hours: s.stalenessHours })),
          unmonitored: syncResult.unmonitored.map(u => ({ scope: u.scope, reason: u.reason })),
          healed: syncResult.healed,
        });
      }
    } catch (e) {
      logger.warn('[MonitorAgent] KnowledgeSync check failed', { error: String(e) });
    }
  }

  private async checkKnowledgeHealth(): Promise<void> {
    try {
      const tracker = new ReferenceTracker(sharedStore);
      const linter = new KnowledgeLinter(sharedStore, tracker);
      const doctor = new KnowledgeHealthScorer(sharedStore, linter);

      const { score, details } = doctor.healthScore();

      logger.info('[MonitorAgent] Knowledge health score', { score, issueCount: details.length });

      if (score < 60) {
        // Escalate to Triage
        triageAgent.handleAlert({
          type: 'knowledge_health_degraded',
          severity: 'warning',
          message: `知识库健康评分: ${score}/100`,
          details: { score, issues: details },
        }).catch(err => {
          logger.warn('[MonitorAgent] Knowledge health triage failed', { error: String(err) });
        });

        // Also emit as alert
        this.emitEvent({
          type: 'monitor:alert',
          level: 'warning',
          source: 'knowledge_health',
          message: `Knowledge health score: ${score}/100`,
          details,
          timestamp: Date.now(),
        });
      }

      // P2.5: Promotion cycle (every 5 min) — scan all draft/verified entries for promotion
      const allEntries = sharedStore.list({ excludeArchived: false }).filter(e => e.maturity === 'draft' || e.maturity === 'verified');
      let promoted = 0;
      for (const entry of allEntries) {
        try {
          const result = sharedLifecycle.tryPromote(entry.id);
          if (result) {
            promoted++;
            logger.info('[MonitorAgent] Knowledge promoted', { entryId: entry.id, from: result.from, to: result.to, reason: result.reason });
          }
        } catch { /* individual entry failure is non-blocking */ }
      }
      if (promoted > 0) {
        logger.info('[MonitorAgent] Knowledge promotion cycle completed', { promoted, scanned: allEntries.length });
      }

      // Daily cycle: decay + lint + LLM maintenance
      if (Date.now() - this.lastDecayRun > 24 * 60 * 60_000) {
        const decayChanges = sharedLifecycle.runDecayCycle();
        const lintReport = linter.run(true);
        this.lastDecayRun = Date.now();

        // F1: KnowledgeAgent LLM-powered maintenance (semantic dedup, quality, freshness, contradictions)
        try {
          const { knowledgeAgent } = await import('./knowledge-agent.service.js');
          const maintenance = await knowledgeAgent.runDailyMaintenance();
          logger.info('[MonitorAgent] KnowledgeAgent daily maintenance', maintenance);
        } catch (err) {
          logger.warn('[MonitorAgent] KnowledgeAgent maintenance failed', { error: String(err) });
        }

        logger.info('[MonitorAgent] Knowledge decay cycle completed', {
          decayChanges: decayChanges.length,
          autoFixed: lintReport.fixed,
        });

        if (decayChanges.length > 0) {
          this.emitEvent({
            type: 'monitor:info',
            source: 'knowledge_decay',
            message: `Decay: ${decayChanges.length} entries, Auto-fixed: ${lintReport.fixed} issues`,
            timestamp: Date.now(),
          });
        }
      }

      // User model update: once per 24h (alongside decay cycle)
      if (Date.now() - this.lastUserModelRun > 24 * 60 * 60_000) {
        this.lastUserModelRun = Date.now();
        try {
          const { execSync } = await import('child_process');
          const result = execSync('npx harness update-user-model --days 1 --json 2>/dev/null || echo "{}"', {
            encoding: 'utf-8', stdio: 'pipe', timeout: 30_000,
          }).trim();
          if (result && result !== '{}') {
            const data = JSON.parse(result);
            logger.info('[MonitorAgent] User model updated', { newSessions: (data as any).newSessions, changes: (data as any).changes?.length });
          }
        } catch (e: any) {
          logger.warn('[MonitorAgent] User model update failed (non-blocking)', { error: String(e) });
        }
      }
    } catch (err) {
      logger.warn('[MonitorAgent] Knowledge health check failed', { error: String(err) });
    }
  }

  private emitEvent(data: Record<string, unknown>): void {
    try {
      const fs = require('fs');
      const path = require('path');
      const os = require('os');
      const dir = process.env.EVENTS_DIR || path.join(os.homedir(), 'events');
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(
        path.join(dir, 'studio.jsonl'),
        JSON.stringify(data) + '\n',
      );
    } catch { /* non-blocking */ }
  }

  // ── Pipeline Latency: per-stage timing + bottleneck detection ──

  private async checkPipelineLatency(): Promise<MonitorAlert[]> {
    const alerts: MonitorAlert[] = [];
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    try {
      // Query recently completed goals with their executions
      const recentGoals = await prisma.goal.findMany({
        where: { status: { in: ['succeeded', 'failed'] }, completedAt: { gte: oneHourAgo } },
        select: { id: true, status: true, createdAt: true, completedAt: true },
        orderBy: { completedAt: 'desc' },
        take: 5,
      });
      if (recentGoals.length === 0) return alerts;

      for (const goal of recentGoals) {
        const execs = await prisma.goalExecution.findMany({
          where: { goalId: goal.id, status: 'succeeded' },
          select: { id: true, stepIndex: true, startedAt: true, completedAt: true },
          orderBy: { completedAt: 'asc' },
        });

        const goalDuration = goal.completedAt
          ? (new Date(goal.completedAt).getTime() - new Date(goal.createdAt).getTime()) / 60000
          : 0;

        // Per-execution timing
        let maxExecMinutes = 0;
        let totalExecMinutes = 0;
        for (const e of execs) {
          if (e.startedAt && e.completedAt) {
            const dur = (new Date(e.completedAt).getTime() - new Date(e.startedAt).getTime()) / 60000;
            totalExecMinutes += dur;
            if (dur > maxExecMinutes) maxExecMinutes = dur;
          }
        }

        // Log pipeline timing
        logger.info('[MonitorAgent] Pipeline timing', {
          goalId: goal.id.slice(0, 8),
          totalMin: Math.round(goalDuration),
          execCount: execs.length,
          maxExecMin: Math.round(maxExecMinutes),
          avgExecMin: execs.length > 0 ? Math.round(totalExecMinutes / execs.length) : 0,
          status: goal.status,
        });

        // Alert on slow stages
        if (goalDuration > 30) {
          alerts.push({
            source: 'total_time',
            level: 'critical',
            message: `Goal ${goal.id.slice(0, 8)} took ${Math.round(goalDuration)}min — check pipeline bottleneck`,
            relatedTaskIds: [goal.id],
          });
        } else if (maxExecMinutes > 20) {
          alerts.push({
            source: 'total_time',
            level: 'warning',
            message: `Execution ${execs[0]?.id?.slice(0, 8) || '?'} took ${Math.round(maxExecMinutes)}min — slow executor`,
            relatedTaskIds: execs.map(e => e.id),
          });
        }
      }
    } catch (e) {
      logger.warn('[MonitorAgent] Pipeline latency check failed', { error: String(e) });
    }

    return alerts;
  }

  // ── P0.3: Tool Pattern Detection — 工具调用异常模式 ──

  private async checkToolPatterns(): Promise<MonitorAlert[]> {
    const alerts: MonitorAlert[] = [];
    try {
      const { toolRegistry } = await import('../mcp/tool-registry.js');
      const allStats = toolRegistry.getStats();

      for (const [toolName, stats] of Object.entries(allStats)) {
        const totalCalls = stats.totalCalls;
        if (totalCalls === 0) continue;

        const errorRate = stats.errorCalls / totalCalls;

        // 高频工具错误率 > 50% 且至少 5 次调用
        if (errorRate > 0.5 && totalCalls >= 5) {
          alerts.push({
            source: 'tool_error_rate',
            level: 'warning',
            message: `Tool "${toolName}" error rate ${Math.round(errorRate * 100)}% (${stats.errorCalls}/${totalCalls} calls)`,
            timestamp: Date.now(),
          });
        }

        // 工具零调用超过 5 次总调用（可能卡住或受限）
        if (stats.successCalls === 0 && totalCalls >= 10) {
          alerts.push({
            source: 'tool_zero_success',
            level: 'warning',
            message: `Tool "${toolName}" has zero successful calls in ${totalCalls} attempts`,
            timestamp: Date.now(),
          });
        }
      }
    } catch (e) {
      logger.warn('[MonitorAgent] Tool pattern check failed', { error: String(e) });
    }
    return alerts;
  }

  // ── G4: Trajectory Eval — 结构化轨迹评估 ──

  async evaluateTrajectory(): Promise<void> {
    try {
      const recent = await prisma.goalExecution.findMany({
        where: { status: { in: ['succeeded', 'failed'] }, completedAt: { gte: new Date(Date.now() - 24 * 3600_000) } },
        select: { id: true, goalId: true, status: true, startedAt: true, completedAt: true, error: true },
        orderBy: { completedAt: 'desc' },
        take: 10,
      });

      if (recent.length === 0) return; // No executions to evaluate

      let totalExecutions = 0;
      let efficientCount = 0;
      let normalCount = 0;
      let slowCount = 0;
      let retryCount = 0;
      let failureCount = 0;
      let timedCount = 0;   // 有 startedAt+completedAt 的执行数

      for (const exec of recent) {
        totalExecutions++;

        // Check progress stagnation via snapshot
        const snap = progressSnapshots.get(exec.id);
        if (snap && snap.unchangedCount >= 3) {
          retryCount++;
        }

        // Check execution time — three tiers, 5-15min gap filled
        if (exec.startedAt && exec.completedAt) {
          timedCount++;
          const durationMin = (new Date(exec.completedAt).getTime() - new Date(exec.startedAt).getTime()) / 60000;
          if (durationMin > 15) slowCount++;
          else if (durationMin > 5) normalCount++;
          else efficientCount++;
        }

        if (exec.status === 'failed') failureCount++;
      }

      // Efficiency: (efficient + normal) / timed (only executions with timing data)
      const efficiency = timedCount > 0 ? Math.round(((efficientCount + normalCount) / timedCount) * 100) : 0;
      const slowRate = timedCount > 0 ? Math.round((slowCount / timedCount) * 100) : 0;

      const report = {
        type: 'monitor:trajectory',
        timestamp: Date.now(),
        totalExecutions,
        efficiency: `${efficiency}%`,
        slowRate: `${slowRate}%`,
        retryCount,
        failureCount,
        verdict: efficiency >= 60 ? 'good' : efficiency >= 30 ? 'degraded' : 'poor',
      };

      logger.info('[MonitorAgent] Trajectory eval', report);

      // Emit for Discord notification
      this.emitEvent(report);

      if (slowRate > 30) {
        this.emitEvent({
          type: 'monitor:alert',
          level: 'warning',
          source: 'trajectory',
          message: `Pipeline efficiency ${efficiency}% (${slowRate}% slow executions, ${retryCount} retries)`,
          timestamp: Date.now(),
        });
      }
    } catch (e) {
      logger.warn('[MonitorAgent] Trajectory eval failed', { error: String(e) });
    }
  }

  // ── G5 Evolution: 路由决策反馈 ──

  private async analyzeRoutingEvolution(): Promise<void> {
    try {
      const { goalScheduler } = await import('../goals/goal-scheduler.js');
      const suggestions = (goalScheduler as any).analyzeRoutingFeedback?.() || [];
      for (const s of suggestions) {
        logger.warn('[MonitorAgent] Routing suggestion', s);
        this.emitEvent({ type: 'monitor:alert', level: 'warning', source: 'routing_evolution', ...s, timestamp: Date.now() });
      }
    } catch { /* non-blocking */ }
  }

  // ── B1-008: System health check for Triage ──

  async systemHealthCheck(): Promise<TriageIncidentInput[]> {
    const anomalies: TriageIncidentInput[] = [];

    try {
      const { execSync } = await import('child_process');

      // 1. Internal process health check (no curl - avoids port mismatch)
      try {
        const memUsage = process.memoryUsage();
        const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
        const uptime = process.uptime();
        if (heapUsedMB > 2000) {
          anomalies.push({
            type: 'resource_critical',
            severity: 'warning',
            message: `High memory usage: ${heapUsedMB}MB heap used`,
            details: { heapUsedMB },
          });
        }
        if (uptime < 60) {
          anomalies.push({
            type: 'service_down',
            severity: 'warning',
            message: `Process restarted recently (uptime ${Math.round(uptime)}s)`,
            details: { uptime },
          });
        }
      } catch {
        // Process health check itself failed - this is unexpected
        anomalies.push({
          type: 'service_down',
          severity: 'critical',
          message: 'Internal process health check failed',
        });
      }

      // 2. Disk usage
      try {
        const df = execSync('df -h / | tail -1', { timeout: 3000, encoding: 'utf-8' }).trim();
        const parts = df.split(/\s+/);
        const usePercent = parseInt(parts[4]); // Use% column
        if (usePercent > 90) {
          anomalies.push({
            type: 'resource_critical',
            severity: 'warning',
            message: `Disk usage ${usePercent}%`,
            details: { usagePercent: usePercent, dfOutput: df },
          });
        }
      } catch { /* ignore */ }

      // 3. Memory usage
      try {
        const free = execSync('free -m | grep Mem', { timeout: 3000, encoding: 'utf-8' }).trim();
        const parts = free.split(/\s+/);
        const total = parseInt(parts[1]);
        const used = parseInt(parts[2]);
        if (total > 0) {
          const memPercent = Math.round((used / total) * 100);
          if (memPercent > 95) {
            anomalies.push({
              type: 'resource_critical',
              severity: 'critical',
              message: `Memory usage ${memPercent}%`,
              details: { usagePercent: memPercent, freeOutput: free },
            });
          }
        }
      } catch { /* ignore */ }

      // 4. Zombie processes
      try {
        const zombies = execSync("ps aux | awk '$8 ~ /Z/ {print}' | wc -l", { timeout: 3000, encoding: 'utf-8' }).trim();
        const zCount = parseInt(zombies);
        if (zCount > 0) {
          anomalies.push({
            type: 'zombie',
            severity: 'warning',
            message: `${zCount} zombie processes detected`,
            details: { zombieCount: zCount },
          });
        }
      } catch { /* ignore */ }

      // 5. DB connection check
      try {
        await prisma.$queryRaw`SELECT 1`;
      } catch {
        anomalies.push({
          type: 'ext_dependency',
          severity: 'critical',
          message: 'Database connection failed',
        });
      }
    } catch (e) {
      logger.warn('[MonitorAgent] System health check error', { error: String(e) });
    }

    return anomalies;
  }

  private async systemTriageCheck(): Promise<void> {
    const anomalies = await this.systemHealthCheck();
    const now = Date.now();

    // Track which anomaly keys are still present
    const activeKeys = new Set<string>();

    for (const anomaly of anomalies) {
      const key = anomaly.type;
      activeKeys.add(key);

      const prev = systemHealthCounters.get(key);
      if (prev) {
        prev.count++;
        if (prev.count >= SYSTEM_HEALTH_CONFIRM_COUNT) {
          logger.error('[MonitorAgent] System anomaly confirmed, triggering Triage', {
            type: anomaly.type,
            confirmCount: prev.count,
          });
          systemHealthCounters.delete(key);

          // Fire-and-forget: triage runs async
          triageAgent.handleAlert(anomaly).catch(err => {
            logger.error('[MonitorAgent] Triage handleAlert failed', { error: String(err) });
          });
        }
      } else {
        systemHealthCounters.set(key, { count: 1, firstSeen: now });
      }
    }

    // Clear counters for anomalies that have resolved
    for (const [key, counter] of systemHealthCounters) {
      if (!activeKeys.has(key)) {
        systemHealthCounters.delete(key);
        logger.info('[MonitorAgent] System anomaly resolved', { type: key, wasSeen: counter.count });
      }
    }
  }

  // ── 自动优化执行 ──

  /**
   * 根据路由反馈自动调整 classifyTaskComplexity 的阈值。
   * 只做降级（降低阈值让更多任务用 flash），不自动升级。
   * ε-greedy 成功率 > 80% → 该 taskCategory 永久降级。
   */
  private async applyRoutingOptimizations(): Promise<void> {
    try {
      const { goalScheduler } = await import('../goals/goal-scheduler.js');
      const suggestions = (goalScheduler as any).analyzeRoutingFeedback?.() || [];

      for (const s of suggestions) {
        if (s.type === 'routing.downgrade') {
          // Extract task category from the message: premium/"import-fix" 100% success → try standard
          const catMatch = s.message.match(/premium\/"(\w+)"/);
          if (catMatch) {
            const category = catMatch[1];
            (goalScheduler as any).addRoutingOverride?.(category, 'standard');
            logger.info('[MonitorAgent] Auto-optimized routing', { category, action: 'downgrade to standard' });
          }
        }
      }
      // ε-greedy exploration success → expand boundary
      if (suggestions.some((s: any) => s.type === 'routing.exploration')) {
        const expSuggestion = suggestions.find((s: any) => s.type === 'routing.exploration');
        const match = expSuggestion?.message?.match(/(\d+)\/(\d+).*(\d+)%/);
        if (match && parseInt(match[1]) >= 3 && parseInt(match[3]) > 80) {
          // Exploration is working well → keep current boundary (don't revert)
          logger.info('[MonitorAgent] ε-greedy boundary confirmed', { success: match[1], total: match[2] });
        }
      }
    } catch { /* best-effort */ }
  }

  /**
   * Token 预算超标的 goal → 在 GoalScheduler 中标记强制降级。
   * 后续该 goal 的所有 executor dispatch 强制使用 flash。
   */
  private async applyTokenBudgetGate(): Promise<void> {
    try {
      const TOKEN_BUDGET_CRIT = 1_000_000;
      const goals = await prisma.goal.findMany({
        where: { status: 'executing', updatedAt: { gte: new Date(Date.now() - 24 * 3600_000) } },
        select: { id: true, context: true },
      });
      for (const goal of goals) {
        const ctx = (typeof goal.context === 'string' ? JSON.parse(goal.context) : goal.context) || {};
        const tokens = (ctx._cumulativeTokens as number) || 0;
        if (tokens >= TOKEN_BUDGET_CRIT) {
          const { goalScheduler } = await import('../goals/goal-scheduler.js');
          (goalScheduler as any).addTokenGate?.(goal.id);
          logger.warn('[MonitorAgent] Token budget gate applied', { goalId: goal.id.slice(0, 8), tokens });
        }
      }
    } catch { /* best-effort */ }
  }

  // ── DailyReflection: 每日洞察聚合 ──

  /**
   * 每天 23:50 聚合所有数据源 → 输出每日开发洞察
   * 数据源: session:summary + pipelineRun + routing.jsonl + git log + KnowledgeBus
   * 输出: #系统 channel 卡片 + Discord discord-alert 频道
   */
  private async dailyReflection(): Promise<void> {
    try {
      const now = new Date();
      const hour = now.getHours();
      const minute = now.getMinutes();
      // Run at ~23:50 (± 5 min), once per day
      if (!(hour === 23 && minute >= 48 && minute <= 55)) return;

      const today = now.toISOString().split('T')[0];
      if (this.lastDailyReflection === today) return;
      this.lastDailyReflection = today;

      const since = new Date(now.getTime() - 24 * 3600_000);
      const lines: string[] = [
        `## 📊 每日洞察 — ${today}`,
        '',
      ];

      // 1. Session summary
      try {
        const eventsFile = path.join(os.homedir(), 'events', 'studio.jsonl');
        if (fs.existsSync(eventsFile)) {
          const raw = fs.readFileSync(eventsFile, 'utf-8');
          const sessions: any[] = [];
          for (const line of raw.split('\n')) {
            if (!line.trim()) continue;
            try {
              const e = JSON.parse(line);
              if (e.type === 'session:summary' && new Date(e.timestamp) >= since) sessions.push(e);
            } catch {}
          }
          if (sessions.length > 0) {
            const totalTurns = sessions.reduce((s: number, e: any) => s + (e.turnCount || 0), 0);
            const deepCount = sessions.filter((e: any) => e.deepAnalysis).length;
            const captureRate = deepCount > 0
              ? Math.round((sessions.filter((e: any) => e.knowledgeCaptured).length / deepCount) * 100)
              : 0;
            const tools = [...new Set(sessions.map((e: any) => e.tool || 'unknown'))];
            const totalMin = sessions.reduce((s: number, e: any) => s + (e.durationMin || 0), 0);

            lines.push('### 会话活动');
            lines.push(`- 会话: ${sessions.length} 次 | 总 turn: ${totalTurns} | 总时长: ${totalMin}min`);
            lines.push(`- 工具: ${tools.join(', ')}`);
            lines.push(`- 深度分析: ${deepCount} | 知识捕获率: ${captureRate}%`);
            const highTurn = sessions.filter((e: any) => e.turnCount > 30);
            if (highTurn.length > 0) {
              lines.push(`- ⚠️ ${highTurn.length} 个会话超过 30 turns — 考虑 cstnew 重置上下文`);
            }
          }
        }
      } catch { lines.push('### 会话活动\n(数据源不可用)'); }

      // 1b. Workflow detection (7-day window, from StudioEvent session:summary)
      try {
        const weekAgo = new Date(now.getTime() - 7 * 24 * 3600_000);
        const summaryEvents = await prisma.studioEvent.findMany({
          where: { type: 'session:summary', timestamp: { gte: weekAgo } },
          select: { payload: true },
        });

        if (summaryEvents.length >= 5) {
          const typeCounts: Record<string, { count: number; successCount: number }> = {};
          for (const ev of summaryEvents) {
            try {
              const p = typeof ev.payload === 'string' ? JSON.parse(ev.payload) : ev.payload;
              const wt = (p as any)?.workflowType || 'unknown';
              if (!typeCounts[wt]) typeCounts[wt] = { count: 0, successCount: 0 };
              typeCounts[wt].count++;
              if ((p as any)?.success !== false) typeCounts[wt].successCount++;
            } catch {}
          }

          const recurring = Object.entries(typeCounts)
            .filter(([_, s]) => s.count >= 3 && s.successCount / s.count > 0.7)
            .sort((a, b) => b[1].count - a[1].count);

          if (recurring.length > 0) {
            lines.push('', '### 工作流模式（7天）');
            for (const [wt, s] of recurring) {
              const rate = Math.round((s.successCount / s.count) * 100);
              lines.push(`- **${wt}**: ${s.count} 次, 成功率 ${rate}%`);
              if (['ci_fix', 'test_triage', 'release_prep'].includes(wt)) {
                lines.push(`  → 建议创建 Skill 自动化此工作流`);
              }
            }
          }

          // B9-025: Persist workflow_report + update UserPreference
          const distribution: Record<string, number> = {};
          for (const [wt, s] of Object.entries(typeCounts)) distribution[wt] = s.count;
          const recurringData = recurring.map(([wt, s]) => ({
            type: wt,
            count: s.count,
            successRate: Math.round((s.successCount / s.count) * 100) / 100,
            lastSeen: today,
          }));

          prisma.studioEvent.create({
            data: {
              type: 'workflow_report',
              source: 'monitor',
              payload: JSON.stringify({ distribution, recurring: recurringData, date: today }),
            },
          }).catch((e: any) => { logger.warn('[MonitorAgent] workflow_report event failed', { error: String(e) }); });

          preferenceObserver.updateFromWorkflowReport(distribution, recurringData).catch(() => {});
        }
      } catch { /* best-effort */ }

      // 2. Pipeline runs
      try {
        const runs = await prisma.pipelineRun.findMany({
          where: { createdAt: { gte: since } },
          select: { phase: true, success: true, inputTokens: true, cacheHitTokens: true, durationMs: true },
        });
        if (runs.length > 0) {
          const goals = runs.filter((r: any) => r.phase === 'full');
          const totalInput = runs.reduce((s: number, r: any) => s + (r.inputTokens || 0), 0);
          const totalCache = runs.reduce((s: number, r: any) => s + (r.cacheHitTokens || 0), 0);

          lines.push('', '### 管线执行');
          lines.push(`- Pipeline runs: ${runs.length} | Goals: ${goals.length}`);
          lines.push(`- Token: ${(totalInput / 1000).toFixed(0)}K input + ${(totalCache / 1000).toFixed(0)}K cache`);

          const execRuns = runs.filter((r: any) => r.phase === 'executor');
          const successRate = execRuns.length > 0
            ? Math.round((execRuns.filter((r: any) => r.success).length / execRuns.length) * 100)
            : 0;
          lines.push(`- Executor 成功率: ${successRate}% (${execRuns.filter((r: any) => r.success).length}/${execRuns.length})`);
        }
      } catch { /* best-effort */ }

      // 3. Git commits
      try {
        const { execSync } = await import('child_process');
        const repoDir = process.env.REPO_DIR || '/root/projects/studio';
        const gitLog = execSync(
          `git log --since="${since.toISOString()}" --oneline --no-merges 2>/dev/null | wc -l`,
          { cwd: repoDir, timeout: 5000 }
        ).toString().trim();
        const fileCount = execSync(
          `git diff --stat HEAD "@{24 hours ago}" 2>/dev/null | tail -1`,
          { cwd: repoDir, timeout: 5000 }
        ).toString().trim();

        if (parseInt(gitLog) > 0) {
          lines.push('', '### 代码变更');
          lines.push(`- Commits: ${gitLog} | ${fileCount || 'N/A'}`);
        }
      } catch { /* best-effort */ }

      // 4. KnowledgeBus
      try {
        const { knowledgeBus } = await import('../knowledge/knowledge-bus.service.js');
        const stats = knowledgeBus.getStats();
        lines.push('', '### 知识积累');
        lines.push(`- KnowledgeBus: ${stats.total || 0} 条 (pattern:${stats.pattern || 0} fix:${stats.fix || 0})`);
      } catch { /* best-effort */ }

      // 4b. Knowledge consumption hit rate (24h)
      try {
        const consumptionEvents = await prisma.studioEvent.findMany({
          where: { type: 'knowledge:consumption', timestamp: { gte: since } },
          select: { source: true, payload: true },
        });
        const searchHitEvents = await prisma.studioEvent.findMany({
          where: { type: 'knowledge:search_hit', timestamp: { gte: since } },
          select: { payload: true },
        });

        if (consumptionEvents.length > 0 || searchHitEvents.length > 0) {
          lines.push('', '### 知识消费（24h）');
          lines.push(`- 引用事件: ${consumptionEvents.length} 次`);

          // By contributor
          const byContributor: Record<string, number> = {};
          for (const ev of consumptionEvents) {
            byContributor[ev.source] = (byContributor[ev.source] || 0) + 1;
          }
          const contribLine = Object.entries(byContributor)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([c, n]) => `${c}(${n})`)
            .join(', ');
          if (contribLine) lines.push(`- 来源: ${contribLine}`);

          // Search hit rate
          if (searchHitEvents.length > 0) {
            let totalHits = 0;
            let totalScore = 0;
            for (const ev of searchHitEvents) {
              try {
                const p = typeof ev.payload === 'string' ? JSON.parse(ev.payload) : ev.payload;
                totalHits += (p as any).hitCount || 0;
                totalScore += ((p as any).avgScore || 0) * ((p as any).hitCount || 1);
              } catch {}
            }
            const avgHitCount = Math.round(totalHits / searchHitEvents.length);
            const avgScore = totalHits > 0 ? Math.round(totalScore / totalHits * 100) / 100 : 0;
            lines.push(`- 搜索: ${searchHitEvents.length} 次查询, 平均命中 ${avgHitCount} 条, 平均分 ${avgScore}`);
          }
        }

        // Write aggregated stats for audit D6 to read
        try {
          const statsPath = path.join(os.homedir(), '.studio', 'knowledge', '.consumption-stats.json');
          fs.writeFileSync(statsPath, JSON.stringify({
            date: today,
            dailyEvents: consumptionEvents.length,
            searchHits: searchHitEvents.length,
          }), 'utf-8');
        } catch { /* best-effort */ }
      } catch { /* best-effort */ }

      // 5. Knowledge quality audit (daily, auto-fix)
      try {
        const { KnowledgeAudit } = await import('@dommaker/harness') as any;
        const knowledgeDir = path.join(os.homedir(), '.studio', 'knowledge');
        const audit = new KnowledgeAudit({ baseDir: knowledgeDir });
        const report = audit.run({ autoFix: true });
        if (report.totalEntries > 0) {
          lines.push('', '### 知识质量审计');
          lines.push(`- 总条目: ${report.totalEntries} | 健康分: ${report.healthScore.before}→${report.healthScore.after}/100`);
          if (report.autoFixed > 0) {
            lines.push(`- 自动修复: ${report.autoFixed} 条`);
          }
          const dimLabels: Record<string, string> = {
            structure: '结构', content: '内容', dedup: '去重',
            maturity: '成熟度', freshness: '新鲜度', flywheel: '飞轮',
          };
          const dimLine = Object.entries(report.dimensions)
            .map(([k, d]: [string, any]) => `${dimLabels[k] || k}:${d.score}`)
            .join(' | ');
          lines.push(`- 维度: ${dimLine}`);
          const criticalCount = report.issues.filter((i: any) => i.severity === 'critical').length;
          const highCount = report.issues.filter((i: any) => i.severity === 'high').length;
          if (criticalCount > 0 || highCount > 0) {
            lines.push(`- ⚠️ 需关注: ${criticalCount} critical, ${highCount} high`);
          }
        }
      } catch { /* best-effort: audit module may not be available */ }

      // B10-201: Behavior profile trends
      try {
        const behaviorProfiles = await prisma.userBehaviorProfile.findMany({
          where: { createdAt: { gte: since } },
          select: { category: true, suggestedAction: true, confidence: true, status: true },
        });
        if (behaviorProfiles.length > 0) {
          const byCat: Record<string, number> = {};
          const byAction: Record<string, number> = {};
          let pendingCount = 0;
          for (const p of behaviorProfiles) {
            byCat[p.category] = (byCat[p.category] || 0) + 1;
            byAction[p.suggestedAction] = (byAction[p.suggestedAction] || 0) + 1;
            if (p.status === 'pending') pendingCount++;
          }
          const catLabels: Record<string, string> = { correction: '纠正', workflow: '决策', automation: '自动化' };
          const actLabels: Record<string, string> = { create_rule: '规则', create_skill: 'Skill', create_automation: '自动化', skip: '跳过' };

          lines.push('', '### 行为模式（24h）');
          lines.push(`- 新提取: ${behaviorProfiles.length} 条 | 待确认: ${pendingCount} 条`);
          const catLine = Object.entries(byCat).map(([c, n]) => `${catLabels[c] || c}(${n})`).join(', ');
          lines.push(`- 分类: ${catLine}`);
          const topAction = Object.entries(byAction).sort((a, b) => b[1] - a[1])[0];
          if (topAction) {
            lines.push(`- 最多建议: ${actLabels[topAction[0]] || topAction[0]} (${topAction[1]} 次)`);
          }
          if (pendingCount >= 5) {
            lines.push(`- ⚠️ 积压 ${pendingCount} 条待确认行为模式 — 考虑批量审核`);
          }
        }
      } catch { /* best-effort */ }

      // B9-025: Weekly profile report (every Sunday)
      if (now.getDay() === 0) {
        try {
          const weekAgoForProfile = new Date(now.getTime() - 7 * 24 * 3600_000);
          const weeklyEvents = await prisma.studioEvent.findMany({
            where: { type: 'workflow_report', timestamp: { gte: weekAgoForProfile } },
            select: { payload: true },
            orderBy: { timestamp: 'desc' },
          });

          if (weeklyEvents.length > 0) {
            const merged: Record<string, number> = {};
            for (const ev of weeklyEvents) {
              try {
                const p = typeof ev.payload === 'string' ? JSON.parse(ev.payload) : ev.payload;
                const dist = (p as any)?.distribution || {};
                for (const [k, v] of Object.entries(dist)) merged[k] = (merged[k] || 0) + (v as number);
              } catch {}
            }

            const sorted = Object.entries(merged).sort((a, b) => b[1] - a[1]);
            if (sorted.length > 0) {
              lines.push('', '### 周工作画像');
              lines.push(`- Top 工作流: ${sorted.slice(0, 3).map(([t, c]) => `${t}(${c})`).join(', ')}`);
              const pref = await (prisma as any).userPreference.findFirst({ where: { userId: 'default' }, select: { preferredWorkflowTypes: true } });
              if (pref?.preferredWorkflowTypes) {
                const preferred = JSON.parse(pref.preferredWorkflowTypes) as string[];
                const newTypes = sorted.filter(([t]) => !preferred.includes(t)).map(([t]) => t);
                if (newTypes.length > 0) lines.push(`- 新增高频类型: ${newTypes.join(', ')}`);
              }
            }
          }
        } catch { /* best-effort */ }
      }

      // Post to #系统 channel
      const content = lines.join('\n');
      try {
        const sysChannel = await prisma.channel.findUnique({ where: { name: '#系统' } });
        if (sysChannel) {
          const { channelMessageService } = await import('../channels/channel-message.service.js');
          await channelMessageService.createAgentMessage(sysChannel.id, 'DailyReflection', content, {
            meta: { cardType: 'daily_reflection', date: today },
          });
          logger.info('[MonitorAgent] DailyReflection posted', { date: today });
        }
      } catch (e: any) { logger.warn('[MonitorAgent] DailyReflection channel post failed', { error: String(e) }); }

      // G30: Record daily reflection event
      prisma.studioEvent.create({
        data: {
          type: 'daily_reflection',
          source: 'monitor',
          payload: JSON.stringify({ date: today, summaryLength: content.length }),
        },
      }).catch((e: any) => { logger.warn('[MonitorAgent] StudioEvent failed', { error: String(e) }); });

      // Discord alert (fire-and-forget, channel configured via DISCORD_DAILY_CHANNEL)
      try {
        const channel = process.env.DISCORD_DAILY_CHANNEL || null;
        if (channel) {
          const { discordNotifier } = await import('../../utils/discord-notifier.js');
          await discordNotifier.sendChannelMessage(channel, 'DailyReflection', content, {
            cardType: 'daily_reflection',
          });
        }
      } catch { /* Discord best-effort */ }
    } catch (e: any) {
      logger.warn('[MonitorAgent] DailyReflection failed', { error: String(e) });
    }
  }

  // ── B9-025: WorkflowObserver — 工作流模式持久化 ──

  /**
   * 从 session:summary 事件中提取工作流分布，写入 workflow_report + 更新 UserPreference。
   * 可独立调用（非 DailyReflection 时间窗口也可触发）。
   */
  async observeWorkflow(): Promise<{ distribution: Record<string, number>; recurring: Array<{ type: string; count: number; successRate: number }> } | null> {
    try {
      const weekAgo = new Date(Date.now() - 7 * 24 * 3600_000);
      const events = await prisma.studioEvent.findMany({
        where: { type: 'session:summary', timestamp: { gte: weekAgo } },
        select: { payload: true },
      });
      if (events.length < 3) return null;

      const typeCounts: Record<string, { count: number; successCount: number }> = {};
      for (const ev of events) {
        try {
          const p = typeof ev.payload === 'string' ? JSON.parse(ev.payload) : ev.payload;
          const wt = (p as any)?.workflowType || 'unknown';
          if (!typeCounts[wt]) typeCounts[wt] = { count: 0, successCount: 0 };
          typeCounts[wt].count++;
          if ((p as any)?.success !== false) typeCounts[wt].successCount++;
        } catch {}
      }

      const distribution: Record<string, number> = {};
      for (const [wt, s] of Object.entries(typeCounts)) distribution[wt] = s.count;

      const recurring = Object.entries(typeCounts)
        .filter(([_, s]) => s.count >= 3 && s.successCount / s.count > 0.7)
        .map(([wt, s]) => ({ type: wt, count: s.count, successRate: Math.round((s.successCount / s.count) * 100) / 100 }));

      const today = new Date().toISOString().split('T')[0];
      await prisma.studioEvent.create({
        data: {
          type: 'workflow_report',
          source: 'monitor',
          payload: JSON.stringify({ distribution, recurring, date: today }),
        },
      });

      await preferenceObserver.updateFromWorkflowReport(distribution, recurring.map(r => ({ ...r, lastSeen: today })));
      return { distribution, recurring };
    } catch (e: any) {
      logger.warn('[MonitorAgent] observeWorkflow failed', { error: String(e) });
      return null;
    }
  }

  // ── G31: Data Lifecycle TTL — 每天 23:55 沉淀→清理 ──

  /**
   * 知识沉淀闸门：清理前从即将过期的数据中提取知识写入 KnowledgeBus。
   * 成功后标记 precipitated=true，只有已沉淀的数据源才允许清理。
   * 沉淀失败 → 不清理对应数据源，下次重试。
   */
  private lastPrecipitateRun = '';

  private async precipitate(): Promise<Record<string, boolean>> {
    const results: Record<string, boolean> = {};
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    if (this.lastPrecipitateRun === today) return results;
    this.lastPrecipitateRun = today;

    // 1. StudioEvent: 提取 >7d 且未沉淀的事件
    results.studioEvent = await this.precipitateStudioEvents();

    // 2. routing.jsonl: 提取路由决策模式
    results.routing = await this.precipitateRouting();

    // 3. .agent.log 归档: 提取执行失败模式
    results.sessions = await this.precipitateSessionLogs();

    logger.info('[MonitorAgent] Precipitation completed', results);
    return results;
  }

  /** 从 StudioEvent 提取知识，成功后标记 precipitated */
  private async precipitateStudioEvents(): Promise<boolean> {
    try {
      const cutoff = new Date(Date.now() - 7 * 24 * 3600_000);
      const oldCutoff = new Date(Date.now() - 30 * 24 * 3600_000);
      // 只处理 7d~30d 之间的未沉淀事件（<7d 留给 dailyReflection，>30d 即将清理）
      const events = await prisma.studioEvent.findMany({
        where: {
          precipitated: false,
          timestamp: { gte: oldCutoff, lt: cutoff },
        },
        orderBy: { timestamp: 'asc' },
        take: 200,
      });
      if (events.length === 0) {
        logger.info('[MonitorAgent] Precipitate: no unprompted StudioEvents');
        return true;
      }

      // 按 type 聚合
      const byType: Record<string, typeof events> = {};
      for (const e of events) {
        const key = e.type || 'unknown';
        if (!byType[key]) byType[key] = [];
        byType[key].push(e);
      }

      // 构建摘要文本供 LLM 提取
      const summary = Object.entries(byType).map(([type, evts]) => {
        const sample = evts.slice(0, 10).map(e => {
          const p = e.payload ? JSON.parse(e.payload) : {};
          return `  - ${e.source} @ ${e.timestamp.toISOString()}: ${JSON.stringify(p).slice(0, 200)}`;
        }).join('\n');
        return `## ${type} (${evts.length} events)\n${sample}`;
      }).join('\n\n');

      const extraction = await modelGateway.promptJson<{ entries: Array<{ type: string; title: string; content: string; tags: string[] }> }>(
        summary.slice(0, 30_000),
        `你是运维知识提取专家。从 Agent 系统的事件日志中提取可复用的运维知识。

关注：
- 失败模式（哪些 type 的事件失败率高，根因是什么）
- 性能趋势（token 消耗、延迟异常）
- 资源使用模式（模型选择、成本）

输出格式：{ "entries": [{ "type": "failure|trend|pitfall", "title": "根因概括", "content": "根因+预防措施", "tags": [...] }] }
只提取有价值的模式。没有则返回空数组。最多 5 条。`,
      );

      if (extraction.entries?.length) {
        for (const entry of extraction.entries) {
          await knowledgeBus.recordPattern({
            source: 'monitor',
            type: entry.type as any,
            title: `[沉淀] ${entry.title}`,
            content: entry.content,
            severity: entry.type === 'failure' ? 'warning' : 'info',
            timestamp: Date.now(),
          });
        }
        logger.info('[MonitorAgent] Precipitate StudioEvent: extracted', { count: extraction.entries.length });
      }

      // 标记已沉淀
      const ids = events.map(e => e.id);
      await prisma.studioEvent.updateMany({
        where: { id: { in: ids } },
        data: { precipitated: true },
      });
      logger.info('[MonitorAgent] Precipitate StudioEvent: marked', { count: ids.length });
      return true;
    } catch (e) {
      logger.warn('[MonitorAgent] Precipitate StudioEvent failed', { error: String(e) });
      return false;
    }
  }

  /** 从 routing.jsonl 提取路由决策模式 */
  private async precipitateRouting(): Promise<boolean> {
    try {
      const routingFile = path.join(os.homedir(), '.studio', '.harness', 'routing.jsonl');
      if (!fs.existsSync(routingFile)) return true;

      const raw = fs.readFileSync(routingFile, 'utf-8');
      const lines = raw.split('\n').filter(l => l.trim());
      if (lines.length < 10) return true; // 数据太少不值得提取

      // 统计路由分布
      const stats = { premium: 0, standard: 0, degraded: 0, total: 0 };
      const recent = lines.slice(-100);
      for (const line of recent) {
        try {
          const entry = JSON.parse(line);
          stats.total++;
          if (entry.tier === 'premium') stats.premium++;
          else if (entry.tier === 'standard') stats.standard++;
          if (entry.degraded) stats.degraded++;
        } catch { /* skip */ }
      }

      if (stats.total < 5) return true;

      const content = [
        `路由统计 (最近 ${stats.total} 条):`,
        `  premium: ${stats.premium} (${Math.round(stats.premium / stats.total * 100)}%)`,
        `  standard: ${stats.standard} (${Math.round(stats.standard / stats.total * 100)}%)`,
        `  降级: ${stats.degraded} (${Math.round(stats.degraded / stats.total * 100)}%)`,
      ].join('\n');

      await knowledgeBus.recordTrend({
        source: 'monitor',
        type: 'trend',
        title: `[沉淀] 路由分布 ${new Date().toISOString().split('T')[0]}`,
        content,
        severity: stats.degraded / stats.total > 0.3 ? 'warning' : 'info',
        timestamp: Date.now(),
      });

      logger.info('[MonitorAgent] Precipitate routing: done', { total: stats.total, degraded: stats.degraded });
      return true;
    } catch (e) {
      logger.warn('[MonitorAgent] Precipitate routing failed', { error: String(e) });
      return false;
    }
  }

  /** 从 .agent.log 归档提取执行失败模式 */
  private async precipitateSessionLogs(): Promise<boolean> {
    try {
      const sessionsDir = path.join(os.homedir(), '.studio', 'sessions');
      if (!fs.existsSync(sessionsDir)) return true;

      const cutoff = Date.now() - 30 * 24 * 3600_000;
      const files = fs.readdirSync(sessionsDir)
        .filter(f => f.endsWith('.log'))
        .map(f => ({
          name: f,
          mtime: fs.statSync(path.join(sessionsDir, f)).mtimeMs,
        }))
        .filter(f => f.mtime < cutoff)
        .slice(0, 20); // 每次最多处理 20 个

      if (files.length === 0) return true;

      // 提取错误模式（只读最后 2KB，错误通常在末尾）
      const errorSnippets: string[] = [];
      for (const f of files) {
        try {
          const content = fs.readFileSync(path.join(sessionsDir, f.name), 'utf-8');
          const tail = content.slice(-2000);
          if (tail.includes('Error') || tail.includes('error') || tail.includes('failed')) {
            errorSnippets.push(`### ${f.name}\n${tail.slice(0, 500)}`);
          }
        } catch { /* skip */ }
      }

      if (errorSnippets.length === 0) return true;

      const extraction = await modelGateway.promptJson<{ entries: Array<{ type: string; title: string; content: string; tags: string[] }> }>(
        errorSnippets.join('\n\n').slice(0, 20_000),
        `你是运维知识提取专家。从 Agent 执行日志的错误片段中提取可复用的失败模式。

关注：
- 高频错误类型（什么错误反复出现）
- 根因模式（环境问题？代码问题？配置问题？）
- 预防措施（如何避免同类错误）

输出格式：{ "entries": [{ "type": "failure|pitfall", "title": "根因概括", "content": "根因+预防", "tags": [...] }] }
只提取有共性的模式，单次偶发错误不提取。最多 3 条。`,
      );

      if (extraction.entries?.length) {
        for (const entry of extraction.entries) {
          await knowledgeBus.recordPattern({
            source: 'monitor',
            type: entry.type as any,
            title: `[沉淀] ${entry.title}`,
            content: entry.content,
            severity: 'warning',
            timestamp: Date.now(),
          });
        }
        logger.info('[MonitorAgent] Precipitate sessions: extracted', { count: extraction.entries.length });
      }

      logger.info('[MonitorAgent] Precipitate sessions: done', { files: files.length, extracted: extraction.entries?.length || 0 });
      return true;
    } catch (e) {
      logger.warn('[MonitorAgent] Precipitate sessions failed', { error: String(e) });
      return false;
    }
  }

  /**
   * Data lifecycle management: purges old records, reclaims disk space.
   * Runs once per day at 23:55 (± 5 min), right after dailyReflection.
   * All operations are best-effort with individual try/catch.
   *
   * G31: 闸门模式 — 先沉淀后清理，沉淀失败的数据源不清理。
   */
  private lastDataLifecycleRun = '';

  private async dataLifecycle(): Promise<void> {
    try {
      const now = new Date();
      const hour = now.getHours();
      const minute = now.getMinutes();
      // Run at ~23:55 (± 5 min), once per day
      if (!(hour === 23 && minute >= 50 && minute <= 59)) return;

      const today = now.toISOString().split('T')[0];
      if (this.lastDataLifecycleRun === today) return;
      this.lastDataLifecycleRun = today;

      logger.info('[MonitorAgent] Data lifecycle TTL cleanup starting', { date: today });

      // G31: 先沉淀后清理 — 沉淀失败的数据源不清理
      const gate = await this.precipitate();
      logger.info('[MonitorAgent] Precipitation gate', gate);

      // 1. Delete ChannelMessage older than 30 days
      try {
        const channelCutoff = new Date(Date.now() - 30 * 24 * 3600_000);
        const deleted = await prisma.channelMessage.deleteMany({
          where: { createdAt: { lt: channelCutoff } },
        });
        logger.info('[MonitorAgent] TTL: ChannelMessage cleaned', { deleted: deleted.count, cutoff: channelCutoff.toISOString() });
      } catch (e) {
        logger.warn('[MonitorAgent] TTL: ChannelMessage cleanup failed', { error: String(e) });
      }

      // 2. Delete GoalExecution older than 90 days
      try {
        const execCutoff = new Date(Date.now() - 90 * 24 * 3600_000);
        const deleted = await prisma.goalExecution.deleteMany({
          where: { createdAt: { lt: execCutoff } },
        });
        logger.info('[MonitorAgent] TTL: GoalExecution cleaned', { deleted: deleted.count, cutoff: execCutoff.toISOString() });
      } catch (e) {
        logger.warn('[MonitorAgent] TTL: GoalExecution cleanup failed', { error: String(e) });
      }

      // 3. Delete PipelineRun older than 90 days
      try {
        const pipelineCutoff = new Date(Date.now() - 90 * 24 * 3600_000);
        const deleted = await prisma.pipelineRun.deleteMany({
          where: { createdAt: { lt: pipelineCutoff } },
        });
        logger.info('[MonitorAgent] TTL: PipelineRun cleaned', { deleted: deleted.count, cutoff: pipelineCutoff.toISOString() });
      } catch (e) {
        logger.warn('[MonitorAgent] TTL: PipelineRun cleanup failed', { error: String(e) });
      }

      // 4. VACUUM to reclaim disk space
      try {
        await prisma.$executeRawUnsafe('VACUUM');
        logger.info('[MonitorAgent] TTL: VACUUM completed');
      } catch (e) {
        logger.warn('[MonitorAgent] TTL: VACUUM failed (non-fatal)', { error: String(e) });
      }

      // 5. Truncate ~/events/studio.jsonl keeping only last 7 days
      try {
        const eventsFile = path.join(os.homedir(), 'events', 'studio.jsonl');
        if (fs.existsSync(eventsFile)) {
          const raw = fs.readFileSync(eventsFile, 'utf-8');
          const sevenDaysAgo = Date.now() - 7 * 24 * 3600_000;
          const keepLines: string[] = [];
          let removedCount = 0;
          for (const line of raw.split('\n')) {
            if (!line.trim()) continue;
            try {
              const entry = JSON.parse(line);
              const ts = entry.timestamp || 0;
              if (ts >= sevenDaysAgo) {
                keepLines.push(line);
              } else {
                removedCount++;
              }
            } catch {
              // Preserve unparseable lines (safer than dropping them)
              keepLines.push(line);
            }
          }
          fs.writeFileSync(eventsFile, keepLines.join('\n') + '\n', 'utf-8');
          logger.info('[MonitorAgent] TTL: studio.jsonl truncated', { kept: keepLines.length, removed: removedCount });
        }
      } catch (e) {
        logger.warn('[MonitorAgent] TTL: studio.jsonl truncation failed', { error: String(e) });
      }

      // 6. Truncate .analyst/knowledge.md keeping last 50 entries
      try {
        const analystDir = process.env.ANALYST_DIR || path.join(process.env.REPO_DIR || path.join(os.homedir(), 'projects'), '.analyst');
        const knowledgeFile = path.join(analystDir, 'knowledge.md');
        if (fs.existsSync(knowledgeFile)) {
          const raw = fs.readFileSync(knowledgeFile, 'utf-8');
          const sections = raw.split(/(?=^## )/m).filter(Boolean);
          if (sections.length > 50) {
            const kept = sections.slice(-50);
            fs.writeFileSync(knowledgeFile, kept.join(''), 'utf-8');
            logger.info('[MonitorAgent] TTL: knowledge.md truncated', { original: sections.length, kept: kept.length });
          } else {
            logger.info('[MonitorAgent] TTL: knowledge.md under limit, skipped', { sections: sections.length });
          }
        }
      } catch (e) {
        logger.warn('[MonitorAgent] TTL: knowledge.md truncation failed', { error: String(e) });
      }

      // 7. StudioEvent TTL: 删除已沉淀且 >30d 的事件
      if (gate.studioEvent !== false) {
        try {
          const eventCutoff = new Date(Date.now() - 30 * 24 * 3600_000);
          const deleted = await prisma.studioEvent.deleteMany({
            where: { precipitated: true, timestamp: { lt: eventCutoff } },
          });
          logger.info('[MonitorAgent] TTL: StudioEvent cleaned', { deleted: deleted.count });
        } catch (e) {
          logger.warn('[MonitorAgent] TTL: StudioEvent cleanup failed', { error: String(e) });
        }
      } else {
        logger.warn('[MonitorAgent] TTL: StudioEvent cleanup skipped (precipitation failed)');
      }

      // 8. routing.jsonl: 截断保留最近 500 行（需沉淀成功）
      if (gate.routing !== false) {
        try {
          const routingFile = path.join(os.homedir(), '.studio', '.harness', 'routing.jsonl');
          if (fs.existsSync(routingFile)) {
            const raw = fs.readFileSync(routingFile, 'utf-8');
            const lines = raw.split('\n').filter(l => l.trim());
            if (lines.length > 500) {
              const kept = lines.slice(-500);
              fs.writeFileSync(routingFile, kept.join('\n') + '\n', 'utf-8');
              logger.info('[MonitorAgent] TTL: routing.jsonl truncated', { original: lines.length, kept: kept.length });
            }
          }
        } catch (e) {
          logger.warn('[MonitorAgent] TTL: routing.jsonl truncation failed', { error: String(e) });
        }
      } else {
        logger.warn('[MonitorAgent] TTL: routing.jsonl cleanup skipped (precipitation failed)');
      }

      // 9. sessions 归档 log: 删除 >30d 的文件（需沉淀成功）
      if (gate.sessions !== false) {
        try {
          const sessionsDir = path.join(os.homedir(), '.studio', 'sessions');
          if (fs.existsSync(sessionsDir)) {
            const sessionCutoff = Date.now() - 30 * 24 * 3600_000;
            const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.log'));
            let deleted = 0;
            for (const f of files) {
              try {
                const fp = path.join(sessionsDir, f);
                if (fs.statSync(fp).mtimeMs < sessionCutoff) {
                  fs.unlinkSync(fp);
                  deleted++;
                }
              } catch { /* skip */ }
            }
            logger.info('[MonitorAgent] TTL: sessions cleaned', { deleted, total: files.length });
          }
        } catch (e) {
          logger.warn('[MonitorAgent] TTL: sessions cleanup failed', { error: String(e) });
        }
      } else {
        logger.warn('[MonitorAgent] TTL: sessions cleanup skipped (precipitation failed)');
      }

      // 10. traces.log: 清理 >30d 的备份文件
      try {
        const tracesDir = path.join(process.cwd(), '.harness', 'logs');
        if (fs.existsSync(tracesDir)) {
          const traceCutoff = Date.now() - 30 * 24 * 3600_000;
          const files = fs.readdirSync(tracesDir).filter(f => f.startsWith('traces-') && f.endsWith('.log'));
          let deleted = 0;
          for (const f of files) {
            try {
              const fp = path.join(tracesDir, f);
              if (fs.statSync(fp).mtimeMs < traceCutoff) {
                fs.unlinkSync(fp);
                deleted++;
              }
            } catch { /* skip */ }
          }
          logger.info('[MonitorAgent] TTL: traces backup cleaned', { deleted, total: files.length });
        }
      } catch (e) {
        logger.warn('[MonitorAgent] TTL: traces cleanup failed', { error: String(e) });
      }

      logger.info('[MonitorAgent] Data lifecycle TTL cleanup completed', { date: today });
    } catch (e: any) {
      logger.warn('[MonitorAgent] Data lifecycle TTL failed', { error: String(e) });
    }
  }
}

export const monitorAgent = new MonitorAgent();
