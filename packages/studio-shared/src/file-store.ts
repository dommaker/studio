/**
 * FileStore — AN 运行时数据文件存储基类
 *
 * 混合架构：运行时数据走文件，知识图谱/安全/OKR 等跨模型关联数据留在 DB。
 * JSON/JSONL 格式文件存储，flock（mkdir 原子操作）保障 claim 原子性。
 *
 * 目录结构：
 *   ~/.studio/data/
 *     agents/{id}/
 *       profile.json     # AgentProfile
 *       state.json       # RuntimeState
 *     channels/{id}/
 *       config.json      # Channel
 *       messages.jsonl   # ChannelMessage（append-only + tombstone；#319 写侧压实清死行）
 *       messages.lock    # 消息写/压实互斥锁目录（#319）
 *     workunits/
 *       lock             # flock 文件锁目录
 *       events.jsonl     # 事件流 (append-only)
 *       index.json       # 当前状态快照
 *     requirements/      # REQ 需求编号体系 (vision §5.3)
 *       lock             # seq 分配 flock 锁目录
 *       index.json       # { nextSeq } 序号计数器
 *       REQ-0042.json    # RequirementData（每需求一个文件）
 *
 * 本文件为门面：数据类型在 file-store-types.ts，JSON/锁原语在 file-store-base.ts，
 * WorkUnit 事件溯源在 file-store-workunit.ts，channels 编解码在 channels-codec.ts，
 * frontmatter 在 frontmatter.ts；全部符号在此 re-export，导出面不变。
 *
 * 工单 26：FileStore 读写原语覆盖为 mtime 校验的读穿缓存 + list 并发读（A1）；
 * Requirement/Evolution 复制段合并为 SeqEntryStoreConfig 泛型条目存储（A2）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { isErrnoError } from './file-store-base';
import { FileStoreWorkUnitBase, type FileStoreWorkUnitOptions } from './file-store-workunit';
import { stringifyChannels } from './channels-codec';
import { parseFrontmatter, serializeFrontmatter } from './frontmatter';
import type {
  AgentProfileData,
  RuntimeStateData,
  ChannelData,
  ChannelMessageData,
  ChannelMessageRow,
  QueryOpts,
  MessagePageOpts,
  MessagePage,
  MessageCompactionOptions,
  CountOpts,
  RequirementData,
  RequirementFilter,
  EvolutionProposalData,
  EvolutionProposalFilter,
  WorkUnitSnapshot,
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
  CountOpts,
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
export { parseChannels, stringifyChannels } from './channels-codec';
export { parseFrontmatter, serializeFrontmatter } from './frontmatter';

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

// ─── 读穿缓存（A1，工单 26）───
//
// 模块级（同进程共享、按绝对路径为 key），任何 FileStore 实例的写/删都会失效对应 key，
// 因此同进程内写后读立即可见。命中时用 stat 的 mtimeMs 校验缓存新鲜度，
// 其他进程的外部写入（mtime 变化）也会触发重读——不引入跨进程脏读。
// 缓存对象一律不直接外发（命中返回结构克隆），调用方原地 mutate 返回值不会污染缓存。

interface CacheEntry<T> {
  value: T;
  mtimeMs: number;
}

const jsonCache = new Map<string, CacheEntry<unknown>>();
const jsonlCache = new Map<string, CacheEntry<unknown[]>>();
const dirCache = new Map<string, CacheEntry<fs.Dirent[]>>();
const MAX_CACHE_ENTRIES = 1000;

function cacheSet<T>(map: Map<string, CacheEntry<T>>, key: string, entry: CacheEntry<T>): void {
  if (map.size >= MAX_CACHE_ENTRIES) map.clear();
  map.set(key, entry);
}

/** 文件/目录 mtimeMs；不存在返回 null；其他错误抛出（与 readFile 错误语义一致） */
async function statMtimeMs(target: string): Promise<number | null> {
  try {
    const st = await fs.promises.stat(target);
    return st.mtimeMs;
  } catch (err: unknown) {
    if (isErrnoError(err) && err.code === 'ENOENT') return null;
    throw err;
  }
}

