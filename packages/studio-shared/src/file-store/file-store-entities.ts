/**
 * EntityStore — 实体存储域 store（#681 P1-1 组合化：自 FileStoreEntitiesBase 继承层
 * 转型为构造注入 FileStoreCore 的独立 store；序号分配型条目段（原
 * file-store-seq-entries.ts FileStoreSeqEntriesBase，Requirement/Evolution 内部支撑）
 * 随组合化并入本类，对外方法面不变）
 *
 * - 目录型实体 CRUD：Profile（agents/<id>/profile.json）/ RuntimeState
 *   （agents/<id>/state.json，与 Profile 共享 agents/<id>/ 命名空间）/ Channel
 *   （channels/<id>/config.json）三段合并为 DirEntityStoreConfig 泛型（#362；
 *   漂移点统一口径：创建一律查重、更新一律补 updatedAt，见配置注释）。
 * - 序号分配型条目存储：Requirement / Evolution 两段共用 SeqEntryStoreConfig
 *   泛型（工单 26 A2：目录 + flock 序号分配 + 每条目一个 JSON 文件的 CRUD）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { isErrnoError } from './file-store-base';
import type { FileStoreCore } from './file-store-core';
import { statMtimeMs, collectNonNull, invalidateFileKey, invalidateRemovedPath } from './cache-primitives';
import type {
  AgentProfileData,
  RuntimeStateData,
  ChannelData,
  RequirementData,
  RequirementFilter,
  EvolutionProposalData,
  EvolutionProposalFilter,
} from './file-store-types';

/**
 * 目录型实体存储的差异配置（#362）。
 * Profile（agents/<id>/profile.json）/ RuntimeState（agents/<id>/state.json，与 Profile
 * 共享 agents/<id>/ 命名空间）/ Channel（channels/<id>/config.json）三段原为逐行复制，
 * 每实体一个子目录、目录内一个 JSON 主文件；差异仅在路径函数、过滤谓词、报错文案与
 * 删除口径，全部收敛到本配置。
 * 漂移点统一口径（2026-08-25 决策）：① 创建一律查重——重复建同 id 报错（正常路径全用
 * 新 id，行为不变；异常路径 Profile/Channel 从静默覆盖变报错，对齐 State 原状）；
 * ② 更新一律自动补 updatedAt（State 也补）。
 */
interface DirEntityStoreConfig<T, F> {
  entityPath: (id: string) => string; // 实体主文件绝对路径（含具体文件名）
  listDir: () => string;              // list 扫描的父目录（每实体一个子目录）
  matchesFilter: (item: T, filter?: F) => boolean;
  notFound: (id: string) => string;         // update/delete 不存在时的报错文案
  alreadyExists: (id: string) => string;    // 重复创建同 id 的报错文案
  /** true = 整删实体子目录 rm -rf（Profile/Channel，含伴生文件）；false = 只删主文件、父目录空时回收（State） */
  deleteWholeDir: boolean;
}

