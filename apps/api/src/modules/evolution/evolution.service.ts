/**
 * E1 约束进化：服务门面（EvolutionService）。
 *
 * 串起整条链路：runScan（信号 → 提案 → 发审核卡到 #系统）与 decide（人类决策 → 生效）。
 * 人审通道（#623）：review-proposal 正本卡片（kind='evolution'，构造本服务即注册
 * adapter）；频道文本审核（approve/reject + EP 编号回复解析）已退役。
 * 卡片审批与 HTTP API 共用同一个 decide 路径（同一幂等语义）。
 *
 * 生效保证：
 *   - 绝不自动生效 —— 只有 decide('approve') 会调用 applier；
 *   - 幂等 —— 已 rejected/applied 的提案再决策抛 CONFLICT；
 *   - 可重试 —— approve 后 apply 失败：状态停留 'approved'，抛 APPLY_FAILED，
 *     再次 approve 可重试 apply。
 */
import {
  eventBus,
  FileStore,
  type EvolutionMetricSnapshot,
  type EvolutionProposalData,
  type EvolutionProposalFilter,
} from '@dommaker/studio-shared';
import { logger } from '@dommaker/studio-shared/node';
import { applyProposal, rollbackProposal, type ApplyResult } from './applier.js';
import {
  EVOLUTION_PROPOSAL_TTL_MS,
  generateEvolutionProposals,
  isProposalExpired,
  type GenerationResult,
} from './generator.js';
import { postEvolutionProposalCard, registerEvolutionReviewAdapter, type EvolutionReviewProposal } from './review-adapter.js';
import {
  registerConstraintReviewAdapter,
  scanConstraintCandidates,
  type ConstraintProposal,
  type ConstraintScanResult,
} from './constraint-adapter.js';
import type { ReviewProposalAdapter } from '../review-proposal/index.js';
import { sharedStore } from '../knowledge/index.js';
import type { KnowledgeEntry, KnowledgeStore } from '@dommaker/harness';
import { loadWindowSignals, resolveEvolutionPaths, type EvolutionPaths } from './signals.js';
import { getErrorMessage } from '../../utils/errors.js';
import { getStore } from '../../core/store.js';

async function captureEvolutionMetrics(
  proposal: EvolutionProposalData,
  paths: EvolutionPaths,
  windowHours: number,
  untilMs: number = Date.now(),
): Promise<EvolutionMetricSnapshot> {
  const signals = await loadWindowSignals(paths, windowHours, untilMs);
  // 约束 retire/disable 后自身 trace 消失，不能拿零 trace 当改善；与 prompt 一样看整体执行结果。
  const failures = proposal.targetType === 'role-preset'
    ? signals.toolCalls.filter(e => e.caller === proposal.targetId).map(e => e.success === false)
    : signals.outcomes.map(o => !o.success);
  const failureCount = failures.filter(Boolean).length;
  return {
    sampleCount: failures.length,
    failureCount,
    failureRate: failures.length > 0 ? failureCount / failures.length : 0,
  };
}

export class EvolutionError extends Error {
  code: 'NOT_FOUND' | 'CONFLICT' | 'APPLY_FAILED';
  constructor(code: EvolutionError['code'], message: string) {
    super(message);
    this.name = 'EvolutionError';
    this.code = code;
  }
}

export interface EvolutionServiceOptions {
  fileStore?: FileStore;
  paths?: Partial<EvolutionPaths>;
  /** 信号窗口，默认 env EVOLUTION_WINDOW_HOURS || 24 */
  windowHours?: number;
  /** 生效后观察窗口，默认 env EVOLUTION_OBSERVATION_WINDOW_HOURS || 24 */
  observationWindowHours?: number;
  /** false 时 runScan 只生成提案不发审核卡（测试用） */
  postCard?: boolean;
  /**
   * 子项 7 约束候选扫描的知识条目来源（constraintCandidate 标签）。
   * 缺省 = 不扫（测试保持封闭）；生产单例 getEvolutionService 显式接 sharedStore。
   */
  constraintCandidates?: { listEntries: () => KnowledgeEntry[] };
  /** 回退时归档关联知识；测试可注入封闭存储。 */
  knowledgeStore?: Pick<KnowledgeStore, 'get' | 'update'>;
  /** constraint 提案存取目录（缺省 <studio>/data/evolution；测试注 tmp） */
  constraintDataDir?: string;
}