/** 缓存值外发前结构克隆（null 直返），防调用方原地 mutate 污染缓存 */
function cloneCached<T>(value: T): T {
  return value === null || value === undefined ? value : structuredClone(value);
}

/** 写路径失效：精确删除对应文件 key；目录级 list 缓存清空（新建文件/目录可能落在同一 mtime 粒度内，不能只靠 mtime 校验） */
function invalidateFileKey(filePath: string): void {
  jsonCache.delete(filePath);
  jsonlCache.delete(filePath);
  dirCache.clear();
}

/** 删路径失效：文件或目录（递归）下所有 key + 目录级 list 缓存 */
function invalidateRemovedPath(target: string): void {
  const prefix = target.endsWith(path.sep) ? target : target + path.sep;
  for (const map of [jsonCache, jsonlCache] as const) {
    for (const key of map.keys()) {
      if (key === target || key.startsWith(prefix)) map.delete(key);
    }
  }
  dirCache.clear();
}

// ─── 频道消息写侧压实（#319）───
//
// messages.jsonl append-only：编辑 = 同 id 追加新版，删除 = 追加 tombstone 行，文件只涨不缩。
// 写侧阈值压实：append/tombstone 每满 checkInterval 次评估一次；总行数 ≥ minLines 且死行
// （被覆盖的旧版行 + 已删除消息的原行与 tombstone 行）占比 ≥ deadRatio 时，在 per-channel
// 文件锁内把活消息（每 id 最新版、首现位置序，口径同 resolveActiveMessages）原子重写回文件。
// 压实只清死行，不动任何活消息；读穿缓存靠 mtime 校验自然失效。
// 摊销设计：逐次 append 全量解析会把读穿缓存省下的成本吃回写路径，故按计数摊销；
// 计数是进程内存，重启清零最多延迟一轮评估，阈值检查自愈，无需持久化。
const MESSAGE_COMPACT_CHECK_INTERVAL = 500;
const MESSAGE_COMPACT_MIN_LINES = 5000;
const MESSAGE_COMPACT_DEAD_RATIO = 0.3;

/**
 * JSONL 行归并（#319 收敛的唯一口径）：每 id 留最后出现的内容、挂首现位置、
 * deleted 整条丢弃。resolveActiveMessages / 压实 / getMessagesSince 三处共用——
 * 口径要改只改这里。
 */
function mergeActiveRows(rows: ChannelMessageRow[]): ChannelMessageData[] {
  const latest = new Map<string, ChannelMessageRow>();
  for (const row of rows) latest.set(row.id, row);
  const active: ChannelMessageData[] = [];
  for (const msg of latest.values()) {
    if (msg.deleted) continue;
    // 删除 deleted 字段以保持与 ChannelMessageData 类型一致
    const { deleted, ...rest } = msg;
    active.push(rest);
  }
  return active;
}

/** FileStore 构造选项（#319：messageCompaction 供测试注入小阈值） */
export interface FileStoreOptions extends FileStoreWorkUnitOptions {
  messageCompaction?: MessageCompactionOptions;
}

// ─── FileStore 类 ───

export class FileStore extends FileStoreWorkUnitBase {
  private readonly messageCompaction: Required<MessageCompactionOptions>;
  /** 压实评估计数（按 messages.jsonl 绝对路径；挂实例——同 baseDir 不同阈值配置的实例互不串扰） */
  private readonly messageAppendCounts = new Map<string, number>();

  constructor(baseDir?: string, opts?: FileStoreOptions) {
    super(baseDir, opts);
    this.messageCompaction = {
      checkInterval: opts?.messageCompaction?.checkInterval ?? MESSAGE_COMPACT_CHECK_INTERVAL,
      minLines: opts?.messageCompaction?.minLines ?? MESSAGE_COMPACT_MIN_LINES,
      deadRatio: opts?.messageCompaction?.deadRatio ?? MESSAGE_COMPACT_DEAD_RATIO,
    };
  }

