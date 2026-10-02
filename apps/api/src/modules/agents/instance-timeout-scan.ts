/**
 * #179（#66 决议 3 scan 侧）agent-timeout-scan handler 本体。
 *
 * 扫描心跳过期（lastHeartbeat 超 5min 或缺失）的非终态实例，terminate 前 pid 复核：
 *  - pid 活（process.kill(pid, 0) 通过且 /proc 启动时间比对排除 pid 复用）
 *    = FileStore 故障非 loop 死 → 不 terminate，发 warning 告警走 #62 管线
 *    （dispatchMonitorAlerts 既有出口）；
 *  - pid 死 / 无 pid / pid 已被复用 → 照常 terminate。
 *
 * #363（决策 3）：terminated 实例统一回收——每轮扫描末尾对全部 terminated 实例
 * deleteState（连带判空删目录），跨角色、不再依赖「某角色恰好启动」；
 * agent-loop 的同角色启动清理已随之拆除。
 *
 * 从 apps/api/src/index.ts 内联 handler 抽出，便于服务级测试。
 */
import { logger, type FileStore } from '@dommaker/studio-shared';
import { AgentInstanceService, INSTANCE_ALIVE_TIMEOUT_MS } from './agent-instance.service.js';
import { dispatchMonitorAlerts, filterCooldownAlerts } from './monitor/monitor-alerts.js';
import { pidStartMatchesInstance, MAX_TIMEOUT_RELEASES } from '../workunit/index.js';
import { WorkUnitService, type WorkUnitMetadata } from '../workunit/index.js';
import { parseWuMetadata } from '../workunit/index.js';
import { postWuSystemMessage } from '../workunit/index.js';
import { withBlockedCta } from '../workunit/index.js';

/** 实例心跳超时阈值（与在线判定同一 5min 窗口，单源 INSTANCE_ALIVE_TIMEOUT_MS） */
export const AGENT_TIMEOUT_MS = INSTANCE_ALIVE_TIMEOUT_MS;

export interface ScanStaleInstancesResult {
  stale: number;
  terminated: number;
  /** 心跳过期但 pid 活 → 跳过 terminate 的实例数（疑似 FileStore 故障） */
  skippedAlive: number;
  /** #363：本轮回收的 terminated 历史实例数（state.json + 判空删目录） */
  reclaimed: number;
  /** 2026-09 性能治理：terminate 死实例后连带释放回池的 active WU 数 */
  releasedWorkUnits: number;
}

/**
 * 2026-09 性能治理分项 6：terminate 死实例后连带释放其持有的 active WU。
 * 此前 WU 滞留只能等租约 TTL（5min）+ workunit-timeout 扫描（5min cron），最坏 ~11min
 * 才回池；实例已确认死亡（terminate 前 pid 复核通过），持有物随本扫描（2min 一轮）立即释放。
 * 释放口径与 timeout-release 对齐：计数入 timeoutReleaseCount（共用 MAX_TIMEOUT_RELEASES
 * 上限防释放-重抢死循环），decision/plan 豁免（人工等待类，无 holder 心跳概念）；
 * holder 已死，无需 timeout-release 的「释放即杀」。
 */
