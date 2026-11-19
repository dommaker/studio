/**
 * 观察段（#668 自 agent-loop.ts 抽出）：
 * observe（零 token 观望：myActive 派生 / §9.5 频道成员过滤 / #221 认领陈旧守卫 /
 * 决策 10 显式认领 / F4 excludeAssignee / #109 blockedBy / 决策 14 unfitRoles /
 * B5 字节水位增量回复检测）+ 事件唤醒三件套（#330/#493/#523：idleSleep 可中断 sleep /
 * onChannelMessageSent / onWorkUnitClaimable——只放行不裁决，归属裁决归 observe）。
 * ARCH-05：回复水位与唤醒闩锁由本类独占，实例/存活经窄 getter 读取。
 * PERF-03：WU/channel 全局观察移交共享协调器，本类只保留角色视图与回复水位。
 */
import type { ChannelMessageData } from '@dommaker/studio-shared';
import type { Observations } from '../agent-loop.types.js';
import type { ObserverDeps } from './loop-deps.js';
import { getLoopObservationCoordinator, type LoopObservationCoordinator } from './loop-observation-coordinator.js';

export class LoopObserver {
  private readonly replyScanWatermarks = new Map<string, number>();
  private readonly coordinator: LoopObservationCoordinator;
  private pendingWake = false;
  private wakeIdle: (() => void) | null = null;

  constructor(private readonly deps: ObserverDeps) {
    this.coordinator = getLoopObservationCoordinator(deps.fileStore);
  }

  /** Observe: collect state from DB (zero token) */
  async observe(): Promise<Observations> {
    const deps = this.deps;
    // PERF-03：WU/channel 的读取、fold、排序按 FileStore + index version 共享；
    // 这里只取角色过滤视图，回复水位仍按 observer 独立维护。
    const shared = await this.coordinator.observe();
    const { myActive, unassigned } = this.coordinator.viewFor(shared, deps.role, deps.getInstance()?.id);
    const activeWuIds = myActive.map(wu => wu.id);
    // #330 扫描裁剪：只扫活跃 WU 所在频道（通常 1-2 个，原来是全频道无差别全扫）。
    // 任一活跃 WU 无 channelId 时退全扫（该 WU 回复可能落在任意频道）。
    // 已接受盲区：WU 换频道后旧频道里的新人类回复不再被扫到（换频道罕见，
    // 且换频道后回复落新频道线程——WU.channelId 已更新）。
    const channelFilter = myActive.length > 0 && myActive.every(wu => wu.channelId)
      ? [...new Set(myActive.map(wu => wu.channelId as string))]
      : undefined;
    // B5（channel-flow-audit-fix）：queryAllMessages 无 limit 全扫改 readChannelMessagesDelta
    // 字节水位增量读——稳态（无新行）每频道只付一次 fstat，不再每轮全文件扫描归并。
    // 边界锚 = 全部 active/blocked 快照的最小 updatedAt（pre-slice 全集、不限 assignee：
    // slice(0,20) 外的在跑 WU 可能经排序挤入视野、认领/状态迁移新入的 WU updatedAt 必晚于
    // 水位推进时点——水位只越过 createdAt < 边界的行，其对任何现在/未来候选恒不可见）。
    // 未消费回复（createdAt >= wu.updatedAt）留在窗口内逐轮重复投递，与全扫口径逐条一致；
    // 压实/重写触发原语 valid=false → 当轮回退 0 偏移全读重建水位。
    let allReplies: ChannelMessageData[] = [];
    if (activeWuIds.length > 0) {
      const boundaryMs = shared.activeBoundaryMs;
      const channelSet = channelFilter ? new Set(channelFilter) : null;
      const scanChannelIds = (await deps.fileStore.listMessageChannelIds())
        .filter(id => !channelSet || channelSet.has(id));
      const perChannel = await Promise.all(scanChannelIds.map(async cid => {
        try {
          const wm = this.replyScanWatermarks.get(cid) ?? 0;
          let delta = await deps.fileStore.readChannelMessagesDelta(cid, wm, { boundarySinceMs: boundaryMs });
          if (!delta.valid && wm !== 0) {
            delta = await deps.fileStore.readChannelMessagesDelta(cid, 0, { boundarySinceMs: boundaryMs });
          }
          if (delta.valid) this.replyScanWatermarks.set(cid, delta.newOffset);
          return delta.messages;
        } catch {
          return []; // 读取失败按空处理（同 queryAllMessages 容错口径），不阻断 observe
        }
      }));
      allReplies = perChannel.flat().filter(msg => {
        if (msg.authorType !== 'human') return false;
        const wu = myActive.find(w => w.id === msg.workUnitId);
        // #493：>= 同毫秒边界——回复与 WU 簿记同毫秒落盘（含重启间隙首扫捞回）不再漏检；
        // 不误循环：回复被消费后 recordResult 簿记推进 updatedAt，下一轮自然越界
        return wu && new Date(msg.createdAt).getTime() >= wu.updatedAt.getTime();
      });
    }

    return { myActive, unassigned, newReplies: allReplies };
  }