  // ─── 读穿缓存覆盖（A1，工单 26）───
  //
  // 基类（file-store-base.ts）读写原语在此覆盖为带 mtime 校验的读穿缓存版本；
  // FileStoreWorkUnitBase 的方法经虚分派同样走缓存与失效。

  public async readJson<T>(filePath: string): Promise<T | null> {
    const mtimeMs = await statMtimeMs(filePath);
    if (mtimeMs === null) {
      jsonCache.delete(filePath);
      return null;
    }
    const hit = jsonCache.get(filePath);
    if (hit && hit.mtimeMs === mtimeMs) {
      return cloneCached(hit.value) as T | null;
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
    cacheSet(jsonCache, filePath, { value, mtimeMs });
    return cloneCached(value) as T | null;
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
    const mtimeMs = await statMtimeMs(filePath);
    if (mtimeMs === null) {
      jsonlCache.delete(filePath);
      return [];
    }
    const hit = jsonlCache.get(filePath);
    if (hit && hit.mtimeMs === mtimeMs) {
      return cloneCached(hit.value) as T[];
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
    cacheSet(jsonlCache, filePath, { value: rows, mtimeMs });
    return cloneCached(rows) as T[];
  }

  /** readdir（withFileTypes）读穿缓存：目录 mtime 校验，目录内容增删触发重读 */
  private async readdirCached(dir: string): Promise<fs.Dirent[]> {
    const mtimeMs = await statMtimeMs(dir);
    if (mtimeMs === null) {
      dirCache.delete(dir);
      return fs.promises.readdir(dir, { withFileTypes: true }); // 保留 ENOENT 抛错语义
    }
    const hit = dirCache.get(dir);
    if (hit && hit.mtimeMs === mtimeMs) {
      return hit.value;
    }
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    cacheSet(dirCache, dir, { value: entries, mtimeMs });
    return entries;
  }

  /**
   * #314（D1）：getIndex 的锁外只读路径走读穿缓存（复用 jsonCache，key =
   * workunits/index.json 绝对路径；所有索引写经 writeJson 覆盖自动精确失效）。
   * 保留 readIndexFile 的严格损坏语义（撕裂/非数组抛错，不静默当空），
   * 命中返回结构克隆。锁内读路径不经过本方法（readIndexFile 保持裸读）。
   */
  protected async readIndexForQuery(): Promise<WorkUnitSnapshot[] | null> {
    const filePath = this.indexPath;
    const mtimeMs = await statMtimeMs(filePath);
    if (mtimeMs === null) {
      jsonCache.delete(filePath);
      return null;
    }
    const hit = jsonCache.get(filePath);
    if (hit && hit.mtimeMs === mtimeMs) {
      return cloneCached(hit.value) as WorkUnitSnapshot[] | null;
    }
    const value = await this.readIndexFile();
    cacheSet(jsonCache, filePath, { value, mtimeMs });
    return cloneCached(value);
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

  private messagesPath(channelId: string): string {
    return path.join(this.baseDir, 'channels', channelId, 'messages.jsonl');
  }

  private agentsDir(): string {
    return path.join(this.baseDir, 'agents');
  }

  private channelsDir(): string {
    return path.join(this.baseDir, 'channels');
  }

  // ═══════════════════════
  // AgentProfile
  // ═══════════════════════

  async getProfile(id: string): Promise<AgentProfileData | null> {
    return this.readJson<AgentProfileData>(this.profilePath(id));
  }

  async listProfiles(filter?: { status?: string }): Promise<AgentProfileData[]> {
    const dir = this.agentsDir();
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      const entries = await this.readdirCached(dir);
      const results = await Promise.all(entries.map(async entry => {
        if (!entry.isDirectory()) return null;
        const profile = await this.readJson<AgentProfileData>(this.profilePath(entry.name));
        if (profile && (!filter?.status || profile.status === filter.status)) return profile;
        return null;
      }));
      return results.filter((p): p is AgentProfileData => p !== null);
    } catch (err: unknown) {
      if (isErrnoError(err) && err.code === 'ENOENT') return [];
      throw err;
    }
  }

  async createProfile(data: AgentProfileData): Promise<void> {
    await this.writeJson(this.profilePath(data.id), data);
  }

  async updateProfile(id: string, patch: Partial<AgentProfileData>): Promise<void> {
    const existing = await this.getProfile(id);
    if (!existing) throw new Error(`AgentProfile not found: ${id}`);
    await this.writeJson(this.profilePath(id), {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    });
  }

  async deleteProfile(id: string): Promise<void> {
    const dir = path.join(this.baseDir, 'agents', id);
    try {
      await fs.promises.rm(dir, { recursive: true, force: true });
    } catch (err: unknown) {
      if (isErrnoError(err) && err.code === 'ENOENT') throw new Error(`AgentProfile not found: ${id}`);
      throw err;
    }
    invalidateRemovedPath(dir);
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
    return this.readJson<RuntimeStateData>(this.statePath(agentId));
  }

  /** 列出所有 RuntimeState */
  async listStates(): Promise<RuntimeStateData[]> {
    const dir = this.agentsDir();
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      const entries = await this.readdirCached(dir);
      const results = await Promise.all(entries.map(async entry => {
        if (!entry.isDirectory()) return null;
        return this.readJson<RuntimeStateData>(this.statePath(entry.name));
      }));
      return results.filter((s): s is RuntimeStateData => s !== null);
    } catch (err: unknown) {
      if (isErrnoError(err) && err.code === 'ENOENT') return [];
      throw err;
    }
  }

  async updateState(agentId: string, patch: Partial<RuntimeStateData>): Promise<void> {
    const existing = await this.getState(agentId);
    if (!existing) throw new Error(`RuntimeState not found for agent: ${agentId}`);
    await this.writeJson(this.statePath(agentId), { ...existing, ...patch });
  }

  /** 删除 RuntimeState（state.json）。保留同目录 profile.json。 */
  async deleteState(agentId: string): Promise<void> {
    const statePath = this.statePath(agentId);
    try {
      await fs.promises.unlink(statePath);
    } catch (err: unknown) {
      if (isErrnoError(err) && err.code === 'ENOENT') throw new Error(`RuntimeState not found for agent: ${agentId}`);
      throw err;
    }
    invalidateFileKey(statePath);
  }

  async createState(agentId: string, data: RuntimeStateData): Promise<void> {
    const statePath = this.statePath(agentId);
    await this.ensureDir(path.dirname(statePath));
    // 检查文件是否已存在
    try {
      await fs.promises.access(statePath, fs.constants.F_OK);
      throw new Error(`RuntimeState already exists for agent: ${agentId}`);
    } catch (err: unknown) {
      if (isErrnoError(err) && err.code === 'ENOENT') {
        // 文件不存在，创建
        await this.writeJson(statePath, data);
        return;
      }
      throw err;
    }
  }

  // ═══════════════════════
  // Channel
  // ═══════════════════════

  async getChannel(id: string): Promise<ChannelData | null> {
    return this.readJson<ChannelData>(this.channelConfigPath(id));
  }

  async listChannels(filter?: { name?: string; type?: string; excludeArchived?: boolean }): Promise<ChannelData[]> {
    const dir = this.channelsDir();
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      const entries = await this.readdirCached(dir);
      const results = await Promise.all(entries.map(async entry => {
        if (!entry.isDirectory()) return null;
        const ch = await this.readJson<ChannelData>(this.channelConfigPath(entry.name));
        if (!ch) return null;
        if (filter?.name && ch.name !== filter.name) return null;
        if (filter?.type && ch.type !== filter.type) return null;
        if (filter?.excludeArchived && /-archived-\d+$/.test(ch.name)) return null;
        return ch;
      }));
      return results.filter((ch): ch is ChannelData => ch !== null);
    } catch (err: unknown) {
      if (isErrnoError(err) && err.code === 'ENOENT') return [];
      throw err;
    }
  }

