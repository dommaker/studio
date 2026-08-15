/**
 * Monitor Agent — 告警分发 / Triage 升级 / 事件写入
 *
 * 从 monitor.service.ts 拆分（探测/告警/报告分离，零行为变更）。
 * 本模块负责告警出口侧：
 *   - 告警日志分级 + 统一事件写入（D18: utils/studio-events）+ notifyAlert 通知出口（P0 修复 4）
 *   - FL-037: critical 告警升级 Triage
 *   - H3: 告警写入 KnowledgeBus pattern
 */

import { logger } from '@dommaker/studio-shared';
import { knowledgeService } from '../../knowledge/knowledge-service.js';
import { notifyAlert } from '../../../utils/notifier.js';
import type { MonitorAlert } from '../types.js';
import { triageService } from '../triage/triage.service.js';
import { resolveStudioEventsFile, writeStudioEvent } from '../../../utils/studio-events.js';

/**
 * D18 事件入口统一：事件文件 = ~/.studio/logs/studio-events.jsonl
 * （测试期经 studio-log-path 隔离）。保留本函数名以兼容既有调用方/测试。
 */
export function studioEventsJsonl(): string {
  return resolveStudioEventsFile();
}

/**
 * 统一事件写入（D18）：data.type 作为事件类型，其余字段作为 payload
 * （StudioEvent 形态 { type, source: 'monitor', payload, createdAt }）。
 * fire-and-forget：写盘失败/空 payload 仅记日志，不阻塞 check loop。
 */
export function emitMonitorEvent(data: Record<string, unknown>): void {
  const { type, ...rest } = data;
  if (typeof type !== 'string' || !type) return;
  void writeStudioEvent(type, rest, { source: 'monitor' });
}

/** Log all alerts + emit warning/critical to studio events file + notifyAlert 出口（频道 + 企业微信 webhook） */
export function dispatchMonitorAlerts(alerts: MonitorAlert[]): void {
  for (const alert of alerts) {
    if (alert.level === 'critical') {
      logger.error('[MonitorService] CRITICAL', alert);
    } else if (alert.level === 'warning') {
      logger.warn('[MonitorService] WARNING', alert);
    } else {
      logger.info('[MonitorService] INFO', alert);
    }
    // Emit to studio events file + 通知出口（P0 修复 4：频道 + 企业微信 webhook）
    if (alert.level === 'critical' || alert.level === 'warning') {
      try {
        emitMonitorEvent({ type: 'monitor:alert', ...alert });
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
  const sourceToType: Record<MonitorAlert['source'], import('../types.js').TriageIncidentType | null> = {
    failure_trend: 'execution_repeated_failure',
    session_escalation: 'execution_session_exhausted',
    total_time: 'execution_timeout',
    stuck_workunits: 'execution_stuck',
    progress_stagnation: 'execution_progress_stagnation',
    tool_error_rate: null,
    tool_zero_success: null,
    session_file_size: null,
    wu_index_reconcile: null, // #170：对账分叉已自动重建，无需 Triage 升级
  };

  for (const alert of alerts) {
    if (alert.level !== 'critical') continue;

    const incidentType = sourceToType[alert.source];
    if (!incidentType) continue;

    triageService.handleAlert({
      type: incidentType,
      severity: 'critical',
      message: alert.message,
      details: {
        projectId: alert.projectId,
        relatedTaskIds: alert.relatedTaskIds,
        monitorSource: alert.source,
      },
    }).catch(err => {
      logger.error('[MonitorService] Triage escalation failed', {
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
