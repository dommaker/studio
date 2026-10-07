/**
 * FileStoreSeqEntriesBase — 序号分配型条目存储层（#670 自 file-store.ts 拆出，PURE_MOVE）
 *
 * Requirement / Evolution 两段原为逐行复制：目录 + flock 序号分配 + 每条目一个
 * JSON 文件的 CRUD；差异收敛为 SeqEntryStoreConfig 泛型配置（工单 26 A2）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { isErrnoError } from './file-store-base';
import { FileStoreEntitiesBase } from './file-store-entities';
import type {
  RequirementData,
  RequirementFilter,
  EvolutionProposalData,
  EvolutionProposalFilter,
} from './file-store-types';

/**
 * 序号分配型条目存储的差异配置（工单 26 A2）。
 * Requirement 与 Evolution 两段原为逐行复制，差异点全部收敛到本配置，
 * 由 FileStore 的泛型私有实现（allocateSeq/getEntry/listEntries/updateEntry）消费。
 */
interface SeqEntryStoreConfig<T, F> {
  dir: string;            // 条目目录（绝对路径）
  lockDir: string;        // seq 分配 flock 锁目录
  indexPath: string;      // { nextSeq } 序号计数器文件
  seqFilePattern: RegExp; // 从文件名提取 seq 的正则（含捕获组）
  listFileFilter: (fileName: string) => boolean; // list 时的文件名口径（两段历史口径不同，保持原样）
  matchesFilter: (item: T, filter?: F) => boolean;
  notFound: (id: string) => string; // update 不存在时的报错文案
}

// ─── FileStoreSeqEntriesBase 类 ───

export class FileStoreSeqEntriesBase extends FileStoreEntitiesBase {

  // ═══════════════════════
  // 序号分配型条目存储（Requirement / Evolution 共用泛型实现，工单 26 A2）
  //
  // 两段原为逐行复制：目录 + flock 序号分配 + 每条目一个 JSON 文件的 CRUD。
  // 差异仅在目录名、id 前缀、list 文件名口径、过滤字段与报错文案，
  // 全部收敛为 SeqEntryStoreConfig 配置；对外方法签名与行为不变。
  // ═══════════════════════

  private get requirementStoreConfig(): SeqEntryStoreConfig<RequirementData, RequirementFilter> {
    const dir = path.join(this.baseDir, 'requirements');
    return {
      dir,
      lockDir: path.join(dir, 'lock'),
      indexPath: path.join(dir, 'index.json'),
      seqFilePattern: /^REQ-(\d+)\.json$/,
      // Requirement 历史口径：任何 *.json（除 index.json）都尝试读取再按结构过滤
      listFileFilter: name => name.endsWith('.json') && name !== 'index.json',
      matchesFilter: (req, filter) => {
        if (filter?.status && req.status !== filter.status) return false;
        if (filter?.channelId && req.channelId !== filter.channelId) return false;
        return true;
      },
      notFound: id => `Requirement not found: ${id}`,
    };
  }

  private get evolutionStoreConfig(): SeqEntryStoreConfig<EvolutionProposalData, EvolutionProposalFilter> {
    const dir = path.join(this.baseDir, 'evolution');
    return {
      dir,
      lockDir: path.join(dir, 'lock'),
      indexPath: path.join(dir, 'index.json'),
      seqFilePattern: /^EP-(\d+)\.json$/,
      listFileFilter: name => /^EP-\d+\.json$/.test(name),
      matchesFilter: (p, filter) => {
        if (filter?.status && p.status !== filter.status) return false;
        if (filter?.targetType && p.targetType !== filter.targetType) return false;
        return true;
      },
      notFound: id => `Evolution proposal not found: ${id}`,
    };
  }

  private entryPath<T, F>(cfg: SeqEntryStoreConfig<T, F>, id: string): string {
    return path.join(cfg.dir, `${id}.json`);
  }