export class EvolutionService {
  private fileStore: FileStore;
  private paths: EvolutionPaths;
  private windowHours: number;
  private observationWindowHours: number;
  private postCard: boolean;
  private constraintCandidates?: { listEntries: () => KnowledgeEntry[] };
  private knowledgeStore: Pick<KnowledgeStore, 'get' | 'update'>;
  /** review-proposal 正本 adapter（kind='evolution'，构造即注册，#623） */
  readonly reviewAdapter: ReviewProposalAdapter<EvolutionReviewProposal>;
  /** review-proposal 正本 adapter（kind='constraint'，构造即注册，ADR-0033 子项 7/8） */
  readonly constraintAdapter: ReviewProposalAdapter<ConstraintProposal>;

  constructor(options?: EvolutionServiceOptions) {
    this.fileStore = options?.fileStore ?? getStore();
    this.paths = resolveEvolutionPaths(options?.paths);
    this.windowHours = options?.windowHours ?? (Number(process.env.EVOLUTION_WINDOW_HOURS) > 0 ? Number(process.env.EVOLUTION_WINDOW_HOURS) : 24);
    this.observationWindowHours = options?.observationWindowHours ?? (Number(process.env.EVOLUTION_OBSERVATION_WINDOW_HOURS) > 0 ? Number(process.env.EVOLUTION_OBSERVATION_WINDOW_HOURS) : 24);
    this.postCard = options?.postCard !== false;
    this.constraintCandidates = options?.constraintCandidates;
    this.knowledgeStore = options?.knowledgeStore ?? sharedStore;
    this.reviewAdapter = registerEvolutionReviewAdapter({ fileStore: this.fileStore, service: this });
    this.constraintAdapter = registerConstraintReviewAdapter({
      fileStore: this.fileStore,
      ...(options?.constraintDataDir ? { dataDir: options.constraintDataDir } : {}),
    });
  }

  get store(): FileStore {
    return this.fileStore;
  }

  async list(filter?: EvolutionProposalFilter): Promise<EvolutionProposalData[]> {
    return this.fileStore.listEvolutionProposals(filter);
  }

  async get(id: string): Promise<EvolutionProposalData | null> {
    return this.fileStore.getEvolutionProposal(id);
  }

  /** 跑一轮提案生成并把新提案发审核卡到 #系统（best-effort）。目标仓库必须显式选择。 */
  async runScan(
    repoRoot: string,
    options?: { roleProfileTargets?: Readonly<Record<string, string[]>> },
  ): Promise<GenerationResult & { posted: number; constraintScan?: ConstraintScanResult }> {
    if (!repoRoot?.trim()) throw new Error('Evolution scan requires an explicit repoRoot');
    await this.settleObservations();
    const paths = resolveEvolutionPaths({ repoRoot, studioEventsFile: this.paths.studioEventsFile });
    const result = await generateEvolutionProposals({
      fileStore: this.fileStore,
      paths,
      windowHours: this.windowHours,
      ...(options?.roleProfileTargets ? { roleProfileTargets: options.roleProfileTargets } : {}),
    });
    let posted = 0;
    if (this.postCard) {
      for (const p of result.created) {
        if (await postEvolutionProposalCard(this.reviewAdapter, p)) posted++;
      }
    }
    for (const p of result.created) {
      try { eventBus.publish('evolution.proposed', { proposal: p }); } catch { /* non-blocking */ }
    }
    // 子项 7：知识→约束候选扫描（constraintCandidate 标签 → constraint_proposal 卡）。
    // 显式装配才启用（缺省不扫）；失败告警不拖垮 evolution 主扫描。
    let constraintScan: ConstraintScanResult | undefined;
    if (this.constraintCandidates) {
      try {
        constraintScan = await scanConstraintCandidates({
          adapter: this.constraintAdapter,
          listEntries: this.constraintCandidates.listEntries,
          repoRoot,
          postCard: this.postCard,
        });
      } catch (err) {
        logger.warn('[Evolution] constraint candidate scan failed', { error: String(err) });
      }
    }
    if (result.created.length > 0 || (constraintScan && constraintScan.created.length > 0)) {
      logger.info('[Evolution] scan completed', {
        created: result.created.length, posted, skipped: result.skipped,
        constraintCandidates: constraintScan?.created.length ?? 0,
      });
    }
    return { ...result, posted, ...(constraintScan ? { constraintScan } : {}) };
  }

