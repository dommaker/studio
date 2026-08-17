/**
 * #209 smell 4（源自 #178 / #63 决议 1/2）：WU 租约追踪器。
 *
 * 从 AgentLoop 整体迁出的租约/fencing 内聚组：
 *   - ensure：持有中 WU 的 30s 租约心跳轨道管理（幂等、令牌换代先停旧轨）
 *   - stillHolds：fencing 校验（claimedAt 代际令牌 + assigneeId 双比对）
 *   - handleLost：易主善后（停心跳、杀自身 CLI 进程组、静默放弃）
 *   - transitionIfHeld：状态迁移前 fencing（易主即善后并返回 false）
 *   - releaseIfForfeited：WU 离开 active / 已易主 -> 停心跳
 * 心跳本体在 lease-heartbeat.ts（同族模块）。
 */
import { logger, type FileStore } from '@dommaker/studio-shared';
import type { WorkUnitData } from '../../workunit/workunit.service.js';
import { startLeaseHeartbeat } from './lease-heartbeat.js';

export interface WuLeaseDeps {
  fileStore: FileStore;
  /** 持有方实例 id 的实时取值（AgentLoop 的 instance 启动后才存在） */
  getAssigneeId: () => string | null;
  /** 当前在飞 execution id（易主时杀自身进程组用） */
  getCurrentExecutionId: () => string | undefined;
  /** 杀进程组（best-effort，失败只记日志） */
  stopProcessGroup: (executionId: string) => Promise<void>;
  /** 真实状态迁移（fencing 通过后由持有方执行） */
  transitionStatus: (wuId: string, status: string) => Promise<unknown>;
}

export class WuLeaseTracker {
  private lease: { wuId: string; claimedAt: string; stop: () => void } | null = null;

  constructor(private deps: WuLeaseDeps) {}

  /** 是否有在跑租约轨道（含指定 WU 时进一步比对） */
  has(wuId?: string): boolean {
    return wuId === undefined ? this.lease !== null : this.lease?.wuId === wuId;
  }

  /**
   * 为持有中的 WU 确保租约心跳在跑。新认领与 myActive 续跑（含 blocked 复活回 active）
   * 统一经此进入；令牌（wuId+claimedAt）与在跑轨道一致时幂等跳过，令牌换代（如本实例
   * 重新认领）先停旧轨再开新轨。
   */
  ensure(wu: WorkUnitData): void {
    const assigneeId = this.deps.getAssigneeId();
    const claimedAt = wu.claimedAt?.toISOString();
    if (!assigneeId || !claimedAt || wu.assigneeId !== assigneeId) return;
    if (this.lease && this.lease.wuId === wu.id && this.lease.claimedAt === claimedAt) return;
    this.stop();
    this.lease = {
      wuId: wu.id,
      claimedAt,
      stop: startLeaseHeartbeat({
        fileStore: this.deps.fileStore,
        wuId: wu.id,
        claimedAt,
        assigneeId,
        onLost: (reason) => { void this.handleLost(wu.id, reason); },
      }),
    };
  }

  /** 停止租约心跳（幂等） */
  stop(): void {
    if (!this.lease) return;
    this.lease.stop();
    this.lease = null;
  }

  /**
   * fencing 校验 -- 步结果回写前 / 状态迁移前比对 claimedAt 代际令牌（「每次心跳前」
   * 校验由 refreshWorkUnitLease 锁内原子完成）。无租约轨道（未 start 的测试直调等）
   * 不拦，保持既有行为。
   */
  async stillHolds(wuId: string): Promise<boolean> {
    const assigneeId = this.deps.getAssigneeId();
    if (!this.lease || this.lease.wuId !== wuId || !assigneeId) return true;
    const snap = (await this.deps.fileStore.getIndex()).find(s => s.id === wuId);
    return !!snap && snap.assigneeId === assigneeId && snap.claimedAt === this.lease.claimedAt;
  }

  /**
   * 易主善后 -- 停止心跳、杀自身 CLI 进程组（best-effort）、静默退出该 WU
   * （不发频道消息、不写回：fencing 语义就是「旧 holder 一字不再写」）。
   */
  async handleLost(wuId: string, reason: 'lost' | 'missing'): Promise<void> {
    if (this.lease?.wuId === wuId) this.stop();
    logger.warn(`[WuLease] Lease lost for ${wuId} (${reason}) - fencing: killing own CLI process group, abandoning WU`);
    const executionId = this.deps.getCurrentExecutionId();
    if (executionId) {
      try {
        await this.deps.stopProcessGroup(executionId);
      } catch (err) {
        logger.warn(`[WuLease] stopProcessGroup failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** 状态迁移前 fencing -- 易主即善后并返回 false（调用方立即静默退出），持有有效才执行真实迁移。 */
  async transitionIfHeld(wuId: string, status: string): Promise<boolean> {
    if (!(await this.stillHolds(wuId))) {
      await this.handleLost(wuId, 'lost');
      return false;
    }
    await this.deps.transitionStatus(wuId, status);
    return true;
  }

  /** WU 离开 active 或已易主 -> 停租约心跳（recordResult 后调用） */
  async releaseIfForfeited(wuId: string): Promise<void> {
    if (!this.lease || this.lease.wuId !== wuId) return;
    const snap = (await this.deps.fileStore.getIndex()).find(s => s.id === wuId);
    if (!snap || snap.status !== 'active' || !(await this.stillHolds(wuId))) {
      this.stop();
    }
  }
}