async function releaseWorkUnitsOfDeadInstance(fileStore: FileStore, instanceId: string): Promise<number> {
  const wuService = new WorkUnitService(fileStore);
  const held = await wuService.list({ assigneeId: instanceId, status: 'active', limit: 1000 });
  let released = 0;
  for (const wu of held.data) {
    if (wu.type === 'decision' || wu.type === 'plan') continue;
    try {
      const metadata = parseWuMetadata(wu.metadata);
      const releases = (metadata.timeoutReleaseCount ?? 0) + 1;
      const title = (metadata.title ?? wu.scope).slice(0, 50);
      const nextMetadata: WorkUnitMetadata = {
        ...metadata,
        timeoutReleasedAt: new Date().toISOString(),
        timeoutReleaseCount: releases,
        ...(releases >= MAX_TIMEOUT_RELEASES
          ? { blockReason: `timeout: ${releases} 次超时/实例死亡释放，不再回池` }
          : {}),
      };
      if (releases >= MAX_TIMEOUT_RELEASES) {
        // 释放次数用尽 → blocked，不再自动回池（与 timeout-release 同口径）
        await wuService.update(wu.id, { timeoutAt: null, metadata: nextMetadata });
        await wuService.transitionStatus(wu.id, 'blocked');
        await postWuSystemMessage(
          { ...wu, metadata: JSON.stringify(nextMetadata) },
          withBlockedCta(
            `任务「${title}」已 ${releases} 次超时/实例死亡被释放回池，转为 blocked，请人工介入处理`,
            nextMetadata.blockReason,
          ),
          { milestone: true, fileStore },
        );
      } else {
        // 释放回 unassigned，清 timeoutAt 等待重新认领后重写
        await wuService.unclaim(wu.id);
        await wuService.update(wu.id, { timeoutAt: null, metadata: nextMetadata });
        await postWuSystemMessage(
          wu,
          `任务「${title}」的持有实例已终止（loop 死亡），已释放回任务池等待重新认领`,
          { fileStore },
        );
      }
      released++;
    } catch (err) {
      logger.warn('[AgentTimeout] Failed to release WU of dead instance', {
        workUnitId: wu.id, instanceId, error: String(err),
      });
    }
  }
  return released;
}

/** pid 存活判定：ESRCH = 死；EPERM = 活（他用户进程，无信号权限） */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

export async function scanStaleAgentInstances(
  fileStore: FileStore,
  timeoutMs: number = AGENT_TIMEOUT_MS,
): Promise<ScanStaleInstancesResult> {
  const threshold = Date.now() - timeoutMs;
  const allStates = await fileStore.listStates();
  const stale = allStates.filter(s =>
    s.status !== 'terminated' && s.status !== 'error' &&
    (s.lastHeartbeat ? new Date(s.lastHeartbeat).getTime() < threshold : true),
  );
  const svc = new AgentInstanceService(fileStore);
  let terminated = 0;
  let skippedAlive = 0;
  let releasedWorkUnits = 0;
  for (const inst of stale) {
    // #179（#66 决议 3）：terminate 前 pid 复核 —— 心跳过期但 pid 活 = FileStore
    // 故障（心跳写失败）非 loop 死，误杀会让活实例管理的在飞 WU 失控
    if (inst.pid && pidAlive(inst.pid) && (await pidStartMatchesInstance(inst.pid, inst.startedAt))) {
      skippedAlive++;
      logger.warn('[AgentTimeout] Stale heartbeat but pid alive — FileStore failure suspected, skip terminate', {
        instanceId: inst.id, pid: inst.pid, lastHeartbeat: inst.lastHeartbeat,
      });
      // #220：dispatch 前冷却过滤；subject = 实例 id，不同实例告警互不吞并
      dispatchMonitorAlerts(filterCooldownAlerts([{
        source: 'agent_timeout_scan',
        level: 'warning',
        subject: inst.id,
        message: `实例 ${inst.id}（role ${inst.roleId}）心跳过期（${inst.lastHeartbeat ?? 'never'}）但 pid ${inst.pid} 仍存活 —— 疑似 FileStore 故障导致心跳写失败，已跳过 terminate，请检查数据区`,
      }]));
      continue;
    }
    try {
      await svc.terminate(inst.id);
      terminated++;
      // 2026-09：实例死亡即连带释放其持有的 active WU 回池，不等 5min 租约 TTL
      releasedWorkUnits += await releaseWorkUnitsOfDeadInstance(fileStore, inst.id);
    } catch (err) {
      logger.warn(`[AgentTimeout] Failed to terminate ${inst.id}: ${err}`);
    }
  }
  // #363（决策 3）：terminated 实例统一回收（跨角色）——原同角色启动清理已拆除，
  // 回收统一由本扫描承担；deleteState 连带判空删目录，实例目录生命周期闭环。
  // 本轮刚 terminate 的实例不在快照的 terminated 口径里，下一轮回收（5min 内）。
  let reclaimed = 0;
  for (const inst of allStates.filter(s => s.status === 'terminated')) {
    try {
      await fileStore.deleteState(inst.id);
      reclaimed++;
    } catch (err) {
      logger.warn(`[AgentTimeout] Failed to reclaim terminated instance ${inst.id}: ${err}`);
    }
  }
  return { stale: stale.length, terminated, skippedAlive, reclaimed, releasedWorkUnits };
}
