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
 *       messages.lock    # 消息写/压实/归档互斥锁目录（#319/#327）
 *       archive/messages-YYYY-MM.jsonl  # 超龄消息冷文件（#327，按消息 createdAt 归月）
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
 * #362：Profile/RuntimeState/Channel 三段目录型实体 CRUD 合并为 DirEntityStoreConfig
 * 泛型（漂移点统一口径：创建一律查重、更新一律补 updatedAt）；扁平目录 JSON 清单
 * 单点化为 listJsonInDir（收编 mcp/tool-store.listJsonFiles、capability scanAll）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { isErrnoError } from './file-store-base';
import { FileStoreWorkUnitBase, type FileStoreWorkUnitOptions } from './file-store-workunit';
import { stringifyChannels } from './channels-codec';
import { parseFrontmatter, serializeFrontmatter } from './frontmatter';
import { readMetricsBegin, emitReadMetric } from './read-metrics';
import { foldJsonlById } from './jsonl-fold';
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
  MessageArchiveOptions,
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
  MessageArchiveOptions,
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

interface CacheEntry<T> {
  value: T;
  mtimeMs: number;
}

const jsonCache = new Map<string, CacheEntry<unknown>>();
const jsonlCache = new Map<string, CacheEntry<unknown[]>>();
const dirCache = new Map<string, CacheEntry<fs.Dirent[]>>();
const mdCache = new Map<string, CacheEntry<{ meta: Record<string, unknown>; body: string } | null>>();
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
 * 频道消息生命周期归档（#327）：活消息超龄即从热文件（messages.jsonl）搬入冷文件
 * （archive/messages-YYYY-MM.jsonl，按消息 createdAt 归月），热文件体积与「在跑的活」
 * 挂钩而非频道年龄。计龄锚点：有 workUnitId → 所属 WU 的 closedAt；无 → 消息 createdAt。
 * 与 #319 压实共用 per-channel messages.lock + 原子重写 + mergeActiveRows 归并口径。
 */
const MESSAGE_ARCHIVE_MAX_AGE_DAYS = 30;

/**
 * JSONL 行归并（#319 收敛的唯一口径）：每 id 留最后出现的内容、挂首现位置、
 * deleted 整条丢弃。resolveActiveMessages / 压实 / getMessagesSince 三处共用——
 * 口径要改只改这里。
 * #360：分组折叠走共享 foldJsonlById（作废判据 = deleted 标记行，墓碑收尾即
 * voided），本函数只保留 channels 特有的「剥 deleted 字段」投影。
 */
function mergeActiveRows(rows: ChannelMessageRow[]): ChannelMessageData[] {
  const active: ChannelMessageData[] = [];
  for (const group of foldJsonlById(rows, row => row.deleted === true).values()) {
    if (group.voided) continue; // 墓碑行收尾：整条丢弃
    // 删除 deleted 字段以保持与 ChannelMessageData 类型一致
    const { deleted, ...rest } = group.latest;
    active.push(rest);
  }
  return active;
}

/** FileStore 构造选项（#319：messageCompaction 供测试注入小阈值；#327：messageArchive 仿同模式） */
export interface FileStoreOptions extends FileStoreWorkUnitOptions {
  messageCompaction?: MessageCompactionOptions;
  messageArchive?: MessageArchiveOptions;
}

// ─── FileStore 类 ───

export class FileStore extends FileStoreWorkUnitBase {
  private readonly messageCompaction: Required<MessageCompactionOptions>;
  private readonly messageArchive: { maxAgeDays: number; now: () => Date };
  /** 压实评估计数（按 messages.jsonl 绝对路径；挂实例——同 baseDir 不同阈值配置的实例互不串扰） */
  private readonly messageAppendCounts = new Map<string, number>();

  constructor(baseDir?: string, opts?: FileStoreOptions) {
    super(baseDir, opts);
    this.messageCompaction = {
      checkInterval: opts?.messageCompaction?.checkInterval ?? MESSAGE_COMPACT_CHECK_INTERVAL,
      minLines: opts?.messageCompaction?.minLines ?? MESSAGE_COMPACT_MIN_LINES,
      deadRatio: opts?.messageCompaction?.deadRatio ?? MESSAGE_COMPACT_DEAD_RATIO,
    };
    this.messageArchive = {
      maxAgeDays: opts?.messageArchive?.maxAgeDays ?? MESSAGE_ARCHIVE_MAX_AGE_DAYS,
      now: opts?.messageArchive?.now ?? (() => new Date()),
    };
  }

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

