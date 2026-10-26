import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { FileStore } from '@dommaker/studio-shared';

export const REPLAY_TTL_MS = 24 * 60 * 60 * 1000;

export interface ReplayEntry {
  key: string;
  /** null = 完成后永久保留（deploy commit）；processing 始终不过期。 */
  ttlMs: number | null;
}

export type ReplayClaim =
  | { status: 'claimed'; token: string }
  | { status: 'replayed'; response?: unknown };

interface PersistedEntry {
  token: string;
  expiresAt: number | null;
  ttlMs: number | null;
  completed: boolean;
  response?: unknown;
}

interface ReplayLedger {
  version: 1;
  entries: Record<string, PersistedEntry>;
}

interface ReplayGuardOptions {
  now?: () => number;
}

/**
 * 持久重放台账。claim/complete/release 都在同一把跨进程锁内裸读。
 * processing 永不过期；调用方只能在已证明零业务副作用时 release。
 * 崩溃或 complete 失败留下 processing 是防重复执行的安全默认，需人工核对。
 */
export class ReplayGuard {
  private readonly filePath: string;
  private readonly lockPath: string;
  private readonly now: () => number;

  constructor(private readonly store: FileStore, options: ReplayGuardOptions = {}) {
    this.filePath = path.join(store.getDataDir(), 'webhook-replays.json');
    this.lockPath = path.join(store.getDataDir(), 'webhook-replays.lock');
    this.now = options.now ?? Date.now;
  }

  async claim(entries: ReplayEntry[]): Promise<ReplayClaim> {
    if (entries.length === 0) throw new Error('replay claim requires at least one entry');
    return this.store.withLock(this.lockPath, async () => {
      const ledger = await this.readLocked();
      const now = this.now();
      for (const entry of entries) {
        const persisted = ledger.entries[entry.key];
        if (persisted && (persisted.expiresAt === null || persisted.expiresAt > now)) {
          return persisted.completed
            ? { status: 'replayed', response: persisted.response }
            : { status: 'replayed' };
        }
      }

      const token = randomUUID();
      for (const [key, persisted] of Object.entries(ledger.entries)) {
        if (persisted.expiresAt !== null && persisted.expiresAt <= now) delete ledger.entries[key];
      }
      for (const entry of entries) {
        ledger.entries[entry.key] = {
          token,
          completed: false,
          ttlMs: entry.ttlMs,
          expiresAt: null,
        };
      }
      await this.store.writeJson(this.filePath, ledger);
      return { status: 'claimed', token };
    });
  }

  async complete(token: string, response?: unknown): Promise<void> {
    await this.store.withLock(this.lockPath, async () => {
      const ledger = await this.readLocked();
      const now = this.now();
      for (const persisted of Object.values(ledger.entries)) {
        if (persisted.token !== token || persisted.completed) continue;
        persisted.completed = true;
        persisted.response = response;
        persisted.expiresAt = persisted.ttlMs === null ? null : now + persisted.ttlMs;
      }
      await this.store.writeJson(this.filePath, ledger);
    });
  }

  async release(token: string): Promise<void> {
    await this.store.withLock(this.lockPath, async () => {
      const ledger = await this.readLocked();
      let changed = false;
      for (const [key, persisted] of Object.entries(ledger.entries)) {
        if (persisted.token === token && !persisted.completed) {
          delete ledger.entries[key];
          changed = true;
        }
      }
      if (changed) await this.store.writeJson(this.filePath, ledger);
    });
  }

  private async readLocked(): Promise<ReplayLedger> {
    return await this.store.readJsonUncached<ReplayLedger>(this.filePath)
      ?? { version: 1, entries: {} };
  }
}
