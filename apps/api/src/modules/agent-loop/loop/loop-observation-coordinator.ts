/**
 * PERF-03：AgentLoop 调度专用单观察协调器。
 * 同一 FileStore 下，一个 index version 只读/fold/排序一次；角色只取自己的过滤视图。
 * claimable 唤醒显式失效，15 秒兜底到期后由首个 observer 刷新，其余共享 single-flight。
 * 本缓存不是跨周期循环的通用“系统状态快照”，不服务 AgentLoop 调度以外的消费者。
 */
import {
  isStaleClaimSleep,
  parseChannels,
  type AgentProfileData,
  type FileStore,
  type WorkUnitSnapshot,
} from '@dommaker/studio-shared';
import { buildStatusById, hasUnfinishedDeps, snapshotToData } from '../../workunit/index.js';
import { parseExcludeAssignee } from '../agent-loop-guards.js';
import { isRoleUnfit } from '../claim-fitness.js';
import type { WorkUnitData } from '../../workunit/index.js';

const FALLBACK_REFRESH_MS = 15_000;

interface SharedObservation {
  readonly newestFirst: readonly WorkUnitSnapshot[];
  readonly unassignedOldest: readonly WorkUnitSnapshot[];
  readonly channelMembers: ReadonlyMap<string, readonly string[]>;
  readonly activeBoundaryMs: number;
}

interface CachedObservation {
  readonly indexVersion: number;
  readonly loadedAt: number;
  readonly observation: SharedObservation;
}

export interface RoleWorkUnitObservation {
  readonly myActive: WorkUnitData[];
  readonly unassigned: WorkUnitData[];
}

function toWorkUnitData(s: WorkUnitSnapshot): WorkUnitData {
  return {
    id: s.id, parentId: s.parentId, type: s.type, scope: s.scope,
    assigneeId: s.assigneeId, status: s.status, failureType: s.failureType,
    retryCount: s.retryCount, timeoutAt: s.timeoutAt ? new Date(s.timeoutAt) : null,
    channelId: s.channelId, projectPath: s.projectPath, workspaceId: s.workspaceId ?? null, metadata: s.metadata,
    createdAt: new Date(s.createdAt), updatedAt: new Date(s.updatedAt),
    claimedAt: s.claimedAt ? new Date(s.claimedAt) : null,
    completedAt: s.completedAt ? new Date(s.completedAt) : null,
  };
}

export class LoopObservationCoordinator {
  private cache: CachedObservation | null = null;
  private inFlight: {
    readonly promise: Promise<SharedObservation>;
    readonly indexVersion: number;
    readonly invalidationVersion: number;
  } | null = null;
  private refreshRequested = false;
  private invalidationVersion = 0;

  constructor(private readonly fileStore: FileStore) {}

  /** claimable 事件只负责放行与失效；归属/可见性仍由角色视图裁决。 */
  invalidate(): void {
    this.refreshRequested = true;
    this.invalidationVersion += 1;
  }

  async observe(): Promise<SharedObservation> {
    const indexVersion = this.fileStore.getIndexVersion();
    const invalidationVersion = this.invalidationVersion;
    const current = this.inFlight;
    // 只共享仍属于当前版本的加载。加载中失效后，事件唤醒的调用必须立即改挂新加载，
    // 不能先拿旧视图白醒一轮；旧调用自身仍可完成，但不得回写覆盖新 cache。
    if (current
      && current.indexVersion === indexVersion
      && current.invalidationVersion === invalidationVersion) {
      return current.promise;
    }
    if (this.cache
      && !this.refreshRequested
      && this.cache.indexVersion === indexVersion
      && Date.now() - this.cache.loadedAt < FALLBACK_REFRESH_MS) {
      return this.cache.observation;
    }

    this.refreshRequested = false;
    const loading = this.load();
    const flight = { promise: loading, indexVersion, invalidationVersion };
    this.inFlight = flight;
    try {
      const observation = await loading;
      if (this.inFlight === flight) {
        this.cache = { indexVersion, loadedAt: Date.now(), observation };
      }
      return observation;
    } finally {
      if (this.inFlight === flight) this.inFlight = null;
    }
  }

  viewFor(shared: SharedObservation, role: AgentProfileData, instanceId: string | undefined): RoleWorkUnitObservation {
    const myActive = shared.newestFirst
      .filter(s => instanceId ? s.assigneeId === instanceId : true)
      .slice(0, 20)
      .map(snapshotToData)
      .filter(wu => wu.status === 'active' || wu.status === 'blocked');
    const unassigned = shared.unassignedOldest.filter(s => {
      if (s.assigneeId) {
        if (s.assigneeId !== role.id) return false;
      } else if (s.channelId) {
        const members = shared.channelMembers.get(s.channelId);
        if (members && !members.includes(role.id)) return false;
      }
      if (parseExcludeAssignee(s.metadata) === role.id) return false;
      if (isRoleUnfit(s.metadata, role.id)) return false;
      return true;
    }).slice(0, 5).map(toWorkUnitData);
    return { myActive, unassigned };
  }

  private async load(): Promise<SharedObservation> {
    const allSnapshots = await this.fileStore.getIndex();
    const channelMembers = new Map<string, readonly string[]>();
    try {
      const channels = await this.fileStore.listChannels();
      for (const ch of channels) channelMembers.set(ch.id, parseChannels(ch.members));
    } catch { /* map miss 放行不裁决，与既有 loadChannelMembers 容错一致 */ }

    const statusById = buildStatusById(allSnapshots);
    const now = Date.now();
    let activeBoundaryMs = Number.POSITIVE_INFINITY;
    for (const s of allSnapshots) {
      if (s.status !== 'active' && s.status !== 'blocked') continue;
      const updatedAtMs = new Date(s.updatedAt).getTime();
      if (updatedAtMs < activeBoundaryMs) activeBoundaryMs = updatedAtMs;
    }
    const newestFirst = [...allSnapshots]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    const unassignedOldest = allSnapshots.filter(s =>
      s.status === 'unassigned'
      && !isStaleClaimSleep(s.updatedAt, now)
      && !hasUnfinishedDeps(s.metadata, statusById)
    ).sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    return { newestFirst, unassignedOldest, channelMembers, activeBoundaryMs };
  }
}

const coordinators = new WeakMap<FileStore, LoopObservationCoordinator>();

export function getLoopObservationCoordinator(fileStore: FileStore): LoopObservationCoordinator {
  let coordinator = coordinators.get(fileStore);
  if (!coordinator) {
    coordinator = new LoopObservationCoordinator(fileStore);
    coordinators.set(fileStore, coordinator);
  }
  return coordinator;
}
