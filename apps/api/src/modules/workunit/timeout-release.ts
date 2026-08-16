/**
 * P0 修复（WU 超时机制）：workunit-timeout 触发器的 EXECUTE handler。
 *
 * 扫描执行超时的 WorkUnit（status=active 且 timeoutAt ≤ now；#178 起 timeoutAt = 租约
 * 到期时刻，由持有方 loop 30s 心跳推前，本扫描逻辑零改动）：
 *  - 释放回 unassigned（清 assigneeId/claimedAt/timeoutAt），记 metadata.timeoutReleasedAt
 *    + timeoutReleaseCount，并向所在频道发系统消息说明任务因超时已释放回池；
 *  - #178（#63 决议 3）释放即杀：顺 assigneeId → 实例记录 → pid best-effort 杀原 holder
 *    进程组（#54/#68 教训：必须杀进程组，SIGTERM 杀不死孙进程）；
 *  - 释放次数 ≥ MAX_TIMEOUT_RELEASES → 不再回池，改 blocked 并频道说明，等待人工介入。
 *
 * 基准时间在每次 tick 现算（handler 入参 now），不再冻结在触发器注册时。
 * 频道系统消息走 wu-messenger 统一出口（eventBus + SSE，挂 anchor 线程）。
 */
import fs from 'node:fs';
import { logger, FileStore } from '@dommaker/studio-shared';
import { WorkUnitService, type WorkUnitMetadata } from './workunit.service.js';
import { postWuSystemMessage } from './wu-messenger.js';
import { parseWuMetadata } from './wu-metadata.js';
import { withBlockedCta } from './blocked-cta.js';

/** 同一 WU 的超时释放上限：达到后转 blocked，等待人工介入 */
export const MAX_TIMEOUT_RELEASES = 3;

/**
 * #178（#63 决议 3）pid 复用兜底：/proc/<pid> 启动时间与实例 startedAt 比对，
 * 偏差超容忍窗（10min）判定 pid 已被复用 → 不杀。非 Linux / 读不到 /proc → 放行
 * （无法校验时按 best-effort 处理；kill 侧仍有 ESRCH 跳过）。
 * #179（#66 决议 3）导出复用：agent-timeout-scan terminate 前 pid 复核同款判定。
 */
export async function pidStartMatchesInstance(pid: number, startedAt: string | null | undefined): Promise<boolean> {
  if (!startedAt) return true;
  try {
    const stat = await fs.promises.readFile(`/proc/${pid}/stat`, 'utf-8');
    // comm 字段可含空格/括号：取最后一个 ')' 之后的内容，starttime 是第 22 字段 → 余部第 20 项
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const startTicks = Number(rest[19]);
    const btimeLine = (await fs.promises.readFile('/proc/stat', 'utf-8'))
      .split('\n')
      .find(l => l.startsWith('btime '));
    if (!btimeLine || !Number.isFinite(startTicks)) return true;
    const procStartMs = Number(btimeLine.slice('btime '.length)) * 1000 + (startTicks / 100) * 1000; // CLK_TCK=100（Linux 通用）
    return Math.abs(procStartMs - new Date(startedAt).getTime()) <= 10 * 60_000;
  } catch {
    return true; // 进程已死（kill 侧 ESRCH 跳过）或非 Linux —— 放行
  }
}

/**
 * #178（#63 决议 3）：best-effort 杀原 holder 的实例进程组。
 * holder 就是本进程（同进程扫描器）时跳过——在进程内的僵尸 holder 由其自身 fencing
 * （心跳易主自杀）收口，扫描器自杀会误杀全部健康 loop。
 */
async function killOriginalHolder(fileStore: FileStore, assigneeId: string | null, wuId: string): Promise<void> {
  if (!assigneeId) return;
  let state;
  try {
    state = await fileStore.getState(assigneeId);
  } catch {
    return; // 实例记录读取失败 → best-effort 跳过
  }
  const pid = state?.pid;
  if (!pid) return;
  if (pid === process.pid) {
    logger.info('[WorkUnitTimeout] Holder is this process — skip kill (in-process fencing will reap)', { workUnitId: wuId, assigneeId });
    return;
  }
  if (!(await pidStartMatchesInstance(pid, state?.startedAt))) {
    logger.warn('[WorkUnitTimeout] Holder pid start-time mismatch (pid reuse) — skip kill', { workUnitId: wuId, assigneeId, pid });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL'); // 实例进程组整组杀（孙进程不留孤儿）
    logger.info('[WorkUnitTimeout] Killed original holder process group', { workUnitId: wuId, assigneeId, pid });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ESRCH') {
      // 组不存在：可能非 detached 启动的旧记录 → 回落单进程杀，仍 ESRCH 则已死跳过
      try { process.kill(pid, 'SIGKILL'); } catch { /* ESRCH：已死 */ }
    } else {
      logger.warn('[WorkUnitTimeout] Failed to kill holder process group', { workUnitId: wuId, assigneeId, pid, error: String(err) });
    }
  }
}

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
    // #108（T2）：decision 单不进超时扫描——决策可能等关键人好几天，
    // claim 写入的 timeoutAt 对其无意义（spec 成文单仍按默认时长正常参与扫描）
    if (wu.type === 'decision') continue;
    try {
      const metadata = parseWuMetadata(wu.metadata);
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
        // #176（决策 #57 D3-1）：blocked 里程碑统一携带 CTA 行动召唤块（含失败原因摘要）
        await postWuSystemMessage(
          { ...wu, metadata: JSON.stringify(nextMetadata) },
          withBlockedCta(
            `任务「${title}」已 ${releases} 次执行超时被释放回池，转为 blocked，请人工介入处理`,
            nextMetadata.blockReason,
          ),
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
      // #178（#63 决议 3）：释放即杀原 holder 进程组（best-effort，不影响释放计数）
      await killOriginalHolder(fileStore, wu.assigneeId, wu.id);
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
