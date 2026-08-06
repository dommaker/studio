/**
 * P0 修复（WU 超时机制）：workunit-timeout 触发器的 EXECUTE handler。
 *
 * 扫描执行超时的 WorkUnit（status=active 且 timeoutAt ≤ now，timeoutAt 由 claim 写入）：
 *  - 释放回 unassigned（清 assigneeId/claimedAt/timeoutAt），记 metadata.timeoutReleasedAt
 *    + timeoutReleaseCount，并向所在频道发系统消息说明任务因超时已释放回池；
 *  - 释放次数 ≥ MAX_TIMEOUT_RELEASES → 不再回池，改 blocked 并频道说明，等待人工介入。
 *
 * 基准时间在每次 tick 现算（handler 入参 now），不再冻结在触发器注册时。
 * 频道系统消息走 wu-messenger 统一出口（eventBus + SSE，挂 anchor 线程）。
 */
import { logger, FileStore } from '@dommaker/studio-shared';
import { WorkUnitService, type WorkUnitMetadata } from './workunit.service.js';
import { postWuSystemMessage } from './wu-messenger.js';

/** 同一 WU 的超时释放上限：达到后转 blocked，等待人工介入 */
export const MAX_TIMEOUT_RELEASES = 3;

/**
 * 扫描并处理执行超时的 WorkUnit（workunit-timeout-scan handler）。
 * @returns 本次处理的超时 WU 数（释放回池 + 转 blocked）
 */
export async function scanTimedOutWorkUnits(fs?: FileStore, now: Date = new Date()): Promise<number> {
  const fileStore = fs ?? new FileStore();
  const wuService = new WorkUnitService(fileStore);

  const timedOut = await wuService.list({ status: 'active', timedOutBefore: now, limit: 1000 });
  let handled = 0;

  for (const wu of timedOut.data) {
    try {
      const metadata = (wu.metadata ? JSON.parse(wu.metadata) : {}) as WorkUnitMetadata;
      const releases = (metadata.timeoutReleaseCount ?? 0) + 1;
      const isoNow = now.toISOString();
      const title = (metadata.title ?? wu.scope).slice(0, 50);
      const nextMetadata: WorkUnitMetadata = {
        ...metadata,
        timeoutReleasedAt: isoNow,
        timeoutReleaseCount: releases,
        // B4: blocked 原因落盘（2026-08-03 token-burn issue P0-2）
        ...(releases >= MAX_TIMEOUT_RELEASES
          ? { blockReason: `timeout: ${releases} 次执行超时释放，不再回池` }
          : {}),
      };

      if (releases >= MAX_TIMEOUT_RELEASES) {
        // 释放次数用尽 → blocked，不再自动回池（清 timeoutAt 避免重复命中）
        await wuService.update(wu.id, { timeoutAt: null, metadata: nextMetadata });
        await wuService.transitionStatus(wu.id, 'blocked');
        // 2026-07 PMO-flow UX（§6-3）：blocked 转人工里程碑 —— meta 带 pmoId（可解析时）+ atHuman
        // wu 参数带 nextMetadata 视图（pmoId 解析以最新落档为准）
        await postWuSystemMessage(
          { ...wu, metadata: JSON.stringify(nextMetadata) },
          `任务「${title}」已 ${releases} 次执行超时被释放回池，转为 blocked，请人工介入处理`,
          { milestone: true, fileStore },
        );
      } else {
        // 释放回 unassigned（unclaim 清 assigneeId/claimedAt），清 timeoutAt 等待重新认领后重写
        await wuService.unclaim(wu.id);
        await wuService.update(wu.id, { timeoutAt: null, metadata: nextMetadata });
        await postWuSystemMessage(
          wu,
          `任务「${title}」执行超时（第 ${releases} 次），已释放回任务池等待重新认领`,
          { fileStore },
        );
      }
      handled++;
    } catch (err) {
      logger.warn('[WorkUnitTimeout] Failed to handle timed-out WorkUnit', {
        workUnitId: wu.id,
        error: String(err),
      });
    }
  }

  if (handled > 0) {
    logger.info(`[WorkUnitTimeout] Handled ${handled} timed-out WorkUnit(s)`);
  }
  return handled;
}
