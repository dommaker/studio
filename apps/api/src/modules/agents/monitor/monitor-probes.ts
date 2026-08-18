/**
 * Monitor Agent — 任务/WorkUnit 级探测
 *
 * 从 monitor.service.ts 拆分（探测/告警/报告分离，零行为变更）。
 * 本模块负责产生 MonitorAlert 的各项任务级检查：
 *   - 失败趋势（#181 起改读统一事件流）/ 进度停滞 / 总执行时间（含主动终止）
 *   - 池滞留 / in_review 滞留（#181）/ blocked 24h 自动放弃 / 会话文件健康 / 工具调用异常模式
 */

import * as fs from 'fs';
import { logger } from '@dommaker/studio-shared';
import type { FileStore } from '@dommaker/studio-shared';
import {
  POOL_STAGNATION_WARN_MS,
  POOL_STAGNATION_CRIT_MS,
  REVIEW_STAGNATION_WARN_MS,
  REVIEW_STAGNATION_CRIT_MS,
  isStaleClaimSleep,
} from '@dommaker/studio-shared';
import { agentRunner } from '@dommaker/studio-agent';
import type { MonitorAlert } from '../types.js';
import { closeWorkUnitWithNotice } from '../../workunit/wu-closure.js';
import { buildDeadLetterNotice } from '../../workunit/blocked-cta.js';
import { parseWuMetadata } from '../../workunit/wu-metadata.js';
import { DECISION_SPEC_TYPES } from '../../workunit/workunit.types.js';
import { getStudioEventTime, parseStudioEventPayload, readStudioEvents } from '../../../utils/studio-events.js';

const FAILURE_THRESHOLD = 3;

// NA Step 7: 告警阈值
const PROGRESS_STAGNATION_WARN = 3;  // 连续 3 次无进展 → Level 1
const PROGRESS_STAGNATION_CRIT = 6;  // 连续 6 次无进展 → Level 2
const TIME_WARN_MS = 60 * 60 * 1000;       // 1h → Level 1
const TIME_ESCALATE_MS = 2 * 60 * 60 * 1000; // 2h → Level 2
const TIME_CRITICAL_MS = 2.5 * 60 * 60 * 1000; // 2.5h → Level 3
const BLOCKED_AUTO_ABANDON_MS = 24 * 60 * 60 * 1000; // 24h

// #181（决策 #62 D2 + #167③）：WU 维度滞留阈值（初版配置，上线后调）--
// 常量正本在 studio-shared/constants/monitoring（#209 smell 3：与 Web 下钻口径同源）

/** 滞留双阈值定级：>crit → critical；>warn → warning；否则不出声（#209 smell 1 共享） */
function stagnationLevel(stalledMs: number, warnMs: number, critMs: number): 'critical' | 'warning' | null {
  if (stalledMs > critMs) return 'critical';
  if (stalledMs > warnMs) return 'warning';
  return null;
}

// ── #181（决策 #62 D2）：失败趋势改读统一事件流 ──

/**
 * 失败趋势：近 1h 的 `workunit:failed`（WU 终态失败）+ `workunit:execution_step`
 * （status=failed 失败步）计数。阈值语义维持旧探针：失败 ≥3 次 → warning；
 * 失败率 >50% 且样本（失败 + 成功步）≥5 → critical。
 * 旧 data/tasks 目录读取已删除（WU 时代空转）。fileStore 形参保留以统一探针签名。
 */
