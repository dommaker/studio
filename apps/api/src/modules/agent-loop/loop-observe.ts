/**
 * 观察段（#668 自 agent-loop.ts 抽出，行为一字不改）：
 * observe（零 token 观望：myActive 派生 / §9.5 频道成员过滤 / #221 认领陈旧守卫 /
 * 决策 10 显式认领 / F4 excludeAssignee / #109 blockedBy / 决策 14 unfitRoles /
 * B5 字节水位增量回复检测）+ loadChannelMembers +
 * 事件唤醒三件套（#330/#493/#523：idleSleep 可中断 sleep / onChannelMessageSent /
 * onWorkUnitClaimable——只放行不裁决，归属裁决归 observe）。
 * 全部共享状态经 AgentLoopHost 读写；本类零自有状态。
 */
import { parseChannels, isStaleClaimSleep, type ChannelMessageData } from '@dommaker/studio-shared';
import { snapshotToData, hasUnfinishedDeps, buildStatusById } from '../workunit/index.js';
import { parseExcludeAssignee } from './agent-loop-guards.js';
import { isRoleUnfit } from './claim-fitness.js';
import type { Observations } from './agent-loop.types.js';
import type { AgentLoopHost } from './loop-host.js';

export class LoopObserver {
  constructor(private readonly host: AgentLoopHost) {}