  /** 生命周期 stop 只中断等待，不读写观察段的唤醒闩锁。 */
  wake(): void {
    this.wakeIdle?.();
  }

  /** #330/#493 + 2026-09-16 放宽：channel.message_sent 唤醒过滤 + 闩锁（独立方法供测试 seam 直驱）。
   *  只放行不裁决：人类消息且带 workUnitId 即醒（负载原始字段）；不再用 lastActiveWuIds
   *  派生缓存否决（认领后首个 sleep 窗口缓存必 stale，回复唤醒 100% 被滤掉，实测白等 30s）。 */
  onChannelMessageSent(payload: { message?: { authorType?: string; workUnitId?: string | null } }): void {
    const msg = payload?.message;
    if (!msg || msg.authorType !== 'human' || !msg.workUnitId) return;
    // #493：闩锁先行——不在 idleSleep（执行中/步骤间 sleep）时 wakeIdle 为 null，
    // 唤醒原样会丢；置闩后下一次 idleSleep 入口消费并立即放行重跑 observe
    this.pendingWake = true;
    this.wakeIdle?.();
  }

  /** #523（#515 决议 P0-1/P0-2）+ 2026-09-16 唤醒放宽（只放行不裁决）：
   *  workunit.created / workunit.status_changed 唤醒过滤（独立方法供测试 seam 直驱）。
   *  放行口径只用负载原始字段：claimable === true（可认领：pending 人闸单/有依赖单不空唤醒）
   *  或 assigneeId === 本实例（我的单状态变化——含 NEED_INPUT 复活 blocked→active；
   *  旧口径只放 claimable，复活被排除，实测回复后白等满 30s dynamicInterval）。
   *  归属/可见性的最终裁决归 observe（幂等零 token），唤醒宁可误醒不可漏醒。 */
  onWorkUnitClaimable(payload: unknown): void {
    const wu = (payload as { workunit?: { claimable?: boolean; assigneeId?: string | null } } | null)?.workunit;
    if (!wu) return;
    const mine = wu.assigneeId != null && wu.assigneeId === this.deps.getInstance()?.id;
    if (wu.claimable !== true && !mine) return;
    this.coordinator.invalidate();
    this.pendingWake = true;
    this.wakeIdle?.();
  }

  /** #330: 可中断的空闲/步间 sleep——channel.message_sent（人类消息带 workUnitId）、
   *  workunit 事件（claimable===true 或 assigneeId===本实例）或 stop 时提前返回 */
  idleSleep(ms: number): Promise<void> {
    if (!this.deps.isAlive()) return Promise.resolve(); // stop 与进入 sleep 的竞态：已停则立即返回
    // #493：消费唤醒闩锁——挂起期间有唤醒意图未送达，不睡直接重跑一轮 observe
    if (this.pendingWake) {
      this.pendingWake = false;
      return Promise.resolve();
    }
    return new Promise(resolve => {
      const wake = () => {
        this.pendingWake = false; // #493：打断即消费——紧随的 observe 已覆盖本次唤醒意图
        clearTimeout(timer);
        if (this.wakeIdle === wake) this.wakeIdle = null;
        resolve();
      };
      const timer = setTimeout(() => {
        if (this.wakeIdle === wake) this.wakeIdle = null;
        resolve();
      }, ms);
      this.wakeIdle = wake;
    });
  }
}
