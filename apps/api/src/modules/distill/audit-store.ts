/**
 * audit-store (#146) — 存量约束审计提案持久化（constraint-audits.jsonl）
 *
 * 形态同 GcStore proposals：append-only 提案行 + 状态墓碑行。
 * 审计提案挂在产出新约束的蒸馏运行后生成（runId 回指触发的蒸馏运行），
 * 人审 approve 后走退役执行（custom-constraints.yml 条目内 retired 元数据段，
 * #82 D6 统一落点，可恢复：POST /api/v1/harness/constraints/:id/rollback 删段即恢复）。
 */
import * as path from 'node:path';
import type { FileStore } from '@dommaker/studio-shared';
import type { AuditSuggestion } from './constraint-audit.js';

export type ConstraintAuditStatus = 'pending' | 'executed' | 'rejected' | 'card-failed';

export interface ConstraintAuditProposal {
  id: string;
  createdAt: string;
  /** 触发本次审计的蒸馏运行 id（该运行产出了新约束） */
  runId: string;
  /** 退役建议清单（每条附判据 category + 理由） */
  suggestions: AuditSuggestion[];
  /** 参与审计的存量 active 约束数 */
  auditedCount: number;
}

export interface ConstraintAuditProposalRecord extends ConstraintAuditProposal {
  status: ConstraintAuditStatus;
  statusAt: string;
}

type ConstraintAuditLine =
  | ({ kind: 'proposal' } & ConstraintAuditProposal)
  | { kind: 'status'; id: string; status: ConstraintAuditStatus; at: string };

export class ConstraintAuditStore {
  constructor(
    private fileStore: FileStore,
    private dataDir: string,
  ) {}

  private proposalsPath(): string {
    return path.join(this.dataDir, 'constraint-audits.jsonl');
  }

  async appendProposal(proposal: ConstraintAuditProposal): Promise<void> {
    await this.fileStore.appendJsonl(this.proposalsPath(), { kind: 'proposal', ...proposal });
    await this.appendStatus(proposal.id, 'pending');
  }

  async appendStatus(id: string, status: ConstraintAuditStatus): Promise<void> {
    await this.fileStore.appendJsonl(this.proposalsPath(), {
      kind: 'status', id, status, at: new Date().toISOString(),
    });
  }

  /** 折叠墓碑：每提案取最新状态 */
  async listProposals(): Promise<ConstraintAuditProposalRecord[]> {
    const lines = await this.fileStore.readJsonl<ConstraintAuditLine>(this.proposalsPath());
    const proposals = new Map<string, ConstraintAuditProposal>();
    const statuses = new Map<string, { status: ConstraintAuditStatus; at: string }>();
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

  async getProposal(id: string): Promise<ConstraintAuditProposalRecord | null> {
    return (await this.listProposals()).find(p => p.id === id) ?? null;
  }

  async findPending(): Promise<ConstraintAuditProposalRecord | null> {
    return (await this.listProposals()).find(p => p.status === 'pending') ?? null;
  }

  /** 曾被 human 驳回的建议约束 id（reject = 人判保留，不再重复提案打扰，同 GC 口径） */
  async rejectedConstraintIds(): Promise<Set<string>> {
    const ids = new Set<string>();
    for (const p of await this.listProposals()) {
      if (p.status !== 'rejected') continue;
      for (const s of p.suggestions) ids.add(s.constraintId);
    }
    return ids;
  }
}
