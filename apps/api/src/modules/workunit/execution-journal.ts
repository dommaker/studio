import { randomUUID } from 'node:crypto';
import { parseAttestations, type AssignmentRecord, type PresentedContextCursor, type StepRecord, type StepRecordDetails, type WorkUnitMetadataRepository, type WorkUnitSnapshot } from '@dommaker/studio-shared';
import { cancelUnresolvedAssignments, verificationFromMetadata, type WorkUnitData } from './workunit-crud.js';
import type { WorkUnitMetadata } from './workunit.types.js';
import { parseWuMetadata } from './wu-metadata.js';
import { assertExecutionMandate } from './mandate.js';

const PROGRESS_LOG_MAX_ENTRIES = 5;
const PROGRESS_LOG_SUMMARY_MAX_CHARS = 200;

export type ExecutionAction = 'progress' | 'complete' | 'need_input' | 'delegate' | 'failed' | 'skipped';

export interface ExecutionStepResult {
  action: ExecutionAction;
  summary: string;
  assignmentId?: string;
  tokenCount?: number;
  transcriptRecorded?: boolean;
  stepRecord?: StepRecordDetails;
  /** #714：仅成功执行结果携带；由 recordStepResult 绑定本 Assignment 的真实 CLI session。 */
  contextCursor?: PresentedContextCursor;
  rulings?: { question: string; suggestion: string; default?: string }[];
  directions?: WorkUnitMetadata['planDirections'];
  metadataUpdates?: Partial<WorkUnitMetadata>;
}

export interface BeginAssignmentInput {
  wu: WorkUnitData;
  provider: string;
  sessionId?: string;
  worktreePath?: string;
  worktreeBranch?: string;
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

function currentAssignment(snapshot: WorkUnitSnapshot): AssignmentRecord | undefined {
  return (snapshot.assignments ?? []).find(a => a.id === snapshot.currentAssignmentId);
}

function nextAssignment(
  snapshot: WorkUnitSnapshot,
  reason: AssignmentRecord['reason'],
  at: string,
): AssignmentRecord {
  const previous = currentAssignment(snapshot) ?? snapshot.assignments?.[snapshot.assignments.length - 1];
  return {
    id: randomUUID(),
    workUnitId: snapshot.id,
    attempt: Math.max(0, ...(snapshot.assignments ?? []).map(a => a.attempt)) + 1,
    previousAssignmentId: previous?.id ?? null,
    status: 'queued',
    reason,
    createdAt: at,
    updatedAt: at,
    tokenCount: 0,
    transcriptCount: 0,
    progress: [],
    evidence: [],
  };
}

function evidenceFromMetadata(metadata: WorkUnitMetadata): AssignmentRecord['evidence'] {
  const attestations = parseAttestations(metadata);
  if (!attestations) return [];
  return Object.entries(attestations).flatMap(([level, entry]) => entry ? [{
    level,
    verdict: entry.verdict,
    at: entry.at,
  }] : []);
}

/** Agent 执行账本与 Assignment 生命周期的唯一语义写口。 */
export class ExecutionJournal {
  constructor(private readonly repository: WorkUnitMetadataRepository) {}

  /** 开始一个执行步：复用未决轮次；失败/恢复后的下一轮建立链接记录。 */
  async beginStep(input: BeginAssignmentInput): Promise<WorkUnitSnapshot | null> {
    const at = new Date().toISOString();
    return this.repository.mutateSnapshot(input.wu.id, current => {
      assertExecutionMandate(current);
      const existing = currentAssignment(current);
      if (existing && ['queued', 'running'].includes(existing.status)) {
        const updated: AssignmentRecord = {
          ...existing,
          status: 'running',
          provider: input.provider,
          sessionId: input.sessionId ?? existing.sessionId,
          worktreePath: input.worktreePath ?? existing.worktreePath,
          worktreeBranch: input.worktreeBranch ?? existing.worktreeBranch,
          startedAt: existing.startedAt ?? at,
          updatedAt: at,
        };
        return {
          ...current,
          assignments: (current.assignments ?? []).map(a => a.id === updated.id ? updated : a),
        };
      }
      if ((current.assignments ?? []).some(a => ['queued', 'running'].includes(a.status))) return null;
      const assignment = nextAssignment(current, existing?.status === 'failed' ? 'retry' : 'recovery', at);
      const running: AssignmentRecord = {
        ...assignment,
        status: 'running',
        provider: input.provider,
        sessionId: input.sessionId,
        worktreePath: input.worktreePath,
        worktreeBranch: input.worktreeBranch,
        startedAt: at,
      };
      return {
        ...current,
        currentAssignmentId: running.id,
        assignments: [
          ...(current.assignments ?? []).map(old => old.status === 'waiting'
            ? { ...old, status: 'superseded' as const, updatedAt: at, endedAt: at }
            : old),
          running,
        ],
      };
    });
  }

