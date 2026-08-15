/**
 * gc-store (#144) — GC 候选清单提案持久化（gc-proposals.jsonl）
 *
 * 形态同 DistillStore proposals：append-only 提案行 + 状态墓碑行。
 * GC 提案挂在蒸馏运行后生成（runId 回指触发的蒸馏运行），人审 approve 后
 * 候选条目 maturity=archived（可恢复：FileKnowledgeStore 归档不搬文件）。
 */
import * as path from 'node:path';
import type { FileStore } from '@dommaker/studio-shared';
import type { GcCandidate } from './gc-candidates.js';

export type GcProposalStatus = 'pending' | 'executed' | 'rejected' | 'card-failed';

export interface GcProposal {
  id: string;
  createdAt: string;
  /** 触发本次 GC 的蒸馏运行 id */
  runId: string;
  /** 候选清单（每条附可读理由） */
  candidates: GcCandidate[];
  /** 主区 >200 强制出清单 */
  forced: boolean;
  mainAreaCount: number;
}

export interface GcProposalRecord extends GcProposal {
  status: GcProposalStatus;
  statusAt: string;
}

type GcProposalLine =
  | ({ kind: 'proposal' } & GcProposal)
  | { kind: 'status'; id: string; status: GcProposalStatus; at: string };

export class GcStore {
  constructor(
    private fileStore: FileStore,
    private dataDir: string,
  ) {}

  private proposalsPath(): string {
    return path.join(this.dataDir, 'gc-proposals.jsonl');
  }

  async appendProposal(proposal: GcProposal): Promise<void> {
    await this.fileStore.appendJsonl(this.proposalsPath(), { kind: 'proposal', ...proposal });
    await this.appendStatus(proposal.id, 'pending');
  }

  async appendStatus(id: string, status: GcProposalStatus): Promise<void> {
    await this.fileStore.appendJsonl(this.proposalsPath(), {
      kind: 'status', id, status, at: new Date().toISOString(),
    });
  }

  /** 折叠墓碑：每提案取最新状态 */
  async listProposals(): Promise<GcProposalRecord[]> {
    const lines = await this.fileStore.readJsonl<GcProposalLine>(this.proposalsPath());
    const proposals = new Map<string, GcProposal>();
    const statuses = new Map<string, { status: GcProposalStatus; at: string }>();
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

  async getProposal(id: string): Promise<GcProposalRecord | null> {
    return (await this.listProposals()).find(p => p.id === id) ?? null;
  }

  async findPending(): Promise<GcProposalRecord | null> {
    return (await this.listProposals()).find(p => p.status === 'pending') ?? null;
  }

  /** 曾被 human 驳回的候选条目 id（reject = 人判保留，不再重复提案打扰） */
  async rejectedEntryIds(): Promise<Set<string>> {
    const ids = new Set<string>();
    for (const p of await this.listProposals()) {
      if (p.status !== 'rejected') continue;
      for (const c of p.candidates) ids.add(c.entryId);
    }
    return ids;
  }
}
