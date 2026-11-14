import { createHash, randomUUID } from 'node:crypto';
import {
  FileStore,
  WorkUnitMetadataRepository,
  type EffectReceipt,
  type EffectRecord,
  type WorkUnitSnapshot,
} from '@dommaker/studio-shared';
import { assertMandateActive } from './mandate.js';
import { MANUAL_GATE_TYPES } from './workunit.types.js';

export const EFFECT_MAX_ATTEMPTS = 3;
export const EFFECT_RETRY_DELAY_MS = 30_000;

export interface EffectProjection {
  effects: EffectRecord[];
  receipts: EffectReceipt[];
}

export interface EffectHandlerContext {
  workUnit: WorkUnitSnapshot;
  effect: EffectRecord;
  recovery: boolean;
}

export type EffectHandler = (context: EffectHandlerContext) => Promise<Record<string, unknown>>;

export interface EffectRecoveryResult {
  attempted: number;
  succeeded: number;
  failed: number;
  cancelled: number;
}

function effectId(workUnitId: string, idempotencyKey: string): string {
  return `effect-${createHash('sha256').update(`${workUnitId}:${idempotencyKey}`).digest('hex').slice(0, 32)}`;
}

function newEffect(
  workUnitId: string,
  kind: EffectRecord['kind'],
  idempotencyKey: string,
  trigger: EffectRecord['trigger'],
  at: string,
  payload?: Record<string, unknown>,
): EffectRecord {
  return {
    id: effectId(workUnitId, idempotencyKey),
    workUnitId,
    kind,
    idempotencyKey,
    trigger,
    status: 'queued',
    attempts: 0,
    maxAttempts: EFFECT_MAX_ATTEMPTS,
    createdAt: at,
    updatedAt: at,
    ...(payload ? { payload } : {}),
  };
}

/** merge 领域意图与持久 Effect 共用幂等键；Effect 只承载执行生命周期。 */
export function newMergeEffect(workUnitId: string, idempotencyKey = `merge:${workUnitId}`): EffectRecord {
  return newEffect(workUnitId, 'merge', idempotencyKey, 'automatic', new Date().toISOString());
}

export function mergeCleanupIdempotencyKey(workUnitId: string): string {
  return `merge:${workUnitId}:cleanup`;
}

export function isMergeCleanupEffect(effect: EffectRecord): boolean {
  return effect.kind === 'merge' && effect.idempotencyKey === mergeCleanupIdempotencyKey(effect.workUnitId);
}

/** 进入评审的领域事实与派单意图必须共享同一个快照提交。 */
export function withReviewDispatchIntent(
  current: WorkUnitSnapshot,
  updated: WorkUnitSnapshot,
): WorkUnitSnapshot {
  if (current.status === 'in_review' || updated.status !== 'in_review'
    || !updated.channelId || updated.type === 'review' || MANUAL_GATE_TYPES.has(updated.type)) {
    return updated;
  }
  const idempotencyKey = `review-dispatch:${updated.id}:${updated.updatedAt}`;
  const effect = newEffect(updated.id, 'review-dispatch', idempotencyKey, 'automatic', updated.updatedAt);
  return {
    ...updated,
    effects: [...(updated.effects ?? []).filter(item => item.idempotencyKey !== idempotencyKey), effect],
  };
}

function appendReceipt(snapshot: WorkUnitSnapshot, receipt: EffectReceipt): EffectReceipt[] {
  return [...(snapshot.effectReceipts ?? []).filter(item => item.id !== receipt.id), receipt];
}

function receiptFor(
  effect: EffectRecord,
  outcome: EffectReceipt['outcome'],
  at: string,
  extra: Partial<Pick<EffectReceipt, 'result' | 'error' | 'recovery'>> = {},
): EffectReceipt {
  return {
    id: `receipt-${randomUUID()}`,
    effectId: effect.id,
    idempotencyKey: effect.idempotencyKey,
    outcome,
    at,
    attempts: effect.attempts,
    ...extra,
  };
}

export class EffectService {
  private readonly repository: WorkUnitMetadataRepository;
  private readonly inFlight = new Map<string, Promise<EffectRecord | null>>();
  private readonly retryDelayMs: number;

  constructor(
    private readonly fileStore: FileStore,
    opts: { retryDelayMs?: number } = {},
  ) {
    this.repository = new WorkUnitMetadataRepository(fileStore);
    this.retryDelayMs = opts.retryDelayMs ?? EFFECT_RETRY_DELAY_MS;
  }