export async function checkFailureTrend(_fileStore: FileStore): Promise<MonitorAlert[]> {
  const alerts: MonitorAlert[] = [];
  const cutoff = Date.now() - 60 * 60 * 1000;

  const events = await readStudioEvents();
  let wuFailed = 0;
  let stepFailed = 0;
  let stepSucceeded = 0;
  const failedWuIds = new Set<string>();

  for (const event of events) {
    const t = getStudioEventTime(event);
    if (!Number.isFinite(t) || t < cutoff) continue;

    if (event.type === 'workunit:failed') {
      wuFailed++;
      const payload = parseStudioEventPayload<{ workUnitId?: string }>(event);
      if (payload?.workUnitId) failedWuIds.add(payload.workUnitId);
    } else if (event.type === 'workunit:execution_step') {
      const payload = parseStudioEventPayload<{ status?: string; workUnitId?: string }>(event);
      if (payload?.status === 'failed') {
        stepFailed++;
        if (payload.workUnitId) failedWuIds.add(payload.workUnitId);
      } else if (payload?.status === 'success') {
        stepSucceeded++;
      }
    }
  }

  const failedCount = wuFailed + stepFailed;
  const sample = failedCount + stepSucceeded;

  if (failedCount >= FAILURE_THRESHOLD) {
    alerts.push({
      source: 'failure_trend',
      level: 'warning',
      subject: 'global', // #220：聚合单车道——relatedTaskIds 首位随 churn 轮换，不作指纹；与 critical 同 subject 升级才生效
      message: `最近 1 小时内有 ${failedCount} 次失败（WU 终态 ${wuFailed} + 失败步 ${stepFailed}）`,
      relatedTaskIds: [...failedWuIds].slice(0, 20),
    });
  }

  const failureRate = sample > 0 ? failedCount / sample : 0;
  if (failureRate > 0.5 && sample >= 5) {
    alerts.push({
      source: 'failure_trend',
      level: 'critical',
      subject: 'global', // #220：与 warning 同车道
      message: `任务失败率 ${(failureRate * 100).toFixed(0)}%（${failedCount}/${sample}），需要关注`,
    });
  }

  return alerts;
}

// ── #181（决策 #62 D2）：池滞留探测 ──

/**
 * 池滞留：扫 status=unassigned，按最老一条滞留时长（createdAt 起计）告警——
 * >2h warning / >12h critical。指名未认领（assigneeId=profile id，等特定 loop 认领）
 * 与无人认领池（assigneeId=null）分开出声：前者是「被指名的 loop 没来领」，后者是「无人认领」。
 */
export async function checkPoolStagnation(fileStore: FileStore): Promise<MonitorAlert[]> {
  const alerts: MonitorAlert[] = [];
  const unassigned = await fileStore.getIndex({ status: 'unassigned' });

  const groups: Array<{ label: string; items: typeof unassigned }> = [
    { label: '无人认领', items: unassigned.filter(w => !w.assigneeId) },
    { label: '指名未认领', items: unassigned.filter(w => w.assigneeId) },
  ];

  for (const { label, items } of groups) {
    if (items.length === 0) continue;
    const oldest = items.reduce((a, b) => (new Date(a.createdAt).getTime() <= new Date(b.createdAt).getTime() ? a : b));
    const stalledMs = Date.now() - new Date(oldest.createdAt).getTime();
    const hours = Math.floor(stalledMs / 3_600_000);
    const designated = oldest.assigneeId ? `（@${oldest.assigneeId}）` : '';

    const level = stagnationLevel(stalledMs, POOL_STAGNATION_WARN_MS, POOL_STAGNATION_CRIT_MS);
    if (level) {
      alerts.push({
        source: 'pool_stagnation',
        level,
        subject: label, // #220：桶级车道（指名/未指名不互吞）；oldest.id 随认领轮换，不作指纹
        message: `未认领池滞留：${label} WU 最老 ${oldest.id}${designated} 已滞留 ${hours}h（共 ${items.length} 条）`,
        relatedTaskIds: [oldest.id],
      });
    }
  }

  return alerts;
}

// ── #181（决策 #167③）：in_review 滞留探测 ──

/**
 * in_review 滞留：人工确认队列以天计（不对齐池滞留 2h/12h）——
 * 最老一条（updatedAt = 进入 in_review 的最近流转时间）>24h warning / >72h critical。
 */
export async function checkReviewStagnation(fileStore: FileStore): Promise<MonitorAlert[]> {
  const alerts: MonitorAlert[] = [];
  const inReview = await fileStore.getIndex({ status: 'in_review' });
  if (inReview.length === 0) return alerts;

  const oldest = inReview.reduce((a, b) => (new Date(a.updatedAt).getTime() <= new Date(b.updatedAt).getTime() ? a : b));
  const stalledMs = Date.now() - new Date(oldest.updatedAt).getTime();
  const hours = Math.floor(stalledMs / 3_600_000);

  const level = stagnationLevel(stalledMs, REVIEW_STAGNATION_WARN_MS, REVIEW_STAGNATION_CRIT_MS);
  if (level) {
    alerts.push({
      source: 'review_stagnation',
      level,
      subject: 'global', // #220：聚合单车道——oldest.id 随确认轮换，不作指纹
      message: `in_review 滞留：WU ${oldest.id} 待人工确认已 ${hours}h（共 ${inReview.length} 条）`,
      relatedTaskIds: [oldest.id],
    });
  }

  return alerts;
}

