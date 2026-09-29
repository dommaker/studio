/**
 * FileStore — AN 运行时数据文件存储基类
 *
 * 运行时数据全部走文件存储（JSON/JSONL），flock（mkdir 原子操作）保障 claim 原子性。
 *
 * 数据区布局（data/ 子树与 ~/.studio 根级条目）唯一正本：
 * docs/architecture/data-directory-contract.md（#570）——布局变更须先修订契约。
 *
 * 本文件为门面：数据类型在 file-store-types.ts，JSON/锁原语在 file-store-base.ts，
 * WorkUnit 事件溯源在 file-store-workunit.ts，频道消息子域在 file-store-messages.ts（#655），
 * channels 编解码在 channels-codec.ts，frontmatter 在 frontmatter.ts；
 * 全部符号在此 re-export，导出面不变。
 *
 * 工单 26：FileStore 读写原语覆盖为 mtime 校验的读穿缓存 + list 并发读（A1）；
 * Requirement/Evolution 复制段合并为 SeqEntryStoreConfig 泛型条目存储（A2）。
 * #362：Profile/RuntimeState/Channel 三段目录型实体 CRUD 合并为 DirEntityStoreConfig
 * 泛型（漂移点统一口径：创建一律查重、更新一律补 updatedAt）；扁平目录 JSON 清单
 * 单点化为 listJsonInDir（收编 mcp/tool-store.listJsonFiles、capability scanAll）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { isErrnoError } from './file-store-base';
import { applyFilter } from './file-store-workunit';
import { FileStoreMessagesBase, dirCache, cacheSet, statMtimeMs, type CacheEntry } from './file-store-messages';
import { stringifyChannels } from './channels-codec';
import { parseFrontmatter, serializeFrontmatter } from './frontmatter';
import { readMetricsBegin, emitReadMetric } from './read-metrics';
import type {
  AgentProfileData,
  RuntimeStateData,
  ChannelData,
  RequirementData,
  RequirementFilter,
  EvolutionProposalData,
  EvolutionProposalFilter,
  WorkUnitSnapshot,
  WorkUnitFilter,
} from './file-store-types';

// ─── re-export（保持原有导出面 100% 不变）───

export type {
  AgentProfileData,
  RuntimeStateData,
  ChannelData,
  ChannelMessageData,
  ChannelMessageRow,
  QueryOpts,
  MessagePageOpts,
  MessagePage,
  MessageCompactionOptions,
  MessageArchiveOptions,
  WorkUnitEventType,
  WorkUnitEvent,
  WorkUnitSnapshot,
  WorkUnitFilter,
  RequirementStatus,
  RequirementData,
  RequirementFilter,
  EvolutionTargetType,
  EvolutionProposalStatus,
  EvolutionProposalData,
  EvolutionProposalFilter,
} from './file-store-types';
export { formatRequirementId, formatEvolutionId } from './file-store-types';
export { LockTimeoutError } from './file-store-base';
export type { WorkUnitReconcileResult } from './file-store-workunit';
export { parseWorkUnitIndexContent } from './file-store-workunit';
export { parseChannels, stringifyChannels } from './channels-codec';
export { parseFrontmatter, serializeFrontmatter } from './frontmatter';
export type { FileStoreOptions } from './file-store-messages';

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

// ─── 读穿缓存（A1，工单 26）───
//
// 模块级（同进程共享、按绝对路径为 key），任何 FileStore 实例的写/删都会失效对应 key，
// 因此同进程内写后读立即可见。命中时用 stat 的 mtimeMs 校验缓存新鲜度，
// 其他进程的外部写入（mtime 变化）也会触发重读——不引入跨进程脏读。
// 缓存对象一律不直接外发（命中返回结构克隆），调用方原地 mutate 返回值不会污染缓存。
// dirCache / statMtimeMs / cacheSet / CacheEntry 随消息子域下移在 file-store-messages.ts
// 定义并 export（readdirCached 所在的层），本文件 import 共用。

const jsonCache = new Map<string, CacheEntry<unknown>>();
const jsonlCache = new Map<string, CacheEntry<unknown[]>>();
const mdCache = new Map<string, CacheEntry<{ meta: Record<string, unknown>; body: string } | null>>();

/** 缓存值外发前结构克隆（null 直返），防调用方原地 mutate 污染缓存 */
function cloneCached<T>(value: T): T {
  return value === null || value === undefined ? value : structuredClone(value);
}

