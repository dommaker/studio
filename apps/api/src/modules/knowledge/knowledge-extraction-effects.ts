import { createSettledTracker, type FileStore, type EffectRecord, type WorkUnitSnapshot } from '@dommaker/studio-shared';
import { logger } from '@dommaker/studio-shared/node';
import { EffectService, parseWuMetadata } from '../workunit/index.js';
import { consumeTranscript, reconcileTranscriptAssignments } from '../transcripts/index.js';
import { knowledgePorts } from './knowledge-service.js';
import type { ConversationExtractionCtx } from './knowledge-types.js';

export const KNOWLEDGE_EXTRACTION_CONSUMER = 'knowledge';

export function knowledgeExtractionIdempotencyKey(workUnitId: string, assignmentId: string): string {
  return `knowledge-extraction:${workUnitId}:${assignmentId}`;
}

/** WU 完成后的知识提取：Effect 负责持久生命周期，transcript watermark 负责输入恢复。 */
export class KnowledgeExtractionEffects {
  private readonly effects: EffectService;
  private readonly settled = createSettledTracker();
  private readonly retries = new Set<string>();

  constructor(private readonly fileStore: FileStore, opts: { retryDelayMs?: number } = {}) {
    this.effects = new EffectService(fileStore, opts);
  }

  async trigger(workUnitId: string, assignmentId: string, learning: ConversationExtractionCtx): Promise<EffectRecord> {
    const effect = await this.effects.enqueue(workUnitId, {
      kind: 'knowledge-extraction',
      idempotencyKey: knowledgeExtractionIdempotencyKey(workUnitId, assignmentId),
      trigger: 'automatic',
      payload: { learning },
    });
    this.settled.track(this.run(workUnitId, effect.id).catch(error => {
      logger.warn('[KnowledgeExtractionEffects] execution failed', { workUnitId, effectId: effect.id, error: String(error) });
    }));
    return effect;
  }

  async waitForSettled(): Promise<void> {
    await this.settled.waitForSettled();
  }

  private async perform(effect: EffectRecord): Promise<Record<string, unknown>> {
    const learning = effect.payload?.learning as ConversationExtractionCtx | undefined;
    const snapshot = (await this.fileStore.getIndex({ id: effect.workUnitId }))[0];
    if (snapshot) await reconcileTranscriptAssignments(snapshot);
    const result = await consumeTranscript(effect.workUnitId, KNOWLEDGE_EXTRACTION_CONSUMER, async entries => {
      const messages = entries
        .filter(entry => typeof entry.rawOutput === 'string' && entry.rawOutput.trim())
        .map(entry => ({ role: 'assistant', content: entry.rawOutput! }));
      await knowledgePorts.produce.extractFromConversation(messages, learning);
    });
    if (result.hasWriting || result.hasUncommitted) {
      throw new Error('Transcript has uncommitted content');
    }
    return { consumed: result.consumed };
  }

  private async run(workUnitId: string, effectId: string): Promise<void> {
    const executed = await this.effects.execute(workUnitId, effectId, ({ effect }) => this.perform(effect), { recovery: true });
    if (executed?.status === 'queued') this.scheduleRetry(workUnitId, effectId, executed.nextAttemptAt);
  }

  private scheduleRetry(workUnitId: string, effectId: string, nextAttemptAt?: string): void {
    if (this.retries.has(effectId)) return;
    this.retries.add(effectId);
    const delay = Math.max(0, (nextAttemptAt ? Date.parse(nextAttemptAt) : Date.now()) - Date.now());
    const timer = setTimeout(() => {
      this.retries.delete(effectId);
      this.settled.track(this.run(workUnitId, effectId).catch(error => {
        logger.warn('[KnowledgeExtractionEffects] retry failed', { workUnitId, effectId, error: String(error) });
      }));
    }, delay);
    timer.unref?.();
  }

  private async ensureDoneEffect(snapshot: WorkUnitSnapshot): Promise<void> {
    if (snapshot.status !== 'done') return;
    const assignment = [...(snapshot.assignments ?? [])].reverse().find(item => item.status === 'succeeded');
    if (!assignment) return;
    const idempotencyKey = knowledgeExtractionIdempotencyKey(snapshot.id, assignment.id);
    if ((snapshot.effects ?? []).some(effect => effect.idempotencyKey === idempotencyKey)) return;

    const metadata = parseWuMetadata(snapshot.metadata);
    const stepRecord = [...(snapshot.stepRecords ?? [])].reverse().find(item => item.assignmentId === assignment.id);
    const repo = metadata.worktreeBaseRepo ?? metadata.workspaceRoot ?? snapshot.projectPath ?? undefined;
    const scope = repo ? { kind: 'repo' as const, id: repo }
      : metadata.pmoId ? { kind: 'project' as const, id: metadata.pmoId }
        : { kind: 'role' as const, id: snapshot.assigneeRoleId ?? 'unknown' };
    await this.trigger(snapshot.id, assignment.id, {
      workUnitId: snapshot.id,
      assignmentId: assignment.id,
      stepRecordId: stepRecord?.id,
      repo,
      commit: metadata.mergeCommit ?? metadata.lastCommitHash,
      transcriptRefs: stepRecord?.transcriptRefs ?? [],
      evidenceRefs: stepRecord?.artifacts ?? [],
      scope,
      extractionVersion: 'conversation-1',
      revision: 1,
      outcome: {
        execution: 'succeeded',
        verification: stepRecord?.verification?.status ?? 'not-run',
        delivery: metadata.mergeCommit ? 'merged' : repo ? 'unmerged' : 'not-required',
      },
    });
  }

  async recoverPending(): Promise<void> {
    await this.effects.recover(({ effect }) => this.perform(effect), {
      include: (_snapshot, effect) => effect.kind === 'knowledge-extraction',
    });
    const snapshots = await this.fileStore.getIndex();
    for (const snapshot of snapshots) {
      try {
        await this.ensureDoneEffect(snapshot);
      } catch (error) {
        logger.warn('[KnowledgeExtractionEffects] recovery enqueue failed', { workUnitId: snapshot.id, error: String(error) });
      }
      for (const effect of snapshot.effects ?? []) {
        if (effect.kind === 'knowledge-extraction' && effect.status === 'queued') {
          this.scheduleRetry(snapshot.id, effect.id, effect.nextAttemptAt);
        }
      }
    }
  }
}

const instances = new WeakMap<FileStore, KnowledgeExtractionEffects>();

export function getKnowledgeExtractionEffects(fileStore: FileStore): KnowledgeExtractionEffects {
  let service = instances.get(fileStore);
  if (!service) {
    service = new KnowledgeExtractionEffects(fileStore);
    instances.set(fileStore, service);
  }
  return service;
}