  /** CLI 会话替换不重写旧轮次：supersede 当前轮次并启动链接的新轮次。 */
  replaceForSession(wuId: string, expectedAssignmentId: string, sessionId: string): Promise<WorkUnitSnapshot | null> {
    const at = new Date().toISOString();
    return this.repository.mutateSnapshot(wuId, current => {
      assertExecutionMandate(current);
      const existing = currentAssignment(current);
      if (!existing || existing.id !== expectedAssignmentId || !['queued', 'running'].includes(existing.status)) return null;
      const assignment = nextAssignment(current, 'session-replacement', at);
      const running: AssignmentRecord = {
        ...assignment,
        status: 'running',
        provider: existing.provider,
        sessionId,
        worktreePath: existing.worktreePath,
        worktreeBranch: existing.worktreeBranch,
        startedAt: at,
      };
      return {
        ...current,
        currentAssignmentId: running.id,
        assignments: [
          ...(current.assignments ?? []).map(old => old.id === existing.id
            ? { ...old, status: 'superseded' as const, updatedAt: at, endedAt: at }
            : old),
          running,
        ],
      };
    });
  }

  /** 人类回复结束等待轮次，并以链接的新 queued 轮次继续同一 WU。 */
  resumeWaiting(wuId: string): Promise<WorkUnitSnapshot | null> {
    const at = new Date().toISOString();
    return this.repository.mutateSnapshot(wuId, current => {
      // close 可能插在 metadata 回复与本操作之间；已关闭 WU 不得再复活 queued 轮次。
      if (current.status !== 'blocked') return null;
      assertExecutionMandate(current);
      const existing = currentAssignment(current);
      if (existing && ['queued', 'running'].includes(existing.status)) return current;
      if ((current.assignments ?? []).some(a => ['queued', 'running'].includes(a.status))) return null;
      const assignment = nextAssignment(current, 'need-input-reply', at);
      const assignments = (current.assignments ?? []).map(old =>
        old.id === existing?.id && old.status === 'waiting'
          ? { ...old, status: 'superseded' as const, updatedAt: at, endedAt: at }
          : old
      );
      return {
        ...current,
        currentAssignmentId: assignment.id,
        assignments: [...assignments, assignment],
      };
    });
  }

  /** 超时/系统终止结束时，未决执行不得继续以 running 展示或被人回复复用。 */
  cancelUnresolved(wuId: string): Promise<WorkUnitSnapshot | null> {
    const at = new Date().toISOString();
    return this.repository.mutateSnapshot(wuId, current => ({
      ...current,
      ...cancelUnresolvedAssignments(current, at),
    }));
  }

  /** Token 在实际消耗的 Assignment 上记账；换代后的迟到写同样被 fencing。 */
  recordTokenUsage(wuId: string, assignmentId: string, tokenCount: number): Promise<WorkUnitSnapshot | null> {
    if (!Number.isFinite(tokenCount) || tokenCount <= 0) return Promise.resolve(null);
    const at = new Date().toISOString();
    return this.repository.mutateSnapshot(wuId, current => {
      const assignment = (current.assignments ?? []).find(a => a.id === assignmentId);
      if (!assignment || current.currentAssignmentId !== assignmentId
        || !['queued', 'running'].includes(assignment.status)) return null;
      const updated = { ...assignment, tokenCount: (assignment.tokenCount ?? 0) + tokenCount, updatedAt: at };
      return {
        ...current,
        assignments: (current.assignments ?? []).map(a => a.id === assignmentId ? updated : a),
      };
    });
  }

