/**
 * E1 约束进化：服务门面（EvolutionService）。
 *
 * 串起整条链路：runScan（信号 → 提案 → 频道发布）与 decide（人类决策 → 生效）。
 * 频道回复与 HTTP API 共用同一个 decide 路径（同一幂等语义）。
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
  logger,
  type EvolutionProposalData,
  type EvolutionProposalFilter,
} from '@dommaker/studio-shared';
import { applyProposal, type ApplyResult } from './applier.js';
import { postProposalToChannel } from './channel-review.js';
import { generateEvolutionProposals, type GenerationResult } from './generator.js';
import { resolveEvolutionPaths, type EvolutionPaths } from './signals.js';
import { channelMessageService, type ChannelMessageService } from '../channels/channel-message.service.js';
import { getErrorMessage } from '../../utils/errors.js';

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
  messageService?: ChannelMessageService;
  /** false 时 runScan 只生成提案不发频道（测试用） */
  postToChannel?: boolean;
}

export class EvolutionService {
  private fileStore: FileStore;
  private paths: EvolutionPaths;
  private windowHours: number;
  private messageService: ChannelMessageService;
  private postToChannel: boolean;

  constructor(options?: EvolutionServiceOptions) {
    this.fileStore = options?.fileStore ?? new FileStore();
    this.paths = resolveEvolutionPaths(options?.paths);
    this.windowHours = options?.windowHours ?? (Number(process.env.EVOLUTION_WINDOW_HOURS) > 0 ? Number(process.env.EVOLUTION_WINDOW_HOURS) : 24);
    this.messageService = options?.messageService ?? channelMessageService;
    this.postToChannel = options?.postToChannel !== false;
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

  /** 跑一轮提案生成并把新提案发到频道（best-effort）。 */
  async runScan(): Promise<GenerationResult & { posted: number }> {
    const result = await generateEvolutionProposals({
      fileStore: this.fileStore,
      paths: this.paths,
      windowHours: this.windowHours,
    });
    let posted = 0;
    if (this.postToChannel) {
      for (const p of result.created) {
        if (await postProposalToChannel(this.fileStore, p, this.messageService)) posted++;
      }
    }
    for (const p of result.created) {
      try { eventBus.publish('evolution.proposed', { proposal: p }); } catch { /* non-blocking */ }
    }
    if (result.created.length > 0) {
      logger.info('[Evolution] scan completed', { created: result.created.length, posted, skipped: result.skipped });
    }
    return { ...result, posted };
  }

  /**
   * 人类决策（频道回复与 API 共用）。
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
    let proposal = existing;
    if (proposal.status === 'pending') {
      proposal = await this.fileStore.updateEvolutionProposal(id, {
        status: 'approved',
        decidedBy: opts?.decidedBy ?? null,
        decidedAt: new Date().toISOString(),
      });
    }
    // status === 'approved'：执行生效（含重试路径）
    let applyResult: ApplyResult;
    try {
      applyResult = await applyProposal(proposal, this.paths);
    } catch (err) {
      logger.error('[Evolution] apply failed', { id, error: String(err) });
      throw new EvolutionError('APPLY_FAILED', `${id} approved but apply failed: ${getErrorMessage(err)}`);
    }
    proposal = await this.fileStore.updateEvolutionProposal(id, {
      status: 'applied',
      appliedAt: new Date().toISOString(),
    });
    try { eventBus.publish('evolution.applied', { proposal, apply: applyResult }); } catch { /* non-blocking */ }
    return proposal;
  }
}

// ─── 单例（生产路径：route 默认实例 + scheduler handler + channel watcher 共用）───

let _service: EvolutionService | null = null;

export function getEvolutionService(): EvolutionService {
  if (!_service) _service = new EvolutionService();
  return _service;
}

/** 测试用：重置单例 */
export function resetEvolutionService(): void {
  _service = null;
}
