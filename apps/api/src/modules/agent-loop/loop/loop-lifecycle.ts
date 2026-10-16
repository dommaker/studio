/**
 * 生命周期段（#668 自 agent-loop.ts 抽出，行为一字不改）：
 * start（健康探针 → 错误态恢复 → stale/单活守卫 → 实例落盘 → EVENT trigger 注册 →
 * 事件唤醒订阅 → 主循环点燃）/ stop（#635 语义收窄：只置退出意图）/ waitForStop /
 * recordStartupFailure / publishInstanceStatus（§6-2 忙闲 SSE，#312/#318 契约负载）/
 * updateIdleState（F6-fix 空闲心跳节流）/ updateStateWithHeartbeatWatch +
 * selfTerminateOnHeartbeatFailure（#179 心跳连败自裁）。
 * 全部共享状态经 AgentLoopHost 读写；本类零自有状态。
 */
import { eventBus, type RuntimeStateData } from '@dommaker/studio-shared';
import { logger, resolveProviderDefinition, buildHealthProbeCommand } from '@dommaker/studio-shared/node';
import { randomUUID } from 'crypto';
import { execAsync } from '../../../core/exec-async.js';
import { getTriggerScheduler } from '../../triggers/index.js';
import { getErrorMessage } from '../../../utils/errors.js';
import { isProcessAlive } from '../agent-loop-parsers.js';
import { loadCurrentWuContexts, type CurrentWuContext } from '../../ops/index.js';
// #665（ADR 2026-08-24 落地）：agent.* SSE 负载与 studio-contract 同源
import type { AgentHealthFailedPayload, AgentInstanceStatusChangedPayload } from '@dommaker/studio-contract';
import type { AgentLoopHost } from './loop-host.js';

/** F6-fix: 空闲分支心跳节流间隔 — agent-timeout-scan 阈值为 5min，45s 一次足够保活 */
const IDLE_HEARTBEAT_INTERVAL_MS = 45_000;
/** 单活实例守卫：心跳/启动时间新鲜度阈值（idle 心跳 45s 一跳，留近 3 跳余量） */
const LIVE_HOLDER_THRESHOLD_MS = 120_000;
/** #179（#66 决议 3 loop 侧）：实例心跳写连败上限 —— 连败 3 次（idle 45s 一跳 ≈90s）
 *  判定 FileStore 故障，loop 自我了断（同 #63 fencing 哲学） */
const HEARTBEAT_FAIL_LIMIT = 3;

export class LoopLifecycle {
  constructor(private readonly host: AgentLoopHost) {}

