/**
 * #183 派工/评审断链 5min 对账扫描（dispatch-reconciliation-scan handler 本体）。
 *
 * 对账哲学见根 CONTEXT.md「对账扫描」（#66 ReviewDispatcher / #159 analysis-handoff）：
 * 周期比对「应有 vs 实有」→ 幂等重跑自动补差集 → warning 事件走 #62 告警管线
 * （频道不出声，非终态迁移）；重跑记尝试数，3 次仍败停跑并升 critical。
 *
 * analysis 侧（#159 决议）：
 *   哨兵清单化（metadata.analysisTasksSpawned = 已建子 WU id 清单，analysis-handoff
 *   spawnTasks 落档）→ 对账比对 analysisTasks 补差集；补建前按 parentId+scope 查活体
 *   去重（create 成功但清单落档失败的极端窗口）；人工关闭的子 WU 仍在清单中 → 不复活；
 *   旧时间戳哨兵（仅 analysisTasksSpawnedAt、无清单）兼容跳过；哨兵落档 ≥10min 才
 *   参与对账（避开在飞 spawn）。事件 analysis.respawned，metadata.analysisRespawnAttempts
 *   记尝试数。
 *
 * review 侧（#66 决议①）：
 *   父 WU in_review 持续 ≥10min（以 updatedAt 为锚——in_review 态无簿记写入，锚定
 *   转入时刻）且无未完结 review 子 WU → 重跑幂等的路径 A（同父唯一性由 createGuarded
 *   锁内 guard 保证）。事件 review.redispatched，metadata.reviewRedispatchAttempts
 *   记尝试数。type=review/analysis/decision/spec 不参与（验收闸是人工 L3，同路径 A 口径）。
 *
 * 挂 5min 触发器（default-triggers.ts `dispatch-reconciliation`，timeout-scan 同类）；
 * 从 apps/api/src/index.ts 注册 handler，便于服务级测试。
 */
import { logger, FileStore } from '@dommaker/studio-shared';
import { WorkUnitService } from '../workunit/workunit.service.js';
import { DECISION_SPEC_TYPES } from '../workunit/workunit.types.js';
import { parseWuMetadata } from '../workunit/wu-metadata.js';
import { AnalysisHandoff } from '../pmo/analysis-handoff.js';
import { ReviewDispatcher } from './loop/review-dispatcher.js';
import { dispatchMonitorAlerts } from './monitor/monitor-alerts.js';
import { writeStudioEvent } from '../../utils/studio-events.js';
import type { MonitorAlertSource } from './types.js';

/** 对账宽限：哨兵落档 / 转入 in_review ≥10min 才参与对账（避开在飞 spawn/建单） */
export const RECONCILE_GRACE_MS = 10 * 60 * 1000;
/** 同一 WU 的对账重跑上限：连续失败达到后停跑并升 critical 引人介入 */
export const MAX_RECONCILE_ATTEMPTS = 3;

export interface ReconciliationResult {
  analysis: { scanned: number; respawned: number; gaveUp: number };
  review: { scanned: number; redispatched: number; gaveUp: number };
}

/** 结构化事件（studio-events.jsonl，带 level）+ #62 告警管线出口（告警频道 + Web 收件箱） */
function emitReconcileAlert(
  type: 'analysis.respawned' | 'review.redispatched',
  source: MonitorAlertSource,
  level: 'warning' | 'critical',
  message: string,
  payload: Record<string, unknown>,
): void {
  void writeStudioEvent(type, payload, { source: 'dispatch-reconciliation', level });
  dispatchMonitorAlerts([{ source, level, message }]);
}

/** 清尝试数（账实相符/自愈后归零；字段删除而非置 0，保持 metadata 干净） */
async function clearAttempts(fileStore: FileStore, wuId: string, field: 'analysisRespawnAttempts' | 'reviewRedispatchAttempts'): Promise<void> {
  await fileStore.updateMetadata(wuId, latest => {
    const next = { ...latest };
    delete next[field];
    return next;
  }).catch(err => logger.warn('[Reconciliation] clear attempts failed (non-blocking)', { wuId, field, error: String(err) }));
}