  async createChannel(data: ChannelData): Promise<void> {
    await this.writeJson(this.channelConfigPath(data.id), data);
  }

  async updateChannel(id: string, patch: Partial<ChannelData>): Promise<void> {
    const existing = await this.getChannel(id);
    if (!existing) throw new Error(`Channel not found: ${id}`);
    await this.writeJson(this.channelConfigPath(id), {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    });
  }

  async deleteChannel(id: string): Promise<void> {
    const dir = path.join(this.baseDir, 'channels', id);
    try {
      await fs.promises.rm(dir, { recursive: true, force: true });
    } catch (err: unknown) {
      if (isErrnoError(err) && err.code === 'ENOENT') throw new Error(`Channel not found: ${id}`);
      throw err;
    }
    invalidateRemovedPath(dir);
  }

  // ═══════════════════════
  // ChannelMessage (JSONL)
  // ═══════════════════════

  private messagesLockDir(channelId: string): string {
    return path.join(this.baseDir, 'channels', channelId, 'messages.lock');
  }

  /**
   * 追加频道消息（#319：per-channel 文件锁 + 写侧压实检查）。
   * 上锁原因：压实会原子重写整个 messages.jsonl，无锁时与并发 append/tombstone 竞争
   * （压实读后写窗口内落入的新行被 rename 覆盖）会丢消息。
   */
  async appendMessage(channelId: string, msg: ChannelMessageData): Promise<void> {
    await this.withLock(this.messagesLockDir(channelId), async () => {
      await this.appendJsonl(this.messagesPath(channelId), msg);
      await this.compactMessagesIfNeededLocked(channelId);
    });
  }