  /** 结算到期观察：后窗失败率不恶化则保留，否则恢复生效前内容并归档关联知识。 */
  async settleObservations(): Promise<{ kept: string[]; rolledBack: string[] }> {
    const kept: string[] = [];
    const rolledBack: string[] = [];
    const proposals = await this.fileStore.listEvolutionProposals({ status: 'applied' });
    for (const proposal of proposals) {
      const observation = proposal.observation;
      if (!observation || observation.decision || Date.parse(observation.endsAt) > Date.now()) continue;
      if (!proposal.targetRepo) throw new Error(`observed proposal has no targetRepo: ${proposal.id}`);
      const paths = resolveEvolutionPaths({
        repoRoot: proposal.targetRepo,
        studioEventsFile: this.paths.studioEventsFile,
      });
      const afterMetrics = await captureEvolutionMetrics(proposal, paths, observation.windowHours, Date.parse(observation.endsAt));
      const decision = afterMetrics.failureRate <= observation.beforeMetrics.failureRate ? 'keep' : 'rollback';
      const decidedAt = new Date().toISOString();
      const decisionReason = afterMetrics.sampleCount === 0
        ? '观察窗口无新样本，未出现退化'
        : `失败率 ${observation.beforeMetrics.failureRate} → ${afterMetrics.failureRate}`;
      let restoredAt: string | undefined;
      let rollbackError: string | undefined;
      if (decision === 'rollback') {
        try {
          await rollbackProposal(proposal, paths, { fileStore: this.fileStore });
          restoredAt = new Date().toISOString();
          for (const entryId of observation.knowledgeEntryIds ?? []) {
            const entry = this.knowledgeStore.get(entryId);
            if (entry && entry.maturity !== 'archived') {
              this.knowledgeStore.update(entryId, {
                maturity: 'archived',
                tags: [...new Set([...(entry.tags ?? []), 'evolution-rolled-back'])],
              });
            }
          }
        } catch (err) {
          rollbackError = getErrorMessage(err);
          logger.error('[Evolution] rollback failed', { id: proposal.id, error: rollbackError });
        }
      }
      const updated = await this.fileStore.updateEvolutionProposal(proposal.id, {
        observation: {
          ...observation,
          afterMetrics,
          decision,
          decidedAt,
          decisionReason,
          ...(restoredAt ? { restoredAt } : {}),
          ...(rollbackError ? { rollbackError } : {}),
        },
      });
      (decision === 'keep' ? kept : rolledBack).push(proposal.id);
      try { eventBus.publish('evolution.observation_decided', { proposal: updated }); } catch { /* non-blocking */ }
    }
    return { kept, rolledBack };
  }

