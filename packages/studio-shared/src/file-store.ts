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
 *       messages.jsonl   # ChannelMessage (append-only)
 *     workunits/
 *       lock             # flock 文件锁目录
 *       events.jsonl     # 事件流 (append-only)
 *       index.json       # 当前状态快照
 *     requirements/      # REQ 需求编号体系 (vision §5.3)
 *       lock             # seq 分配 flock 锁目录
 *       index.json       # { nextSeq } 序号计数器
 *       REQ-0042.json    # RequirementData（每需求一个文件）
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

// ─── 类型定义 ───

export interface AgentProfileData {
  id: string;
  name: string;
  description: string | null;
  channels: string;        // JSON: Channel ID[] — @deprecated §9.5: channel.members 为成员关系唯一事实源；过渡期保留可读，新代码勿写入
  status: string;          // active | inactive
  provider: string | null; // bound CLI: claude | kimi | codex | opencode | openclaw | null
  createdAt: string;       // ISO 8601
  updatedAt: string;       // ISO 8601
  /** §9.6 P1: 节点 ID。undefined 或 'local' → 本地执行；其他 → RemoteExecutor 路由。 */
  nodeId?: string;
  /** 决策 9: 显式职能域（阶段词表，见 domain-vocab.ts）。创建时可从 .agents/roles/*.yaml 预设带入 */
  acceptedTypes?: string[];
  /** 决策 13: 角色自述（prompt「## 你的角色」段内容）；缺省回退 description */
  persona?: string;
}

export interface RuntimeStateData {
  id: string;
  roleId: string;
  sessionId: string | null;
  status: string;          // idle | active | error | terminated
  currentWorkUnitId: string | null;
  startedAt: string;       // ISO 8601
  terminatedAt: string | null;
  lastHeartbeat: string | null;
  metadata: string | null; // JSON
  pid?: number;            // process.pid for dead-instance detection
  lastError?: string | null;   // F2: last startup-fatal error (e.g. health probe failure)
  lastErrorAt?: string | null; // ISO 8601
}

export interface ChannelData {
  id: string;
  name: string;
  type: string;            // rnd | decision | system
  defaultWorkspaceId: string | null;
  defaultPath: string | null;
  discordChannelId: string | null;
  discordWebhookUrl: string | null;
  members: string;         // JSON: AgentProfile ID[]
  /** AC-6.1: 频道默认管线 AgentProfile name 数组。空数组=清除；undefined=未配置 */
  defaultPipeline?: string[];
  /** 决策 12: 无 @ 消息的默认认领角色（AgentProfile ID）。未配置（null/undefined）= 维持纯存储 */
  defaultProfileId?: string | null;
  createdAt: string;       // ISO 8601
  updatedAt: string;       // ISO 8601
}

export interface ChannelMessageData {
  id: string;
  channelId: string;
  workUnitId: string | null;
  authorType: string;      // human | agent
  agentName: string | null;
  content: string;         // Markdown
  replyToId: string | null;
  meta: string;            // JSON
  createdAt: string;       // ISO 8601
}

/** 带删除标记的消息（JSONL tombstone） */
export interface ChannelMessageRow extends ChannelMessageData {
  deleted?: boolean;
}

export interface QueryOpts {
  workUnitId?: string;
  authorType?: string;
  since?: string;          // ISO 8601
  limit?: number;
}

export interface CountOpts {
  workUnitId?: string;
  authorType?: string;
}

export type WorkUnitEventType = 'created' | 'claimed' | 'updated' | 'completed' | 'closed' | 'blocked';

export interface WorkUnitEvent {
  type: WorkUnitEventType;
  wuId: string;
  timestamp: string;       // ISO 8601
  data?: Record<string, unknown>;
}

