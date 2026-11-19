import type { WorkUnitSnapshot } from './file-store-types';

export interface WorkUnitMetadataWritePort {
  updateMetadata(
    wuId: string,
    mutator: (current: Record<string, unknown>) => Record<string, unknown>,
    opts?: { touchUpdatedAt?: boolean },
  ): Promise<WorkUnitSnapshot | null>;
  mutateSnapshot(
    wuId: string,
    mutator: (current: WorkUnitSnapshot) => WorkUnitSnapshot | null,
    opts?: { touchUpdatedAt?: boolean },
  ): Promise<WorkUnitSnapshot | null>;
}

/**
 * WorkUnit metadata 的窄 repository。FileStore 的物理锁、事件与索引写保持不变；
 * 通用 mutator 只在本 repository 与 WorkUnit 语义命令内部出现。
 */
export class WorkUnitMetadataRepository {
  constructor(private readonly store: WorkUnitMetadataWritePort) {}

  mutate(
    wuId: string,
    mutator: (current: Record<string, unknown>) => Record<string, unknown>,
    opts?: { touchUpdatedAt?: boolean },
  ): Promise<WorkUnitSnapshot | null> {
    return this.store.updateMetadata(wuId, mutator, opts);
  }

  patch(wuId: string, patch: Record<string, unknown>): Promise<WorkUnitSnapshot | null> {
    return this.mutate(wuId, latest => ({ ...latest, ...patch }));
  }

  mutateSnapshot(
    wuId: string,
    mutator: (current: WorkUnitSnapshot) => WorkUnitSnapshot | null,
  ): Promise<WorkUnitSnapshot | null> {
    return this.store.mutateSnapshot(wuId, mutator);
  }

  markStaleClaim(wuId: string, expectedUpdatedAt: string): Promise<WorkUnitSnapshot | null> {
    return this.mutate(
      wuId,
      latest => ({ ...latest, staleGuardBlockedAt: expectedUpdatedAt }),
      { touchUpdatedAt: false },
    );
  }
}