  /** readdir（withFileTypes）读穿缓存：目录 mtime 校验，目录内容增删触发重读 */
  private async readdirCached(dir: string): Promise<fs.Dirent[]> {
    const t = readMetricsBegin();
    const t0 = t?.() ?? 0;
    const mtimeMs = await statMtimeMs(dir);
    const t1 = t?.() ?? 0;
    if (mtimeMs === null) {
      dirCache.delete(dir);
      const fallback = await fs.promises.readdir(dir, { withFileTypes: true }); // 保留 ENOENT 抛错语义
      if (t) emitReadMetric({ file: dir, op: 'readdir', cacheHit: false, statMs: t1 - t0, readParseMs: t() - t1, cloneMs: 0 });
      return fallback;
    }
    const hit = dirCache.get(dir);
    if (hit && hit.mtimeMs === mtimeMs) {
      if (t) emitReadMetric({ file: dir, op: 'readdir', cacheHit: true, statMs: t1 - t0, readParseMs: 0, cloneMs: 0 });
      return hit.value;
    }
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    if (t) emitReadMetric({ file: dir, op: 'readdir', cacheHit: false, statMs: t1 - t0, readParseMs: t() - t1, cloneMs: 0 });
    cacheSet(dirCache, dir, { value: entries, mtimeMs });
    return entries;
  }

  /**
   * readdir 读穿缓存公开入口（#321）：聚合读层（library/sdd-legacy）扫外部仓目录用。
   * 目录 mtime 校验；目录不存在抛 ENOENT（与 fs.readdir 语义一致，调用方自行容错）。
   */
  public async readdir(dir: string): Promise<fs.Dirent[]> {
    return this.readdirCached(dir);
  }

  /**
   * #314（D1）：getIndex 的锁外只读路径走读穿缓存（复用 jsonCache，key =
   * workunits/index.json 绝对路径；所有索引写经 writeJson 覆盖自动精确失效）。
   * 保留 readIndexFile 的严格损坏语义（撕裂/非数组抛错，不静默当空），
   * 命中返回结构克隆。锁内读路径不经过本方法（readIndexFile 保持裸读）。
   */
  protected async readIndexForQuery(): Promise<WorkUnitSnapshot[] | null> {
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
      const cached = cloneCached(hit.value) as WorkUnitSnapshot[] | null;
      if (t) emitReadMetric({ file: filePath, op: 'readIndexForQuery', cacheHit: true, statMs: t1 - t0, readParseMs: 0, cloneMs: t() - t1 });
      return cached;
    }
    const value = await this.readIndexFile();
    const t2 = t?.() ?? 0;
    cacheSet(jsonCache, filePath, { value, mtimeMs });
    const cloned = cloneCached(value);
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

  private messagesPath(channelId: string): string {
    return path.join(this.baseDir, 'channels', channelId, 'messages.jsonl');
  }

  /** #327：冷文件目录（超龄消息按月归档，纯 ChannelMessageData 行，无 tombstone） */
  private archiveDir(channelId: string): string {
    return path.join(this.baseDir, 'channels', channelId, 'archive');
  }

  private archiveMonthPath(channelId: string, month: string): string {
    return path.join(this.archiveDir(channelId), `messages-${month}.jsonl`);
  }

  private agentsDir(): string {
    return path.join(this.baseDir, 'agents');
  }