  /**
   * §9.5: 加载全部频道的 members（channelId → member profile ids）。
   * 每次 observe 调用一次；读取失败按空表处理（全量走 profile.channels 回退，不致停摆）。
   */
  private async loadChannelMembers(): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    try {
      const channels = await this.host.fileStore.listChannels();
      for (const ch of channels) {
        map.set(ch.id, parseChannels(ch.members));
      }
    } catch { /* non-blocking — 回退到 profile.channels 口径 */ }
    return map;
  }

  /** Observe: collect state from DB (zero token) */
  async observe(): Promise<Observations> {
    const host = this.host;
    // 工单 27：index.json 每轮只读一次——myActive 由同一批快照本地派生，
    // 过滤/排序/分页口径与 workUnitService.list({assigneeId}) 完全一致
    // （含先按 createdAt desc 取前 20 条、再按状态过滤的顺序）。
    const allSnapshots = await host.fileStore.getIndex();
    const myAssigneeId = host.instance?.id;
    const mine = myAssigneeId
      ? allSnapshots.filter(s => s.assigneeId === myAssigneeId)
      : [...allSnapshots];
    const myActive = mine
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 20)
      .map(snapshotToData)
      .filter(wu => wu.status === 'active' || wu.status === 'blocked');
    // §9.5: channel.members 为成员关系唯一事实源 — observe 每轮加载一次频道配置
    // （FileStore 规模小，成本可忽略）。
    const channelMembers = await this.loadChannelMembers();
    // #109（M4 接单过滤）：全局 id→status 映射（FileStore index 天然跨 PMO）
    const statusById = buildStatusById(allSnapshots);
    const now = Date.now();
    const unassigned = allSnapshots.filter(s => {
      if (s.status !== 'unassigned') return false;
      // #221（#214 决议）：认领陈旧守卫 —— updatedAt 超 72h 的 unassigned WU（含显式指名）
      // 在可见性层拦截：不可见、状态不动、不迁移、不写事件流 WU 状态。observe 保持纯过滤
      // 无副作用；首次拦截告警由 monitor 探针 stale_claim_guard 出声。updatedAt 被任何
      // 写操作刷新后复活（零新增机制）。判定与探针同源（isStaleClaimSleep）。
      if (isStaleClaimSleep(s.updatedAt, now)) return false;
      // Assignee-aware claiming（@mention 语义，docs/vision-2026.md §3）：
      // 显式指派给某个 profile 的 WorkUnit 只能被该 profile 的 loop 认领；
      // 未指派的保持频道作用域（§9.5: 频道 members 含本 profile）。
      // 决策 10：认领纯显式，不再有 acceptedTypes 类型过滤（推断只用于 skill 排序，不否决路由）。
      if (s.assigneeId) {
        if (s.assigneeId !== host.role.id) return false;
      } else if (s.channelId) {
        const members = channelMembers.get(s.channelId);
        if (members && members.length > 0) {
          // members 非空 → 唯一事实源：仅频道成员可见
          if (!members.includes(host.role.id)) return false;
        } else if (host.myChannels.length > 0 && !host.myChannels.includes(s.channelId)) {
          // 过渡期回退：频道无 members（历史数据未回填）时沿用旧 profile.channels 口径
          return false;
        }
      }
      // F4（reviewer 解锚，决策 5）：评审 WU 排除实现者 —— metadata.excludeAssignee
      // 命中的 profile 不可见（自评兜底场景 dispatcher 不设该字段，此处自然放行）
      if (parseExcludeAssignee(s.metadata) === host.role.id) return false;
      // #109（M4 接单过滤）：metadata.blockedBy 中有未 done 的 WU → 对所有 loop 不可见
      if (hasUnfinishedDeps(s.metadata, statusById)) return false;
      // 决策 14 认领前适任判断：本角色已被判不适任（metadata.unfitRoles 含本 role.id）→ 不可见。
      // 约束挂 WU 不挂角色身份（合规 ADR D2/决策 10），同 excludeAssignee 口径
      if (isRoleUnfit(s.metadata, host.role.id)) return false;
      return true;
    }).sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      .slice(0, 5)
      .map(s => ({
        id: s.id, parentId: s.parentId, type: s.type, scope: s.scope,
        assigneeId: s.assigneeId, status: s.status, failureType: s.failureType,
        retryCount: s.retryCount, timeoutAt: s.timeoutAt ? new Date(s.timeoutAt) : null,
        channelId: s.channelId, projectPath: s.projectPath, workspaceId: s.workspaceId ?? null, metadata: s.metadata,
        createdAt: new Date(s.createdAt), updatedAt: new Date(s.updatedAt),
        claimedAt: s.claimedAt ? new Date(s.claimedAt) : null,
        completedAt: s.completedAt ? new Date(s.completedAt) : null,
      }));

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
      let boundaryMs = Number.POSITIVE_INFINITY;
      for (const s of allSnapshots) {
        if (s.status !== 'active' && s.status !== 'blocked') continue;
        const t = new Date(s.updatedAt).getTime();
        if (t < boundaryMs) boundaryMs = t;
      }
      const channelSet = channelFilter ? new Set(channelFilter) : null;
      const scanChannelIds = (await host.fileStore.listMessageChannelIds())
        .filter(id => !channelSet || channelSet.has(id));
      const perChannel = await Promise.all(scanChannelIds.map(async cid => {
        try {
          const wm = host.replyScanWatermarks.get(cid) ?? 0;
          let delta = await host.fileStore.readChannelMessagesDelta(cid, wm, { boundarySinceMs: boundaryMs });
          if (!delta.valid && wm !== 0) {
            delta = await host.fileStore.readChannelMessagesDelta(cid, 0, { boundarySinceMs: boundaryMs });
          }
          if (delta.valid) host.replyScanWatermarks.set(cid, delta.newOffset);
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

  /** #330/#493 + 2026-09-16 放宽：channel.message_sent 唤醒过滤 + 闩锁（独立方法供测试 seam 直驱）。
   *  只放行不裁决：人类消息且带 workUnitId 即醒（负载原始字段）；不再用 lastActiveWuIds
   *  派生缓存否决（认领后首个 sleep 窗口缓存必 stale，回复唤醒 100% 被滤掉，实测白等 30s）。 */
  onChannelMessageSent(payload: { message?: { authorType?: string; workUnitId?: string | null } }): void {
    const msg = payload?.message;
    if (!msg || msg.authorType !== 'human' || !msg.workUnitId) return;
    // #493：闩锁先行——不在 idleSleep（执行中/步骤间 sleep）时 wakeIdle 为 null，
    // 唤醒原样会丢；置闩后下一次 idleSleep 入口消费并立即放行重跑 observe
    this.host.pendingWake = true;
    this.host.wakeIdle?.();
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
    const mine = wu.assigneeId != null && wu.assigneeId === this.host.instance?.id;
    if (wu.claimable !== true && !mine) return;
    this.host.pendingWake = true;
    this.host.wakeIdle?.();
  }

  /** #330: 可中断的空闲/步间 sleep——channel.message_sent（人类消息带 workUnitId）、
   *  workunit 事件（claimable===true 或 assigneeId===本实例）或 stop 时提前返回 */
  idleSleep(ms: number): Promise<void> {
    const host = this.host;
    if (!host.alive) return Promise.resolve(); // stop 与进入 sleep 的竞态：已停则立即返回
    // #493：消费唤醒闩锁——挂起期间有唤醒意图未送达，不睡直接重跑一轮 observe
    if (host.pendingWake) {
      host.pendingWake = false;
      return Promise.resolve();
    }
    return new Promise(resolve => {
      const wake = () => {
        host.pendingWake = false; // #493：打断即消费——紧随的 observe 已覆盖本次唤醒意图
        clearTimeout(timer);
        if (host.wakeIdle === wake) host.wakeIdle = null;
        resolve();
      };
      const timer = setTimeout(() => {
        if (host.wakeIdle === wake) host.wakeIdle = null;
        resolve();
      }, ms);
      host.wakeIdle = wake;
    });
  }
}