export interface WorkUnitSnapshot {
  id: string;
  parentId: string | null;
  type: string;
  scope: string;
  assigneeId: string | null;
  status: string;
  failureType: string | null;
  retryCount: number;
  timeoutAt: string | null;
  channelId: string | null;
  projectPath: string | null;
  workspaceId?: string | null;  // F6: 绑定的注册工程（可选 — 旧事件/快照无此字段仍可加载）
  reqId?: string | null;        // REQ 需求编号（可选 — 旧事件/快照无此字段仍可加载）
  metadata: string | null;
  createdAt: string;
  updatedAt: string;
  claimedAt: string | null;
  completedAt: string | null;
}

export interface WorkUnitFilter {
  status?: string;
  type?: string;
  assigneeId?: string;
  channelId?: string;
}

// ─── Requirement（REQ 需求编号体系, vision §5.3）───
// Requirement 是 WorkUnit 的父实体：一个需求 = 一组 WorkUnit。
// 编号 REQ-<递增序号> 在频道首次 @mention 派发时自动分配，也可手动创建。

export type RequirementStatus = 'open' | 'in-progress' | 'done' | 'archived';

export interface RequirementData {
  id: string;                 // REQ-<zero-padded seq>，如 REQ-0042
  seq: number;                // 递增序号（flock 原子分配）
  title: string;
  status: RequirementStatus;
  channelId?: string | null;  // 来源频道（可选 — 手动创建可无）
  createdAt: string;          // ISO 8601
  createdBy: string;          // 创建来源：mention | convert | manual | api
  docs?: string[];            // 关联文档（需求文档 / SDD 路径）
  description?: string;
}

export interface RequirementFilter {
  status?: string;
  channelId?: string;
}

// ─── Evolution（E1 约束进化, vision §6 / docs/plans/2026-07-flywheel-repair.md §4）───
//
// 约束进化提案：signals（traces/模式挖掘）→ 提案 → 人在频道/API 审核 → 生效。
// 存储复制 Requirement 模式：`~/.studio/data/evolution/EP-0042.json` + flock 序号。

export type EvolutionTargetType = 'iron-law' | 'guideline' | 'prompt-template' | 'role-preset';
export type EvolutionProposalStatus = 'pending' | 'approved' | 'rejected' | 'applied';

export interface EvolutionProposalData {
  id: string;                 // EP-<zero-padded seq>，如 EP-0042
  seq: number;                // 递增序号（flock 原子分配）
  targetType: EvolutionTargetType;
  targetId: string;           // 约束 id | prompt templateId | role 名（.agents/roles/<name>.yaml）
  action: 'add' | 'amend';    // add=新增条目（或 shadow 覆盖内置约束）；amend=修改既有条目
  /** 仅 iron-law/guideline：变更种类（message=改提示文案；exception=加例外；new-entry=新增约束条目） */
  constraintChange?: 'message' | 'exception' | 'new-entry';
  currentText: string;        // 当前文本（add 时可为空串）
  proposedText: string;       // 提案文本（message/模板/persona 全量替换内容）
  rationale: string;          // 理由（含预期效果）
  evidence: {                 // 证据（事件计数/样例）
    windowHours: number;
    eventCounts: Record<string, number>;
    samples?: string[];
  };
  status: EvolutionProposalStatus;
  source: string;             // 'harness-autoEvolve' | 'heuristic:prompt-failure' | 'heuristic:role-failure'
  createdAt: string;          // ISO 8601
  decidedBy?: string | null;  // 'channel' | 'api:<user>' 等
  decidedAt?: string | null;
  appliedAt?: string | null;
  rejectReason?: string | null;
}

export interface EvolutionProposalFilter {
  status?: string;
  targetType?: string;
}