  /**
   * 压实评估（锁内专用：withLock 不可重入，严禁改走公共 appendMessage）。
   * 归并走 mergeActiveRows 唯一口径——压实前后 queryMessages 结果逐条一致。
   */
  private async compactMessagesIfNeededLocked(channelId: string): Promise<void> {
    const filePath = this.messagesPath(channelId);
    const n = (this.messageAppendCounts.get(filePath) ?? 0) + 1;
    this.messageAppendCounts.set(filePath, n);
    if (n % this.messageCompaction.checkInterval !== 0) return;

    // 锁内裸读（ADR 2026-08-24-cache-seam-decision-rules 例外条款）：压实依据必须是此刻磁盘真值
    const rows = await super.readJsonl<ChannelMessageRow>(filePath);
    if (rows.length < this.messageCompaction.minLines) return;

    const winners = mergeActiveRows(rows);
    if ((rows.length - winners.length) / rows.length < this.messageCompaction.deadRatio) return;

    // 基类 writeJsonl 为原子写（tmp+rename），FileStore 覆盖版负责缓存失效
    await this.writeJsonl(filePath, winners);
  }

  /**
   * §4.2 发言层新鲜度检查：频道版本快照（messages.jsonl 最后一行的消息 id，含 tombstone 行——
   * 删除也要被感知为「房间已变」）。
   * #319：行号口径退役（压实会压缩行数，按原始行数下标的契约不再成立），一律以 id 为准。
   * 读取失败（频道不存在等）返回空版本 —— 调用方按「无变化」处理，绝不阻断发言。
   */
  async getChannelVersion(channelId: string): Promise<{ lastMessageId: string | null }> {
    try {
      const rows = await this.readJsonl<ChannelMessageRow>(this.messagesPath(channelId));
      return { lastMessageId: rows.length > 0 ? rows[rows.length - 1].id : null };
    } catch {
      return { lastMessageId: null };
    }
  }