  async getProjection(workUnitId: string): Promise<EffectProjection> {
    const snapshot = (await this.fileStore.getIndex({ id: workUnitId }))[0];
    return { effects: snapshot?.effects ?? [], receipts: snapshot?.effectReceipts ?? [] };
  }

  /** 人工补派与旧数据补账共用；相同幂等键只保留一个意图。 */
  async enqueue(
    workUnitId: string,
    input: {
      kind: EffectRecord['kind']; idempotencyKey: string; trigger: EffectRecord['trigger'];
      payload?: Record<string, unknown>;
    },
  ): Promise<EffectRecord> {
    let selected: EffectRecord | undefined;
    const updated = await this.repository.mutateSnapshot(workUnitId, current => {
      const existing = (current.effects ?? []).find(effect => effect.idempotencyKey === input.idempotencyKey);
      if (existing) {
        selected = existing;
        return current;
      }
      const at = new Date().toISOString();
      selected = newEffect(workUnitId, input.kind, input.idempotencyKey, input.trigger, at, input.payload);
      return { ...current, effects: [...(current.effects ?? []), selected], updatedAt: at };
    });
    if (!updated || !selected) throw new Error('WorkUnit not found');
    return selected;
  }

  /** 安全取消尚未开始的动作；running 的不确定性必须走恢复核查。 */
  async cancel(workUnitId: string, id: string, reason: string): Promise<EffectRecord | null> {
    let selected: EffectRecord | null = null;
    const updated = await this.repository.mutateSnapshot(workUnitId, current => {
      const effect = (current.effects ?? []).find(item => item.id === id);
      if (!effect) return current;
      selected = effect;
      if (effect.status !== 'queued') return current;
      const at = new Date().toISOString();
      selected = { ...effect, status: 'cancelled', lastError: reason, nextAttemptAt: undefined, updatedAt: at };
      return {
        ...current,
        effects: (current.effects ?? []).map(item => item.id === id ? selected! : item),
        effectReceipts: appendReceipt(current, receiptFor(selected, 'cancelled', at, { error: reason })),
        updatedAt: at,
      };
    });
    return updated ? selected : null;
  }