  /**
   * 人类决策（提案卡 approve/reject 与 API 共用）。
   * approve：pending → approved → 同步 apply → applied（发 evolution.applied 事件）。
   *          approved（apply 曾失败）→ 重试 apply。
   * reject：pending → rejected（reason 可选）。
   */
  async decide(
    id: string,
    decision: 'approve' | 'reject',
    opts?: { decidedBy?: string; reason?: string },
  ): Promise<EvolutionProposalData> {
    const existing = await this.fileStore.getEvolutionProposal(id);
    if (!existing) throw new EvolutionError('NOT_FOUND', `Evolution proposal not found: ${id}`);

    // TTL（#602 D2）：超期未审的 pending/approved 不再接受决策，惰性转 stale，
    // 等下一轮扫描重新生成带新证据的提案。
    if (isProposalExpired(existing)) {
      await this.fileStore.updateEvolutionProposal(id, { status: 'stale', staledAt: new Date().toISOString() });
      const ttlDays = Math.round(EVOLUTION_PROPOSAL_TTL_MS / 86_400_000);
      throw new EvolutionError('CONFLICT', `${id} 超期未审（TTL ${ttlDays}d），已转 stale；触发新一轮扫描可重新生成`);
    }

    if (decision === 'reject') {
      if (existing.status !== 'pending') {
        throw new EvolutionError('CONFLICT', `${id} is already ${existing.status}, cannot reject`);
      }
      return this.fileStore.updateEvolutionProposal(id, {
        status: 'rejected',
        decidedBy: opts?.decidedBy ?? null,
        decidedAt: new Date().toISOString(),
        rejectReason: opts?.reason ?? null,
      });
    }

    // approve
    if (existing.status === 'rejected') {
      throw new EvolutionError('CONFLICT', `${id} is already rejected, cannot approve`);
    }
    if (existing.status === 'applied') {
      throw new EvolutionError('CONFLICT', `${id} is already applied`);
    }
    if (!existing.targetRepo?.trim()) {
      throw new EvolutionError('CONFLICT', `${id} 缺少显式 targetRepo，禁止回退 process.cwd() 生效`);
    }
    let proposal = existing;
    if (proposal.status === 'pending') {
      proposal = await this.fileStore.updateEvolutionProposal(id, {
        status: 'approved',
        decidedBy: opts?.decidedBy ?? null,
        decidedAt: new Date().toISOString(),
      });
    }
    // status === 'approved'：执行生效（含重试路径）
    const targetPaths = resolveEvolutionPaths({
      repoRoot: proposal.targetRepo!,
      studioEventsFile: this.paths.studioEventsFile,
    });
    let applyResult: ApplyResult;
    try {
      applyResult = await applyProposal(proposal, targetPaths, { fileStore: this.fileStore });
    } catch (err) {
      logger.error('[Evolution] apply failed', { id, error: String(err) });
      throw new EvolutionError('APPLY_FAILED', `${id} approved but apply failed: ${getErrorMessage(err)}`);
    }
    const startedAt = new Date();
    const beforeMetrics = await captureEvolutionMetrics(proposal, targetPaths, this.observationWindowHours, startedAt.getTime());
    proposal = await this.fileStore.updateEvolutionProposal(id, {
      status: 'applied',
      appliedAt: startedAt.toISOString(),
      observation: {
        targetPath: applyResult.targetPath,
        backupPath: applyResult.backupPath,
        targetRevision: applyResult.targetRevision,
        beforeContentHash: applyResult.beforeContentHash,
        afterContentHash: applyResult.afterContentHash,
        startedAt: startedAt.toISOString(),
        endsAt: new Date(startedAt.getTime() + this.observationWindowHours * 3600_000).toISOString(),
        windowHours: this.observationWindowHours,
        beforeMetrics,
        ...(proposal.constraintChange === 'retire' ? { knowledgeEntryIds: [`decision-constraint-retired-${proposal.targetId}`] } : {}),
        ...(applyResult.profileSnapshots ? { profileSnapshots: applyResult.profileSnapshots } : {}),
      },
    });
    try { eventBus.publish('evolution.applied', { proposal, apply: applyResult }); } catch { /* non-blocking */ }
    return proposal;
  }
}

// ─── 单例（生产路径：route 默认实例 + scheduler handler 共用；构造即注册 review-proposal adapter）───

let _service: EvolutionService | null = null;

export function getEvolutionService(): EvolutionService {
  // 子项 7：生产单例显式接统一知识库（constraintCandidate 标签条目来源）
  if (!_service) {
    _service = new EvolutionService({
      constraintCandidates: { listEntries: () => sharedStore.list() },
    });
  }
  return _service;
}

/** 测试用：重置单例 */
export function resetEvolutionService(): void {
  _service = null;
}
