/**
 * Monitor Agent — 告警分发 / Triage 升级 / 事件写入 / 心跳持久化
 *
 * 从 monitor-agent.service.ts 拆分（探测/告警/报告分离，零行为变更）。
 * 本模块负责告警出口侧：
 *   - 告警日志分级 + studio.jsonl 事件写入
 *   - FL-037: critical 告警升级 Triage
 *   - H3: 告警写入 KnowledgeBus pattern
 *   - 心跳记录与持久化恢复
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger, resolveEventsDir } from '@dommaker/studio-shared';
import { knowledgeService } from '../knowledge/knowledge-service.js';
import type { MonitorAlert } from './types.js';
import { triageAgent } from './triage-agent.service.js';

const HEARTBEAT_FILE = path.join(os.homedir(), '.studio', 'heartbeats.json');

/**
 * R2 事件目录统一: studio.jsonl 路径经 resolveEventsDir() 懒解析
 * （STUDIO_EVENTS_DIR > EVENTS_DIR > ~/.studio/events）。
 * 懒解析保证运行时/测试注入的 env 生效，且模块加载期不读 env。
 */
export function studioEventsJsonl(): string {
  return path.join(resolveEventsDir(), 'studio.jsonl');
}

// 上次检查时的进度快照（用于停滞检测）
const progressSnapshots = new Map<string, { completedCount: number; unchangedCount: number; lastHeartbeat: number }>();

export function emitMonitorEvent(data: Record<string, unknown>): void {
  try {
    const fs = require('fs');
    const path = require('path');
    const dir = resolveEventsDir(); // R2: 统一事件目录
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, 'studio.jsonl'),
      JSON.stringify(data) + '\n',
    );
  } catch { /* non-blocking */ }
}

/** Log all alerts + emit warning/critical to studio events file for Discord notification */
export function dispatchMonitorAlerts(alerts: MonitorAlert[]): void {
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
        emitMonitorEvent({ type: 'monitor:alert', ...alert, timestamp: Date.now() });
      } catch { /* non-blocking */ }
    }
  }
}

/**
 * FL-037: Map MonitorAlert.source → TriageIncidentInput.type
 * Only critical alerts are escalated. Fire-and-forget, does not block check loop.
 */
export function escalateToTriage(alerts: MonitorAlert[]): void {
  const sourceToType: Record<MonitorAlert['source'], import('./types.js').TriageIncidentType | null> = {
    failure_trend: 'execution_repeated_failure',
    session_escalation: 'execution_session_exhausted',
    total_time: 'execution_timeout',
    heartbeat_loss: 'execution_heartbeat_lost',
    stuck_workunits: 'execution_stuck',
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

/** H3: Write patterns to KnowledgeBus (Monitor→Auditor/KK→Analyst) */
export function recordAlertPatterns(alerts: MonitorAlert[]): void {
  for (const alert of alerts) {
    if (alert.level === 'critical' || alert.level === 'warning') {
      knowledgeService.recordPattern({
        type: alert.source.includes('tool') ? 'failure' : 'pattern',
        title: `[Monitor] ${alert.source}: ${alert.message.slice(0, 80)}`,
        content: alert.message,
        tags: ['monitor'],
      }).catch(() => { /* non-blocking */ });
    }
  }
}

/**
 * 🆕 记录心跳（由 agent.heartbeat 事件调用）+ 文件持久化
 */
export function recordHeartbeat(executionId: string): void {
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
export function loadPersistedHeartbeats(): void {
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