  async execute(
    workUnitId: string,
    id: string,
    handler: EffectHandler,
    opts: { recovery?: boolean; reconcileRevoked?: boolean } = {},
  ): Promise<EffectRecord | null> {
    const key = `${workUnitId}:${id}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const promise = this.performExecute(workUnitId, id, handler, opts)
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, promise);
    return promise;
  }

  private async performExecute(
    workUnitId: string,
    id: string,
    handler: EffectHandler,
    opts: { recovery?: boolean; reconcileRevoked?: boolean },
  ): Promise<EffectRecord | null> {
    let selected: EffectRecord | undefined;
    let shouldRun = false;
    let recoveryKind: EffectReceipt['recovery'];
    const runningSnapshot = await this.repository.mutateSnapshot(workUnitId, current => {
      const effect = (current.effects ?? []).find(item => item.id === id);
      if (!effect) return current;
      selected = effect;
      if (['succeeded', 'failed', 'cancelled'].includes(effect.status)) return current;
      if (effect.status === 'running' && !opts.recovery) return current;
      if (effect.status === 'needs_reconciliation' && current.mandate?.revokedAt && !opts.reconcileRevoked) return current;
      if (effect.status === 'queued' && effect.nextAttemptAt && Date.parse(effect.nextAttemptAt) > Date.now()) return current;
      shouldRun = true;
      recoveryKind = effect.status === 'queued' ? 'queued-restarted' : 'running-reconciled';

      const at = new Date().toISOString();
      try {
        if (!(opts.reconcileRevoked && effect.status === 'needs_reconciliation' && current.mandate?.revokedAt)) {
          assertMandateActive(current);
        }
      } catch (error) {
        const outcome = current.mandate?.revokedAt ? 'cancelled' : 'failed';
        selected = {
          ...effect,
          status: outcome,
          lastError: String(error),
          updatedAt: at,
          nextAttemptAt: undefined,
        };
        return {
          ...current,
          effects: (current.effects ?? []).map(item => item.id === id ? selected! : item),
          effectReceipts: appendReceipt(current, receiptFor(selected, outcome, at, {
            error: String(error),
            ...(outcome === 'cancelled' ? { recovery: 'revocation' as const } : {}),
          })),
          updatedAt: at,
        };
      }

      selected = {
        ...effect,
        status: 'running',
        attempts: effect.attempts + 1,
        startedAt: at,
        updatedAt: at,
        nextAttemptAt: undefined,
      };
      return {
        ...current,
        effects: (current.effects ?? []).map(item => item.id === id ? selected! : item),
        updatedAt: at,
      };
    });
    if (!runningSnapshot || !selected || !shouldRun) return selected ?? null;

    const effectToRun = selected;
    try {
      const result = await handler({ workUnit: runningSnapshot, effect: effectToRun, recovery: opts.recovery === true });
      const completed = await this.repository.mutateSnapshot(workUnitId, current => {
        const effect = (current.effects ?? []).find(item => item.id === id);
        if (!effect) return current;
        const at = new Date().toISOString();
        const succeeded: EffectRecord = {
          ...effect,
          status: 'succeeded',
          updatedAt: at,
          nextAttemptAt: undefined,
          lastError: undefined,
        };
        selected = succeeded;
        return {
          ...current,
          effects: (current.effects ?? []).map(item => item.id === id ? succeeded : item),
          effectReceipts: appendReceipt(current, receiptFor(succeeded, 'succeeded', at, {
            result,
            ...(opts.recovery ? { recovery: recoveryKind } : {}),
          })),
          updatedAt: at,
        };
      });
      return completed ? selected ?? null : null;
    } catch (error) {
      const failed = await this.repository.mutateSnapshot(workUnitId, current => {
        const effect = (current.effects ?? []).find(item => item.id === id);
        if (!effect || effect.status === 'needs_reconciliation' || effect.status === 'cancelled') {
          selected = effect;
          return current;
        }
        if (opts.reconcileRevoked && current.mandate?.revokedAt) {
          const at = new Date().toISOString();
          selected = {
            ...effect, status: 'needs_reconciliation', lastError: String(error),
            updatedAt: at, nextAttemptAt: undefined,
          };
          return {
            ...current,
            effects: (current.effects ?? []).map(item => item.id === id ? selected! : item),
            updatedAt: at,
          };
        }
        const at = new Date().toISOString();
        const retry = effect.attempts < effect.maxAttempts;
        selected = {
          ...effect,
          status: retry ? 'queued' : 'failed',
          lastError: String(error),
          updatedAt: at,
          nextAttemptAt: retry ? new Date(Date.now() + this.retryDelayMs).toISOString() : undefined,
        };
        return {
          ...current,
          effects: (current.effects ?? []).map(item => item.id === id ? selected! : item),
          effectReceipts: appendReceipt(current, receiptFor(selected, retry ? 'retrying' : 'failed', at, {
            error: String(error),
            ...(opts.recovery ? { recovery: recoveryKind } : {}),
          })),
          updatedAt: at,
        };
      });
      return failed ? selected ?? null : null;
    }
  }

  /** 启动时从磁盘恢复；EventBus 是否曾投递不参与判定。 */
  async recover(
    handler: EffectHandler,
    opts: {
      include?: (snapshot: WorkUnitSnapshot, effect: EffectRecord) => boolean;
      /** 仅限可按持久事实只读认养的 kind；不得在撤销后产生新副作用。 */
      reconcileRevoked?: boolean;
    } = {},
  ): Promise<EffectRecoveryResult> {
    const result: EffectRecoveryResult = { attempted: 0, succeeded: 0, failed: 0, cancelled: 0 };
    const snapshots = await this.fileStore.getIndex();
    for (const snapshot of snapshots) {
      for (const effect of snapshot.effects ?? []) {
        if (!['queued', 'running', 'needs_reconciliation'].includes(effect.status)) continue;
        if (opts.include && !opts.include(snapshot, effect)) continue;
        if (effect.status === 'queued' && effect.nextAttemptAt && Date.parse(effect.nextAttemptAt) > Date.now()) continue;
        if (effect.status === 'needs_reconciliation' && snapshot.mandate?.revokedAt && !opts.reconcileRevoked) continue;
        result.attempted++;
        const recovered = await this.execute(snapshot.id, effect.id, handler, {
          recovery: true, reconcileRevoked: opts.reconcileRevoked,
        });
        if (recovered?.status === 'succeeded') result.succeeded++;
        else if (recovered?.status === 'cancelled') result.cancelled++;
        else if (recovered?.status === 'failed') result.failed++;
      }
    }
    return result;
  }
}
