/**
 * #178（2026-08-16，#63 决议 1/2）WU 租约心跳。
 *
 * 持有方 loop 每 30s 把持有中 WU 的 timeoutAt 推前为 now+5min（租约 TTL 单一固定值
 * WU_LEASE_TTL_MS，废除按 type 的 30/60min 预算默认值）；timeoutAt 语义 = 租约到期时刻，
 * timeout-release 扫描逻辑零改动。
 *
 * fencing：心跳写经 FileStore.refreshWorkUnitLease —— claimedAt 代际令牌 + assigneeId
 * 双比对在锁内与写入原子完成（「每次心跳前校验」落地形态）；易主（lost）/ WU 消失（missing）
 * → 停跳并回调 onLost（AgentLoop 据此杀自身 CLI 进程组、静默退出该 WU）。
 *
 * 单跳 IO 失败（撕裂读取等瞬态）只记日志不停跳——fencing 不漏判：真正易主时下一跳仍会命中。
 */
import { logger, type FileStore } from '@dommaker/studio-shared';
import { WU_LEASE_TTL_MS } from '../../workunit/workunit.types.js';

/** #63 决议 1：租约心跳间隔 30s（10 跳缺席 = 5min TTL 耗尽才释放） */
export const LEASE_HEARTBEAT_INTERVAL_MS = 30_000;

export interface LeaseHeartbeatOptions {
  fileStore: FileStore;
  wuId: string;
  /** fencing 代际令牌 = 认领时刻的 claimedAt（ISO 串，unclaim 清空/重新认领重写，天然单调） */
  claimedAt: string;
  /** 持有方实例 id（assigneeId 双比对，防实例 id 复用盲区） */
  assigneeId: string;
  /** 易主/消失回调：'lost' = claimedAt 或 assigneeId 不匹配；'missing' = WU 已删除 */
  onLost: (reason: 'lost' | 'missing') => void;
  /** 测试注入：覆盖心跳间隔（生产缺省 30s） */
  intervalMs?: number;
}

/**
 * 启动租约心跳，返回停止函数（幂等）。
 * 首跳在 interval 后触发（claim 已写 now+5min 租约，无需立即补跳）。
 */
export function startLeaseHeartbeat(opts: LeaseHeartbeatOptions): () => void {
  const intervalMs = opts.intervalMs ?? LEASE_HEARTBEAT_INTERVAL_MS;
  let stopped = false;
  let ticking = false;

  const tick = async (): Promise<void> => {
    if (stopped || ticking) return;
    ticking = true;
    try {
      const result = await opts.fileStore.refreshWorkUnitLease(
        opts.wuId,
        opts.assigneeId,
        opts.claimedAt,
        new Date(Date.now() + WU_LEASE_TTL_MS),
      );
      if (result !== 'ok' && !stopped) {
        stopped = true;
        clearInterval(timer);
        opts.onLost(result);
      }
    } catch (err) {
      // 瞬态 IO 失败：记日志、下一跳重试（5min TTL 对 30s 间隔有 10 跳余量）
      logger.warn('[LeaseHeartbeat] refresh failed (will retry next tick)', {
        workUnitId: opts.wuId,
        error: String(err),
      });
    } finally {
      ticking = false;
    }
  };

  const timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref?.(); // 不阻止进程退出（测试/关停路径）

  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
}
