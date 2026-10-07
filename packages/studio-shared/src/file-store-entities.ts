/**
 * FileStoreEntitiesBase — 目录型实体存储层（#670 自 file-store.ts 拆出，PURE_MOVE）
 *
 * Profile（agents/<id>/profile.json）/ RuntimeState（agents/<id>/state.json，与 Profile
 * 共享 agents/<id>/ 命名空间）/ Channel（channels/<id>/config.json）三段目录型实体 CRUD
 * 合并为 DirEntityStoreConfig 泛型（#362；漂移点统一口径：创建一律查重、更新一律补
 * updatedAt，见配置注释）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { isErrnoError } from './file-store-base';
import { FileStoreCachedBase } from './file-store-cached';
import { statMtimeMs, collectNonNull, invalidateFileKey, invalidateRemovedPath } from './file-store-cache';
import { stringifyChannels } from './channels-codec';
import type {
  AgentProfileData,
  RuntimeStateData,
  ChannelData,
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

// ─── FileStoreEntitiesBase 类 ───

export class FileStoreEntitiesBase extends FileStoreCachedBase {

  // ─── 路径生成 ───

  private profilePath(id: string): string {
    return path.join(this.baseDir, 'agents', id, 'profile.json');
  }

  private statePath(agentId: string): string {
    return path.join(this.baseDir, 'agents', agentId, 'state.json');
  }

  private channelConfigPath(id: string): string {
    return path.join(this.baseDir, 'channels', id, 'config.json');
  }

  private agentsDir(): string {
    return path.join(this.baseDir, 'agents');
  }

  // channelsDir 与消息路径 helper（messagesPath/archiveDir/archiveMonthPath/messagesLockDir）
  // 随消息子域下移在 file-store-messages-core.ts（protected，本类经继承使用）。

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
    return this.readJson<T>(cfg.entityPath(id));
  }

  /** 列出实体：扫描父目录的子目录、读各自主文件（损坏跳过），过滤谓词可省 */
  private async listDirEntities<T, F>(cfg: DirEntityStoreConfig<T, F>, filter?: F): Promise<T[]> {
    const dir = cfg.listDir();
    try {
      await this.ensureDir(dir);
      const entries = await this.readdirCached(dir);
      const results = await Promise.all(entries.map(async entry => {
        if (!entry.isDirectory()) return null;
        const item = await this.readJson<T>(cfg.entityPath(entry.name));
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
    await this.ensureDir(path.dirname(filePath));
    if ((await statMtimeMs(filePath)) !== null) throw new Error(cfg.alreadyExists(key));
    await this.writeJson(filePath, data);
  }

  /** 更新实体：不存在抛错；合并补丁后自动补 updatedAt（#362 统一口径②） */
  private async updateDirEntity<T, F>(cfg: DirEntityStoreConfig<T, F>, id: string, patch: Partial<T>): Promise<void> {
    const filePath = cfg.entityPath(id);
    const existing = await this.readJson<T>(filePath);
    if (!existing) throw new Error(cfg.notFound(id));
    await this.writeJson(filePath, { ...existing, ...patch, updatedAt: new Date().toISOString() });
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

  /**
   * F3 一次性迁移：把所有 profile.json 的 channels 字段归一化为单层 JSON 编码
   * （修复历史双重编码 bug 的存量数据）。dryRun 时只统计不写盘。
   * 无法读取/非字符串 channels 的 profile 跳过（交给清洗脚本判定去留）。
   */
  async migrateChannelsEncoding(opts?: { dryRun?: boolean }): Promise<{ scanned: number; rewritten: number }> {
    const dir = this.agentsDir();
    let scanned = 0;
    let rewritten = 0;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err: unknown) {
      if (isErrnoError(err) && err.code === 'ENOENT') return { scanned, rewritten };
      throw err;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const profile = await this.readJson<AgentProfileData>(this.profilePath(entry.name));
      if (!profile || typeof profile.channels !== 'string') continue;
      scanned++;
      const normalized = stringifyChannels(profile.channels);
      if (normalized !== profile.channels) {
        rewritten++;
        if (!opts?.dryRun) {
          await this.writeJson(this.profilePath(entry.name), { ...profile, channels: normalized });
        }
      }
    }
    return { scanned, rewritten };
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
}