  recordStepResult(input: RecordStepResultInput): Promise<WorkUnitSnapshot | null> {
    const { wu, action, result, guardUpdates, freshnessUpdates, bookkeeping } = input;
    const stepUpdates = result.metadataUpdates ?? {};
    const persistedMeta = parseWuMetadata(wu.metadata);
    const stepStartReplyCount = Array.isArray(persistedMeta.pendingReplies) ? persistedMeta.pendingReplies.length : 0;
    const consumedPending = 'pendingReplies' in stepUpdates && stepUpdates.pendingReplies === undefined;
    const freshnessHeld = Array.isArray(freshnessUpdates.pendingReplies) ? freshnessUpdates.pendingReplies : [];
    const assignmentId = result.assignmentId ?? wu.execution?.current?.id;

    return this.repository.mutateSnapshot(wu.id, current => {
      const assignment = assignmentId
        ? (current.assignments ?? []).find(a => a.id === assignmentId)
        : undefined;
      // Assignment 是 claimedAt 之外的第二代际令牌；旧轮次迟到结果在锁内一字不写。
      if (assignmentId && (
        current.currentAssignmentId !== assignmentId
        || !assignment
        || !['queued', 'running'].includes(assignment.status)
      )) return null;

      const latestRaw = parseMetadata(current.metadata);
      const latest = latestRaw as WorkUnitMetadata;
      const nextStepCount = (latest.stepCount ?? 0) + 1;
      const at = new Date().toISOString();
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
      const progress = (action === 'progress' || action === 'complete') ? {
        step: nextStepCount,
        action,
        summary: (result.summary ?? '').slice(0, PROGRESS_LOG_SUMMARY_MAX_CHARS),
        at,
        ...(assignmentId ? { assignmentId } : {}),
      } : null;
      if (progress) {
        const prevLog = Array.isArray(latest.progressLog) ? latest.progressLog : [];
        next.progressLog = [...prevLog, progress].slice(-PROGRESS_LOG_MAX_ENTRIES);
      }
      let replies = Array.isArray(latest.pendingReplies) ? [...latest.pendingReplies] : [];
      if (consumedPending) replies = replies.slice(stepStartReplyCount);
      if (freshnessHeld.length > 0) replies.push(...freshnessHeld);
      if (replies.length > 0) next.pendingReplies = replies;
      else delete next.pendingReplies;

      let assignments = current.assignments;
      let stepRecords = current.stepRecords;
      if (assignment) {
        const status = action === 'complete' ? 'succeeded'
          : action === 'need_input' ? 'waiting'
            : action === 'failed' ? 'failed'
              : assignment.status === 'queued' ? 'running' : assignment.status;
        const priorEvidence = assignment.evidence ?? [];
        const nextEvidence = evidenceFromMetadata(next).filter(entry =>
          !priorEvidence.some(old => old.level === entry.level && old.at === entry.at)
        );
        const cliSessionId = typeof next.cliSessionId === 'string'
          ? next.cliSessionId
          : assignment.provider === 'claude' && typeof next.sessionId === 'string'
            ? next.sessionId
            : assignment.cliSessionId;
        const updated: AssignmentRecord = {
          ...assignment,
          status,
          updatedAt: at,
          startedAt: assignment.startedAt ?? at,
          waitingAt: status === 'waiting' ? at : assignment.waitingAt,
          endedAt: status === 'succeeded' || status === 'failed' ? at : assignment.endedAt,
          lastError: action === 'failed' ? result.summary.slice(0, 500) : assignment.lastError,
          tokenCount: (assignment.tokenCount ?? 0) + (result.tokenCount ?? 0),
          transcriptCount: (assignment.transcriptCount ?? 0) + (result.transcriptRecorded ? 1 : 0),
          progress: progress ? [...(assignment.progress ?? []), progress] : assignment.progress ?? [],
          evidence: [...priorEvidence, ...nextEvidence],
          ...(cliSessionId ? { cliSessionId } : {}),
          ...(action !== 'failed' && result.contextCursor && cliSessionId
            ? { presentedContext: result.contextCursor }
            : {}),
        };
        assignments = (current.assignments ?? []).map(a => a.id === assignment.id ? updated : a);

        const details = result.stepRecord ?? {};
        const record: StepRecord = {
          id: randomUUID(),
          workUnitId: current.id,
          assignmentId: assignment.id,
          step: nextStepCount,
          action,
          result: result.summary,
          at,
          acProgress: details.acProgress ?? [],
          modifiedFiles: details.modifiedFiles ?? [],
          commands: details.commands ?? [],
          verification: stepVerification(latest, next, details),
          decisions: details.decisions ?? [],
          artifacts: details.artifacts ?? [],
          nextStep: details.nextStep ?? null,
          transcriptRefs: details.transcriptRefs ?? [],
        };
        stepRecords = [...(current.stepRecords ?? []), record];
      }
      return {
        ...current,
        metadata: JSON.stringify(next),
        ...(assignments ? { assignments } : {}),
        ...(stepRecords ? { stepRecords } : {}),
      };
    });
  }
}

function stepVerification(
  beforeMetadata: WorkUnitMetadata,
  afterMetadata: WorkUnitMetadata,
  details: StepRecordDetails,
) {
  if (details.verification !== undefined) return details.verification;
  const before = parseAttestations(beforeMetadata)?.l1;
  const after = parseAttestations(afterMetadata)?.l1;
  if (!after || JSON.stringify(before) === JSON.stringify(after)) return null;
  return verificationFromMetadata(afterMetadata);
}

function parseMetadata(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
