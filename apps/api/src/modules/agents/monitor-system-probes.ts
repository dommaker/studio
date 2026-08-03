/**
 * Monitor Agent — 系统/知识级探测与自修复
 *
 * 从 monitor.service.ts 拆分（探测/告警/报告分离，零行为变更）。
 * 本模块负责系统面检查：
 *   - B1-008: 系统健康探测（内存/磁盘/僵尸进程/CPU/存储）
 *   - 系统异常 3 次确认窗口 → Triage
 *   - worktree GC
 *   - P2a: 知识库健康评分 / 晋升 / 24h 衰减循环 / 用户模型更新
 *   - Circuit check → KnowledgeSync 自修复
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from '@dommaker/studio-shared';
import type { TriageIncidentInput } from './types.js';
import { triageService } from './triage.service.js';
import { KnowledgeLinter, KnowledgeHealthScorer, ReferenceTracker } from '@dommaker/harness';
import { sharedStore, sharedLifecycle } from '../knowledge/knowledge-bus.service.js';
import { knowledgeSync } from '../knowledge/knowledge-sync.service.js';
import { emitMonitorEvent } from './monitor-alerts.js';

const WORKTREES_DIR = process.env.WORKTREES_DIR || path.join(os.homedir(), 'worktrees');

// 系统健康确认窗口计数器（3 checks × 60s window）
const systemHealthCounters = new Map<string, { count: number; firstSeen: number }>();
const SYSTEM_HEALTH_CONFIRM_COUNT = 3;
const SYSTEM_HEALTH_CONFIRM_WINDOW_MS = 60 * 1000; // 60s between checks (Monitor polls every 5 min, so this is per-check, not per-second)

/**
 * 知识循环的实例级状态（由 MonitorService 实例持有并传入，保持 per-instance 语义）。
 */
export interface KnowledgeCycleState {
  lastDecayRun: number;
  lastUserModelRun: number;
}

/**
 * B7 F1 LLM 每日维护开关（2026-08-03 token 止血，docs/issues/2026-08-03-unattended-token-burn.md）：
 * KnowledgeCurator 每日维护（语义去重/质量评估/过期验证/矛盾审查）是日级 LLM 批调用，
 * 无人值守期间每天 + 每次进程重启各烧一波（实测单次 ~2M token），且不走 C3 预算闸。
 * 与 A 档停用的日级 LLM 触发器同类，默认停用；STUDIO_KNOWLEDGE_MAINTENANCE=on 显式开启。
 * 注意：lastDecayRun 为内存态，开启后每次重启会在首个 5-min check 立即重跑一波。
 */
export function knowledgeMaintenanceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.STUDIO_KNOWLEDGE_MAINTENANCE === 'on';
}

/**
 * GC: clean up stale git worktrees and orphaned task directories.
 * Non-blocking — runs as part of the 5-min check loop.
 */
export async function gcStaleWorktrees(): Promise<void> {
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
            logger.info('[MonitorService] GC removed stale worktree', { path: wtPath, age: Math.round((Date.now() - stat.mtimeMs) / 3600000) + 'h' });
          }
        } catch { /* skip */ }
      }
    }
  } catch (e) {
    // Non-blocking — GC failure must not crash the monitor loop, but MUST be logged
    logger.warn('[MonitorService] gcStaleWorktrees failed', { error: String(e) });
  }
}

/**
 * P2a: Knowledge base health check + decay cycle
 * - Health score: every 5 min (Monitor cycle), escalates to Triage if < 60
 * - Decay cycle: once per 24h, runs maturity decay + linter auto-fix
 */

/**
 * Circuit check → repair → write meta-knowledge to store.
 * Runs at MonitorService startup + hourly. Makes knowledge system self-documenting.
 */
export async function runCircuitCheckAndRepair(): Promise<void> {
  try {
    // KnowledgeSync: detect staleness + unmonitored + heal
    const syncResult = await knowledgeSync.runSyncCycle();
    if (syncResult.stale.length > 0 || syncResult.unmonitored.length > 0) {
      logger.warn('[MonitorService] KnowledgeSync detected issues', {
        staleScopes: syncResult.stale.map(s => ({ scope: s.scope, changedFiles: s.changedFiles, hours: s.stalenessHours })),
        unmonitored: syncResult.unmonitored.map(u => ({ scope: u.scope, reason: u.reason })),
        healed: syncResult.healed,
      });
    }
  } catch (e) {
    logger.warn('[MonitorService] KnowledgeSync check failed', { error: String(e) });
  }
}