  /** Start the agent loop: create instance, register EVENT trigger, enter observe-decide-act cycle.
   *  Returns true when the loop started; false on startup-fatal failure (recorded for UI/monitoring, F2). */
  async start(): Promise<boolean> {
    const host = this.host;
    try {
      // AC-4.5 + F4: Health probe — verify the profile's provider CLI is available
      // 异步 exec（#374 纪律：loop/启动链禁止 sync 子进程阻塞事件循环）；失败/超时 reject
      const providerId = host.role.provider || 'claude';
      const probeCmd = buildHealthProbeCommand(providerId);
      try {
        await execAsync(probeCmd, { timeout: 5000 });
      } catch {
        const message = `${resolveProviderDefinition(providerId).displayName} CLI not available (health probe \`${probeCmd}\` failed)`;
        logger.error(`[AgentLoop] ${message} — agent ${host.role.name} unavailable`);
        await this.recordStartupFailure(message);
        return false;
      }

      const allStates = await host.fileStore.listStates();

      // #363：terminated 历史实例的回收已从此处拆除（原 2026-07-30 同角色启动清理），
      // 统一由 instance-timeout-scan 承担（跨角色，每 5min，连带判空删目录闭环）。

      // F2: recovery — a successful probe clears previous error states for this role
      for (const s of allStates.filter(s => s.roleId === host.role.id && s.status === 'error')) {
        await host.fileStore.updateState(s.id, {
          status: 'terminated',
          terminatedAt: new Date().toISOString(),
          lastError: null,
          lastErrorAt: null,
        }).catch(() => {});
      }

      // AC-4.6: Detect and clean up stale previous instances for this role
      const stalePrev = allStates.find(s => s.roleId === host.role.id && s.status !== 'error' && s.status !== 'terminated' && s.pid && !isProcessAlive(s.pid));
      if (stalePrev) {
        logger.info(`[AgentLoop] Cleaning up stale instance ${stalePrev.id} (PID ${stalePrev.pid})`);
        await host.fileStore.updateState(stalePrev.id, { status: 'terminated' }).catch(() => {});
      }

      // 同角色单活实例守卫（2026-07-30 走查修复）：另一进程持有的活实例存在时 standby。
      // 判活 = 异 pid 进程存活 且 心跳新鲜（lastHeartbeat/startedAt 在阈值内）。
      // 防 dev/prod 双实例共享同一 ~/.studio 时同 profile 被重复挂载（认领竞争、频道重复
      // 回复、会话续用错位命中）。持有者死亡/心跳停摆后，下次挂载（重启或 profile 生命周期
      // 事件）自动接管。stale 清理只管死 pid，管不了两个活进程——本守卫补这一层。
      const liveHolder = allStates.find(s => {
        if (s.roleId !== host.role.id) return false;
        if (s.status === 'error' || s.status === 'terminated') return false;
        if (!s.pid || s.pid === process.pid || !isProcessAlive(s.pid)) return false;
        const beat = s.lastHeartbeat ?? s.startedAt;
        return !!beat && (Date.now() - new Date(beat).getTime()) < LIVE_HOLDER_THRESHOLD_MS;
      });
      if (liveHolder) {
        const message = `role 已有活实例 ${liveHolder.id}（pid ${liveHolder.pid}，心跳新鲜）持有，本实例 standby —— 持有者退出后重启本实例即可接管`;
        logger.warn(`[AgentLoop] ${host.role.name}: ${message}`);
        await this.recordStartupFailure(message);
        return false;
      }

      const now = new Date().toISOString();
      const instanceId = randomUUID();
      const state: RuntimeStateData = {
        id: instanceId,
        roleId: host.role.id,
        sessionId: null,
        status: 'idle',
        currentWorkUnitId: null,
        startedAt: now,
        terminatedAt: null,
        lastHeartbeat: null,
        metadata: null,
        pid: process.pid,
      };
      await host.fileStore.createState(instanceId, state);
      host.instance = state;

      host.alive = true;
      logger.info(`[AgentLoop] Started for role ${host.role.name} (instance=${host.instance.id})`);

      // AC-3: Register EVENT trigger for workunit.created
      const scheduler = getTriggerScheduler();
      host.triggerId = `agent-loop-${host.role.id}-workunit-created`;
      const handlerTarget = `agent-loop-${host.role.id}-observe`;

      scheduler.registerExecuteHandler(handlerTarget, async (context) => {
        // #523（#515 决议 P0-1）：认领真唤醒——不再白跑一次 observe 丢弃结果，
        // 复用 channel.message_sent 同款机制（pendingWake 闩锁 + wakeIdle）叫醒
        // runLoop 自己走 observe→认领；context = trigger scheduler 传入的事件 payload
        if (host.alive) host.onWorkUnitClaimable(context);
      });

      scheduler.registerTrigger({
        id: host.triggerId,
        name: `Agent ${host.role.name} observe on workunit.created`,
        condition: { type: 'EVENT', event: 'workunit.created' },
        action: { type: 'EXECUTE', target: handlerTarget },
        enabled: true,
        scope: 'agent',
      });

      // #330: 事件驱动唤醒——订阅 channel.message_sent（同进程 eventBus）。
      // 2026-09-16 放宽为「只放行不裁决」：人类消息带 workUnitId 即打断空闲 sleep 跑一轮 observe，
      // 不再用 myActive 派生缓存否决（缓存在认领后首个 sleep 窗口必 stale，回复唤醒会被滤掉，
      // 实测白等满 30s dynamicInterval）；归属裁决归 observe（幂等零 token），误醒廉价、漏醒人感。
      // 事件 fire-and-forget 无持久，15s 空闲兜底轮询保留
      // （防未来跨进程写者与重启间隙——当前生产写消息路径全部经 channel-message.service 发事件；
      //  重启间隙的回复由启动首轮 observe 经 newReplies >= 口径捞回，#493）。
      // #493：过滤+闩锁逻辑收进 onChannelMessageSent（seam 可测）。
      host.messageSentHandler = (payload) => host.onChannelMessageSent(payload);
      eventBus.subscribe('channel.message_sent', host.messageSentHandler);

      // #523（#515 决议 P0-2）+ 2026-09-16 放宽：增订 workunit.status_changed——
      // claimable===true（人闸确认/unclaim/reopen）或 assigneeId===本实例
      // （含 NEED_INPUT 复活 blocked→active，旧口径把它滤掉导致回复后白等 30s）。零新事件类型。
      host.workunitChangedHandler = (payload) => host.onWorkUnitClaimable(payload);
      eventBus.subscribe('workunit.status_changed', host.workunitChangedHandler);

      // Main loop (non-blocking — fire and forget like original)
      host.loopPromise = host.runLoop().catch(err =>
        logger.error(`[AgentLoop] Loop failed for ${host.role.name}: ${err.message}`)
      );
      return true;
    } catch (err) {
      // F2: any other startup-fatal failure is also surfaced
      const message = getErrorMessage(err);
      logger.error(`[AgentLoop] Startup failed for ${host.role.name}: ${message}`);
      await this.recordStartupFailure(message).catch(() => {});
      return false;
    }
  }

