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
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ─── 类型定义 ───

export interface AgentProfileData {
  id: string;
  name: string;
  description: string | null;
  channels: string;        // JSON: Channel ID[]
  status: string;          // active | inactive
  provider: string | null; // bound CLI: claude | codex | opencode | openclaw | null
  createdAt: string;       // ISO 8601
  updatedAt: string;       // ISO 8601
}

export interface RuntimeStateData {
  id: string;
  roleId: string;
  sessionId: string | null;
  status: string;          // idle | active | terminated
  currentWorkUnitId: string | null;
  startedAt: string;       // ISO 8601
  terminatedAt: string | null;
  lastHeartbeat: string | null;
  metadata: string | null; // JSON
  pid?: number;            // process.pid for dead-instance detection
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

// ─── FileStore 类 ───

export class FileStore {
  private baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? path.join(os.homedir(), '.studio', 'data');
  }

  // ─── 内部工具方法 ───

  /** 确保目录存在 */
  private async ensureDir(dir: string): Promise<void> {
    await fs.promises.mkdir(dir, { recursive: true });
  }

  /** 读取 JSON 文件，不存在返回 null */
  private async readJson<T>(filePath: string): Promise<T | null> {
    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      return JSON.parse(content) as T;
    } catch (err: unknown) {
      if (isErrnoError(err) && err.code === 'ENOENT') return null;
      throw err;
    }
  }

  /** 写入 JSON 文件 */
  private async writeJson(filePath: string, data: unknown): Promise<void> {
    await this.ensureDir(path.dirname(filePath));
    await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  /** 追加一行 JSONL */
  private async appendJsonl(filePath: string, data: unknown): Promise<void> {
    await this.ensureDir(path.dirname(filePath));
    await fs.promises.appendFile(filePath, JSON.stringify(data) + '\n', 'utf-8');
  }

  /** 读取全部 JSONL 行 */
  private async readJsonl<T>(filePath: string): Promise<T[]> {
    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim().length > 0);
      return lines.map(l => JSON.parse(l) as T);
    } catch (err: unknown) {
      if (isErrnoError(err) && err.code === 'ENOENT') return [];
      throw err;
    }
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
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      const profiles: AgentProfileData[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const profile = await this.readJson<AgentProfileData>(this.profilePath(entry.name));
        if (profile && (!filter?.status || profile.status === filter.status)) {
          profiles.push(profile);
        }
      }
      return profiles;
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
    const filePath = this.profilePath(id);
    try {
      await fs.promises.unlink(filePath);
    } catch (err: unknown) {
      if (isErrnoError(err) && err.code === 'ENOENT') throw new Error(`AgentProfile not found: ${id}`);
      throw err;
    }
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
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      const states: RuntimeStateData[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const state = await this.readJson<RuntimeStateData>(this.statePath(entry.name));
        if (state) states.push(state);
      }
      return states;
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
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      const channels: ChannelData[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const ch = await this.readJson<ChannelData>(this.channelConfigPath(entry.name));
        if (ch) {
          if (filter?.name && ch.name !== filter.name) continue;
          if (filter?.type && ch.type !== filter.type) continue;
          if (filter?.excludeArchived && /-archived-\d+$/.test(ch.name)) continue;
          channels.push(ch);
        }
      }
      return channels;
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
    const dir = this.channelConfigPath(id);
    try {
      await fs.promises.unlink(dir);
    } catch (err: unknown) {
      if (isErrnoError(err) && err.code === 'ENOENT') throw new Error(`Channel not found: ${id}`);
      throw err;
    }
  }

  // ═══════════════════════
  // ChannelMessage (JSONL)
  // ═══════════════════════

  async appendMessage(channelId: string, msg: ChannelMessageData): Promise<void> {
    await this.appendJsonl(this.messagesPath(channelId), msg);
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
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const active = await this.resolveActiveMessages(entry.name);
        for (const msg of active) {
          if (filter?.workUnitId && msg.workUnitId !== filter.workUnitId) continue;
          if (filter?.workUnitIds && msg.workUnitId && !filter.workUnitIds.includes(msg.workUnitId)) continue;
          if (filter?.authorType && msg.authorType !== filter.authorType) continue;
          if (filter?.agentName && msg.agentName !== filter.agentName) continue;
          if (filter?.agentNames && msg.agentName && !filter.agentNames.includes(msg.agentName)) continue;
          result.push(msg);
        }
      }
    } catch {
      // channels dir 不存在 → 空结果
    }
    return result;
  }

  /** 按全局 messageId 查找消息（跨频道扫描），返回消息及其所属 channelId */
  async getMessageById(messageId: string): Promise<{ channelId: string; message: ChannelMessageData } | null> {
    const dir = this.channelsDir();
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const rows = await this.readJsonl<ChannelMessageRow>(this.messagesPath(entry.name));
        const latest = new Map<string, ChannelMessageRow>();
        for (const row of rows) latest.set(row.id, row);
        for (const msg of latest.values()) {
          if (msg.id === messageId && !msg.deleted) {
            const { deleted, ...rest } = msg;
            return { channelId: entry.name, message: rest };
          }
        }
      }
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

  async getIndex(filter?: WorkUnitFilter): Promise<WorkUnitSnapshot[]> {
    try {
      const snapshots = await this.readJson<WorkUnitSnapshot[]>(this.indexPath);
      if (!snapshots) return [];
      return applyFilter(snapshots, filter);
    } catch {
      // index 损坏则重建
      return this.rebuildIndex(filter);
    }
  }

  async rebuildIndex(filter?: WorkUnitFilter): Promise<WorkUnitSnapshot[]> {
    const events = await this.readJsonl<WorkUnitEvent>(this.eventsPath);
    const snapshotMap = new Map<string, WorkUnitSnapshot>();

    for (const event of events) {
      switch (event.type) {
        case 'created':
          snapshotMap.set(event.wuId, event.data as unknown as WorkUnitSnapshot);
          break;
        case 'claimed':
        case 'updated':
        case 'completed':
        case 'closed':
        case 'blocked': {
          const existing = snapshotMap.get(event.wuId);
          if (existing && event.data) {
            snapshotMap.set(event.wuId, { ...existing, ...event.data as Partial<WorkUnitSnapshot> } as WorkUnitSnapshot);
          }
          break;
        }
      }
    }

    const snapshots = Array.from(snapshotMap.values());

    // 写回 index.json
    await this.writeJson(this.indexPath, snapshots);

    return applyFilter(snapshots, filter);
  }

  async claimWorkUnit(wuId: string, assigneeId: string): Promise<boolean> {
    return this.withLock(this.lockDir, async () => {
      // 读取当前 index
      let snapshots: WorkUnitSnapshot[] = [];
      try {
        const loaded = await this.readJson<WorkUnitSnapshot[]>(this.indexPath);
        if (loaded) snapshots = loaded;
      } catch {
        // index 不存在或损坏，从 events 重建
        snapshots = await this.rebuildIndex();
      }

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
   */
  async upsertSnapshot(snapshot: WorkUnitSnapshot): Promise<void> {
    let snapshots: WorkUnitSnapshot[] = [];
    try {
      const loaded = await this.readJson<WorkUnitSnapshot[]>(this.indexPath);
      if (loaded) snapshots = loaded;
    } catch {
      // index 不存在或损坏，从 events 重建
      snapshots = await this.rebuildIndex();
    }
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
   */
  async removeSnapshot(id: string): Promise<void> {
    let snapshots: WorkUnitSnapshot[] = [];
    try {
      const loaded = await this.readJson<WorkUnitSnapshot[]>(this.indexPath);
      if (loaded) snapshots = loaded;
    } catch {
      // index 不存在或损坏 — nothing to remove
      return;
    }
    const filtered = snapshots.filter(s => s.id !== id);
    await this.writeJson(this.indexPath, filtered);
  }
}

// ─── 工具函数 ───

function isErrnoError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
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
