// AgentLoop 运行时实例状态写入（启动失败记录 / idle 心跳 / 忙闲 SSE）——
// 从 agent-loop.ts 原样抽出，行为不变。
import { eventBus, logger, FileStore, type RuntimeStateData, type AgentProfileData } from '@dommaker/studio-shared';
import { randomUUID } from 'crypto';
import { eventStore } from '../../core/event-store.js';

/** F6-fix: 空闲分支心跳节流间隔 — agent-timeout-scan 阈值为 5min，45s 一次足够保活 */
const IDLE_HEARTBEAT_INTERVAL_MS = 45_000;

/** F2: Record a startup-fatal failure to runtime state (state.json) + notify via eventBus and SSE */
export async function recordStartupFailure(fileStore: FileStore, role: AgentProfileData, message: string): Promise<void> {
  const now = new Date().toISOString();
  try {
    // Reuse this role's existing error state if any (avoid one record per retry)
    const allStates = await fileStore.listStates();
    const existing = allStates.find(s => s.roleId === role.id && s.status === 'error');
    if (existing) {
      await fileStore.updateState(existing.id, { lastError: message, lastErrorAt: now });
    } else {
      const instanceId = randomUUID();
      const state: RuntimeStateData = {
        id: instanceId,
        roleId: role.id,
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
      await fileStore.createState(instanceId, state);
    }
  } catch (err) {
    logger.warn(`[AgentLoop] Failed to record startup failure state: ${err instanceof Error ? err.message : String(err)}`);
  }

  const payload = { profileId: role.id, name: role.name, provider: role.provider ?? 'claude', error: message };
  eventBus.publish('agent.health.failed', payload);
  // SSE 'events' topic (same shape as channel-message.service.ts publishSSE)
  eventStore.publish('events', JSON.stringify({
    event_type: 'agent.health.failed',
    event_id: randomUUID(),
    timestamp: now,
    data: payload,
  })).catch(() => {}); // best-effort
}

/**
 * 2026-07 PMO-flow UX（§6-2）：instance 忙闲变化发 SSE（agent.instance.status_changed）。
 * 形状与 recordStartupFailure 的 agent.health.failed 一致（events topic 信封；
 * sse.routes 无 agent.* 显式映射 → 落 all topic，前端订阅 all 即收，无需改路由）。
 * 仅在 status 相对上次发布实际变化时发（lastPublishedStatus 去重）——
 * updateIdleState 的 45s 节流分支反复进入 idle 不刷屏。best-effort，绝不阻断主循环。
 * 返回新的 lastPublishedStatus（未发布时原样返回入参）。
 */
export function publishInstanceStatus(
  instance: { id: string } | null,
  role: AgentProfileData,
  lastPublishedStatus: string | null,
  status: string,
  currentWorkUnitId: string | null,
): string | null {
  if (!instance || lastPublishedStatus === status) return lastPublishedStatus;
  eventStore.publish('events', JSON.stringify({
    event_type: 'agent.instance.status_changed',
    event_id: randomUUID(),
    timestamp: new Date().toISOString(),
    data: {
      profileId: role.id,
      instanceId: instance.id,
      name: role.name,
      status,
      currentWorkUnitId,
    },
  })).catch(() => {}); // best-effort
  return status;
}

export interface IdleStateResult {
  lastIdleHeartbeatAt: number;
  lastPublishedStatus: string | null;
}

/**
 * Idle branch state update. F6-fix: 空闲也要刷新 lastHeartbeat（按
 * IDLE_HEARTBEAT_INTERVAL_MS 节流），否则 agent-timeout-scan 会把
 * 空闲 >5min 的实例标记 terminated（内存 loop 仍在跑，监控却显示已终止）。
 */
export async function updateIdleState(
  fileStore: FileStore,
  instance: { id: string } | null,
  role: AgentProfileData,
  lastIdleHeartbeatAt: number,
  lastPublishedStatus: string | null,
): Promise<IdleStateResult> {
  if (!instance) return { lastIdleHeartbeatAt, lastPublishedStatus };
  const update: { status: string; currentWorkUnitId: null; lastHeartbeat?: string } = {
    status: 'idle',
    currentWorkUnitId: null,
  };
  const nowMs = Date.now();
  if (nowMs - lastIdleHeartbeatAt >= IDLE_HEARTBEAT_INTERVAL_MS) {
    update.lastHeartbeat = new Date(nowMs).toISOString();
    lastIdleHeartbeatAt = nowMs;
  }
  await fileStore.updateState(instance.id, update).catch(() => {});
  // 2026-07 PMO-flow UX（§6-2）：进入 idle 发一次 SSE；45s 节流心跳重入不重复发
  lastPublishedStatus = publishInstanceStatus(instance, role, lastPublishedStatus, 'idle', null);
  return { lastIdleHeartbeatAt, lastPublishedStatus };
}
