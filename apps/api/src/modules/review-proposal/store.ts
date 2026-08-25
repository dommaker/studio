/**
 * review-proposal/store (#351) — 人审提案卡通用存取（append-only JSONL + 状态墓碑折叠）
 *
 * 唯一正本（docs/adr/2026-08-25-review-proposal-lifecycle-module.md）：自 distill 三胞胎
 * store（distill-store/gc-store/audit-store）同构实现收敛而来，行为口径不变：
 *   - 行形态 { kind:'proposal', ...P } / { kind:'status', id, status, at }（append-only，历史不改写）
 *   - appendProposal 自带 pending 墓碑；listProposals 折叠墓碑取每提案最新状态
 * 状态词表唯一口径 = pending | executed | rejected | failed | card-failed（distill 超集）。
 */
import type { FileStore } from '@dommaker/studio-shared';

export type ReviewProposalStatus = 'pending' | 'executed' | 'rejected' | 'failed' | 'card-failed';

/** 提案载荷基座：id + createdAt 必备，其余字段归业务方（adapter 泛型 P） */
export interface ReviewProposalBase {
  id: string;
  createdAt: string;
}

export type ReviewProposalRecord<P extends ReviewProposalBase> = P & {
  status: ReviewProposalStatus;
  statusAt: string;
};

type ProposalLine<P extends ReviewProposalBase> =
  | ({ kind: 'proposal' } & P)
  | { kind: 'status'; id: string; status: ReviewProposalStatus; at: string };

export class ReviewProposalStore<P extends ReviewProposalBase> {
  constructor(
    private fileStore: FileStore,
    private filePath: string,
  ) {}

  async appendProposal(proposal: P): Promise<void> {
    await this.fileStore.appendJsonl(this.filePath, { kind: 'proposal', ...proposal });
    await this.appendStatus(proposal.id, 'pending');
  }

  async appendStatus(id: string, status: ReviewProposalStatus): Promise<void> {
    await this.fileStore.appendJsonl(this.filePath, {
      kind: 'status', id, status, at: new Date().toISOString(),
    });
  }

  /** 折叠墓碑：每提案取最新状态 */
  async listProposals(): Promise<ReviewProposalRecord<P>[]> {
    const lines = await this.fileStore.readJsonl<ProposalLine<P>>(this.filePath);
    const proposals = new Map<string, P>();
    const statuses = new Map<string, { status: ReviewProposalStatus; at: string }>();
    for (const line of lines) {
      if (line.kind === 'proposal') {
        const { kind: _kind, ...proposal } = line;
        proposals.set(proposal.id, proposal as unknown as P);
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

  async getProposal(id: string): Promise<ReviewProposalRecord<P> | null> {
    return (await this.listProposals()).find(p => p.id === id) ?? null;
  }

  async findPending(): Promise<ReviewProposalRecord<P> | null> {
    return (await this.listProposals()).find(p => p.status === 'pending') ?? null;
  }
}
