import type { WorkUnitMetadataRepository, WorkUnitSnapshot } from '@dommaker/studio-shared';
import { PLAN_STEP_LIMIT } from './workunit.types.js';

export type WaitingGateCommand =
  | { kind: 'buffer-reply'; replyText: string; traceId?: string | null }
  | { kind: 'resume'; replyText: string; traceId?: string | null }
  | { kind: 'bind-ownership'; replyText: string; workspaceRoot: string; traceId?: string | null }
  | { kind: 'ownership-attempt' }
  | { kind: 'grant-requirement-override' }
  | { kind: 'clear-plan-ruling' }
  | { kind: 'clear-plan-direction' }
  | { kind: 'mark-reminder'; field: 'gateReminderTier1At' | 'gateReminderTier2At'; at: string };

/** F5 等待人输入状态及人工续期的语义写口。 */
export class WaitingGate {
  constructor(private readonly repository: WorkUnitMetadataRepository) {}

  apply(wuId: string, command: WaitingGateCommand): Promise<WorkUnitSnapshot | null> {
    if (command.kind === 'mark-reminder') {
      return this.repository.mutate(
        wuId,
        latest => ({ ...latest, [command.field]: command.at }),
        { touchUpdatedAt: false },
      );
    }
    return this.repository.mutate(wuId, latest => {
      const pendingReplies = 'replyText' in command
        ? [...(Array.isArray(latest.pendingReplies) ? latest.pendingReplies : []), command.replyText]
        : undefined;
      const trace = 'traceId' in command && command.traceId ? { traceId: command.traceId } : {};
      switch (command.kind) {
        case 'buffer-reply':
          return { ...latest, pendingReplies, ...trace };
        case 'resume':
          return {
            ...latest, waitingForInput: false, waitingReminded: false, blockReason: undefined,
            consecutiveStuck: 0, resumeCount: (typeof latest.resumeCount === 'number' ? latest.resumeCount : 0) + 1,
            pendingReplies, ...trace,
          };
        case 'bind-ownership':
          return {
            ...latest, waitingForInput: false, waitingReminded: false, waitingReason: undefined,
            workspaceRoot: command.workspaceRoot, ownershipSource: 'human-reply', ownershipAttempts: undefined,
            pendingReplies, ...trace,
          };
        case 'ownership-attempt':
          return { ...latest, ownershipAttempts: (typeof latest.ownershipAttempts === 'number' ? latest.ownershipAttempts : 0) + 1 };
        case 'grant-requirement-override':
          return { ...latest, requirementOverride: true, waitingReason: undefined };
        case 'clear-plan-ruling':
          return { ...latest, waitingReason: undefined, planRulings: undefined };
        case 'clear-plan-direction':
          return { ...latest, waitingReason: undefined, planDirections: undefined };
      }
    });
  }

  renew(wuId: string): Promise<WorkUnitSnapshot | null> {
    return this.repository.mutate(wuId, latest => ({
      ...latest,
      planStepAllowance: (typeof latest.planStepAllowance === 'number' && latest.planStepAllowance > 0
        ? Math.floor(latest.planStepAllowance)
        : PLAN_STEP_LIMIT) + PLAN_STEP_LIMIT,
      waitingReason: undefined,
    }));
  }
}
