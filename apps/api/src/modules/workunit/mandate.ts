import {
  FileStore,
  WorkUnitMetadataRepository,
  type MandatePrincipal,
  type MandateRecord,
  type MandateSource,
  type WorkUnitSnapshot,
} from '@dommaker/studio-shared';
import type { WorkUnitMetadata } from './workunit.types.js';
import { parseWuMetadata } from './wu-metadata.js';

export interface MandateAuthorization {
  requestedBy: MandatePrincipal;
  source: MandateSource;
  /** 多仓规划等服务端已解析的初始范围；派生时忽略，只能继承父子集。 */
  repositories?: MandateRecord['repositories'];
}

export const SYSTEM_PRINCIPAL: MandatePrincipal = { id: 'system', type: 'System' };

function finiteBudget(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/** 建单时把已解析的执行归属固化为授权范围；后续消息不会改写此记录。 */
export function issueMandate(input: {
  workUnitId: string;
  reqId?: string | null;
  metadata: WorkUnitMetadata;
  authorization?: MandateAuthorization;
  parentMandate?: MandateRecord;
  now?: Date;
}): MandateRecord {
  const requestedBy = input.parentMandate?.requestedBy ?? input.authorization?.requestedBy ?? SYSTEM_PRINCIPAL;
  const at = (input.now ?? new Date()).toISOString();
  const repo = input.metadata.workspaceRoot;
  const repositories = repo ? [{ repo, leg: input.metadata.pmoBranch ?? input.metadata.worktreeBaseBranch ?? null }] : [];
  const tokens = input.metadata.tokenBudget === undefined && input.parentMandate
    ? input.parentMandate.budget.tokens : finiteBudget(input.metadata.tokenBudget);
  const planSteps = input.metadata.planStepAllowance === undefined && input.parentMandate
    ? input.parentMandate.budget.planSteps : finiteBudget(input.metadata.planStepAllowance);
  if (input.parentMandate) {
    const parent = input.parentMandate;
    if (parent.revokedAt) throw new Error('Mandate revoked');
    if (!parent.deliveryActions.includes('merge')) throw new Error('Mandate scope exceeded: merge');
    if (repositories.some(scope => !parent.repositories.some(allowed =>
      allowed.repo === scope.repo && (allowed.leg === null || allowed.leg === scope.leg)))) {
      throw new Error('Mandate scope exceeded: repository');
    }
    if ((parent.budget.tokens !== null && (tokens === null || tokens > parent.budget.tokens))
      || (parent.budget.planSteps !== null && (planSteps === null || planSteps > parent.budget.planSteps))) {
      throw new Error('Mandate scope exceeded: budget');
    }
  }
  return {
    workUnitId: input.workUnitId,
    revision: 1,
    policyVersion: '1',
    requestedBy,
    grantedBy: requestedBy,
    grantedAt: at,
    source: input.parentMandate
      ? { kind: 'derived', parentWorkUnitId: input.parentMandate.workUnitId }
      : input.authorization?.source ?? { kind: 'system' },
    reqId: input.parentMandate?.reqId ?? input.reqId ?? null,
    pmoId: input.parentMandate?.pmoId ?? (typeof input.metadata.pmoId === 'string' ? input.metadata.pmoId : null),
    repositories: input.parentMandate
      ? (repositories.length > 0 ? repositories : input.parentMandate.repositories)
      : input.authorization?.repositories ?? repositories,
    deliveryActions: input.parentMandate
      ? [...input.parentMandate.deliveryActions]
      : ['merge', 'deliver', 'mark-delivered'],
    budget: { tokens, planSteps },
    // 系统内部建单允许系统策略续期；外部 Operator 仍须经过认证主体。
    expansionPrincipals: input.parentMandate?.expansionPrincipals
      ?? (requestedBy.type === 'System' ? [SYSTEM_PRINCIPAL] : []),
    history: [{ revision: 1, action: 'issued', actor: requestedBy, at }],
  };
}

export interface MandateExpansion {
  repositories?: MandateRecord['repositories'];
  deliveryActions?: MandateRecord['deliveryActions'];
  budget?: { tokens?: number | null; planSteps?: number | null };
  reason?: string;
}

function samePrincipal(left: MandatePrincipal, right: MandatePrincipal): boolean {
  return left.id === right.id && left.type === right.type;
}

export function canExpandMandate(mandate: MandateRecord, actor: MandatePrincipal): boolean {
  // 策略 v1：认证 Operator（含项目 owner）或 Mandate 显式列出的系统主体。
  return actor.type === 'Operator'
    || mandate.expansionPrincipals.some(principal => samePrincipal(principal, actor));
}

/** 新执行与延迟副作用的共同重验口；未知策略和旧单均 fail-closed。 */
export function assertMandateActive(snapshot: Pick<WorkUnitSnapshot, 'mandate'> | undefined): MandateRecord {
  const mandate = snapshot?.mandate;
  if (!mandate) throw new Error('Mandate authorization required');
  if (mandate.policyVersion !== '1') throw new Error('Mandate policy version unsupported');
  if (mandate.revokedAt) throw new Error('Mandate revoked');
  return mandate;
}

export function assertMandateScope(
  snapshot: Pick<WorkUnitSnapshot, 'mandate'> | undefined,
  scope: { repo: string; leg: string | null },
): MandateRecord {
  const mandate = assertMandateActive(snapshot);
  if (!mandate.repositories.some(allowed =>
    allowed.repo === scope.repo && (allowed.leg === null || allowed.leg === scope.leg))) {
    throw new Error(`Mandate scope exceeded: ${scope.repo} ${scope.leg ?? '*'}`);
  }
  return mandate;
}

/** claim、会话替换与回复恢复共用：撤销、策略版本和当前执行根均须有效。 */
export function assertExecutionMandate(snapshot: WorkUnitSnapshot): MandateRecord {
  const mandate = assertMandateActive(snapshot);
  const metadata = parseWuMetadata(snapshot.metadata);
  if (metadata.workspaceRoot) {
    assertMandateScope(snapshot, {
      repo: metadata.workspaceRoot,
      leg: metadata.pmoBranch ?? metadata.worktreeBaseBranch ?? null,
    });
  }
  return mandate;
}

export function assertMandateAllows(
  snapshot: Pick<WorkUnitSnapshot, 'mandate'> | undefined,
  action: MandateRecord['deliveryActions'][number],
  scope: { repo: string; leg: string | null },
): MandateRecord {
  const mandate = assertMandateScope(snapshot, scope);
  if (!mandate.deliveryActions.includes(action)) throw new Error(`Mandate scope exceeded: ${action}`);
  return mandate;
}

/** Mandate 唯一语义写口；开放 metadata 仅保留现有执行链所需的兼容镜像。 */
export class MandateService {
  private readonly repository: WorkUnitMetadataRepository;

  constructor(private readonly fileStore: FileStore) {
    this.repository = new WorkUnitMetadataRepository(fileStore);
  }

  async authorize(id: string, actor: MandatePrincipal, patch: MandateExpansion): Promise<WorkUnitSnapshot> {
    const existing = (await this.fileStore.getIndex({ id }))[0];
    if (!existing) throw new Error('WorkUnit not found');
    // 旧单没有可证明的请求人；Operator 的显式重新授权才会创建 Mandate。
    if (!existing.mandate && actor.type !== 'Operator') throw new Error('Mandate authorization required');
    const updated = await this.repository.mutateSnapshot(id, current => {
      const previous = current.mandate;
      if (previous && !canExpandMandate(previous, actor)) throw new Error('Mandate expansion forbidden');
      const at = new Date().toISOString();
      const base = previous ?? issueMandate({
        workUnitId: id,
        reqId: current.reqId,
        metadata: parseWuMetadata(current.metadata),
        authorization: { requestedBy: actor, source: { kind: 'api' } },
      });
      const next: MandateRecord = {
        ...base,
        revision: base.revision + (previous ? 1 : 0),
        grantedBy: actor,
        grantedAt: at,
        repositories: patch.repositories ?? base.repositories,
        deliveryActions: patch.deliveryActions ?? base.deliveryActions,
        budget: {
          tokens: patch.budget && 'tokens' in patch.budget ? patch.budget.tokens ?? null : base.budget.tokens,
          planSteps: patch.budget && 'planSteps' in patch.budget ? patch.budget.planSteps ?? null : base.budget.planSteps,
        },
        revokedAt: undefined,
        revokedBy: undefined,
        revokeReason: undefined,
        history: [...base.history, {
          revision: base.revision + (previous ? 1 : 0),
          action: previous?.revokedAt ? 'reauthorized' : previous ? 'expanded' : 'issued',
          actor,
          at,
          ...(patch.reason ? { reason: patch.reason } : {}),
        }],
      };
      const metadata = parseWuMetadata(current.metadata);
      if (patch.repositories?.length) {
        metadata.workspaceRoot = patch.repositories[0].repo;
        metadata.pmoBranch = patch.repositories[0].leg ?? undefined;
      }
      if (patch.budget && 'tokens' in patch.budget) metadata.tokenBudget = next.budget.tokens ?? undefined;
      if (patch.budget && 'planSteps' in patch.budget) metadata.planStepAllowance = next.budget.planSteps ?? undefined;
      return { ...current, metadata: JSON.stringify(metadata), mandate: next };
    });
    if (!updated) throw new Error('WorkUnit not found');
    return updated;
  }

  async revoke(id: string, actor: MandatePrincipal, reason?: string): Promise<WorkUnitSnapshot> {
    const updated = await this.repository.mutateSnapshot(id, current => {
      if (!current.mandate) throw new Error('Mandate authorization required');
      if (!canExpandMandate(current.mandate, actor)) throw new Error('Mandate expansion forbidden');
      const at = new Date().toISOString();
      const revision = current.mandate.revision + 1;
      const effects = (current.effects ?? []).map(effect =>
        effect.status === 'queued'
          ? { ...effect, status: 'cancelled' as const, lastError: reason ?? 'Mandate revoked', nextAttemptAt: undefined, updatedAt: at }
          : effect.status === 'running'
            ? { ...effect, status: 'needs_reconciliation' as const, updatedAt: at }
            : effect);
      const cancellationReceipts = (current.effects ?? []).filter(effect => effect.status === 'queued').map(effect => ({
        id: `receipt-${effect.id}-revocation-${revision}`,
        effectId: effect.id,
        idempotencyKey: effect.idempotencyKey,
        outcome: 'cancelled' as const,
        at,
        attempts: effect.attempts,
        error: reason ?? 'Mandate revoked',
        recovery: 'revocation' as const,
      }));
      return {
        ...current,
        effects,
        effectReceipts: [...(current.effectReceipts ?? []), ...cancellationReceipts],
        mandate: {
          ...current.mandate,
          revision,
          revokedAt: at,
          revokedBy: actor,
          ...(reason ? { revokeReason: reason } : {}),
          history: [...current.mandate.history, { revision, action: 'revoked', actor, at, ...(reason ? { reason } : {}) }],
        },
        assignments: (current.assignments ?? []).map(assignment =>
          ['queued', 'running', 'waiting'].includes(assignment.status)
            ? { ...assignment, status: 'cancelled' as const, updatedAt: at, endedAt: at }
            : assignment),
      };
    });
    if (!updated) throw new Error('WorkUnit not found');
    return updated;
  }
}
