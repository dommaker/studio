/**
 * Monitor Agent — 任务/WorkUnit 级探测
 *
 * 从 monitor-agent.service.ts 拆分（探测/告警/报告分离，零行为变更）。
 * 本模块负责产生 MonitorAlert 的各项任务级检查：
 *   - 失败趋势 / 进度停滞 / 总执行时间（含主动终止）/ 心跳丢失
 *   - blocked 24h 自动放弃 / 会话文件健康 / 审查质量 / token 预算
 *   - deploy push 失败 / proxy 重启耗尽 / 工具调用异常模式
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from '@dommaker/studio-shared';
import type { FileStore } from '@dommaker/studio-shared';
import { agentRunner } from '@dommaker/studio-agent';
import type { MonitorAlert } from './types.js';
import { studioEventsJsonl } from './monitor-alerts.js';

const FAILURE_THRESHOLD = 3;

// NA Step 7: 告警阈值
const PROGRESS_STAGNATION_WARN = 3;  // 连续 3 次无进展 → Level 1
const PROGRESS_STAGNATION_CRIT = 6;  // 连续 6 次无进展 → Level 2
const TIME_WARN_MS = 60 * 60 * 1000;       // 1h → Level 1
const TIME_ESCALATE_MS = 2 * 60 * 60 * 1000; // 2h → Level 2
const TIME_CRITICAL_MS = 2.5 * 60 * 60 * 1000; // 2.5h → Level 3
const HEARTBEAT_LOST_MS = 15 * 60 * 1000;  // 15min 无心跳 → Level 2
const BLOCKED_AUTO_ABANDON_MS = 24 * 60 * 60 * 1000; // 24h

// ── 已有 ──

export async function checkFailureTrend(fileStore: FileStore): Promise<MonitorAlert[]> {
  const alerts: MonitorAlert[] = [];
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  // Read recent tasks from FileStore
  const tasksDir = path.join(os.homedir(), '.studio', 'data', 'tasks');
  let allTasks: any[] = [];
  try {
    const entries = await fs.promises.readdir(tasksDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.json')) continue;
      const t = await fileStore.readJson<any>(path.join(tasksDir, e.name));
      if (t) allTasks.push(t);
    }
  } catch { /* no tasks dir */ }
  const recentTasks = allTasks
    .filter(t => t.startedAt && new Date(t.startedAt) >= oneHourAgo && ['completed', 'failed'].includes(t.status))
    .map(t => ({ id: t.id, status: t.status, projectId: t.projectId, name: t.name, startedAt: t.startedAt }))
    .sort((a, b) => new Date(b.startedAt || 0).getTime() - new Date(a.startedAt || 0).getTime())
    .slice(0, 20);

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

// ── NA Step 7: 进度停滞检测 ──

export async function checkProgressStagnation(fileStore: FileStore): Promise<MonitorAlert[]> {
  const alerts: MonitorAlert[] = [];
  const running = (await fileStore.getIndex({ status: 'active' })).slice(0, 10);

  for (const wu of running) {
    const minutesSinceUpdate = Math.round((Date.now() - new Date(wu.updatedAt).getTime()) / 60_000);

    if (minutesSinceUpdate > PROGRESS_STAGNATION_CRIT * 5) {
      alerts.push({
        source: 'progress_stagnation',
        level: 'critical',
        message: `WorkUnit ${wu.id} 进度停滞 ${minutesSinceUpdate} 分钟（Level 2）`,
        relatedTaskIds: [wu.id],
      });
    } else if (minutesSinceUpdate > PROGRESS_STAGNATION_WARN * 5) {
      alerts.push({
        source: 'progress_stagnation',
        level: 'info',
        message: `WorkUnit ${wu.id} 进度停滞 ${minutesSinceUpdate} 分钟（Level 1）`,
        relatedTaskIds: [wu.id],
      });
    }
  }

  return alerts;
}

// ── NA Step 7: 总执行时间告警 + 主动终止 ──