  /** Stop the agent loop and clean up.
   *  #635：语义收窄为「置退出意图」——不停租约心跳、不清租约轨道；在飞 step 全程处于
   *  租约保护之下（续租不中断、易主 fencing 可达 handleLost），停心跳收尾在 runLoop 退出点 */
  stop(): void {
    const host = this.host;
    host.alive = false;
    if (host.triggerId) {
      getTriggerScheduler().unregisterTrigger(host.triggerId);
    }
    // #330: 退订事件唤醒 + 中断空闲 sleep（waitForStop 不必等满 15s）
    if (host.messageSentHandler) {
      eventBus.unsubscribe('channel.message_sent', host.messageSentHandler);
      host.messageSentHandler = null;
    }
    // #523: 退订 workunit.status_changed 认领唤醒
    if (host.workunitChangedHandler) {
      eventBus.unsubscribe('workunit.status_changed', host.workunitChangedHandler);
      host.workunitChangedHandler = null;
    }
    host.wakeIdle?.();
    if (host.instance) {
      host.terminateWrite = host.fileStore.updateState(host.instance.id, {
        status: 'terminated',
        terminatedAt: new Date().toISOString(),
      }).catch(err => logger.error(`[AgentLoop] Failed to terminate instance: ${err.message}`));
    }
  }

  /** Wait for the runLoop promise to fully settle (for test cleanup).
   *  #634: 连带等 stop() 的 terminated 落盘写——重挂方据此确认旧实例完全退出 */
  async waitForStop(): Promise<void> {
    const host = this.host;
    if (host.loopPromise) {
      try { await host.loopPromise; } catch { /* loop errors already logged */ }
    }
    if (host.terminateWrite) {
      await host.terminateWrite;
    }
  }

  /** F2: Record a startup-fatal failure to runtime state (state.json) + notify via eventBus and SSE */
  async recordStartupFailure(message: string): Promise<void> {
    const host = this.host;
    const now = new Date().toISOString();
    let errorStateId: string | null = null;
    try {
      // Reuse this role's existing error state if any (avoid one record per retry)
      const allStates = await host.fileStore.listStates();
      const existing = allStates.find(s => s.roleId === host.role.id && s.status === 'error');
      if (existing) {
        await host.fileStore.updateState(existing.id, { lastError: message, lastErrorAt: now });
        errorStateId = existing.id;
      } else {
        const instanceId = randomUUID();
        const state: RuntimeStateData = {
          id: instanceId,
          roleId: host.role.id,
          sessionId: null,
          status: 'error',
          currentWorkUnitId: null,
          startedAt: now,
          terminatedAt: null,
          lastHeartbeat: null,
          metadata: null,
          pid: process.pid,
          lastError: message,
          lastErrorAt: now,
        };
        await host.fileStore.createState(instanceId, state);
        errorStateId = instanceId;
      }
    } catch (err) {
      logger.warn(`[AgentLoop] Failed to record startup failure state: ${getErrorMessage(err)}`);
    }

    const payload: AgentHealthFailedPayload = { profileId: host.role.id, name: host.role.name, provider: host.role.provider ?? 'claude', error: message };
    eventBus.publish('agent.health.failed', payload);
    // SSE 'events' topic (same shape as channel-message.service.ts publishSSE)
    eventBus.publish('events', {
      event_type: 'agent.health.failed',
      event_id: randomUUID(),
      timestamp: now,
      data: payload,
    });

    // #312（SSE 事件负载契约体检）：error 迁移也发 status_changed（与 publishInstanceStatus
    // 同一构造出口，带 lastError/lastErrorAt），前端错误状态点可就地更新；
    // agent.health.failed 保留不动（additive）。无当前 WU → ctx null（快照/channelId/pmo null）。
    eventBus.publish('events', {
      event_type: 'agent.instance.status_changed',
      event_id: randomUUID(),
      timestamp: now,
      data: this.buildInstanceStatusPayload({
        instanceId: errorStateId,
        status: 'error',
        currentWorkUnitId: null,
        ctx: null,
        startedAt: now,
        lastError: message,
        lastErrorAt: now,
      }),
    });
  }

