/**
 * distill-store (#143) — 蒸馏运行状态持久化（proposals + runs）
 *
 * 落 ~/.studio/ 数据区（运行时装配 studioPath('distill')，测试注入临时目录），两个 JSONL：
 *   - proposals.jsonl：提案 + 状态墓碑（append-only，同 role-memory draft.jsonl 口径）——
 *     行形态 { kind:'proposal', ...DistillProposal } / { kind:'status', id, status, at }
 *   - runs.jsonl：蒸馏运行记录（时间戳/命中信号/原料与产物 id）——7 天熔断与 GC 计龄（#144）
 *     都依赖这个序列。executed 与 failed 都落记录（failed 也烧了 token，同样触发熔断）。
 */
import * as path from 'node:path';
import type { FileStore } from '@dommaker/studio-shared';

export type DistillProposalStatus = 'pending' | 'executed' | 'rejected' | 'failed' | 'card-failed';

export interface DistillProposal {
  id: string;
  createdAt: string;
  /** 原料条目 id 清单（门槛命中信号构成，≤ MAX_MATERIALS） */
  materialIds: string[];
  /** 原料快照（提案卡展示用；执行时以 store 内最新状态为准） */
  materials: Array<{ id: string; title: string }>;
  /** 命中信号摘要 */
  signals: { topicTags: string[]; manualCount: number };
  triggerWorkUnitId?: string;
}

export interface DistillProposalRecord extends DistillProposal {
  status: DistillProposalStatus;
  statusAt: string;
}

export interface DistillRun {
  id: string;
  proposalId: string;
  executedAt: string;
  outcome: 'executed' | 'failed';
  signals: { topicTags: string[]; manualCount: number };
  materialIds: string[];
  productIds: string[];
  error?: string;
}

type ProposalLine =
  | ({ kind: 'proposal' } & DistillProposal)
  | { kind: 'status'; id: string; status: DistillProposalStatus; at: string };

export class DistillStore {
  constructor(
    private fileStore: FileStore,
    private dataDir: string,
  ) {}

  private proposalsPath(): string {
    return path.join(this.dataDir, 'proposals.jsonl');
  }

  private runsPath(): string {
    return path.join(this.dataDir, 'runs.jsonl');
  }

  async appendProposal(proposal: DistillProposal): Promise<void> {
    await this.fileStore.appendJsonl(this.proposalsPath(), { kind: 'proposal', ...proposal });
    await this.appendStatus(proposal.id, 'pending');
  }

  async appendStatus(id: string, status: DistillProposalStatus): Promise<void> {
    await this.fileStore.appendJsonl(this.proposalsPath(), {
      kind: 'status', id, status, at: new Date().toISOString(),
    });
  }

  /** 折叠墓碑：每提案取最新状态 */
  async listProposals(): Promise<DistillProposalRecord[]> {
    const lines = await this.fileStore.readJsonl<ProposalLine>(this.proposalsPath());
    const proposals = new Map<string, DistillProposal>();
    const statuses = new Map<string, { status: DistillProposalStatus; at: string }>();
    for (const line of lines) {
      if (line.kind === 'proposal') {
        const { kind: _kind, ...proposal } = line;
        proposals.set(proposal.id, proposal);
      } else if (line.kind === 'status') {
        statuses.set(line.id, { status: line.status, at: line.at });
      }
    }
    return [...proposals.values()].map(p => ({
      ...p,
      status: statuses.get(p.id)?.status ?? 'pending',
      statusAt: statuses.get(p.id)?.at ?? p.createdAt,
    }));
  }

  async getProposal(id: string): Promise<DistillProposalRecord | null> {
    return (await this.listProposals()).find(p => p.id === id) ?? null;
  }

  async findPending(): Promise<DistillProposalRecord | null> {
    return (await this.listProposals()).find(p => p.status === 'pending') ?? null;
  }

  async appendRun(run: DistillRun): Promise<void> {
    await this.fileStore.appendJsonl(this.runsPath(), run);
  }

  async listRuns(): Promise<DistillRun[]> {
    return this.fileStore.readJsonl<DistillRun>(this.runsPath());
  }

  /** 上次蒸馏运行时间（任何 outcome，ISO；无记录 → null）。7 天烧钱熔断的输入。 */
  async lastRunAt(): Promise<string | null> {
    return this.latestExecutedAt(() => true);
  }

  /**
   * 上次实际消费原料的运行时间（executed 且产物 ≥1；无 → null）。「新条目」基线输入——
   * 失败/空产出不推进此基线，原料不被老化作废。
   */
  async lastConsumedAt(): Promise<string | null> {
    return this.latestExecutedAt(run => run.outcome === 'executed' && run.productIds.length > 0);
  }

  private async latestExecutedAt(match: (run: DistillRun) => boolean): Promise<string | null> {
    const runs = await this.listRuns();
    let latest: string | null = null;
    for (const run of runs) {
      if (!match(run)) continue;
      if (!latest || run.executedAt > latest) latest = run.executedAt;
    }
    return latest;
  }
}
