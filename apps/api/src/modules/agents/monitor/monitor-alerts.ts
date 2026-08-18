/**
 * Monitor Agent — 告警分发 / Triage 升级 / 事件写入
 *
 * 从 monitor.service.ts 拆分（探测/告警/报告分离，零行为变更）。
 * 本模块负责告警出口侧：
 *   - 告警日志分级 + 统一事件写入（D18: utils/studio-events）+ notifyAlert 通知出口（P0 修复 4）
 *   - FL-037: critical 告警升级 Triage
 *   - H3: 告警写入 KnowledgeBus pattern
 */

import { logger, ALERT_COOLDOWN_WARN_MS, ALERT_COOLDOWN_CRIT_MS, ALERT_COOLDOWN_GC_MS } from '@dommaker/studio-shared';
import { knowledgeService } from '../../knowledge/knowledge-service.js';
import { notifyAlert } from '../../../utils/notifier.js';
import type { MonitorAlert } from '../types.js';
import { triageService } from '../triage/triage.service.js';
import { resolveStudioEventsFile, writeStudioEvent } from '../../../utils/studio-events.js';

// ── 告警指纹冷却去重（#220，#218 决议）──
// 进程内存态，不落盘：FileStore 故障本身是告警条件之一，落盘 = 循环依赖。
// API 重启清零、活跃条件一次性补发一轮为已接受代价。

export interface AlertCooldownEntry {
  lastEmitAt: number;
  lastLevel: MonitorAlert['level'];
  lastSeenAt: number;
}

/** 冷却表：fingerprint → 条目。导出供测试 clear()/观察 */
export const alertCooldownState = new Map<string, AlertCooldownEntry>();

/**
 * 指纹 = source + subject。回退链：subject → relatedTaskIds[0] → source 单车道
 * （聚合探针 failure_trend/池滞留/in_review 滞留天然单车道）。
 * message 文本含周期变量（分钟数/计数），不作指纹成分。
 */
export function alertFingerprint(alert: MonitorAlert): string {
  return `${alert.source}:${alert.subject ?? alert.relatedTaskIds?.[0] ?? ''}`;
}

/**
 * 冷却过滤器：同指纹 warning 4h / critical 1h 内只出声一次。
 * 级别升级（上次非 critical 本轮 critical）无视冷却立即出声并重置计时；
 * 同级内容漂移压掉；降级不动作（按当前级别冷却继续压）。
 * 被压制条目打 debug 级日志（不进事件流）。惰性 GC：超 24h 未见的条目删除。
 */
export function filterCooldownAlerts(alerts: MonitorAlert[], now: number = Date.now()): MonitorAlert[] {
  // 惰性 GC：超窗未见的条目删除（lastSeenAt 每轮刷新，持续出现的条目不 GC）
  for (const [fp, entry] of alertCooldownState) {
    if (now - entry.lastSeenAt > ALERT_COOLDOWN_GC_MS) alertCooldownState.delete(fp);
  }
  const out: MonitorAlert[] = [];
  for (const alert of alerts) {
    const fp = alertFingerprint(alert);
    const entry = alertCooldownState.get(fp);
    if (!entry) {
      alertCooldownState.set(fp, { lastEmitAt: now, lastLevel: alert.level, lastSeenAt: now });
      out.push(alert);
      continue;
    }
    entry.lastSeenAt = now;
    const upgraded = alert.level === 'critical' && entry.lastLevel !== 'critical';
    const cooldownMs = alert.level === 'critical' ? ALERT_COOLDOWN_CRIT_MS : ALERT_COOLDOWN_WARN_MS;
    if (!upgraded && now - entry.lastEmitAt < cooldownMs) {
      logger.debug('[MonitorService] Alert suppressed by cooldown', {
        fingerprint: fp, level: alert.level, source: alert.source,
      });
      continue;
    }
    entry.lastEmitAt = now;
    entry.lastLevel = alert.level;
    out.push(alert);
  }
  return out;
}

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
 * data.level 为合法级别时同时落 envelope level（#184：读取侧 level 过滤只认
 * envelope，否则告警收件箱 level≥warning 查询恒空）；payload 侧保留 level 兼容既有读者。
 * fire-and-forget：写盘失败/空 payload 仅记日志，不阻塞 check loop。
 */
export function emitMonitorEvent(data: Record<string, unknown>): void {
  const { type, ...rest } = data;
  if (typeof type !== 'string' || !type) return;
  const level = rest.level;
  const envelopeLevel = level === 'debug' || level === 'warning' || level === 'critical' ? level : undefined;
  void writeStudioEvent(type, rest, { source: 'monitor', ...(envelopeLevel ? { level: envelopeLevel } : {}) });
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
    lock: null, // #169: lock 告警不设 critical，无需 Triage 映射
    wu_index_reconcile: null, // #170：对账分叉已自动重建，无需 Triage 升级
    agent_timeout_scan: 'execution_heartbeat_lost', // #179：疑似 FileStore 故障（仅 critical 才升级，本告警为 warning 不触发）
    pool_stagnation: null, // #181：滞留告警不升级 Triage（决策 #62：不发明新出口）
    review_stagnation: null, // #181：同上
    analysis_respawn: null, // #183：critical 引人介入走告警管线本身，不升级 Triage
    review_redispatch: null, // #183：同上
    analysis_confirm: null, // #186：人工动作队列走收件箱本身，不升级 Triage（决策 #62：不发明新出口）
    stale_claim_guard: null, // #221：观察层守卫告警不升级 Triage（同 pool_stagnation，决策 #62：不发明新出口）
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
