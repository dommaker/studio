import {
  type FileStore,
  type MandateRecord,
  type StepAcProgress,
  type StepRecord,
  type StepVerificationRecord,
  type WorkUnitSnapshot,
} from '@dommaker/studio-shared';
import { withDirectoryCapability } from '@dommaker/studio-shared/node';
import { execFileAsync } from '../../core/exec-async.js';
import { verificationFromMetadata, type WorkUnitData } from './workunit-crud.js';
import { parseWuMetadata } from './wu-metadata.js';

export interface RecoveryRepositoryState {
  root: string;
  branch: string | null;
  commit: string | null;
  /** null = 本次无法读取，绝不能把旧摘要当作干净或 dirty 现状。 */
  dirty: boolean | null;
  readAt: string;
}

export interface RecoveryPacket {
  workUnitId: string;
  assignmentId: string | null;
  mandate: MandateRecord | null;
  acceptanceCriteria: StepAcProgress[];
  confirmedDecisions: string[];
  repository: RecoveryRepositoryState | null;
  unfinishedItems: string[];
  recentVerification: StepVerificationRecord | null;
  openQuestions: string[];
  transcriptRefs: string[];
  steps: StepRecord[];
}

/** 恢复时重新读取真实仓库；任何 Git 故障都保留 unknown/null。 */
export async function readRecoveryRepository(root: string): Promise<RecoveryRepositoryState> {
  const readAt = new Date().toISOString();
  try {
    return await withDirectoryCapability(root, async cwd => {
      try {
        const [branch, commit, status] = await Promise.all([
          execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeout: 5000 }),
          execFileAsync('git', ['rev-parse', 'HEAD'], { cwd, timeout: 5000 }),
          execFileAsync('git', ['status', '--porcelain'], { cwd, timeout: 5000 }),
        ]);
        return {
          root,
          branch: branch.trim() || null,
          commit: commit.trim() || null,
          dirty: status.trim().length > 0,
          readAt,
        };
      } catch {
        return { root, branch: null, commit: null, dirty: null, readAt };
      }
    });
  } catch {
    return { root, branch: null, commit: null, dirty: null, readAt };
  }
}

/** 只从 typed StepRecord 与当前快照派生，不消费 sessionSummary/progressLog。 */
export function createRecoveryPacket(
  snapshot: WorkUnitSnapshot,
  repository: RecoveryRepositoryState | null,
): RecoveryPacket {
  const metadata = parseWuMetadata(snapshot.metadata);
  const steps = snapshot.stepRecords ?? [];
  const latestAc = new Map<string, StepAcProgress>();
  for (const step of steps) {
    for (const progress of step.acProgress ?? []) latestAc.set(progress.ac, progress);
  }
  const acNames = [...(metadata.ac ?? [])];
  for (const ac of latestAc.keys()) if (!acNames.includes(ac)) acNames.push(ac);
  const acceptanceCriteria = acNames.map(ac => latestAc.get(ac) ?? { ac, status: 'pending' as const });

  const confirmedDecisions = unique(steps.flatMap(step => step.decisions ?? []));
  const latestNextStep = [...steps].reverse().find(step => step.nextStep?.trim())?.nextStep?.trim();
  const unfinishedItems = unique([
    ...acceptanceCriteria.filter(item => item.status !== 'completed').map(item => item.ac),
    ...(latestNextStep ? [latestNextStep] : []),
  ]);

  const recentVerification = [...steps].reverse().find(step => step.verification)?.verification
    ?? verificationFromMetadata(metadata);

  const openQuestions = metadata.waitingForInput && metadata.waitingQuestion?.trim()
    ? [metadata.waitingQuestion.trim()]
    : [];

  return {
    workUnitId: snapshot.id,
    assignmentId: snapshot.currentAssignmentId ?? null,
    mandate: snapshot.mandate ?? null,
    acceptanceCriteria,
    confirmedDecisions,
    repository,
    unfinishedItems,
    recentVerification,
    openQuestions,
    transcriptRefs: unique(steps.flatMap(step => step.transcriptRefs ?? [])),
    steps,
  };
}

/** 新会话恢复入口：重读当前 WU 快照和实时 Git，不信任调用方持有的旧摘要。 */
export async function loadRecoveryPacket(
  fileStore: FileStore,
  wu: WorkUnitData,
): Promise<RecoveryPacket | null> {
  const snapshot = (await fileStore.getIndex({ id: wu.id }))[0];
  if (!snapshot) return null;
  const metadata = parseWuMetadata(snapshot.metadata);
  const assignment = (snapshot.assignments ?? []).find(item => item.id === snapshot.currentAssignmentId);
  const root = assignment?.worktreePath
    ?? metadata.worktreePath
    ?? metadata.workspaceRoot
    ?? snapshot.projectPath;
  const repository = root ? await readRecoveryRepository(root) : null;
  return createRecoveryPacket(snapshot, repository);
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(value => value.trim().length > 0))];
}