/** 锁超时错误 */
export class LockTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Lock acquisition timed out after ${timeoutMs}ms`);
    this.name = 'LockTimeoutError';
  }
}

// ─── 常量 ───

const LOCK_RETRY_INTERVAL_MS = 10;
const DEFAULT_LOCK_TIMEOUT_MS = 5000;

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

// ─── FileStore 类 ───

export class FileStore {
  private baseDir: string;

  constructor(baseDir?: string) {
    // CWD 陷阱修复：baseDir 解耦 HOME。
    // buildSessionEnv 把 claude CLI 子进程 HOME 设成 agentHome（GAP-2 隔离），
    // 子进程里 new FileStore() 无参构造时 os.homedir() 返回 agentHome，baseDir 漂移到
    // ~/.studio/data/agents/<profile-id>/.studio/data 产生嵌套。STUDIO_DATA_DIR env
    // 由 API server bootstrap 显式设置并经 buildSessionEnv 透传，提供绝对路径锚点。
    this.baseDir = baseDir ?? process.env.STUDIO_DATA_DIR ?? path.join(os.homedir(), '.studio', 'data');
  }

  // ─── 内部工具方法 ───

  /** 确保目录存在 */
  private async ensureDir(dir: string): Promise<void> {
    await fs.promises.mkdir(dir, { recursive: true });
  }

  /** 读取 JSON 文件，不存在或损坏返回 null（A1: mtime 校验的读穿缓存） */
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

  /**
   * 写入 JSON 文件（原子写）。
   * 同目录 tmp 文件 + rename（同分区 rename 原子），进程崩溃或并发读不会看到撕裂内容；
   * tmp 名含 pid + 随机串防并发冲突；rename 前 fsync 落盘；失败时清理 tmp。
   */
  public async writeJson(filePath: string, data: unknown): Promise<void> {
    await this.ensureDir(path.dirname(filePath));
    const tmpPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
    try {
      const fh = await fs.promises.open(tmpPath, 'w');
      try {
        await fh.writeFile(JSON.stringify(data, null, 2), 'utf-8');
        await fh.sync();
      } finally {
        await fh.close();
      }
      await fs.promises.rename(tmpPath, filePath);
    } catch (err) {
      await fs.promises.unlink(tmpPath).catch(() => {});
      throw err;
    }
    invalidateFileKey(filePath);
  }

  /** 追加一行 JSONL */
  public async appendJsonl(filePath: string, data: unknown): Promise<void> {
    await this.ensureDir(path.dirname(filePath));
    await fs.promises.appendFile(filePath, JSON.stringify(data) + '\n', 'utf-8');
    invalidateFileKey(filePath);
  }

  /** 写入全部 JSONL 行（覆盖） */
  public async writeJsonl(filePath: string, data: unknown[]): Promise<void> {
    await this.ensureDir(path.dirname(filePath));
    const content = data.map(item => JSON.stringify(item)).join('\n') + (data.length > 0 ? '\n' : '');
    await fs.promises.writeFile(filePath, content, 'utf-8');
    invalidateFileKey(filePath);
  }

  /** 读取全部 JSONL 行（跳过解析失败的行；A1: mtime 校验的读穿缓存） */
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

  // ─── 文件锁 ───

  /**
   * 基于 mkdir 原子性的跨进程文件锁。
   * 获取锁后执行 fn，释放锁后返回结果。
   * timeoutMs 为获取锁的超时时间。
   */
  async withLock<T>(lockDir: string, fn: () => Promise<T>, timeoutMs: number = DEFAULT_LOCK_TIMEOUT_MS): Promise<T> {
    // 确保父目录存在，防止 mkdir 因 ENOENT 失败
    await fs.promises.mkdir(path.dirname(lockDir), { recursive: true });
    const start = Date.now();
    while (true) {
      try {
        // 原子性创建锁目录（没有 recursive，存在即失败）
        await fs.promises.mkdir(lockDir);
        break;
      } catch (err: unknown) {
        // EEXIST 是预期中的锁冲突，其他错误直接抛
        if (isErrnoError(err) && err.code !== 'EEXIST') throw err;
        if (Date.now() - start > timeoutMs) {
          throw new LockTimeoutError(timeoutMs);
        }
        await sleep(LOCK_RETRY_INTERVAL_MS);
      }
    }
    try {
      return await fn();
    } finally {
      await fs.promises.rmdir(lockDir).catch(() => {});
    }
  }

  private get lockDir(): string {
    return path.join(this.baseDir, 'workunits', 'lock');
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

  private get eventsPath(): string {
    return path.join(this.baseDir, 'workunits', 'events.jsonl');
  }

  private get indexPath(): string {
    return path.join(this.baseDir, 'workunits', 'index.json');
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

  /** 创建新的 RuntimeState（不是 upsert，确保第一次创建不会覆盖已有） */
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

  async appendMessage(channelId: string, msg: ChannelMessageData): Promise<void> {
    await this.appendJsonl(this.messagesPath(channelId), msg);
  }

  /**
   * §4.2 发言层新鲜度检查：频道版本快照（messages.jsonl 原始行数 + 最后一行的消息 id）。
   * 读取失败（频道不存在等）返回空版本 —— 调用方按「无变化」处理，绝不阻断发言。
   */
  async getChannelVersion(channelId: string): Promise<{ lineCount: number; lastMessageId: string | null }> {
    try {
      const rows = await this.readJsonl<ChannelMessageRow>(this.messagesPath(channelId));
      return { lineCount: rows.length, lastMessageId: rows.length > 0 ? rows[rows.length - 1].id : null };
    } catch {
      return { lineCount: 0, lastMessageId: null };
    }
  }

  /**
   * §4.2: 读取 messages.jsonl 中从 fromLine（原始行数下标）之后追加的消息（过滤 tombstone）。
   * 与 getChannelVersion 的 lineCount 口径一致（同一 readJsonl 原始行数组）。
   */
  async getMessagesSinceLine(channelId: string, fromLine: number): Promise<ChannelMessageData[]> {
    try {
      const rows = await this.readJsonl<ChannelMessageRow>(this.messagesPath(channelId));
      const result: ChannelMessageData[] = [];
      for (const row of rows.slice(Math.max(0, fromLine))) {
        if (row.deleted) continue;
        const { deleted, ...rest } = row;
        result.push(rest);
      }
      return result;
    } catch {
      return [];
    }
  }

  /** 解析 JSONL，按 id 去重（最新条目生效），过滤已删除 */
  private resolveActiveMessages(channelId: string): Promise<ChannelMessageData[]> {
    return this.readJsonl<ChannelMessageRow>(this.messagesPath(channelId)).then(rows => {
      const latest = new Map<string, ChannelMessageRow>();
      for (const row of rows) {
        latest.set(row.id, row);
      }
      const active: ChannelMessageData[] = [];
      for (const msg of latest.values()) {
        if (!msg.deleted) {
          // 删除 deleted 字段以保持与 ChannelMessageData 类型一致
          const { deleted, ...rest } = msg;
          active.push(rest);
        }
      }
      return active;
    });
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
    const all = await this.readJsonl<ChannelMessageRow>(this.messagesPath(channelId));
    const msg = all.find(m => m.id === messageId && !m.deleted);
    if (!msg) throw new Error(`Message not found: ${messageId}`);
    // append tombstone
    const tombstone: ChannelMessageRow = {
      ...msg,
      deleted: true,
    };
    await this.appendJsonl(this.messagesPath(channelId), tombstone);
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
  // WorkUnit Event Sourcing
  // ═══════════════════════

  async appendEvent(event: WorkUnitEvent): Promise<void> {
    await this.appendJsonl(this.eventsPath, event);
  }

  /**
   * 读取 workunits/index.json 原始快照数组。
   * 文件不存在 → null（调用方按空处理）；存在但 JSON 撕裂/非数组 → 抛出带路径的错误。
   * 损坏绝不静默当空数组——防止后续基于空数组回写把全部已有快照抹掉。
   */
  private async readIndexFile(): Promise<WorkUnitSnapshot[] | null> {
    let content: string;
    try {
      content = await fs.promises.readFile(this.indexPath, 'utf-8');
    } catch (err: unknown) {
      if (isErrnoError(err) && err.code === 'ENOENT') return null;
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      throw new Error(
        `WorkUnit index corrupted (JSON parse failed): ${this.indexPath}` +
        `${err instanceof Error ? ` — ${err.message}` : ''}`
      );
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`WorkUnit index corrupted (not an array): ${this.indexPath}`);
    }
    return parsed as WorkUnitSnapshot[];
  }

  async getIndex(filter?: WorkUnitFilter): Promise<WorkUnitSnapshot[]> {
    const snapshots = (await this.readIndexFile()) ?? [];
    return applyFilter(snapshots, filter);
  }

  async claimWorkUnit(wuId: string, assigneeId: string): Promise<boolean> {
    return this.withLock(this.lockDir, async () => {
      // 读取当前 index（不存在 → 空；撕裂/损坏 → 抛错，不再幻影 "not found"）
      const snapshots = (await this.readIndexFile()) ?? [];

      const wu = snapshots.find(s => s.id === wuId);
      if (!wu || wu.status !== 'unassigned') {
        return false;
      }

      // append claim event
      const timestamp = new Date().toISOString();
      const claimEvent: WorkUnitEvent = {
        type: 'claimed',
        wuId,
        timestamp,
        data: {
          assigneeId,
          status: 'active',
          claimedAt: timestamp,
          updatedAt: timestamp,
        },
      };
      await this.appendJsonl(this.eventsPath, claimEvent);

      // update index snapshot
      const updated = snapshots.map(s =>
        s.id === wuId
          ? { ...s, assigneeId, status: 'active' as const, claimedAt: timestamp, updatedAt: timestamp }
          : s
      );
      await this.writeJson(this.indexPath, updated);

      return true;
    });
  }

  /**
   * Upsert a single WorkUnit snapshot in index.json.
   * 用于 service 层 create/update 后同步更新快照。
   * read-modify-write 全程持有 workunits flock（与 claimWorkUnit 同一把锁），
   * 跨进程并发写不会丢更新。
   */
  async upsertSnapshot(snapshot: WorkUnitSnapshot): Promise<void> {
    return this.withLock(this.lockDir, () => this.upsertSnapshotLocked(snapshot));
  }

  /**
   * upsertSnapshot 的无锁变体：仅供已持有 this.lockDir 的内部路径调用。
   * withLock（mkdir）不可重入，持锁方若调公共 upsertSnapshot 会自死锁。
   */
  private async upsertSnapshotLocked(snapshot: WorkUnitSnapshot): Promise<void> {
    // index 不存在 → 从空开始；撕裂/损坏 → 抛错，绝不基于空数组回写
    const snapshots = (await this.readIndexFile()) ?? [];
    const idx = snapshots.findIndex(s => s.id === snapshot.id);
    if (idx >= 0) {
      snapshots[idx] = snapshot;
    } else {
      snapshots.push(snapshot);
    }
    await this.writeJson(this.indexPath, snapshots);
  }

  /**
   * Remove a WorkUnit snapshot from index.json by id.
   * 用于 service 层 delete 后清理快照。
   * 与 upsertSnapshot 同一把 workunits flock。
   */
  async removeSnapshot(id: string): Promise<void> {
    return this.withLock(this.lockDir, () => this.removeSnapshotLocked(id));
  }

  /** removeSnapshot 的无锁变体：仅供已持有 this.lockDir 的内部路径调用 */
  private async removeSnapshotLocked(id: string): Promise<void> {
    // index 不存在 → nothing to remove；撕裂/损坏 → 抛错
    const snapshots = await this.readIndexFile();
    if (!snapshots) return;
    const filtered = snapshots.filter(s => s.id !== id);
    await this.writeJson(this.indexPath, filtered);
  }

  // ═══════════════════════
  // Requirement（REQ 需求编号体系, vision §5.3）
  // ═══════════════════════

  private get requirementsDir(): string {
    return path.join(this.baseDir, 'requirements');
  }

  private get requirementsLockDir(): string {
    return path.join(this.baseDir, 'requirements', 'lock');
  }

  private get requirementsIndexPath(): string {
    return path.join(this.baseDir, 'requirements', 'index.json');
  }

  private requirementPath(id: string): string {
    return path.join(this.requirementsDir, `${id}.json`);
  }

  /** 读取目录中现存 REQ 文件的 seq 集合（容错：文件名不规范的跳过） */
  private async listExistingRequirementSeqs(): Promise<number[]> {
    try {
      const entries = await fs.promises.readdir(this.requirementsDir, { withFileTypes: true });
      const seqs: number[] = [];
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const m = entry.name.match(/^REQ-(\d+)\.json$/);
        if (m) seqs.push(parseInt(m[1], 10));
      }
      return seqs;
    } catch (err: unknown) {
      if (isErrnoError(err) && err.code === 'ENOENT') return [];
      throw err;
    }
  }

  /**
   * 原子分配下一个需求序号（flock 保护，跨进程安全）。
   * index.json 缺失/损坏/落后时按现存文件恢复，保证 seq 唯一。
   */
  async allocateRequirementSeq(): Promise<number> {
    return this.withLock(this.requirementsLockDir, async () => {
      const index = await this.readJson<{ nextSeq: number }>(this.requirementsIndexPath);
      const fromIndex = index && Number.isInteger(index.nextSeq) && index.nextSeq > 0 ? index.nextSeq : 1;
      const existing = await this.listExistingRequirementSeqs();
      const seq = Math.max(fromIndex, existing.length > 0 ? Math.max(...existing) + 1 : 1);
      await this.writeJson(this.requirementsIndexPath, { nextSeq: seq + 1 });
      return seq;
    });
  }

  async createRequirement(data: RequirementData): Promise<void> {
    await this.writeJson(this.requirementPath(data.id), data);
  }

  /** 读取单个需求（容错：文件缺失/损坏/结构异常 → null） */
  async getRequirement(id: string): Promise<RequirementData | null> {
    const req = await this.readJson<RequirementData>(this.requirementPath(id));
    if (!req || typeof req.id !== 'string' || typeof req.seq !== 'number') return null;
    return req;
  }

  /** 列出需求（容错读：损坏文件跳过），按 seq 升序 */
  async listRequirements(filter?: RequirementFilter): Promise<RequirementData[]> {
    let entries: fs.Dirent[];
    try {
      await this.ensureDir(this.requirementsDir);
      entries = await this.readdirCached(this.requirementsDir);
    } catch (err: unknown) {
      if (isErrnoError(err) && err.code === 'ENOENT') return [];
      throw err;
    }
    const results = await Promise.all(entries.map(async entry => {
      if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name === 'index.json') return null;
      const req = await this.readJson<RequirementData>(path.join(this.requirementsDir, entry.name));
      if (!req || typeof req.id !== 'string' || typeof req.seq !== 'number') return null; // skip malformed
      if (filter?.status && req.status !== filter.status) return null;
      if (filter?.channelId && req.channelId !== filter.channelId) return null;
      return req;
    }));
    const requirements = results.filter((r): r is RequirementData => r !== null);
    requirements.sort((a, b) => a.seq - b.seq);
    return requirements;
  }

  /** 更新需求（id/seq 不可变）。不存在时抛错。 */
  async updateRequirement(id: string, patch: Partial<RequirementData>): Promise<RequirementData> {
    const existing = await this.getRequirement(id);
    if (!existing) throw new Error(`Requirement not found: ${id}`);
    const updated: RequirementData = { ...existing, ...patch, id: existing.id, seq: existing.seq };
    await this.writeJson(this.requirementPath(id), updated);
    return updated;
  }

  // ═══════════════════════
  // Evolution（E1 约束进化提案存储，复制 Requirement 模式）
  // ═══════════════════════

  private get evolutionDir(): string {
    return path.join(this.baseDir, 'evolution');
  }

  private get evolutionLockDir(): string {
    return path.join(this.baseDir, 'evolution', 'lock');
  }

  private get evolutionIndexPath(): string {
    return path.join(this.baseDir, 'evolution', 'index.json');
  }

  private evolutionProposalPath(id: string): string {
    return path.join(this.evolutionDir, `${id}.json`);
  }

  /** 读取目录中现存 EP 文件的 seq 集合（容错：文件名不规范的跳过） */
  private async listExistingEvolutionSeqs(): Promise<number[]> {
    try {
      const entries = await fs.promises.readdir(this.evolutionDir, { withFileTypes: true });
      const seqs: number[] = [];
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const m = entry.name.match(/^EP-(\d+)\.json$/);
        if (m) seqs.push(parseInt(m[1], 10));
      }
      return seqs;
    } catch (err: unknown) {
      if (isErrnoError(err) && err.code === 'ENOENT') return [];
      throw err;
    }
  }

  /**
   * 原子分配下一个进化提案序号（flock 保护，跨进程安全）。
   * index.json 缺失/损坏/落后时按现存文件恢复，保证 seq 唯一。
   */
  async allocateEvolutionSeq(): Promise<number> {
    return this.withLock(this.evolutionLockDir, async () => {
      const index = await this.readJson<{ nextSeq: number }>(this.evolutionIndexPath);
      const fromIndex = index && Number.isInteger(index.nextSeq) && index.nextSeq > 0 ? index.nextSeq : 1;
      const existing = await this.listExistingEvolutionSeqs();
      const seq = Math.max(fromIndex, existing.length > 0 ? Math.max(...existing) + 1 : 1);
      await this.writeJson(this.evolutionIndexPath, { nextSeq: seq + 1 });
      return seq;
    });
  }

  async createEvolutionProposal(data: EvolutionProposalData): Promise<void> {
    await this.writeJson(this.evolutionProposalPath(data.id), data);
  }

  /** 读取单个提案（容错：文件缺失/损坏/结构异常 → null） */
  async getEvolutionProposal(id: string): Promise<EvolutionProposalData | null> {
    const p = await this.readJson<EvolutionProposalData>(this.evolutionProposalPath(id));
    if (!p || typeof p.id !== 'string' || typeof p.seq !== 'number') return null;
    return p;
  }

  /** 列出提案（容错读：损坏文件跳过），按 seq 升序 */
  async listEvolutionProposals(filter?: EvolutionProposalFilter): Promise<EvolutionProposalData[]> {
    let entries: fs.Dirent[];
    try {
      await this.ensureDir(this.evolutionDir);
      entries = await this.readdirCached(this.evolutionDir);
    } catch (err: unknown) {
      if (isErrnoError(err) && err.code === 'ENOENT') return [];
      throw err;
    }
    const results = await Promise.all(entries.map(async entry => {
      if (!entry.isFile() || !/^EP-\d+\.json$/.test(entry.name)) return null;
      const p = await this.readJson<EvolutionProposalData>(path.join(this.evolutionDir, entry.name));
      if (!p || typeof p.id !== 'string' || typeof p.seq !== 'number') return null; // skip malformed
      if (filter?.status && p.status !== filter.status) return null;
      if (filter?.targetType && p.targetType !== filter.targetType) return null;
      return p;
    }));
    const proposals = results.filter((p): p is EvolutionProposalData => p !== null);
    proposals.sort((a, b) => a.seq - b.seq);
    return proposals;
  }

  /** 更新提案（id/seq 不可变）。不存在时抛错。 */
  async updateEvolutionProposal(id: string, patch: Partial<EvolutionProposalData>): Promise<EvolutionProposalData> {
    const existing = await this.getEvolutionProposal(id);
    if (!existing) throw new Error(`Evolution proposal not found: ${id}`);
    const updated: EvolutionProposalData = { ...existing, ...patch, id: existing.id, seq: existing.seq };
    await this.writeJson(this.evolutionProposalPath(id), updated);
    return updated;
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

  // ═══ 版本管理 ═══

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

// ─── 工具函数 ───

/**
 * F3: 容错解析「JSON 编码的字符串数组」字段（AgentProfile.channels / Channel.members）。
 * 历史写入 bug 曾把值二次 JSON 编码（"\"[\\\"id\\\"]\""），本函数最多解包 2 层编码；
 * 无法解析或不是字符串数组时返回 []。
 */
export function parseChannels(raw: unknown): string[] {
  let value: unknown = raw;
  for (let depth = 0; depth <= 2; depth++) {
    if (Array.isArray(value)) {
      return value.filter((v): v is string => typeof v === 'string');
    }
    if (typeof value !== 'string' || value.trim() === '') return [];
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * F3: 写入端归一化 — 接受 string[] 或（可能多次编码的）JSON 字符串，
 * 输出单层 JSON 编码，保证落盘的 channels/members 字段永远只有一层编码。
 */
export function stringifyChannels(raw: unknown): string {
  return JSON.stringify(parseChannels(raw));
}

function isErrnoError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

/**
 * REQ 需求编号格式化（vision §5.3）：seq → `REQ-<zero-padded>`（至少 4 位）。
 * formatRequirementId(42) === 'REQ-0042'
 */
export function formatRequirementId(seq: number): string {
  return `REQ-${String(seq).padStart(4, '0')}`;
}

/**
 * E1 约束进化提案编号格式化（vision §6）：seq → `EP-<zero-padded>`（至少 4 位）。
 * formatEvolutionId(42) === 'EP-0042'
 */
export function formatEvolutionId(seq: number): string {
  return `EP-${String(seq).padStart(4, '0')}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function applyFilter(snapshots: WorkUnitSnapshot[], filter?: WorkUnitFilter): WorkUnitSnapshot[] {
  if (!filter) return snapshots;
  return snapshots.filter(s => {
    if (filter.status && s.status !== filter.status) return false;
    if (filter.type && s.type !== filter.type) return false;
    if (filter.assigneeId && s.assigneeId !== filter.assigneeId) return false;
    if (filter.channelId && s.channelId !== filter.channelId) return false;
    return true;
  });
}