// ── #221（#214 决议）：认领陈旧守卫告警探针 ──

/**
 * 认领陈旧守卫：扫 status=unassigned 且 updatedAt 超 STALE_CLAIM_GUARD_MS（72h）的 WU
 * ——它们已被 observe 可见性层拦截（任何 loop 都看不见、不会认领），此处负责首次拦截出声。
 * 探测由探针做、observe 保持纯过滤（issue #221 开放点决策：与 #62 体系同构）。
 *
 * 防重复（双保险）：
 *   1. 落盘：metadata.staleGuardBlockedAt 记拦截时的 updatedAt，与当前 updatedAt 一致 = 本次
 *      沉睡已出过声。写走 #65-1 锁内字段级合并 mutator，且 touchUpdatedAt:false——守卫自身
 *      的标记写不能刷新 updatedAt（任何 updatedAt 刷新 = 复活语义，守卫复活僵尸则防线失效）。
 *   2. 内存：#220 冷却指纹 = source+subject（subject=wuId），同 WU 同轮/跨轮只出声一条。
 * WU 被任何外部写刷新 updatedAt 后复活（零新增机制）；再次沉睡超阈值（updatedAt ≠ 落盘标记）
 * 重新告警。不自动关闭/迁移沉睡 WU，CTA 对齐 #57/#87 既有入口（回复即复活 / 回复「关闭」）。
 */