  /**
   * §4.2: 读取锚点消息之后追加的活消息（过滤 tombstone，不含锚点本身）。
   * 锚点为 null（空频道快照）返回全部活消息。
   * 锚点 id 找不到——根因：压实可能抹除锚点行本身（tombstone 或被覆盖行），位置不可知——
   * 保守返回全部活消息：消费方（§4.2）过滤本 loop 自己的消息且拦截 ≤2 次后照发，
   * 代价是有界误报；反向漏报（丢掉真正的新消息）不允许。
   */
  async getMessagesSince(channelId: string, messageId: string | null): Promise<ChannelMessageData[]> {
    try {
      const rows = await this.readJsonl<ChannelMessageRow>(this.messagesPath(channelId));
      let from = 0;
      if (messageId) {
        let anchor = -1;
        for (let i = rows.length - 1; i >= 0; i--) {
          if (rows[i].id === messageId) { anchor = i; break; }
        }
        if (anchor !== -1) from = anchor + 1;
      }
      // 窗口内按 id 归并（mergeActiveRows 唯一口径）：窗口内发了又删的消息不出现在增量里
      return mergeActiveRows(rows.slice(from));
    } catch {
      return [];
    }
  }

  /** 解析 JSONL，按 id 去重（最新条目生效），过滤已删除 */
  private resolveActiveMessages(channelId: string): Promise<ChannelMessageData[]> {
    return this.readJsonl<ChannelMessageRow>(this.messagesPath(channelId)).then(mergeActiveRows);
  }

  async queryMessages(channelId: string, opts?: QueryOpts): Promise<ChannelMessageData[]> {
    const resolved = await this.resolveActiveMessages(channelId);
    let filtered: ChannelMessageData[] = resolved;

    if (opts?.workUnitId) {
      filtered = filtered.filter(m => m.workUnitId === opts.workUnitId);
    }
    if (opts?.authorType) {
      filtered = filtered.filter(m => m.authorType === opts.authorType);
    }
    if (opts?.since) {
      const since = new Date(opts.since).getTime();
      filtered = filtered.filter(m => new Date(m.createdAt).getTime() >= since);
    }

    // 按创建时间升序
    filtered.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    if (opts?.limit !== undefined && opts.limit > 0) {
      filtered = filtered.slice(-opts.limit);
    }

    return filtered;
  }

  /**
   * 频道消息分页（#319 半下沉）：存储层过滤→排序→切片，路由不再全量拉回内存切。
   * before = 锚点消息 id 游标（不含锚点；替代原 timestamp 游标——同毫秒多条消息不再漏/重）。
   * 锚点 id 不存在（已删除/被压实抹除）→ 空页 + hasMore=false：位置不可知时不整页错发。
   * total 语义与路由现状一致：锚点过滤后的总数。
   */
  async queryMessagesPage(channelId: string, opts?: MessagePageOpts): Promise<MessagePage> {
    const resolved = await this.resolveActiveMessages(channelId);
    // 按创建时间升序（与 queryMessages 同口径；同刻消息按文件序稳定排列）
    resolved.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    let end = resolved.length;
    if (opts?.before) {
      const anchor = resolved.findIndex(m => m.id === opts.before);
      if (anchor === -1) return { messages: [], total: resolved.length, hasMore: false };
      end = anchor;
    }
    const limit = opts?.limit !== undefined && opts.limit > 0 ? opts.limit : 50;
    return {
      messages: resolved.slice(Math.max(0, end - limit), end),
      total: end,
      hasMore: end > limit,
    };
  }

  async countMessages(channelId: string, opts?: CountOpts): Promise<number> {
    const resolved = await this.resolveActiveMessages(channelId);
    let filtered = resolved;

    if (opts?.workUnitId) {
      filtered = filtered.filter(m => m.workUnitId === opts.workUnitId);
    }
    if (opts?.authorType) {
      filtered = filtered.filter(m => m.authorType === opts.authorType);
    }

    return filtered.length;
  }

  async softDeleteMessage(channelId: string, messageId: string): Promise<void> {
    // #319：与 appendMessage 同锁——压实重写与 tombstone 追加竞争会丢 tombstone（已删消息复活）
    await this.withLock(this.messagesLockDir(channelId), async () => {
      // 锁内裸读（ADR 例外条款）：要删的必须是此刻磁盘最新状态，不走读穿缓存
      const all = await super.readJsonl<ChannelMessageRow>(this.messagesPath(channelId));
      const msg = all.find(m => m.id === messageId && !m.deleted);
      if (!msg) throw new Error(`Message not found: ${messageId}`);
      // append tombstone
      const tombstone: ChannelMessageRow = {
        ...msg,
        deleted: true,
      };
      await this.appendJsonl(this.messagesPath(channelId), tombstone);
      await this.compactMessagesIfNeededLocked(channelId);
    });
  }