/**
 * 序号分配型条目存储的差异配置（工单 26 A2）。
 * Requirement 与 Evolution 两段原为逐行复制，差异点全部收敛到本配置，
 * 由泛型私有实现（allocateSeq/getEntry/listEntries/updateEntry）消费。
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

// ─── EntityStore 类 ───

export class EntityStore {
  private readonly ctx: FileStoreCore;

  constructor(ctx: FileStoreCore) {
    this.ctx = ctx;
  }

  // ─── 路径生成 ───

  private profilePath(id: string): string {
    return path.join(this.ctx.baseDir, 'agents', id, 'profile.json');
  }

  private statePath(agentId: string): string {
    return path.join(this.ctx.baseDir, 'agents', agentId, 'state.json');
  }

  private channelConfigPath(id: string): string {
    return path.join(this.ctx.baseDir, 'channels', id, 'config.json');
  }

  private agentsDir(): string {
    return path.join(this.ctx.baseDir, 'agents');
  }

  private channelsDir(): string {
    return path.join(this.ctx.baseDir, 'channels');
  }

  // ═══════════════════════
  // 目录型实体存储（AgentProfile / RuntimeState / Channel 共用泛型实现，#362）
  //
  // 三段原为逐行复制，差异点全部收敛为上方 DirEntityStoreConfig 配置，
  // 由本节泛型私有实现消费；对外方法签名与行为不变（漂移点统一口径见配置注释）。
  // ═══════════════════════

  private get profileStoreConfig(): DirEntityStoreConfig<AgentProfileData, { status?: string }> {
    return {
      entityPath: id => this.profilePath(id),
      listDir: () => this.agentsDir(),
      matchesFilter: (profile, filter) => !filter?.status || profile.status === filter.status,
      notFound: id => `AgentProfile not found: ${id}`,
      alreadyExists: id => `AgentProfile already exists: ${id}`,
      deleteWholeDir: true,
    };
  }

  private get runtimeStateStoreConfig(): DirEntityStoreConfig<RuntimeStateData, void> {
    return {
      entityPath: agentId => this.statePath(agentId),
      listDir: () => this.agentsDir(),
      matchesFilter: () => true,
      notFound: agentId => `RuntimeState not found for agent: ${agentId}`,
      alreadyExists: agentId => `RuntimeState already exists for agent: ${agentId}`,
      // agents/<id>/ 是 profile 与 state 共享 namespace，只删 state.json
      deleteWholeDir: false,
    };
  }

  private get channelStoreConfig(): DirEntityStoreConfig<ChannelData, { name?: string; type?: string; excludeArchived?: boolean }> {
    return {
      entityPath: id => this.channelConfigPath(id),
      listDir: () => this.channelsDir(),
      matchesFilter: (ch, filter) => {
        if (filter?.name && ch.name !== filter.name) return false;
        if (filter?.type && ch.type !== filter.type) return false;
        if (filter?.excludeArchived && /-archived-\d+$/.test(ch.name)) return false;
        return true;
      },
      notFound: id => `Channel not found: ${id}`,
      alreadyExists: id => `Channel already exists: ${id}`,
      deleteWholeDir: true,
    };
  }

  /** 读取单个实体（文件缺失/损坏 → null） */
  private async getDirEntity<T, F>(cfg: DirEntityStoreConfig<T, F>, id: string): Promise<T | null> {
    return this.ctx.io.readJson<T>(cfg.entityPath(id));
  }

  /** 列出实体：扫描父目录的子目录、读各自主文件（损坏跳过），过滤谓词可省 */
  private async listDirEntities<T, F>(cfg: DirEntityStoreConfig<T, F>, filter?: F): Promise<T[]> {
    const dir = cfg.listDir();
    try {
      await this.ctx.base.ensureDir(dir);
      const entries = await this.ctx.io.readdirCached(dir);
      const results = await Promise.all(entries.map(async entry => {
        if (!entry.isDirectory()) return null;
        const item = await this.ctx.io.readJson<T>(cfg.entityPath(entry.name));
        if (!item || !cfg.matchesFilter(item, filter)) return null;
        return item;
      }));
      const items = collectNonNull(results);
      return items;
    } catch (err: unknown) {
      if (isErrnoError(err) && err.code === 'ENOENT') return [];
      throw err;
    }
  }

  /** 创建实体：查重后原子写入。重复建同 id 报错（#362 统一口径①）。
   *  key = 实体子目录名（决定落盘路径）；data.id 不一定是子目录名（RuntimeState 的
   *  data.id 为 instance-<agentId>，而子目录是 agentId），故显式传参不取自 data。
   *  局限：查重与写入间无锁——跨进程并发同 id 双建存在竞态窗口（旧 createState 同此），
   *  统一的是单进程语义；跨进程强一致创建需另立票。 */
  private async createDirEntity<T, F>(cfg: DirEntityStoreConfig<T, F>, key: string, data: T): Promise<void> {
    const filePath = cfg.entityPath(key);
    await this.ctx.base.ensureDir(path.dirname(filePath));
    if ((await statMtimeMs(filePath)) !== null) throw new Error(cfg.alreadyExists(key));
    await this.ctx.io.writeJson(filePath, data);
  }

  /** 更新实体：不存在抛错；合并补丁后自动补 updatedAt（#362 统一口径②） */
  private async updateDirEntity<T, F>(cfg: DirEntityStoreConfig<T, F>, id: string, patch: Partial<T>): Promise<void> {
    const filePath = cfg.entityPath(id);
    const existing = await this.ctx.io.readJson<T>(filePath);
    if (!existing) throw new Error(cfg.notFound(id));
    await this.ctx.io.writeJson(filePath, { ...existing, ...patch, updatedAt: new Date().toISOString() });
  }

  /**
   * 删除实体。deleteWholeDir=true 整删子目录 rm -rf；否则只删主文件、父目录空时回收
   * （与 sweepEmptyAgentDirs 同判空条件）。
   */
  private async deleteDirEntity<T, F>(cfg: DirEntityStoreConfig<T, F>, id: string): Promise<void> {
    const filePath = cfg.entityPath(id);
    const entityDir = path.dirname(filePath);
    try {
      if (cfg.deleteWholeDir) {
        await fs.promises.rm(entityDir, { recursive: true, force: true });
      } else {
        await fs.promises.unlink(filePath);
      }
    } catch (err: unknown) {
      if (isErrnoError(err) && err.code === 'ENOENT') throw new Error(cfg.notFound(id));
      throw err;
    }
    if (cfg.deleteWholeDir) {
      invalidateRemovedPath(entityDir);
    } else {
      invalidateFileKey(filePath);
      await this.removeDirIfEmpty(entityDir);
    }
  }

  // ═══════════════════════
  // AgentProfile
  // ═══════════════════════

  async getProfile(id: string): Promise<AgentProfileData | null> {
    return this.getDirEntity(this.profileStoreConfig, id);
  }

  async listProfiles(filter?: { status?: string }): Promise<AgentProfileData[]> {
    return this.listDirEntities(this.profileStoreConfig, filter);
  }

  async createProfile(data: AgentProfileData): Promise<void> {
    await this.createDirEntity(this.profileStoreConfig, data.id, data);
  }

  async updateProfile(id: string, patch: Partial<AgentProfileData>): Promise<void> {
    await this.updateDirEntity(this.profileStoreConfig, id, patch);
  }

  async deleteProfile(id: string): Promise<void> {
    await this.deleteDirEntity(this.profileStoreConfig, id);
  }

  // ═══════════════════════
  // RuntimeInstance
  // ═══════════════════════

  async getState(agentId: string): Promise<RuntimeStateData | null> {
    return this.getDirEntity(this.runtimeStateStoreConfig, agentId);
  }

  /** 列出所有 RuntimeState */
  async listStates(): Promise<RuntimeStateData[]> {
    return this.listDirEntities(this.runtimeStateStoreConfig);
  }

  async updateState(agentId: string, patch: Partial<RuntimeStateData>): Promise<void> {
    await this.updateDirEntity(this.runtimeStateStoreConfig, agentId, patch);
  }

  /** 删除 RuntimeState（state.json）。保留同目录 profile.json；
   *  #363：删后目录判空——为空才连目录一起删（目录闭环，防死实例空目录无界累积；
   *  agents/<id>/ 是 profile 与 state 共享 namespace，有任何其他文件绝不碰）。 */
  async deleteState(agentId: string): Promise<void> {
    await this.deleteDirEntity(this.runtimeStateStoreConfig, agentId);
  }

  /** #363：<dir>/ 判空删除——空才 rmdir，返回是否删了；
   *  ENOENT（已被删）/ENOTEMPTY（判空后被写入的竞态）容错 */
  private async removeDirIfEmpty(dir: string): Promise<boolean> {
    try {
      const entries = await fs.promises.readdir(dir);
      if (entries.length > 0) return false;
      await fs.promises.rmdir(dir);
    } catch (err: unknown) {
      if (isErrnoError(err) && (err.code === 'ENOENT' || err.code === 'ENOTEMPTY')) return false;
      throw err;
    }
    invalidateRemovedPath(dir);
    return true;
  }

  /**
   * #363：一次性存量清扫——删 agents/ 下所有空实例目录（与删除 RuntimeState 同判空条件）。
   * 幂等：无空目录时 removed=0；agents/ 不存在不抛错。
   */
  async sweepEmptyAgentDirs(): Promise<{ removed: number }> {
    const dir = this.agentsDir();
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err: unknown) {
      if (isErrnoError(err) && err.code === 'ENOENT') return { removed: 0 };
      throw err;
    }
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (await this.removeDirIfEmpty(path.join(dir, entry.name))) removed++;
    }
    return { removed };
  }

  async createState(agentId: string, data: RuntimeStateData): Promise<void> {
    await this.createDirEntity(this.runtimeStateStoreConfig, agentId, data);
  }

  // ═══════════════════════
  // Channel
  // ═══════════════════════

  async getChannel(id: string): Promise<ChannelData | null> {
    return this.getDirEntity(this.channelStoreConfig, id);
  }

  async listChannels(filter?: { name?: string; type?: string; excludeArchived?: boolean }): Promise<ChannelData[]> {
    return this.listDirEntities(this.channelStoreConfig, filter);
  }

  async createChannel(data: ChannelData): Promise<void> {
    await this.createDirEntity(this.channelStoreConfig, data.id, data);
  }

  async updateChannel(id: string, patch: Partial<ChannelData>): Promise<void> {
    await this.updateDirEntity(this.channelStoreConfig, id, patch);
  }

  async deleteChannel(id: string): Promise<void> {
    await this.deleteDirEntity(this.channelStoreConfig, id);
  }

  // ═══════════════════════
  // 序号分配型条目存储（Requirement / Evolution 共用泛型实现，工单 26 A2；
  // #681 自 file-store-seq-entries.ts 并入本类）
  //
  // 两段原为逐行复制：目录 + flock 序号分配 + 每条目一个 JSON 文件的 CRUD。
  // 差异仅在目录名、id 前缀、list 文件名口径、过滤字段与报错文案，
  // 全部收敛为 SeqEntryStoreConfig 配置；对外方法签名与行为不变。
  // ═══════════════════════

  private get requirementStoreConfig(): SeqEntryStoreConfig<RequirementData, RequirementFilter> {
    const dir = path.join(this.ctx.baseDir, 'requirements');
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
    const dir = path.join(this.ctx.baseDir, 'evolution');
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
    return this.ctx.base.withLock(cfg.lockDir, async () => {
      const index = await this.ctx.io.readJson<{ nextSeq: number }>(cfg.indexPath);
      const fromIndex = index && Number.isInteger(index.nextSeq) && index.nextSeq > 0 ? index.nextSeq : 1;
      const existing = await this.listExistingSeqs(cfg);
      const seq = Math.max(fromIndex, existing.length > 0 ? Math.max(...existing) + 1 : 1);
      await this.ctx.io.writeJson(cfg.indexPath, { nextSeq: seq + 1 });
      return seq;
    });
  }

  /** 读取单个条目（容错：文件缺失/损坏/结构异常 → null） */
  private async getEntry<T extends { id: string; seq: number }, F>(cfg: SeqEntryStoreConfig<T, F>, id: string): Promise<T | null> {
    const item = await this.ctx.io.readJson<T>(this.entryPath(cfg, id));
    if (!item || typeof item.id !== 'string' || typeof item.seq !== 'number') return null;
    return item;
  }

  /** 列出条目（容错读：损坏文件跳过），按 seq 升序 */
  private async listEntries<T extends { id: string; seq: number }, F>(cfg: SeqEntryStoreConfig<T, F>, filter?: F): Promise<T[]> {
    let entries: fs.Dirent[];
    try {
      await this.ctx.base.ensureDir(cfg.dir);
      entries = await this.ctx.io.readdirCached(cfg.dir);
    } catch (err: unknown) {
      if (isErrnoError(err) && err.code === 'ENOENT') return [];
      throw err;
    }
    const results = await Promise.all(entries.map(async entry => {
      if (!entry.isFile() || !cfg.listFileFilter(entry.name)) return null;
      const item = await this.ctx.io.readJson<T>(path.join(cfg.dir, entry.name));
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
    await this.ctx.io.writeJson(this.entryPath(cfg, id), updated);
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
    await this.ctx.io.writeJson(this.entryPath(this.requirementStoreConfig, data.id), data);
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
    await this.ctx.io.writeJson(this.entryPath(this.evolutionStoreConfig, data.id), data);
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
