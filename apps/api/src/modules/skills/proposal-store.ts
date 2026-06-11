/**
 * ProposalStore — File-based CRUD for SkillProposal
 *
 * Replaces prisma.skillProposal with file-system storage.
 * Proposals persisted to ~/.studio/proposals.json.
 *
 * Migration: D-005 Prisma SkillProposal deletion.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { logger } from '@dommaker/studio-shared';

// ── Types ──

export interface ProposalRecord {
  id: string;
  skillId: string;
  status: string;
  proposedBy: string;
  summary?: string | null;
  proposedAt: string;
  reviewedAt?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface ProposalCreateInput {
  skillId: string;
  status?: string;
  proposedBy: string;
  summary?: string;
  metadata?: Record<string, unknown>;
}

export interface ProposalUpdateInput {
  status?: string;
  reviewedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface ProposalListFilter {
  status?: string | { in?: string[] };
  skillId?: string;
  proposedBy?: string;
}

// ── Store ──

const DATA_DIR = path.join(os.homedir(), '.studio');
const INDEX_FILE = path.join(DATA_DIR, 'proposals.json');

export class ProposalStore {
  private cache: ProposalRecord[] | null = null;

  private ensureDir(): void {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  }

  private loadIndex(): ProposalRecord[] {
    if (this.cache) return this.cache;
    try {
      if (!fs.existsSync(INDEX_FILE)) {
        this.cache = [];
        return this.cache;
      }
      const raw = fs.readFileSync(INDEX_FILE, 'utf-8');
      this.cache = JSON.parse(raw);
      return this.cache!;
    } catch {
      this.cache = [];
      return this.cache;
    }
  }

  private saveIndex(records: ProposalRecord[]): void {
    this.ensureDir();
    this.cache = records;
    fs.writeFileSync(INDEX_FILE, JSON.stringify(records, null, 2), 'utf-8');
  }

  private matchesFilter(record: ProposalRecord, filter: ProposalListFilter): boolean {
    if (filter.status) {
      if (typeof filter.status === 'string') {
        if (record.status !== filter.status) return false;
      } else if (filter.status.in) {
        if (!filter.status.in.includes(record.status)) return false;
      }
    }
    if (filter.skillId && record.skillId !== filter.skillId) return false;
    if (filter.proposedBy && record.proposedBy !== filter.proposedBy) return false;
    return true;
  }

  // ── CRUD ──

  list(filter: ProposalListFilter = {}, options?: { orderBy?: { field: keyof ProposalRecord; dir: 'asc' | 'desc' }; take?: number }): ProposalRecord[] {
    const all = this.loadIndex();
    let filtered = all.filter(r => this.matchesFilter(r, filter));

    if (options?.orderBy) {
      const { field, dir } = options.orderBy;
      filtered.sort((a, b) => {
        const av = a[field] ?? '';
        const bv = b[field] ?? '';
        if (av < bv) return dir === 'asc' ? -1 : 1;
        if (av > bv) return dir === 'asc' ? 1 : -1;
        return 0;
      });
    }

    if (options?.take) {
      filtered = filtered.slice(0, options.take);
    }

    return filtered;
  }

  get(id: string): ProposalRecord | null {
    const all = this.loadIndex();
    return all.find(r => r.id === id) || null;
  }

  create(input: ProposalCreateInput): ProposalRecord {
    const all = this.loadIndex();
    const now = new Date().toISOString();
    const record: ProposalRecord = {
      id: randomUUID(),
      skillId: input.skillId,
      status: input.status || 'pending',
      proposedBy: input.proposedBy,
      summary: input.summary ?? null,
      proposedAt: now,
      reviewedAt: null,
      metadata: input.metadata ?? null,
    };
    all.push(record);
    this.saveIndex(all);

    logger.info('[ProposalStore] Created proposal', { id: record.id, skillId: record.skillId });
    return record;
  }

  update(id: string, data: ProposalUpdateInput): ProposalRecord | null {
    const all = this.loadIndex();
    const idx = all.findIndex(r => r.id === id);
    if (idx === -1) return null;

    const record = all[idx];
    if (data.status !== undefined) record.status = data.status;
    if (data.reviewedAt !== undefined) record.reviewedAt = data.reviewedAt;
    if (data.metadata !== undefined) record.metadata = data.metadata;
    all[idx] = record;
    this.saveIndex(all);

    logger.info('[ProposalStore] Updated proposal', { id, status: record.status });
    return record;
  }

  /** Invalidate cache — call after external file changes */
  invalidateCache(): void {
    this.cache = null;
  }
}

/** Singleton */
export const proposalStore = new ProposalStore();