  private channelsDir(): string {
    return path.join(this.baseDir, 'channels');
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
   * 频道消息分页（#319 半下沉 + #327 冷热穿透）：存储层过滤→排序→切片，路由不再全量拉回内存切。
   * before = 锚点消息 id 游标（不含锚点；替代原 timestamp 游标——同毫秒多条消息不再漏/重）。
   * 锚点 id 不存在（已删除/被压实抹除/冷热都没有）→ 空页 + hasMore=false：位置不可知时不整页错发。
   * total 语义与路由现状一致：锚点过滤后的可见总数（热+冷有效行）。
   *
   * #327 穿透规则：遍历链 = 热（新→旧）接冷（月新→旧、月内 createdAt 新→旧）；
   * 无 before（最新页）热页不足 limit 从冷链补满（热全空时首页直接出冷，历史永远在）；
   * 锚在热而热侧不足 limit 时余量从冷续；锚在冷则整页从冷出；
   * 跨冷热按 id 去重（thaw/崩溃残留同 id，新→旧先见为准——热侧恒遮蔽冷侧残留）。
   * 无冷数据（无 archive 目录）时行为与 #319 现状逐条一致。
   */
  async queryMessagesPage(channelId: string, opts?: MessagePageOpts): Promise<MessagePage> {
    const resolved = await this.resolveActiveMessages(channelId);
    // 按创建时间升序（与 queryMessages 同口径；同刻消息按文件序稳定排列）
    resolved.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    const limit = opts?.limit !== undefined && opts.limit > 0 ? opts.limit : 50;

    // 冷链（新→旧）+ 有效行过滤：热侧 id 遮蔽冷侧残留，冷侧内部同 id 先见为准
    const hotIds = new Set(resolved.map(m => m.id));
    const seenCold = new Set<string>();
    const cold: ChannelMessageData[] = [];
    for (const msg of await this.readColdChain(channelId)) {
      if (hotIds.has(msg.id) || seenCold.has(msg.id)) continue;
      seenCold.add(msg.id);
      cold.push(msg);
    }

    if (!opts?.before) {
      // 最新页：热页不足 limit 从冷链（新→旧）补满——热全空时首页直接出冷数据，
      // 「滚动穿透、历史永远在」；与锚在热的补冷同一去重纪律（cold 已过滤热遮蔽/冷内同 id）
      const hotPage = resolved.slice(-limit);
      const coldNeed = limit - hotPage.length;
      const coldPart = coldNeed > 0 ? cold.slice(0, coldNeed).reverse() : [];
      return {
        messages: [...coldPart, ...hotPage],
        total: resolved.length + cold.length,
        hasMore: resolved.length + cold.length > limit,
      };
    }

    const anchor = resolved.findIndex(m => m.id === opts.before);
    if (anchor !== -1) {
      // 锚在热：链上锚点之前 = 热[0..anchor) 接整条冷链；页 = 该序列末尾 limit 条（升序）
      const hotPage = resolved.slice(Math.max(0, anchor - limit), anchor);
      const coldNeed = limit - hotPage.length;
      const coldPart = coldNeed > 0 ? cold.slice(0, coldNeed).reverse() : [];
      const olderCount = anchor + cold.length;
      return {
        messages: [...coldPart, ...hotPage],
        total: olderCount,
        hasMore: olderCount > limit,
      };
    }

    // 锚在冷：整页从冷出
    const coldAnchor = cold.findIndex(m => m.id === opts.before);
    if (coldAnchor === -1) {
      return { messages: [], total: resolved.length + cold.length, hasMore: false };
    }
    const older = cold.slice(coldAnchor + 1); // 新→旧
    return {
      messages: older.slice(0, limit).reverse(),
      total: older.length,
      hasMore: older.length > limit,
    };
  }

  /** 冷文件月清单（YYYY-MM，新→旧）；无 archive 目录 → [] */
  private async listArchiveMonths(channelId: string): Promise<string[]> {
    let entries: fs.Dirent[];
    try {
      entries = await this.readdirCached(this.archiveDir(channelId));
    } catch (err: unknown) {
      if (isErrnoError(err) && err.code === 'ENOENT') return [];
      throw err;
    }
    return entries
      .filter(e => e.isFile())
      .map(e => /^messages-(\d{4}-\d{2})\.jsonl$/.exec(e.name)?.[1])
      .filter((m): m is string => m !== undefined)
      .sort()
      .reverse();
  }

  /** 冷链：全部归档消息按分页遍历序（月新→旧，月内 createdAt 新→旧）。读穿缓存摊销 */
  private async readColdChain(channelId: string): Promise<ChannelMessageData[]> {
    const chain: ChannelMessageData[] = [];
    for (const month of await this.listArchiveMonths(channelId)) {
      const rows = await this.readJsonl<ChannelMessageData>(this.archiveMonthPath(channelId, month));
      rows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      chain.push(...rows);
    }
    return chain;
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

  // ─── 消息生命周期归档（#327）───

  /**
   * 归档 sweep：逐频道把超龄活消息从热文件搬入冷文件（archive/messages-YYYY-MM.jsonl）。
   * 定期任务（启动一次 + 每 24h，挂 index.ts 轮转调度点），非请求路径。
   *
   * 超龄规则：有 workUnitId → 所属 WU 的 closedAt + maxAgeDays（closedAt 缺失的遗产数据
   * 回退 updatedAt；WU 悬空回退消息 createdAt 规则；WU 非 closed 一律保留）；
   * 无 workUnitId → 消息 createdAt + maxAgeDays。
   *
   * 纪律：per-channel messages.lock 锁内操作（与并发 append/tombstone/压实互斥）；
   * 写序先冷后热——崩溃在中间 = 同 id 冷热都有，下次 sweep 冷侧按 id 去重吸收；
   * 无超龄消息不动热文件（不重写、不 bump mtime）；归并走 mergeActiveRows 唯一口径
   * （顺带压实效果：死行不进冷热文件）。
   */
  async archiveChannelMessages(): Promise<{ archivedMessages: number }> {
    const nowMs = this.messageArchive.now().getTime();
    const maxAgeMs = this.messageArchive.maxAgeDays * 86_400_000;
    // WU 计龄锚点索引（读穿缓存 mtime 校验；sweep 是离线任务，锚点滞后最多影响一轮）
    const wuIndex = new Map((await this.getIndex()).map(s => [s.id, s]));

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(this.channelsDir(), { withFileTypes: true });
    } catch (err: unknown) {
      if (isErrnoError(err) && err.code === 'ENOENT') return { archivedMessages: 0 };
      throw err;
    }

    let archivedMessages = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      archivedMessages += await this.withLock(this.messagesLockDir(entry.name), () =>
        this.archiveChannelMessagesLocked(entry.name, wuIndex, nowMs, maxAgeMs));
    }
    return { archivedMessages };
  }