  /**
   * agent.instance.status_changed 负载唯一构造出口（#312 契约 + #318 additive pmo/startedAt）——
   * publishInstanceStatus 与 recordStartupFailure 共用，防两处拷贝契约漂移。
   */
  private buildInstanceStatusPayload(input: {
    instanceId: string | null;
    status: string;
    currentWorkUnitId: string | null;
    ctx: CurrentWuContext | null;
    startedAt: string | null;
    lastError: string | null;
    lastErrorAt: string | null;
  }): AgentInstanceStatusChangedPayload {
    const host = this.host;
    return {
      profileId: host.role.id,
      instanceId: input.instanceId,
      name: host.role.name,
      status: input.status,
      currentWorkUnitId: input.currentWorkUnitId,
      currentWorkUnit: input.ctx?.currentWorkUnit ?? null,
      channelId: input.ctx?.channelId ?? null,
      pmo: input.ctx?.pmo ?? null,
      startedAt: input.startedAt,
      lastError: input.lastError,
      lastErrorAt: input.lastErrorAt,
    };
  }

  /**
   * #179（#66 决议 3 loop 侧）：实例状态写（含心跳）不再静默吞错 —— 成功清零连败计数；
   * 失败计数并在连败 HEARTBEAT_FAIL_LIMIT 次（≈90s）时自我了断。
   * 返回是否仍存活（调用方据此中止本次迭代，不再开新 step）。
   */
  async updateStateWithHeartbeatWatch(update: Partial<RuntimeStateData>): Promise<boolean> {
    const host = this.host;
    if (!host.instance) return host.alive;
    try {
      await host.fileStore.updateState(host.instance.id, update);
      host.consecutiveHeartbeatFailures = 0;
    } catch (err) {
      host.consecutiveHeartbeatFailures++;
      logger.warn(`[AgentLoop] Heartbeat/state write failed (${host.consecutiveHeartbeatFailures}/${HEARTBEAT_FAIL_LIMIT})`, {
        instanceId: host.instance.id,
        error: getErrorMessage(err),
      });
      if (host.consecutiveHeartbeatFailures >= HEARTBEAT_FAIL_LIMIT) {
        await this.selfTerminateOnHeartbeatFailure();
      }
    }
    return host.alive;
  }

  /**
   * #179（#66 决议 3 loop 侧）：心跳连败自我了断 —— FileStore 故障时 loop 继续跑只会
   * 盲写盲判；停租约心跳、杀自身 CLI 进程组（停 step）、静默退出循环（不写状态——
   * 写了也会失败）。在飞 WU 由租约到期正常回收（timeout-release）。
   */
  private async selfTerminateOnHeartbeatFailure(): Promise<void> {
    const host = this.host;
    if (!host.alive) return;
    logger.error(`[AgentLoop] Heartbeat write failed ${HEARTBEAT_FAIL_LIMIT} consecutive times — FileStore suspected broken; self-terminating (kill own CLI process group, silent exit)`);
    host.stopLease();
    const executionId = host.currentExecutionId;
    if (executionId) {
      try {
        await host.executor.stopProcessGroup?.(executionId);
      } catch (err) {
        logger.warn(`[AgentLoop] stopProcessGroup failed (non-blocking): ${getErrorMessage(err)}`);
      }
    }
    host.alive = false;
  }