async function reconcileAnalysisRespawns(
  fileStore: FileStore,
  wuService: WorkUnitService,
  handoff: AnalysisHandoff,
  now: Date,
  result: ReconciliationResult,
): Promise<void> {
  const candidates = await wuService.list({ type: 'analysis', status: 'done', limit: 1000 });
  for (const wu of candidates.data) {
    const meta = parseWuMetadata(wu.metadata);
    // 旧时间戳哨兵兼容：无清单不参与对账（#159 存量查证账实相符，无需迁移）
    if (!Array.isArray(meta.analysisTasksSpawned)) continue;
    const sentinelAt = typeof meta.analysisTasksSpawnedAt === 'string' ? Date.parse(meta.analysisTasksSpawnedAt) : NaN;
    if (!Number.isFinite(sentinelAt) || now.getTime() - sentinelAt < RECONCILE_GRACE_MS) continue; // 10min 宽限
    const attempts = typeof meta.analysisRespawnAttempts === 'number' ? meta.analysisRespawnAttempts : 0;
    if (attempts >= MAX_RECONCILE_ATTEMPTS) continue; // 已停跑（critical 在达标轮已发，不重复刷告警）
    result.analysis.scanned++;

    try {
      const missing = await handoff.listMissingSpawnScopes(wu);
      if (missing.length === 0) {
        if (attempts > 0) await clearAttempts(fileStore, wu.id, 'analysisRespawnAttempts'); // 已账实相符
        continue;
      }

      const r = await handoff.respawnScopes(wu, missing);
      const healed = r.failedScopes.length === 0;
      const nextAttempts = healed ? 0 : attempts + 1;
      if (healed) {
        await clearAttempts(fileStore, wu.id, 'analysisRespawnAttempts');
      } else {
        await fileStore.updateMetadata(wu.id, latest => ({ ...latest, analysisRespawnAttempts: nextAttempts }));
      }

      const payload = {
        wuId: wu.id,
        missing: missing.length,
        created: r.createdIds.length,
        adopted: r.adoptedIds.length,
        failed: r.failedScopes.length,
        attempts: nextAttempts,
        outcome: healed ? 'healed' : 'failed',
      };
      if (!healed && nextAttempts >= MAX_RECONCILE_ATTEMPTS) {
        result.analysis.gaveUp++;
        emitReconcileAlert(
          'analysis.respawned', 'analysis_respawn', 'critical',
          `analysis WU ${wu.id} 派工断链对账补建连续 ${nextAttempts} 次失败（缺 ${missing.length} 项），已停跑，请人工介入`,
          payload,
        );
      } else {
        result.analysis.respawned++;
        emitReconcileAlert(
          'analysis.respawned', 'analysis_respawn', 'warning',
          healed
            ? `analysis WU ${wu.id} 派工断链自愈：补建 ${r.createdIds.length} 项、认养 ${r.adoptedIds.length} 项（应建 ${missing.length} 项缺失）`
            : `analysis WU ${wu.id} 派工断链补建部分失败（第 ${nextAttempts} 次，缺 ${missing.length} 项、败 ${r.failedScopes.length} 项）`,
          payload,
        );
      }
    } catch (err) {
      // 异常同样算一次失败（与 review 侧对称）：递增尝试数，达上限停跑升 critical
      const nextAttempts = attempts + 1;
      await fileStore.updateMetadata(wu.id, latest => ({ ...latest, analysisRespawnAttempts: nextAttempts }))
        .catch(e => logger.warn('[Reconciliation] persist analysis attempts failed', { wuId: wu.id, error: String(e) }));
      const payload = { wuId: wu.id, attempts: nextAttempts, outcome: 'failed', error: String(err) };
      if (nextAttempts >= MAX_RECONCILE_ATTEMPTS) {
        result.analysis.gaveUp++;
        emitReconcileAlert(
          'analysis.respawned', 'analysis_respawn', 'critical',
          `analysis WU ${wu.id} 派工断链对账连续 ${nextAttempts} 次异常，已停跑，请人工介入`,
          payload,
        );
      } else {
        emitReconcileAlert(
          'analysis.respawned', 'analysis_respawn', 'warning',
          `analysis WU ${wu.id} 派工断链对账异常（第 ${nextAttempts} 次）：${String(err).slice(0, 120)}`,
          payload,
        );
      }
    }
  }
}