  /** 单频道归档（锁内专用：withLock 不可重入，调用方须已持 messages.lock） */
  private async archiveChannelMessagesLocked(
    channelId: string,
    wuIndex: Map<string, WorkUnitSnapshot>,
    nowMs: number,
    maxAgeMs: number,
  ): Promise<number> {
    const filePath = this.messagesPath(channelId);
    // 锁内裸读（ADR 例外条款，同压实）：归档依据必须是此刻磁盘真值
    const rows = await super.readJsonl<ChannelMessageRow>(filePath);
    if (rows.length === 0) return 0;

    const active = mergeActiveRows(rows);
    const keep: ChannelMessageData[] = [];
    const archive: ChannelMessageData[] = [];
    for (const msg of active) {
      const anchorMs = this.archiveAnchorMs(msg, wuIndex);
      if (anchorMs !== null && nowMs - anchorMs >= maxAgeMs) archive.push(msg);
      else keep.push(msg);
    }
    if (archive.length === 0) return 0; // 空操作纪律：无超龄不动热文件

    // 先追加冷文件（按消息 createdAt 归月、月内升序；追加前按 id 去重——吸收崩溃残留/重复 sweep）
    const byMonth = new Map<string, ChannelMessageData[]>();
    for (const msg of archive) {
      const month = msg.createdAt.slice(0, 7); // ISO 8601 前缀 YYYY-MM
      const list = byMonth.get(month);
      if (list) list.push(msg);
      else byMonth.set(month, [msg]);
    }
    for (const [month, msgs] of byMonth) {
      msgs.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      const monthPath = this.archiveMonthPath(channelId, month);
      const existingIds = new Set((await super.readJsonl<ChannelMessageData>(monthPath)).map(m => m.id));
      for (const msg of msgs) {
        if (existingIds.has(msg.id)) continue;
        await this.appendJsonl(monthPath, msg);
      }
    }
    // 后原子重写热文件（tmp+rename，同压实纪律；崩溃在中间 = 同 id 冷热都有，查询面按 id 去重）
    await this.writeJsonl(filePath, keep);
    return archive.length;
  }

  /**
   * 单条消息的计龄锚点（epoch ms）；返回 null = 一律保留（活 WU / 锚点日期损坏）。
   * 损坏锚点按保留处理：宁可多留一轮不丢可读性。
   */
  private archiveAnchorMs(msg: ChannelMessageData, wuIndex: Map<string, WorkUnitSnapshot>): number | null {
    let anchorIso: string;
    if (msg.workUnitId) {
      const wu = wuIndex.get(msg.workUnitId);
      if (wu && wu.status !== 'closed') return null; // 活 WU 的消息永远在热层
      // 遗产 closedAt 缺失回退 updatedAt；WU 悬空（已删除/从未存在）回退 createdAt 规则
      anchorIso = wu ? (wu.closedAt ?? wu.updatedAt) : msg.createdAt;
    } else {
      anchorIso = msg.createdAt;
    }
    const t = Date.parse(anchorIso);
    return Number.isNaN(t) ? null : t;
  }