  /**
   * Idle branch state update. F6-fix: 空闲也要刷新 lastHeartbeat（按
   * IDLE_HEARTBEAT_INTERVAL_MS 节流），否则 agent-timeout-scan 会把
   * 空闲 >5min 的实例标记 terminated（内存 loop 仍在跑，监控却显示已终止）。
   */
  async updateIdleState(): Promise<void> {
    const host = this.host;
    if (!host.instance) return;
    const update: { status: string; currentWorkUnitId: null; lastHeartbeat?: string } = {
      status: 'idle',
      currentWorkUnitId: null,
    };
    const nowMs = Date.now();
    if (nowMs - host.lastIdleHeartbeatAt >= IDLE_HEARTBEAT_INTERVAL_MS) {
      update.lastHeartbeat = new Date(nowMs).toISOString();
      host.lastIdleHeartbeatAt = nowMs;
    }
    // #179（#66 决议 3 loop 侧）：心跳写连败计数/自裁统一走 watch 入口
    await this.updateStateWithHeartbeatWatch(update);
    // 2026-07 PMO-flow UX（§6-2）：进入 idle 发一次 SSE；45s 节流心跳重入不重复发
    void this.publishInstanceStatus('idle', null);
  }

  /**
   * 2026-07 PMO-flow UX（§6-2）：instance 忙闲变化发 SSE（agent.instance.status_changed）。
   * 形状与 recordStartupFailure 的 agent.health.failed 一致（events topic 信封；
   * sse.routes 无 agent.* 显式映射 → 落 all topic，前端订阅 all 即收，无需改路由）。
   * 仅在 status 相对上次发布实际变化时发（lastPublishedStatus 去重）——
   * updateIdleState 的 45s 节流分支反复进入 idle 不刷屏。best-effort，绝不阻断主循环。
   * #312（SSE 事件负载契约体检）：负载 additive 带 currentWorkUnit 快照（逐字段对齐
   * getAgentSummary：title = metadata.title ?? scope；悬空 WU → null，裸 currentWorkUnitId
   * 保留）+ channelId（当前 WU 所在频道，无当前 WU → null）+ lastError/lastErrorAt。
   * #318：负载再添 pmo 快照 + startedAt；WU 聚合上下文改走共享出口
   * （monitoring/current-wu-context，与 getAgentSummary 同源，claimedAt 快照原样透传）。
   * WU 查询失败/不存在不阻断发布（快照 null 兜底），调用方 fire-and-forget。
   */
  async publishInstanceStatus(status: string, currentWorkUnitId: string | null): Promise<void> {
    const host = this.host;
    if (!host.instance || host.lastPublishedStatus === status) return;
    host.lastPublishedStatus = status;
    const instance = host.instance;
    try {
      // #318：WU 聚合上下文走共享出口（current-wu-context，与 getAgentSummary 同源）——
      // 负载 additive 补 pmo 快照；claimedAt 改快照原样透传（对齐 getAgentSummary 口径）。
      // projects 读取失败不阻断发布（pmo null 兜底），调用方 fire-and-forget。
      // project.service 走动态 import：避免与 pmo/workunit 模块链形成加载期循环依赖（同 monitoring.service 的 lazy 惯例）
      const ctx = currentWorkUnitId
        ? (await loadCurrentWuContexts(host.fileStore, [currentWorkUnitId], async () => {
            const mod = await import('../../pmo/index.js');
            return mod.projectService.list({ limit: 100000 });
          }).catch(() => new Map())).get(currentWorkUnitId) ?? null
        : null;
      eventBus.publish('events', {
        event_type: 'agent.instance.status_changed',
        event_id: randomUUID(),
        timestamp: new Date().toISOString(),
        data: this.buildInstanceStatusPayload({
          instanceId: instance.id,
          status,
          currentWorkUnitId,
          ctx,
          startedAt: instance.startedAt ?? null,
          lastError: instance.lastError ?? null,
          lastErrorAt: instance.lastErrorAt ?? null,
        }),
      });
    } catch { /* best-effort：负载构建失败绝不阻断主循环 */ }
  }
}