/** Promise.all 读文件结果收集：null（缺失/损坏/被过滤）丢弃，保持输入序。泛型谓词在 filter 上不可用，显式循环为先例写法 */
function collectNonNull<T>(results: Array<T | null>): T[] {
  const items: T[] = [];
  for (const r of results) {
    if (r !== null) items.push(r);
  }
  return items;
}

/** 写路径失效：精确删除对应文件 key；目录级 list 缓存清空（新建文件/目录可能落在同一 mtime 粒度内，不能只靠 mtime 校验） */
function invalidateFileKey(filePath: string): void {
  jsonCache.delete(filePath);
  jsonlCache.delete(filePath);
  mdCache.delete(filePath);
  dirCache.clear();
}

/** 删路径失效：文件或目录（递归）下所有 key + 目录级 list 缓存 */
function invalidateRemovedPath(target: string): void {
  const prefix = target.endsWith(path.sep) ? target : target + path.sep;
  for (const map of [jsonCache, jsonlCache, mdCache] as const) {
    for (const key of map.keys()) {
      if (key === target || key.startsWith(prefix)) map.delete(key);
    }
  }
  dirCache.clear();
}

// ─── FileStore 类 ───
//
// 频道消息子域（压实 #319 / 归档 #327 / 尾部倒扫 #524 / 增量水位线 B5 等）整块承载在
// file-store-messages.ts 的 FileStoreMessagesBase（extends FileStoreWorkUnitBase），
// 本类经继承获得全部消息方法与 readdirCached/readdir/channelsDir（后两者 protected 下移）。

export class FileStore extends FileStoreMessagesBase {

  // ─── 读穿缓存覆盖（A1，工单 26）───
  //
  // 基类（file-store-base.ts）读写原语在此覆盖为带 mtime 校验的读穿缓存版本；
  // FileStoreWorkUnitBase 的方法经虚分派同样走缓存与失效。