export async function checkTotalExecutionTime(fileStore: FileStore): Promise<MonitorAlert[]> {
  const alerts: MonitorAlert[] = [];
  const running = (await fileStore.getIndex({ status: 'active' })).slice(0, 10);

  for (const exec of running) {
    const startTime = new Date(exec.claimedAt || exec.createdAt).getTime();
    const elapsed = Date.now() - startTime;

    if (elapsed > TIME_CRITICAL_MS) {
      alerts.push({
        source: 'total_time',
        level: 'critical',
        message: `WorkUnit ${exec.id} 执行超过 2.5h — 主动终止`,
        relatedTaskIds: [exec.id],
      });

      // Active intervention: stop agent process
      const elapsedMin = Math.round(elapsed / 60_000);
      try {
        await agentRunner.stop(exec.id);
        logger.info('[MonitorAgent] Stopped timed-out workUnit', { workUnitId: exec.id.slice(0, 8), elapsedMin });
      } catch (stopErr) {
        logger.warn('[MonitorAgent] Failed to stop workUnit process', { workUnitId: exec.id.slice(0, 8), error: String(stopErr) });
      }
      // Update status via FileStore
      try {
        const current = (await fileStore.getIndex()).find(s => s.id === exec.id);
        if (current) {
          await fileStore.upsertSnapshot({
            ...current,
            status: 'closed',
            completedAt: new Date().toISOString(),
          });
        }
        logger.info('[MonitorAgent] Auto-closed timed-out workUnit', { workUnitId: exec.id.slice(0, 8), elapsedMin });
      } catch (dbErr) {
        logger.error('[MonitorAgent] Failed to update workUnit status', { workUnitId: exec.id.slice(0, 8), error: String(dbErr) });
      }
    } else if (elapsed > TIME_ESCALATE_MS) {
      alerts.push({
        source: 'total_time',
        level: 'warning',
        message: `WorkUnit ${exec.id} 执行超过 2h（Level 2）`,
        relatedTaskIds: [exec.id],
      });
    } else if (elapsed > TIME_WARN_MS) {
      alerts.push({
        source: 'total_time',
        level: 'info',
        message: `WorkUnit ${exec.id} 执行超过 1h（Level 1）`,
        relatedTaskIds: [exec.id],
      });
    }
  }

  return alerts;
}

// ── NA Step 7: 心跳丢失检测 ──

export async function checkHeartbeatLoss(): Promise<MonitorAlert[]> {
  // WorkUnit.updatedAt 作为心跳机制，workunit-timeout trigger 覆盖超时检测
  return [];
}

// ── NA Step 7: 24h 自动放弃 ──

export async function autoAbandonStaleBlocked(fileStore: FileStore): Promise<void> {
  const cutoff = new Date(Date.now() - BLOCKED_AUTO_ABANDON_MS);

  const stale = (await fileStore.getIndex({ status: 'blocked' }))
    .filter(s => new Date(s.createdAt).getTime() < cutoff.getTime())
    .slice(0, 20);

  for (const exec of stale) {
    logger.warn('[MonitorAgent] Auto-abandoning stale blocked workUnit', { workUnitId: exec.id });
    try {
      const current = (await fileStore.getIndex()).find(s => s.id === exec.id);
      if (current) {
        await fileStore.upsertSnapshot({ ...current, status: 'closed' });
      }
    } catch (e) {
      logger.error('[MonitorAgent] Failed to auto-abandon', { executionId: exec.id, error: String(e) });
    }
  }

  if (stale.length > 0) {
    logger.info('[MonitorAgent] Auto-abandoned', { count: stale.length });
  }
}

// ── Orphan execution 自动放弃（2.5h, 父 goal 已终态）──

export async function autoAbandonStaleRunning(): Promise<void> {
  // WorkUnit workunit-timeout trigger + checkFileConflicts 已覆盖孤儿清理
  return;
}

/**
 * Check shared session file size and age (optional, env-configurable).
 * Warns at >50MB or >3 days old. Runs every 5 min as part of the GC cycle.
 * Set SESSION_FILE_PATH to enable; skipped if not configured.
 */