async function reconcileReviewRedispatches(
  fileStore: FileStore,
  wuService: WorkUnitService,
  dispatcher: ReviewDispatcher,
  now: Date,
  result: ReconciliationResult,
): Promise<void> {
  const candidates = await wuService.list({ status: 'in_review', limit: 1000 });
  const snapshots = await fileStore.getIndex();
  for (const wu of candidates.data) {
    // 同路径 A 口径：review 不再被评审；analysis/decision/spec 验收闸是人工 L3
    if (wu.type === 'review' || wu.type === 'analysis' || DECISION_SPEC_TYPES.has(wu.type)) continue;
    if (!wu.channelId) continue; // 评审子 WU 经频道涌现认领，无频道必卡死（同 dispatchReviewNow 守卫）
    // in_review 持续 ≥10min（宽限避开在飞建单；updatedAt 为锚——in_review 态无簿记写入）
    if (now.getTime() - wu.updatedAt.getTime() < RECONCILE_GRACE_MS) continue;
    // 无未完结 review 子 WU 才重跑（同父唯一性；done/closed 的历史子单不挡）
    const hasUnfinished = snapshots.some(s =>
      s.parentId === wu.id && s.type === 'review' && s.status !== 'done' && s.status !== 'closed');
    if (hasUnfinished) continue;
    const meta = parseWuMetadata(wu.metadata);
    const attempts = typeof meta.reviewRedispatchAttempts === 'number' ? meta.reviewRedispatchAttempts : 0;
    if (attempts >= MAX_RECONCILE_ATTEMPTS) continue; // 已停跑
    result.review.scanned++;

    try {
      const child = await dispatcher.redispatchReview(wu);
      if (!child) {
        // 锁内 guard 拦截 = 并发方已抢建 → 账实相符，静默（不出声）
        if (attempts > 0) await clearAttempts(fileStore, wu.id, 'reviewRedispatchAttempts');
        continue;
      }
      if (attempts > 0) await clearAttempts(fileStore, wu.id, 'reviewRedispatchAttempts');
      result.review.redispatched++;
      emitReconcileAlert(
        'review.redispatched', 'review_redispatch', 'warning',
        `父 WU ${wu.id} in_review 断链自愈：重跑评审派工，已建评审子 WU ${child.id}`,
        { parentId: wu.id, childId: child.id, attempts: 0, outcome: 'redispatched' },
      );
    } catch (err) {
      const nextAttempts = attempts + 1;
      await fileStore.updateMetadata(wu.id, latest => ({ ...latest, reviewRedispatchAttempts: nextAttempts }))
        .catch(e => logger.warn('[Reconciliation] persist review attempts failed', { wuId: wu.id, error: String(e) }));
      const payload = { parentId: wu.id, attempts: nextAttempts, outcome: 'failed', error: String(err) };
      if (nextAttempts >= MAX_RECONCILE_ATTEMPTS) {
        result.review.gaveUp++;
        emitReconcileAlert(
          'review.redispatched', 'review_redispatch', 'critical',
          `父 WU ${wu.id} review 断链重跑连续 ${nextAttempts} 次失败，已停跑，请人工介入`,
          payload,
        );
      } else {
        emitReconcileAlert(
          'review.redispatched', 'review_redispatch', 'warning',
          `父 WU ${wu.id} review 断链重跑失败（第 ${nextAttempts} 次）：${String(err).slice(0, 120)}`,
          payload,
        );
      }
    }
  }
}

/**
 * 对账扫描入口（dispatch-reconciliation-scan handler）。
 * 两侧各自容错：一侧异常不影响另一侧；单 WU 异常不影响其余。
 */
export async function reconcileDispatchBreaks(fs?: FileStore, now: Date = new Date()): Promise<ReconciliationResult> {
  const fileStore = fs ?? new FileStore();
  const wuService = new WorkUnitService(fileStore);
  const handoff = new AnalysisHandoff(fileStore, wuService);
  const dispatcher = new ReviewDispatcher(fileStore, wuService);

  const result: ReconciliationResult = {
    analysis: { scanned: 0, respawned: 0, gaveUp: 0 },
    review: { scanned: 0, redispatched: 0, gaveUp: 0 },
  };

  await reconcileAnalysisRespawns(fileStore, wuService, handoff, now, result).catch(err =>
    logger.warn('[Reconciliation] analysis side scan failed (non-blocking)', { error: String(err) }),
  );
  await reconcileReviewRedispatches(fileStore, wuService, dispatcher, now, result).catch(err =>
    logger.warn('[Reconciliation] review side scan failed (non-blocking)', { error: String(err) }),
  );

  const acted = result.analysis.respawned + result.analysis.gaveUp + result.review.redispatched + result.review.gaveUp;
  if (acted > 0) {
    logger.info('[Reconciliation] dispatch breaks reconciled', result as unknown as Record<string, unknown>);
  }
  return result;
}