export async function checkKnowledgeHealth(state: KnowledgeCycleState): Promise<void> {
  try {
    const tracker = new ReferenceTracker(sharedStore);
    const linter = new KnowledgeLinter(sharedStore, tracker);
    const doctor = new KnowledgeHealthScorer(sharedStore, linter);

    const { score, details } = doctor.healthScore();

    logger.info('[MonitorService] Knowledge health score', { score, issueCount: details.length });

    if (score < 60) {
      // Escalate to Triage
      triageService.handleAlert({
        type: 'knowledge_health_degraded',
        severity: 'warning',
        message: `知识库健康评分: ${score}/100`,
        details: { score, issues: details },
      }).catch(err => {
        logger.warn('[MonitorService] Knowledge health triage failed', { error: String(err) });
      });

      // Also emit as alert
      emitMonitorEvent({
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
          logger.info('[MonitorService] Knowledge promoted', { entryId: entry.id, from: result.from, to: result.to, reason: result.reason });
        }
      } catch { /* individual entry failure is non-blocking */ }
    }
    if (promoted > 0) {
      logger.info('[MonitorService] Knowledge promotion cycle completed', { promoted, scanned: allEntries.length });
    }

    // Daily cycle: decay + lint + LLM maintenance
    if (Date.now() - state.lastDecayRun > 24 * 60 * 60_000) {
      const decayChanges = sharedLifecycle.runDecayCycle();
      const lintReport = linter.run(true);
      state.lastDecayRun = Date.now();

      // F1: KnowledgeCurator LLM-powered maintenance (semantic dedup, quality, freshness, contradictions)
      try {
        const { knowledgeCurator } = await import('./knowledge-curator.service.js');
        const maintenance = await knowledgeCurator.runDailyMaintenance();
        logger.info('[MonitorService] KnowledgeCurator daily maintenance', maintenance);
      } catch (err) {
        logger.warn('[MonitorService] KnowledgeCurator maintenance failed', { error: String(err) });
      }

      logger.info('[MonitorService] Knowledge decay cycle completed', {
        decayChanges: decayChanges.length,
        autoFixed: lintReport.fixed,
      });

      if (decayChanges.length > 0) {
        emitMonitorEvent({
          type: 'monitor:info',
          source: 'knowledge_decay',
          message: `Decay: ${decayChanges.length} entries, Auto-fixed: ${lintReport.fixed} issues`,
          timestamp: Date.now(),
        });
      }
    }

    // User model update: once per 24h (alongside decay cycle)
    if (Date.now() - state.lastUserModelRun > 24 * 60 * 60_000) {
      state.lastUserModelRun = Date.now();
      try {
        const { execSync } = await import('child_process');
        const result = execSync('npx harness update-user-model --days 1 --json 2>/dev/null || echo "{}"', {
          encoding: 'utf-8', stdio: 'pipe', timeout: 30_000,
        }).trim();
        if (result && result !== '{}') {
          const data = JSON.parse(result);
          logger.info('[MonitorService] User model updated', { newSessions: (data as any).newSessions, changes: (data as any).changes?.length });
        }
      } catch (e: any) {
        logger.warn('[MonitorService] User model update failed (non-blocking)', { error: String(e) });
      }
    }
  } catch (err) {
    logger.warn('[MonitorService] Knowledge health check failed', { error: String(err) });
  }
}

// ── B1-008: System health check for Triage ──

export async function systemHealthCheck(): Promise<TriageIncidentInput[]> {
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

    // 5. CPU load average
    try {
      const loadAvg = os.loadavg();
      const cores = os.cpus().length;
      const load1m = loadAvg[0];
      if (load1m > cores * 4) {
        anomalies.push({
          type: 'resource_critical',
          severity: 'critical',
          message: `CPU overload: load ${load1m.toFixed(1)} on ${cores} cores (1m avg)`,
          details: { load1m, load5m: loadAvg[1], load15m: loadAvg[2], cores },
        });
      } else if (load1m > cores * 2) {
        anomalies.push({
          type: 'resource_critical',
          severity: 'warning',
          message: `CPU high: load ${load1m.toFixed(1)} on ${cores} cores (1m avg)`,
          details: { load1m, load5m: loadAvg[1], load15m: loadAvg[2], cores },
        });
      }
    } catch { /* ignore */ }

    // 6. Storage health check
    try {
      const probeFile = path.join(os.homedir(), '.studio', 'data', '_monitor_probe');
      await fs.promises.writeFile(probeFile, Date.now().toString());
      await fs.promises.unlink(probeFile);
    } catch {
      anomalies.push({
        type: 'ext_dependency',
        severity: 'critical',
        message: 'Storage access failed',
      });
    }
  } catch (e) {
    logger.warn('[MonitorService] System health check error', { error: String(e) });
  }

  return anomalies;
}

export async function systemTriageCheck(): Promise<void> {
  const anomalies = await systemHealthCheck();
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
        logger.error('[MonitorService] System anomaly confirmed, triggering Triage', {
          type: anomaly.type,
          confirmCount: prev.count,
        });
        systemHealthCounters.delete(key);

        // Fire-and-forget: triage runs async
        triageService.handleAlert(anomaly).catch(err => {
          logger.error('[MonitorService] Triage handleAlert failed', { error: String(err) });
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
      logger.info('[MonitorService] System anomaly resolved', { type: key, wasSeen: counter.count });
    }
  }
}