  /**
   * 跨频道查询消息（扫描所有 channel 的 messages.jsonl）。
   * 支持按 workUnitId(s) 和 authorType 过滤。
   */
  async queryAllMessages(filter?: { workUnitIds?: string[]; workUnitId?: string; authorType?: string; agentName?: string; agentNames?: string[] }): Promise<ChannelMessageData[]> {
    const result: ChannelMessageData[] = [];
    const dir = this.channelsDir();
    try {
      const entries = await this.readdirCached(dir);
      const perChannel = await Promise.all(entries.map(async entry => {
        if (!entry.isDirectory()) return [];
        const active = await this.resolveActiveMessages(entry.name);
        return active.filter(msg => {
          if (filter?.workUnitId && msg.workUnitId !== filter.workUnitId) return false;
          if (filter?.workUnitIds && msg.workUnitId && !filter.workUnitIds.includes(msg.workUnitId)) return false;
          if (filter?.authorType && msg.authorType !== filter.authorType) return false;
          if (filter?.agentName && msg.agentName !== filter.agentName) return false;
          if (filter?.agentNames && msg.agentName && !filter.agentNames.includes(msg.agentName)) return false;
          return true;
        });
      }));
      for (const msgs of perChannel) result.push(...msgs);
    } catch {
      // channels dir 不存在 → 空结果
    }
    return result;
  }

  /** 按全局 messageId 查找消息（跨频道扫描），返回消息及其所属 channelId */
  async getMessageById(messageId: string): Promise<{ channelId: string; message: ChannelMessageData } | null> {
    const dir = this.channelsDir();
    try {
      const entries = await this.readdirCached(dir);
      const perChannel = await Promise.all(entries.map(async entry => {
        if (!entry.isDirectory()) return null;
        const rows = await this.readJsonl<ChannelMessageRow>(this.messagesPath(entry.name));
        const latest = new Map<string, ChannelMessageRow>();
        for (const row of rows) latest.set(row.id, row);
        for (const msg of latest.values()) {
          if (msg.id === messageId && !msg.deleted) {
            const { deleted, ...rest } = msg;
            return { channelId: entry.name, message: rest };
          }
        }
        return null;
      }));
      // 保持原串行语义：按 readdir 顺序返回首个命中
      return perChannel.find(r => r !== null) ?? null;
    } catch {
      // channels dir 不存在 → 无消息
    }
    return null;
  }


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
  // Markdown 读写（Phase 1: spec-2a filestore-unification）
  // ═══════════════════════

  /**
   * 读取 markdown 文件，解析 frontmatter + body。
   * 文件不存在返回 null。
   */
  async readDoc(dir: string, key: string): Promise<{ meta: Record<string, unknown>; body: string } | null> {
    const filePath = path.join(dir, `${key}.md`);
    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      const parsed = parseFrontmatter(content);
      // 无 frontmatter fence → 整文件视为 body，meta 为空
      if (!parsed) return { meta: {}, body: content.trim() };
      return parsed;
    } catch (err: unknown) {
      if (isErrnoError(err) && err.code === 'ENOENT') return null;
      throw err;
    }
  }

  /**
   * 写入 markdown 文件（含 YAML frontmatter）。
   * 目录不存在时自动创建。
   */
  async writeDoc(dir: string, key: string, meta: Record<string, unknown>, body: string): Promise<void> {
    const filePath = path.join(dir, `${key}.md`);
    await this.ensureDir(path.dirname(filePath));
    const content = serializeFrontmatter(meta, body);
    await fs.promises.writeFile(filePath, content, 'utf-8');
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