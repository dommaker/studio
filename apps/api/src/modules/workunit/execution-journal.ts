import type { WorkUnitMetadataRepository, WorkUnitSnapshot } from '@dommaker/studio-shared';
import type { WorkUnitData } from './workunit-crud.js';
import type { WorkUnitMetadata } from './workunit.types.js';
import { parseWuMetadata } from './wu-metadata.js';

const PROGRESS_LOG_MAX_ENTRIES = 5;
const PROGRESS_LOG_SUMMARY_MAX_CHARS = 200;

export type ExecutionAction = 'progress' | 'complete' | 'need_input' | 'delegate' | 'failed' | 'skipped';

export interface ExecutionStepResult {
  action: ExecutionAction;
  summary: string;
  rulings?: { question: string; suggestion: string; default?: string }[];
  directions?: WorkUnitMetadata['planDirections'];
  metadataUpdates?: Partial<WorkUnitMetadata>;
}

export interface StepBookkeeping {
  stepCount: number;
  consecutiveStuck: number;
  waitingUpdates: Partial<WorkUnitMetadata>;
  blockReasonUpdates: Partial<WorkUnitMetadata>;
}

export interface RecordStepResultInput {
  wu: WorkUnitData;
  metadata: WorkUnitMetadata;
  action: ExecutionAction;
  result: ExecutionStepResult;
  guardUpdates: Partial<WorkUnitMetadata>;
  freshnessUpdates: Partial<WorkUnitMetadata>;
  bookkeeping: StepBookkeeping;
}

/** Agent 执行账本的唯一 recordStepResult 写口；锁内合并规则不泄漏给 AgentLoop。 */
export class ExecutionJournal {
  constructor(private readonly repository: WorkUnitMetadataRepository) {}

  recordStepResult(input: RecordStepResultInput): Promise<WorkUnitSnapshot | null> {
    const { wu, action, result, guardUpdates, freshnessUpdates, bookkeeping } = input;
    const stepUpdates = result.metadataUpdates ?? {};
    const persistedMeta = parseWuMetadata(wu.metadata);
    const stepStartReplyCount = Array.isArray(persistedMeta.pendingReplies) ? persistedMeta.pendingReplies.length : 0;
    const consumedPending = 'pendingReplies' in stepUpdates && stepUpdates.pendingReplies === undefined;
    const freshnessHeld = Array.isArray(freshnessUpdates.pendingReplies) ? freshnessUpdates.pendingReplies : [];

    return this.repository.mutate(wu.id, latestRaw => {
      const latest = latestRaw as WorkUnitMetadata;
      const nextStepCount = (latest.stepCount ?? 0) + 1;
      const next: WorkUnitMetadata = {
        ...latest,
        ...stepUpdates,
        ...bookkeeping.waitingUpdates,
        ...guardUpdates,
        ...freshnessUpdates,
        ...bookkeeping.blockReasonUpdates,
        stepCount: nextStepCount,
        consecutiveStuck: action === 'progress' ? 0 : (latest.consecutiveStuck ?? 0) + 1,
      };
      if (action === 'progress' || action === 'complete') {
        const prevLog = Array.isArray(latest.progressLog) ? latest.progressLog : [];
        next.progressLog = [...prevLog, {
          step: nextStepCount,
          action,
          summary: (result.summary ?? '').slice(0, PROGRESS_LOG_SUMMARY_MAX_CHARS),
          at: new Date().toISOString(),
        }].slice(-PROGRESS_LOG_MAX_ENTRIES);
      }
      let replies = Array.isArray(latest.pendingReplies) ? [...latest.pendingReplies] : [];
      if (consumedPending) replies = replies.slice(stepStartReplyCount);
      if (freshnessHeld.length > 0) replies.push(...freshnessHeld);
      if (replies.length > 0) next.pendingReplies = replies;
      else delete next.pendingReplies;
      return next as Record<string, unknown>;
    });
  }
}