// ─── 通用 Markdown / Frontmatter ───

/**
 * 解析 markdown 文件的 YAML frontmatter。
 * 泛化版 parseSddFrontmatter：meta 使用 Record<string, unknown> 而非 SDD 专用类型。
 */
export function parseFrontmatter(content: string): { meta: Record<string, unknown>; body: string } | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return null;

  const yaml = match[1];
  const body = match[2].trim();
  const meta: Record<string, unknown> = {};

  for (const line of yaml.split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (!kv) continue;
    const [, key, val] = kv;

    // 数组：[a, b, c]
    if (val.startsWith('[') && val.endsWith(']')) {
      meta[key] = val.slice(1, -1)
        .split(',')
        .map(s => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    }
    // 数字
    else if (/^\d+$/.test(val)) {
      meta[key] = parseInt(val, 10);
    }
    // 字符串（去引号）
    else {
      meta[key] = val.replace(/^["']|["']$/g, '');
    }
  }

  return { meta, body };
}

/**
 * 序列化 meta + body 为 markdown 文件内容（含 YAML frontmatter）。
 */
export function serializeFrontmatter(meta: Record<string, unknown>, body: string): string {
  const lines: string[] = [];

  for (const [key, val] of Object.entries(meta)) {
    if (val === undefined || val === null) continue;
    if (Array.isArray(val)) {
      if (val.length > 0) {
        lines.push(`${key}: [${val.map(v => `"${String(v)}"`).join(', ')}]`);
      }
    } else if (typeof val === 'number') {
      lines.push(`${key}: ${val}`);
    } else {
      lines.push(`${key}: "${String(val)}"`);
    }
  }

  return `---\n${lines.join('\n')}\n---\n\n${body}`;
}
