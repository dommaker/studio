import type { WorkUnitMetadataRepository, WorkUnitSnapshot } from '@dommaker/studio-shared';

export type ReconciliationAttemptField = 'analysisRespawnAttempts' | 'reviewRedispatchAttempts';

/** PMO 派生哨兵与对账计数的窄写口。 */
export class DerivationLedger {
  constructor(private readonly repository: WorkUnitMetadataRepository) {}

  claim(wuId: string, stamp: string): Promise<WorkUnitSnapshot | null> {
    return this.repository.mutate(wuId, latest =>
      (latest.analysisTasksSpawnedAt || latest.analysisTasksSpawned)
        ? latest
        : { ...latest, analysisTasksSpawnedAt: stamp, analysisTasksSpawned: [] as string[] });
  }

  mark(wuId: string, childId: string): Promise<WorkUnitSnapshot | null> {
    return this.repository.mutate(wuId, latest => {
      const list = Array.isArray(latest.analysisTasksSpawned) ? latest.analysisTasksSpawned as string[] : [];
      if (list.includes(childId)) return latest;
      return { ...latest, analysisTasksSpawned: [...list, childId] };
    });
  }

  markAutoConfirmed(wuId: string, at: string): Promise<WorkUnitSnapshot | null> {
    return this.repository.patch(wuId, { autoConfirmedBy: 'trigger-inspection-no-gate', autoConfirmedAt: at });
  }

  recordReconciliationAttempt(
    wuId: string,
    field: ReconciliationAttemptField,
    attempts: number | null,
  ): Promise<WorkUnitSnapshot | null> {
    return this.repository.mutate(wuId, latest => {
      const next = { ...latest };
      if (attempts === null) delete next[field];
      else next[field] = attempts;
      return next;
    });
  }
}
