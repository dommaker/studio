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
import { logger } from '@dommaker/studio-shared';
import { knowledgeBus } from '../knowledge/knowledge-bus.service.js';
import type { MonitorAlert, TriageIncidentInput } from './types.js';
import { triageAgent } from './triage-agent.service.js';

const CHECK_INTERVAL = 5 * 60_000; // 5 min
const FAILURE_THRESHOLD = 3;
const WORKTREES_DIR = process.env.WORKTREES_DIR || path.join(os.homedir(), 'worktrees');

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

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => this.check().catch(e => {
      logger.error('[MonitorAgent] Check failed', { error: String(e) });
    }), CHECK_INTERVAL);
    logger.info('[MonitorAgent] Started', { checkInterval: CHECK_INTERVAL });
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    logger.info('[MonitorAgent] Stopped');
  }

  private async check(): Promise<void> {
    const alerts: MonitorAlert[] = [];

    alerts.push(...await this.checkFailureTrend());
    alerts.push(...await this.checkStuckGoals());
    alerts.push(...await this.checkProgressStagnation());
    alerts.push(...await this.checkSessionEscalation());
    alerts.push(...await this.checkTotalExecutionTime());
    alerts.push(...await this.checkHeartbeatLoss());
    alerts.push(...await this.checkPipelineLatency());
    alerts.push(...await this.checkToolPatterns());
    await this.evaluateTrajectory();  // G4
    await this.analyzeRoutingEvolution();  // G5 evolution
    await this.autoAbandonStaleBlocked();
    await this.systemTriageCheck();

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

  /**
   * 🆕 记录心跳（由 agent.heartbeat 事件调用）
   */
  recordHeartbeat(executionId: string): void {
    const snapshot = progressSnapshots.get(executionId);
    if (snapshot) {
      snapshot.lastHeartbeat = Date.now();
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

      let totalExecutions = 0;
      let efficientCount = 0;
      let slowCount = 0;
      let retryCount = 0;
      let failureCount = 0;

      for (const exec of recent) {
        totalExecutions++;

        // Check progress stagnation via snapshot
        const snap = progressSnapshots.get(exec.id);
        if (snap && snap.unchangedCount >= 3) {
          retryCount++;
        }

        // Check execution time
        if (exec.startedAt && exec.completedAt) {
          const durationMin = (new Date(exec.completedAt).getTime() - new Date(exec.startedAt).getTime()) / 60000;
          if (durationMin > 15) slowCount++;
          else if (durationMin <= 5) efficientCount++;
        }

        if (exec.status === 'failed') failureCount++;
      }

      const efficiency = totalExecutions > 0 ? Math.round((efficientCount / totalExecutions) * 100) : 0;
      const slowRate = totalExecutions > 0 ? Math.round((slowCount / totalExecutions) * 100) : 0;

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
}

export const monitorAgent = new MonitorAgent();