export async function checkStaleClaimGuard(fileStore: FileStore): Promise<MonitorAlert[]> {
  const alerts: MonitorAlert[] = [];
  const now = Date.now();
  // 先排除已出声者再截断：已标记 WU 永不认领、长期占据 index 前部，
  // 先 slice 会让第 21 条起的新沉睡 WU 永久静默（#221 review 修复）。
  const pending = (await fileStore.getIndex({ status: 'unassigned' }))
    .filter(s => isStaleClaimSleep(s.updatedAt, now))
    .filter(s => parseWuMetadata(s.metadata).staleGuardBlockedAt !== s.updatedAt) // 本次沉睡已出过声
    .slice(0, 20); // 周期上限只压未出声者，防存量清点刷屏

  for (const s of pending) {
    const written = await fileStore.updateMetadata(
      s.id,
      latest => ({ ...latest, staleGuardBlockedAt: s.updatedAt }),
      { touchUpdatedAt: false },
    );
    // 扫描到取锁之间 WU 被外部写复活（updatedAt 已变）→ 本轮不出声；
    // 落盘标记与现 updatedAt 不一致，若再沉睡下轮会正常告警（自愈）。
    if (!written || written.updatedAt !== s.updatedAt) continue;
    const days = Math.floor((now - new Date(s.updatedAt).getTime()) / 86_400_000);
    const designated = s.assigneeId ? `（指名 @${s.assigneeId}）` : '';
    alerts.push({
      source: 'stale_claim_guard',
      level: 'warning',
      subject: s.id, // #220 指纹含 wuId：同 WU 一条车道
      message: `认领陈旧守卫：WU ${s.id}${designated} 已沉睡 ${days} 天（updatedAt 超 72h 未动），`
        + '已在认领可见性层拦截，不会被任何 loop 认领。'
        + '回复该 WU 即复活（任何写刷新 updatedAt 后恢复可认领）；确认无需执行请回复「关闭」。',
      relatedTaskIds: [s.id],
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
        logger.info('[MonitorService] Stopped timed-out workUnit', { workUnitId: exec.id.slice(0, 8), elapsedMin });
      } catch (stopErr) {
        logger.warn('[MonitorService] Failed to stop workUnit process', { workUnitId: exec.id.slice(0, 8), error: String(stopErr) });
      }
      // 推向终态（closed）必须双出声（#176，决策 #62 §3）：结构化事件 + 频道说明，
      // 统一走 wu-closure 出口（#170 锁内成对写在其内部保持）
      try {
        const current = (await fileStore.getIndex()).find(s => s.id === exec.id);
        if (current) {
          await closeWorkUnitWithNotice(fileStore, current, {
            reason: `执行超过 2.5h（已 ${elapsedMin} 分钟），系统强制关闭`,
            closedBy: 'total-time-kill',
          });
        }
        logger.info('[MonitorService] Auto-closed timed-out workUnit', { workUnitId: exec.id.slice(0, 8), elapsedMin });
      } catch (dbErr) {
        logger.error('[MonitorService] Failed to update workUnit status', { workUnitId: exec.id.slice(0, 8), error: String(dbErr) });
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

// ── NA Step 7: 24h 自动放弃（死信） ──

/**
 * #176（决策 #57 D4）：死信计时基准从 createdAt 改为 metadata.blockedAt
 * （修掉「创建超 24h 的 WU 刚 blocked 就被秒关」bug；无 blockedAt 的存量档案回退 createdAt）。
 * 全 blocked 类型统一适用；decision/spec 豁免（#108 裁剪状态机无 closed，可等关键人多天）。
 * 关闭必须双出声（决策 #62 §3）：workunit:closed 结构化事件 + 频道死信通知
 * （已关闭 + 后续出路），统一走 wu-closure 出口，不再静默改状态。
 */
export async function autoAbandonStaleBlocked(fileStore: FileStore): Promise<void> {
  const cutoff = Date.now() - BLOCKED_AUTO_ABANDON_MS;

  const stale = (await fileStore.getIndex({ status: 'blocked' }))
    .filter(s => !DECISION_SPEC_TYPES.has(s.type))
    .filter(s => {
      const blockedAt = parseWuMetadata(s.metadata).blockedAt;
      const basis = new Date(typeof blockedAt === 'string' ? blockedAt : s.createdAt).getTime();
      return Number.isFinite(basis) && basis < cutoff;
    })
    .slice(0, 20);

  for (const exec of stale) {
    logger.warn('[MonitorService] Auto-abandoning stale blocked workUnit', { workUnitId: exec.id });
    try {
      const current = (await fileStore.getIndex()).find(s => s.id === exec.id);
      if (current && current.status === 'blocked') {
        const meta = parseWuMetadata(current.metadata);
        const title = (meta.title ?? current.scope ?? current.id).slice(0, 50);
        await closeWorkUnitWithNotice(fileStore, current, {
          reason: 'blocked 超 24h 无人工介入，自动关闭',
          closedBy: 'auto-abandon-stale-blocked',
          message: buildDeadLetterNotice(title, meta.blockReason),
        });
      }
    } catch (e) {
      logger.error('[MonitorService] Failed to auto-abandon', { executionId: exec.id, error: String(e) });
    }
  }

  if (stale.length > 0) {
    logger.info('[MonitorService] Auto-abandoned', { count: stale.length });
  }
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

// ── P0.3: Tool Pattern Detection — 工具调用异常模式 ──

export async function checkToolPatterns(): Promise<MonitorAlert[]> {
  const alerts: MonitorAlert[] = [];
  try {
    const { toolRegistry } = await import('../../mcp/tool-registry.js');
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
          subject: toolName, // #220：指纹主体 = 工具名，不同工具互不吞并
          message: `Tool "${toolName}" error rate ${Math.round(errorRate * 100)}% (${stats.errorCalls}/${totalCalls} calls)`,
          timestamp: Date.now(),
        });
      }

      // 工具零调用超过 5 次总调用（可能卡住或受限）
      if (stats.successCalls === 0 && totalCalls >= 10) {
        alerts.push({
          source: 'tool_zero_success',
          level: 'warning',
          subject: toolName, // #220：指纹主体 = 工具名
          message: `Tool "${toolName}" has zero successful calls in ${totalCalls} attempts`,
          timestamp: Date.now(),
        });
      }
    }
  } catch (e) {
    logger.warn('[MonitorService] Tool pattern check failed', { error: String(e) });
  }
  return alerts;
}
