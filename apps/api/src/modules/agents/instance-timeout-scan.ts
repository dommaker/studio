/**
 * #179（#66 决议 3 scan 侧）agent-timeout-scan handler 本体。
 *
 * 扫描心跳过期（lastHeartbeat 超 5min 或缺失）的非终态实例，terminate 前 pid 复核：
 *  - pid 活（process.kill(pid, 0) 通过且 /proc 启动时间比对排除 pid 复用）
 *    = FileStore 故障非 loop 死 → 不 terminate，发 warning 告警走 #62 管线
 *    （dispatchMonitorAlerts 既有出口）；
 *  - pid 死 / 无 pid / pid 已被复用 → 照常 terminate。
 *
 * 从 apps/api/src/index.ts 内联 handler 抽出，便于服务级测试。
 */
import { logger, type FileStore } from '@dommaker/studio-shared';
import { AgentInstanceService } from './agent-instance.service.js';
import { dispatchMonitorAlerts } from './monitor/monitor-alerts.js';
import { pidStartMatchesInstance } from '../workunit/timeout-release.js';

/** 实例心跳超时阈值（与原内联 handler 一致：5min） */
export const AGENT_TIMEOUT_MS = 5 * 60 * 1000;

export interface ScanStaleInstancesResult {
  stale: number;
  terminated: number;
  /** 心跳过期但 pid 活 → 跳过 terminate 的实例数（疑似 FileStore 故障） */
  skippedAlive: number;
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
  for (const inst of stale) {
    // #179（#66 决议 3）：terminate 前 pid 复核 —— 心跳过期但 pid 活 = FileStore
    // 故障（心跳写失败）非 loop 死，误杀会让活实例管理的在飞 WU 失控
    if (inst.pid && pidAlive(inst.pid) && (await pidStartMatchesInstance(inst.pid, inst.startedAt))) {
      skippedAlive++;
      logger.warn('[AgentTimeout] Stale heartbeat but pid alive — FileStore failure suspected, skip terminate', {
        instanceId: inst.id, pid: inst.pid, lastHeartbeat: inst.lastHeartbeat,
      });
      dispatchMonitorAlerts([{
        source: 'agent_timeout_scan',
        level: 'warning',
        message: `实例 ${inst.id}（role ${inst.roleId}）心跳过期（${inst.lastHeartbeat ?? 'never'}）但 pid ${inst.pid} 仍存活 —— 疑似 FileStore 故障导致心跳写失败，已跳过 terminate，请检查数据区`,
      }]);
      continue;
    }
    try {
      await svc.terminate(inst.id);
      terminated++;
    } catch (err) {
      logger.warn(`[AgentTimeout] Failed to terminate ${inst.id}: ${err}`);
    }
  }
  return { stale: stale.length, terminated, skippedAlive };
}