  /**
   * reopen 解冻（#327）：把该 WU 的已归档消息从冷文件搬回热文件（保留原 id/createdAt），
   * 冷文件原子重写剔除已 thaw 行。规则保持一条线：活 WU 的消息永远在热层。
   * 低频操作（WU closed→unassigned 钩子），全频道扫描成本可接受；
   * 无 archive 目录/无匹配行 = 零成本短路（不取锁、不动热文件）。
   * 写序先热后冷：崩溃在中间 = 同 id 冷热都有，查询面按 id 去重（热侧遮蔽冷侧残留）。
   */
  async thawWorkUnitMessages(workUnitId: string): Promise<{ thawedMessages: number }> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(this.channelsDir(), { withFileTypes: true });
    } catch (err: unknown) {
      if (isErrnoError(err) && err.code === 'ENOENT') return { thawedMessages: 0 };
      throw err;
    }
    let thawedMessages = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const months = await this.listArchiveMonths(entry.name);
      if (months.length === 0) continue; // 零成本短路：无冷文件不取锁
      thawedMessages += await this.thawChannelWorkUnitMessages(entry.name, workUnitId, months);
    }
    return { thawedMessages };
  }

  /** 单频道解冻：锁外预检无匹配不取锁；锁内裸读重判后先 append 热、后原子重写冷 */
  private async thawChannelWorkUnitMessages(channelId: string, workUnitId: string, months: string[]): Promise<number> {
    // 锁外预检（读穿缓存）：该频道冷文件无此 WU 的行 → 不取锁
    let hasMatch = false;
    for (const month of months) {
      const rows = await this.readJsonl<ChannelMessageData>(this.archiveMonthPath(channelId, month));
      if (rows.some(m => m.workUnitId === workUnitId)) { hasMatch = true; break; }
    }
    if (!hasMatch) return 0;

    return this.withLock(this.messagesLockDir(channelId), async () => {
      // 锁内裸读重判（预检后可能有并发 sweep/thaw 改动）
      const thawRows: ChannelMessageData[] = [];
      const rewrittenMonths: Array<{ monthPath: string; remain: ChannelMessageData[] }> = [];
      for (const month of months) {
        const monthPath = this.archiveMonthPath(channelId, month);
        const rows = await super.readJsonl<ChannelMessageData>(monthPath);
        const remain = rows.filter(m => {
          if (m.workUnitId === workUnitId) { thawRows.push(m); return false; }
          return true;
        });
        if (remain.length !== rows.length) rewrittenMonths.push({ monthPath, remain });
      }
      if (thawRows.length === 0) return 0;

      // 先 append 回热文件（保留原 id/createdAt，按 createdAt 升序；热侧已有同 id 不重复）
      const hotPath = this.messagesPath(channelId);
      const hotIds = new Set((await super.readJsonl<ChannelMessageRow>(hotPath)).map(r => r.id));
      thawRows.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      let appended = 0;
      for (const msg of thawRows) {
        if (hotIds.has(msg.id)) continue;
        await this.appendJsonl(hotPath, msg);
        appended++;
      }
      // 后原子重写冷文件剔除已 thaw 行（tmp+rename，同 sweep 纪律）
      for (const { monthPath, remain } of rewrittenMonths) {
        await this.writeJsonl(monthPath, remain);
      }
      return appended;
    });
  }

  /**
   * 跨频道查询消息（扫描所有 channel 的 messages.jsonl）。
   * 支持按 workUnitId(s) 和 authorType 过滤。
   * #330：可选 channelIds 预过滤——提供时 readdir 后跳过集合外频道（不读其文件），
   * 供 observe 巡查只扫活跃 WU 所在频道；缺省全扫，既有调用方行为不变。
   */
  async queryAllMessages(filter?: { workUnitIds?: string[]; workUnitId?: string; authorType?: string; agentName?: string; agentNames?: string[]; channelIds?: string[] }): Promise<ChannelMessageData[]> {
    const result: ChannelMessageData[] = [];
    const dir = this.channelsDir();
    try {
      const entries = await this.readdirCached(dir);
      const channelSet = filter?.channelIds ? new Set(filter.channelIds) : null;
      const perChannel = await Promise.all(entries.map(async entry => {
        if (!entry.isDirectory()) return [];
        if (channelSet && !channelSet.has(entry.name)) return [];
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
        // #360：与 queryMessages 同走 mergeActiveRows 唯一归并口径（原为 inline 重复折叠）
        const active = mergeActiveRows(await this.readJsonl<ChannelMessageRow>(this.messagesPath(entry.name)));
        const msg = active.find(m => m.id === messageId);
        return msg ? { channelId: entry.name, message: msg } : null;
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
  // 扁平目录 JSON 清单原语（#362 收编单点）
  // ═══════════════════════

  /**
   * 扁平目录 JSON 实体清单：扫描 {dir}/*.json 全量读取，损坏/缺失文件跳过；
   * 目录不存在返回 []（不建目录）。与目录型实体的差异是实体直接平铺为文件、无子目录。
   * 消费方：apps/api mcp tool-store.listJsonFiles、studio-capability CapabilityService.scanAll。
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