import { createSettledTracker, type EffectRecord, type FileStore } from '@dommaker/studio-shared';
import type { KnowledgeStore } from '@dommaker/harness';
import { logger } from '@dommaker/studio-shared/node';
import { EffectService } from '../workunit/index.js';
import { sharedStore } from './knowledge-singletons.js';
import { applyTerminalLearningOutcome, type TerminalLearningOutcomeInput } from './learning-outcomes.js';

export function knowledgeOutcomeIdempotencyKey(eventId: string): string {
  return `knowledge-outcome:${eventId}`;
}

function parsePayload(effect: EffectRecord): TerminalLearningOutcomeInput {
  const { eventId, kind, workUnitIds } = effect.payload ?? {};
  if (typeof eventId !== 'string' || (kind !== 'pmo-review-rejected' && kind !== 'delivery-failed')
    || !Array.isArray(workUnitIds) || !workUnitIds.every(id => typeof id === 'string')) {
    throw new Error('知识结果 Effect 缺 eventId/kind/workUnitIds');
  }
  return { eventId, kind, workUnitIds };
}

/** PMO 终局事实的知识回写；知识条目自身的 eventId 承担部分写入后的幂等恢复。 */
export class KnowledgeOutcomeEffects {
  private readonly effects: EffectService;
  private readonly settled = createSettledTracker();
  private readonly retries = new Set<string>();

  constructor(
    private readonly fileStore: FileStore,
    private readonly knowledgeStore: KnowledgeStore = sharedStore,
    opts: { retryDelayMs?: number } = {},
  ) {
    this.effects = new EffectService(fileStore, opts);
  }

  async trigger(anchorWorkUnitId: string, input: TerminalLearningOutcomeInput): Promise<EffectRecord> {
    const effect = await this.effects.enqueue(anchorWorkUnitId, {
      kind: 'knowledge-outcome',
      idempotencyKey: knowledgeOutcomeIdempotencyKey(input.eventId),
      trigger: 'automatic',
      payload: { ...input },
    });
    this.settled.track(this.run(anchorWorkUnitId, effect.id).catch(error => {
      logger.warn('[KnowledgeOutcomeEffects] execution failed', { anchorWorkUnitId, effectId: effect.id, error: String(error) });
    }));
    return effect;
  }

  async waitForSettled(): Promise<void> {
    await this.settled.waitForSettled();
  }

  private async run(workUnitId: string, effectId: string): Promise<void> {
    const executed = await this.effects.execute(workUnitId, effectId,
      ({ effect }) => this.perform(effect), { recovery: true });
    if (executed?.status === 'succeeded') await this.reconcileCompleted();
    if (executed?.status === 'queued') this.scheduleRetry(workUnitId, effectId, executed.nextAttemptAt);
  }

  private async perform(effect: EffectRecord): Promise<Record<string, unknown>> {
    return applyTerminalLearningOutcome(this.knowledgeStore, parsePayload(effect));
  }

  private scheduleRetry(workUnitId: string, effectId: string, nextAttemptAt?: string): void {
    if (this.retries.has(effectId)) return;
    this.retries.add(effectId);
    const delay = Math.max(0, (nextAttemptAt ? Date.parse(nextAttemptAt) : Date.now()) - Date.now());
    const timer = setTimeout(() => {
      this.retries.delete(effectId);
      this.settled.track(this.run(workUnitId, effectId).catch(error => {
        logger.warn('[KnowledgeOutcomeEffects] retry failed', { workUnitId, effectId, error: String(error) });
      }));
    }, delay);
    timer.unref?.();
  }

  /** 成功 Effect 是终局事件台账；迟到提取后重放可补标新条目，条目 eventId 保证幂等。 */
  async reconcileCompleted(): Promise<void> {
    for (const snapshot of await this.fileStore.getIndex()) {
      for (const effect of snapshot.effects ?? []) {
        if (effect.kind === 'knowledge-outcome' && effect.status === 'succeeded') await this.perform(effect);
      }
    }
  }

  async recoverPending(): Promise<void> {
    await this.effects.recover(({ effect }) => this.perform(effect), {
      include: (_snapshot, effect) => effect.kind === 'knowledge-outcome',
    });
    for (const snapshot of await this.fileStore.getIndex()) {
      for (const effect of snapshot.effects ?? []) {
        if (effect.kind === 'knowledge-outcome' && effect.status === 'queued') {
          this.scheduleRetry(snapshot.id, effect.id, effect.nextAttemptAt);
        }
      }
    }
    await this.reconcileCompleted();
  }
}

const instances = new WeakMap<FileStore, KnowledgeOutcomeEffects>();

export function getKnowledgeOutcomeEffects(fileStore: FileStore): KnowledgeOutcomeEffects {
  let service = instances.get(fileStore);
  if (!service) {
    service = new KnowledgeOutcomeEffects(fileStore);
    instances.set(fileStore, service);
  }
  return service;
}