  /** 读取目录中现存条目文件的 seq 集合（容错：文件名不规范的跳过） */
  private async listExistingSeqs<T, F>(cfg: SeqEntryStoreConfig<T, F>): Promise<number[]> {
    try {
      const entries = await fs.promises.readdir(cfg.dir, { withFileTypes: true });
      const seqs: number[] = [];
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const m = entry.name.match(cfg.seqFilePattern);
        if (m) seqs.push(parseInt(m[1], 10));
      }
      return seqs;
    } catch (err: unknown) {
      if (isErrnoError(err) && err.code === 'ENOENT') return [];
      throw err;
    }
  }

  /**
   * 原子分配下一个条目序号（flock 保护，跨进程安全）。
   * index.json 缺失/损坏/落后时按现存文件恢复，保证 seq 唯一。
   */
  private async allocateSeq<T, F>(cfg: SeqEntryStoreConfig<T, F>): Promise<number> {
    return this.withLock(cfg.lockDir, async () => {
      const index = await this.readJson<{ nextSeq: number }>(cfg.indexPath);
      const fromIndex = index && Number.isInteger(index.nextSeq) && index.nextSeq > 0 ? index.nextSeq : 1;
      const existing = await this.listExistingSeqs(cfg);
      const seq = Math.max(fromIndex, existing.length > 0 ? Math.max(...existing) + 1 : 1);
      await this.writeJson(cfg.indexPath, { nextSeq: seq + 1 });
      return seq;
    });
  }

  /** 读取单个条目（容错：文件缺失/损坏/结构异常 → null） */
  private async getEntry<T extends { id: string; seq: number }, F>(cfg: SeqEntryStoreConfig<T, F>, id: string): Promise<T | null> {
    const item = await this.readJson<T>(this.entryPath(cfg, id));
    if (!item || typeof item.id !== 'string' || typeof item.seq !== 'number') return null;
    return item;
  }

  /** 列出条目（容错读：损坏文件跳过），按 seq 升序 */
  private async listEntries<T extends { id: string; seq: number }, F>(cfg: SeqEntryStoreConfig<T, F>, filter?: F): Promise<T[]> {
    let entries: fs.Dirent[];
    try {
      await this.ensureDir(cfg.dir);
      entries = await this.readdirCached(cfg.dir);
    } catch (err: unknown) {
      if (isErrnoError(err) && err.code === 'ENOENT') return [];
      throw err;
    }
    const results = await Promise.all(entries.map(async entry => {
      if (!entry.isFile() || !cfg.listFileFilter(entry.name)) return null;
      const item = await this.readJson<T>(path.join(cfg.dir, entry.name));
      if (!item || typeof item.id !== 'string' || typeof item.seq !== 'number') return null; // skip malformed
      if (!cfg.matchesFilter(item, filter)) return null;
      return item;
    }));
    const items: T[] = [];
    for (const r of results) {
      if (r !== null) items.push(r);
    }
    items.sort((a, b) => a.seq - b.seq);
    return items;
  }

  /** 更新条目（id/seq 不可变）。不存在时抛错。 */
  private async updateEntry<T extends { id: string; seq: number }, F>(cfg: SeqEntryStoreConfig<T, F>, id: string, patch: Partial<T>): Promise<T> {
    const existing = await this.getEntry(cfg, id);
    if (!existing) throw new Error(cfg.notFound(id));
    const updated: T = { ...existing, ...patch, id: existing.id, seq: existing.seq };
    await this.writeJson(this.entryPath(cfg, id), updated);
    return updated;
  }

  // ─── Requirement（REQ 需求编号体系, vision §5.3）───

  /**
   * 原子分配下一个需求序号（flock 保护，跨进程安全）。
   * index.json 缺失/损坏/落后时按现存文件恢复，保证 seq 唯一。
   */
  async allocateRequirementSeq(): Promise<number> {
    return this.allocateSeq(this.requirementStoreConfig);
  }

  async createRequirement(data: RequirementData): Promise<void> {
    await this.writeJson(this.entryPath(this.requirementStoreConfig, data.id), data);
  }

  /** 读取单个需求（容错：文件缺失/损坏/结构异常 → null） */
  async getRequirement(id: string): Promise<RequirementData | null> {
    return this.getEntry(this.requirementStoreConfig, id);
  }

  /** 列出需求（容错读：损坏文件跳过），按 seq 升序 */
  async listRequirements(filter?: RequirementFilter): Promise<RequirementData[]> {
    return this.listEntries(this.requirementStoreConfig, filter);
  }

  /** 更新需求（id/seq 不可变）。不存在时抛错。 */
  async updateRequirement(id: string, patch: Partial<RequirementData>): Promise<RequirementData> {
    return this.updateEntry(this.requirementStoreConfig, id, patch);
  }

  // ─── Evolution（E1 约束进化提案存储）───

  /**
   * 原子分配下一个进化提案序号（flock 保护，跨进程安全）。
   * index.json 缺失/损坏/落后时按现存文件恢复，保证 seq 唯一。
   */
  async allocateEvolutionSeq(): Promise<number> {
    return this.allocateSeq(this.evolutionStoreConfig);
  }

  async createEvolutionProposal(data: EvolutionProposalData): Promise<void> {
    await this.writeJson(this.entryPath(this.evolutionStoreConfig, data.id), data);
  }

  /** 读取单个提案（容错：文件缺失/损坏/结构异常 → null） */
  async getEvolutionProposal(id: string): Promise<EvolutionProposalData | null> {
    return this.getEntry(this.evolutionStoreConfig, id);
  }

  /** 列出提案（容错读：损坏文件跳过），按 seq 升序 */
  async listEvolutionProposals(filter?: EvolutionProposalFilter): Promise<EvolutionProposalData[]> {
    return this.listEntries(this.evolutionStoreConfig, filter);
  }

  /** 更新提案（id/seq 不可变）。不存在时抛错。 */
  async updateEvolutionProposal(id: string, patch: Partial<EvolutionProposalData>): Promise<EvolutionProposalData> {
    return this.updateEntry(this.evolutionStoreConfig, id, patch);
  }
}
