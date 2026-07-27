/**
 * Monitor Agent — 告警分发 / Triage 升级 / 事件写入
 *
 * 从 monitor-agent.service.ts 拆分（探测/告警/报告分离，零行为变更）。
 * 本模块负责告警出口侧：
 *   - 告警日志分级 + studio.jsonl 事件写入 + notifyAlert 通知出口（P0 修复 4）
 *   - FL-037: critical 告警升级 Triage
 *   - H3: 告警写入 KnowledgeBus pattern
 */

import * as path from 'path';
import { logger, resolveEventsDir } from '@dommaker/studio-shared';
import { knowledgeService } from '../knowledge/knowledge-service.js';
import { notifyAlert } from '../../utils/notifier.js';
import type { MonitorAlert } from './types.js';
import { triageAgent } from './triage-agent.service.js';

/**
 * R2 事件目录统一: studio.jsonl 路径经 resolveEventsDir() 懒解析
 * （STUDIO_EVENTS_DIR > EVENTS_DIR > ~/.studio/events）。
 * 懒解析保证运行时/测试注入的 env 生效，且模块加载期不读 env。
 */
export function studioEventsJsonl(): string {
  return path.join(resolveEventsDir(), 'studio.jsonl');
}

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

/** Log all alerts + emit warning/critical to studio events file + notifyAlert 出口（频道 + 企业微信 webhook） */
export function dispatchMonitorAlerts(alerts: MonitorAlert[]): void {
  for (const alert of alerts) {
    if (alert.level === 'critical') {
      logger.error('[MonitorAgent] CRITICAL', alert);
    } else if (alert.level === 'warning') {
      logger.warn('[MonitorAgent] WARNING', alert);
    } else {
      logger.info('[MonitorAgent] INFO', alert);
    }
    // Emit to studio events file + 通知出口（P0 修复 4：频道 + 企业微信 webhook）
    if (alert.level === 'critical' || alert.level === 'warning') {
      try {
        emitMonitorEvent({ type: 'monitor:alert', ...alert, timestamp: Date.now() });
      } catch { /* non-blocking */ }
      // fire-and-forget：sink 失败仅记日志，不阻塞 check loop
      void notifyAlert(alert.level, `[Monitor] ${alert.source}`, alert.message)
        .catch(() => { /* non-blocking */ });
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
    stuck_workunits: 'execution_stuck',
    progress_stagnation: 'execution_progress_stagnation',
    tool_error_rate: null,
    tool_zero_success: null,
    session_file_size: null,
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