export async function checkSessionFileHealth(): Promise<MonitorAlert[]> {
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
export async function checkReviewQuality(fileStore: FileStore): Promise<MonitorAlert[]> {
  const REVIEW_QUALITY_THRESHOLD = 75;
  const alerts: MonitorAlert[] = [];
  try {
    const cutoff = Date.now() - 7 * 24 * 3600_000;
    const recentWorkUnits = (await fileStore.getIndex({ status: 'done' }))
      .filter(s => new Date(s.updatedAt).getTime() >= cutoff)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, 20);

    for (const wu of recentWorkUnits) {
      const ctx = (typeof wu.metadata === 'string' ? JSON.parse(wu.metadata) : wu.metadata) || {};
      const reviewScore = ctx.reviewScore as number | undefined;
      const reviewCycle = (ctx.reviewCycle as number) || 1;

      if (reviewScore !== undefined && reviewScore > 0 && reviewScore < REVIEW_QUALITY_THRESHOLD) {
        alerts.push({
          projectId: wu.id.slice(0, 8),
          message: `WorkUnit ${wu.id.slice(0, 8)} review score ${reviewScore} < ${REVIEW_QUALITY_THRESHOLD} but approved. ${reviewCycle > 1 ? `(after ${reviewCycle} cycles)` : '(first cycle)'}. Review may be letting sub-par code through.`,
          source: 'review_quality',
          level: reviewScore < 50 ? 'critical' : 'warning',
          relatedTaskIds: [wu.id],
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
 * P2-1: Token budget check — WorkUnit 累计 token 超阈值告警
 */
export async function checkTokenBudget(fileStore: FileStore): Promise<MonitorAlert[]> {
  const TOKEN_BUDGET_WARN = 500_000;
  const TOKEN_BUDGET_CRIT = 1_000_000;
  const alerts: MonitorAlert[] = [];
  try {
    const validStatuses = new Set(['active', 'done', 'blocked']);
    const cutoff = Date.now() - 7 * 24 * 3600_000;
    const workUnits = (await fileStore.getIndex())
      .filter(s => validStatuses.has(s.status) && new Date(s.updatedAt).getTime() >= cutoff)
      .slice(0, 10);

    for (const wu of workUnits) {
      const ctx = (typeof wu.metadata === 'string' ? JSON.parse(wu.metadata) : wu.metadata) || {};
      const tokens = (ctx._cumulativeTokens as number) || 0;
      if (tokens >= TOKEN_BUDGET_CRIT) {
        alerts.push({
          projectId: wu.id.slice(0, 8),
          message: `WorkUnit ${wu.id.slice(0, 8)} exceeded critical token budget: ${(tokens / 1000).toFixed(0)}K tokens`,
          source: 'total_time',
          level: 'critical',
          relatedTaskIds: [wu.id],
          timestamp: Date.now(),
        });
      } else if (tokens >= TOKEN_BUDGET_WARN) {
        alerts.push({
          projectId: wu.id.slice(0, 8),
          message: `WorkUnit ${wu.id.slice(0, 8)} approaching token budget: ${(tokens / 1000).toFixed(0)}K tokens`,
          source: 'total_time',
          level: 'warning',
          relatedTaskIds: [wu.id],
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
export async function checkDeployPushFailed(fileStore: FileStore): Promise<MonitorAlert[]> {
  const alerts: MonitorAlert[] = [];
  try {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    let events: Array<{ payload: string | null; timestamp: Date }> = [];
    try {
      const allEvents = await fileStore.readJsonl<any>(studioEventsJsonl());
      events = allEvents
        .filter((e: any) => e.type === 'deploy_push_failed' && e.timestamp && new Date(e.timestamp).getTime() >= oneHourAgo.getTime())
        .sort((a: any, b: any) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
        .slice(0, 5)
        .map((e: any) => ({
          payload: typeof e.payload === 'string' ? e.payload : JSON.stringify(e.payload),
          timestamp: new Date(e.timestamp),
        }));
    } catch { /* no events file */ }
    for (const event of events) {
      let details: any = {};
      try { details = JSON.parse(event.payload || '{}'); } catch {}
      alerts.push({
        source: 'deploy_push_failed',
        level: 'critical',
        message: `Deploy push failed: ${details.error || 'unknown error'} (branch: ${details.branch || '?'})`,
        timestamp: event.timestamp.getTime(),
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
export async function checkProxyRestartExhausted(fileStore: FileStore): Promise<MonitorAlert[]> {
  const alerts: MonitorAlert[] = [];
  try {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    let events: Array<{ payload: string | null; timestamp: Date }> = [];
    try {
      const allEvents = await fileStore.readJsonl<any>(studioEventsJsonl());
      events = allEvents
        .filter((e: any) => e.type === 'proxy_restart_exhausted' && e.timestamp && new Date(e.timestamp).getTime() >= oneHourAgo.getTime())
        .sort((a: any, b: any) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
        .slice(0, 3)
        .map((e: any) => ({
          payload: typeof e.payload === 'string' ? e.payload : JSON.stringify(e.payload),
          timestamp: new Date(e.timestamp),
        }));
    } catch { /* no events file */ }
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

// ── P0.3: Tool Pattern Detection — 工具调用异常模式 ──

export async function checkToolPatterns(): Promise<MonitorAlert[]> {
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