  public async readJson<T>(filePath: string): Promise<T | null> {
    const t = readMetricsBegin();
    const t0 = t?.() ?? 0;
    const mtimeMs = await statMtimeMs(filePath);
    const t1 = t?.() ?? 0;
    if (mtimeMs === null) {
      jsonCache.delete(filePath);
      if (t) emitReadMetric({ file: filePath, op: 'readJson', cacheHit: false, statMs: t1 - t0, readParseMs: 0, cloneMs: 0 });
      return null;
    }
    const hit = jsonCache.get(filePath);
    if (hit && hit.mtimeMs === mtimeMs) {
      const cached = cloneCached(hit.value) as T | null;
      if (t) emitReadMetric({ file: filePath, op: 'readJson', cacheHit: true, statMs: t1 - t0, readParseMs: 0, cloneMs: t() - t1 });
      return cached;
    }
    let value: unknown = null;
    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      try {
        value = JSON.parse(content);
      } catch {
        value = null; // corrupt JSON → treat as missing
      }
    } catch (err: unknown) {
      if (!isErrnoError(err) || err.code !== 'ENOENT') throw err;
      value = null; // stat 与 readFile 之间被删 → 按缺失处理
    }
    const t2 = t?.() ?? 0;
    cacheSet(jsonCache, filePath, { value, mtimeMs });
    const cloned = cloneCached(value) as T | null;
    if (t) emitReadMetric({ file: filePath, op: 'readJson', cacheHit: false, statMs: t1 - t0, readParseMs: t2 - t1, cloneMs: t() - t2 });
    return cloned;
  }

  /** 写入 JSON 文件（原子写），写后失效缓存 */
  public async writeJson(filePath: string, data: unknown): Promise<void> {
    await super.writeJson(filePath, data);
    invalidateFileKey(filePath);
  }

  /** 追加一行 JSONL，写后失效缓存 */
  public async appendJsonl(filePath: string, data: unknown): Promise<void> {
    await super.appendJsonl(filePath, data);
    invalidateFileKey(filePath);
  }

  /** 写入全部 JSONL 行（覆盖），写后失效缓存 */
  public async writeJsonl(filePath: string, data: unknown[]): Promise<void> {
    await super.writeJsonl(filePath, data);
    invalidateFileKey(filePath);
  }

  public async readJsonl<T>(filePath: string): Promise<T[]> {
    const t = readMetricsBegin();
    const t0 = t?.() ?? 0;
    const mtimeMs = await statMtimeMs(filePath);
    const t1 = t?.() ?? 0;
    if (mtimeMs === null) {
      jsonlCache.delete(filePath);
      if (t) emitReadMetric({ file: filePath, op: 'readJsonl', cacheHit: false, statMs: t1 - t0, readParseMs: 0, cloneMs: 0 });
      return [];
    }
    const hit = jsonlCache.get(filePath);
    if (hit && hit.mtimeMs === mtimeMs) {
      const cached = cloneCached(hit.value) as T[];
      if (t) emitReadMetric({ file: filePath, op: 'readJsonl', cacheHit: true, statMs: t1 - t0, readParseMs: 0, cloneMs: t() - t1 });
      return cached;
    }
    let rows: unknown[] = [];
    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim().length > 0);
      const results: unknown[] = [];
      for (const line of lines) {
        try {
          results.push(JSON.parse(line));
        } catch {
          // skip corrupt lines
        }
      }
      rows = results;
    } catch (err: unknown) {
      if (!isErrnoError(err) || err.code !== 'ENOENT') throw err;
      rows = []; // stat 与 readFile 之间被删 → 按空处理
    }
    const t2 = t?.() ?? 0;
    cacheSet(jsonlCache, filePath, { value: rows, mtimeMs });
    const cloned = cloneCached(rows) as T[];
    if (t) emitReadMetric({ file: filePath, op: 'readJsonl', cacheHit: false, statMs: t1 - t0, readParseMs: t2 - t1, cloneMs: t() - t2 });
    return cloned;
  }

  /** readdirCached / readdir（readdir 读穿缓存公开入口，#321）随消息子域下移为
   *  FileStoreMessagesBase 的 protected / public 成员，本类经继承继续使用。 */

  /**
   * #314（D1）：getIndex 的锁外只读路径走读穿缓存（复用 jsonCache，key =
   * workunits/index.json 绝对路径；所有索引写经 writeJson 覆盖自动精确失效）。
   * 保留 readIndexFile 的严格损坏语义（撕裂/非数组抛错，不静默当空），
   * 命中返回结构克隆。锁内读路径不经过本方法（readIndexFile 保持裸读）。
   * #406：filter 下推——命中路径在共享缓存数组上按引用选行、只克隆命中行
   * （monitor 等带 status 过滤的读口不再为丢弃的行付克隆税）；无 filter 时
   * 全量克隆，与 #314 行为一致。下推只动本锁外读穿路径，锁内裸读不经此 seam。
   */
  protected async readIndexForQuery(filter?: WorkUnitFilter): Promise<WorkUnitSnapshot[] | null> {
    const filePath = this.indexPath;
    const t = readMetricsBegin();
    const t0 = t?.() ?? 0;
    const mtimeMs = await statMtimeMs(filePath);
    const t1 = t?.() ?? 0;
    if (mtimeMs === null) {
      jsonCache.delete(filePath);
      if (t) emitReadMetric({ file: filePath, op: 'readIndexForQuery', cacheHit: false, statMs: t1 - t0, readParseMs: 0, cloneMs: 0 });
      return null;
    }
    const hit = jsonCache.get(filePath);
    if (hit && hit.mtimeMs === mtimeMs) {
      // 共享缓存数组上按引用选行（applyFilter 不 mutate），克隆只发生在命中子集上
      const matched = hit.value === null ? null : applyFilter(hit.value as WorkUnitSnapshot[], filter);
      const cached = cloneCached(matched) as WorkUnitSnapshot[] | null;
      if (t) emitReadMetric({ file: filePath, op: 'readIndexForQuery', cacheHit: true, statMs: t1 - t0, readParseMs: 0, cloneMs: t() - t1 });
      return cached;
    }
    const value = await this.readIndexFile();
    const t2 = t?.() ?? 0;
    cacheSet(jsonCache, filePath, { value, mtimeMs });
    const cloned = cloneCached(value === null ? null : applyFilter(value, filter)) as WorkUnitSnapshot[] | null;
    if (t) emitReadMetric({ file: filePath, op: 'readIndexForQuery', cacheHit: false, statMs: t1 - t0, readParseMs: t2 - t1, cloneMs: t() - t2 });
    return cloned;
  }

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
  // 随消息子域下移在 FileStoreMessagesBase（channelsDir 为 protected，本类经继承使用）。

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

  // ═══════════════════════
  // ChannelMessage (JSONL)
  //
  // 频道消息子域整块下移 file-store-messages.ts 的 FileStoreMessagesBase（#655，PURE_MOVE），
  // 本类经继承获得 appendMessage/queryMessages/queryMessagesPage/getMessageById 等全部消息方法。
  // ═══════════════════════

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

  // ═══════════════════════
  // 扁平目录 JSON 清单原语（#362 收编单点）
  // ═══════════════════════

  /**
   * 扁平目录 JSON 实体清单：扫描 {dir}/*.json 全量读取，损坏/缺失文件跳过；
   * 目录不存在返回 []（不建目录）。与目录型实体的差异是实体直接平铺为文件、无子目录。
   * 消费方：apps/api mcp tool-store.listJsonFiles。
   */
  public async listJsonInDir<T>(dir: string): Promise<T[]> {
    let entries: fs.Dirent[];
    try {
      entries = await this.readdirCached(dir);
    } catch (err: unknown) {
      if (isErrnoError(err) && err.code === 'ENOENT') return [];
      throw err;
    }
    const results = await Promise.all(entries
      .filter(e => e.isFile() && e.name.endsWith('.json'))
      .map(e => this.readJson<T>(path.join(dir, e.name))));
    return collectNonNull(results);
  }

  // ═══════════════════════
  // Markdown 读写（Phase 1: spec-2a filestore-unification）
  // ═══════════════════════

  /**
   * 读取 markdown 文件，解析 frontmatter + body（#321：读穿缓存，mtime 校验）。
   * 文件不存在返回 null。命中返回结构克隆。
   */
  async readDoc(dir: string, key: string): Promise<{ meta: Record<string, unknown>; body: string } | null> {
    const entry = await this.readDocCached(dir, key);
    return entry ? { meta: entry.meta, body: entry.body } : null;
  }

  /**
   * readDoc + 校验用 mtimeMs（#321）：library 聚合读层的 updatedAt 兜底链需要文件 mtime，
   * 与缓存校验共用同一次 stat，不引入第二次。mtimeMs 即缓存校验戳——命中时等于文件当前 mtime。
   */
  async readDocWithMtime(dir: string, key: string): Promise<{ meta: Record<string, unknown>; body: string; mtimeMs: number } | null> {
    return this.readDocCached(dir, key);
  }

  /** readDoc 的读穿缓存实现（mdCache，与 readJson 同一 mtime 校验模式） */
  private async readDocCached(dir: string, key: string): Promise<{ meta: Record<string, unknown>; body: string; mtimeMs: number } | null> {
    const filePath = path.join(dir, `${key}.md`);
    const mtimeMs = await statMtimeMs(filePath);
    if (mtimeMs === null) {
      mdCache.delete(filePath);
      return null;
    }
    const hit = mdCache.get(filePath);
    if (hit && hit.mtimeMs === mtimeMs) {
      return hit.value ? { ...cloneCached(hit.value), mtimeMs } : null;
    }
    let doc: { meta: Record<string, unknown>; body: string } | null = null;
    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      const parsed = parseFrontmatter(content);
      // 无 frontmatter fence → 整文件视为 body，meta 为空
      doc = parsed ?? { meta: {}, body: content.trim() };
    } catch (err: unknown) {
      if (!isErrnoError(err) || err.code !== 'ENOENT') throw err;
      doc = null; // stat 与 readFile 之间被删 → 按缺失处理
    }
    cacheSet(mdCache, filePath, { value: doc, mtimeMs });
    return doc ? { ...cloneCached(doc), mtimeMs } : null;
  }

  /**
   * 写入 markdown 文件（含 YAML frontmatter）。
   * 目录不存在时自动创建。写后失效缓存。
   */
  async writeDoc(dir: string, key: string, meta: Record<string, unknown>, body: string): Promise<void> {
    const filePath = path.join(dir, `${key}.md`);
    await this.ensureDir(path.dirname(filePath));
    const content = serializeFrontmatter(meta, body);
    await fs.promises.writeFile(filePath, content, 'utf-8');
    invalidateFileKey(filePath);
  }

  // ═══ 索引管理 ═══

  async buildIndex(dir: string, fields: string[]): Promise<void> {
    await this.ensureDir(dir);
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const mdFiles = entries.filter(e => e.isFile() && e.name.endsWith('.md') && e.name !== '_index.md').map(e => e.name);
    const header = `# Directory Index\n# Auto-generated\n# Total: ${mdFiles.length} entries\n#\n# filename|${fields.join('|')}`;
    const dataLines: string[] = [];
    for (const filename of mdFiles) {
      const doc = await this.readDoc(dir, filename.replace(/\.md$/, ''));
      const values = fields.map(f => {
        const v = doc?.meta[f];
        if (v === undefined || v === null) return '';
        if (Array.isArray(v)) return (v as string[]).join(';');
        return String(v);
      });
      dataLines.push(`${filename}|${values.join('|')}`);
    }
    await fs.promises.writeFile(path.join(dir, '_index.md'), header + '\n' + dataLines.join('\n') + '\n', 'utf-8');
  }

  async listDocs(dir: string): Promise<string[]> {
    try {
      const content = await fs.promises.readFile(path.join(dir, '_index.md'), 'utf-8');
      return content.split('\n').filter(l => l.trim() && !l.startsWith('#'))
        .map(l => l.split('|')[0].replace(/\.md$/, ''));
    } catch (err: unknown) {
      if (isErrnoError(err) && err.code === 'ENOENT') {
        try {
          const entries = await fs.promises.readdir(dir, { withFileTypes: true });
          return entries.filter(e => e.isFile() && e.name.endsWith('.md') && e.name !== '_index.md')
            .map(e => e.name.replace(/\.md$/, ''));
        } catch { return []; }
      }
      throw err;
    }
  }

  async appendChangelog(dir: string, key: string, entry: string): Promise<void> {
    const changelogDir = path.join(dir, key);
    await this.ensureDir(changelogDir);
    const filePath = path.join(changelogDir, 'CHANGELOG.md');
    const newEntry = `\n## ${new Date().toISOString()}\n\n${entry}\n`;
    try {
      const existing = await fs.promises.readFile(filePath, 'utf-8');
      await fs.promises.writeFile(filePath, existing + newEntry, 'utf-8');
    } catch (err: unknown) {
      if (isErrnoError(err) && err.code === 'ENOENT') {
        await fs.promises.writeFile(filePath, `# CHANGELOG\n${newEntry}`, 'utf-8');
      } else { throw err; }
    }
  }
}