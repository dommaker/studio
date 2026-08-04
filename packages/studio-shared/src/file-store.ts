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
 *
 * 本文件为门面：数据类型在 file-store-types.ts，JSON/锁原语在 file-store-base.ts，
 * WorkUnit 事件溯源在 file-store-workunit.ts，channels 编解码在 channels-codec.ts，
 * frontmatter 在 frontmatter.ts；全部符号在此 re-export，导出面不变。
 */

import fs from 'node:fs';
import path from 'node:path';
import { isErrnoError } from './file-store-base';
import { FileStoreWorkUnitBase } from './file-store-workunit';
import { stringifyChannels } from './channels-codec';
import { parseFrontmatter, serializeFrontmatter } from './frontmatter';
import type {
  AgentProfileData,
  RuntimeStateData,
  ChannelData,
  ChannelMessageData,
  ChannelMessageRow,
  QueryOpts,
  CountOpts,
  RequirementData,
  RequirementFilter,
  EvolutionProposalData,
  EvolutionProposalFilter,
} from './file-store-types';

// ─── re-export（保持原有导出面 100% 不变）───

export type {
  AgentProfileData,
  RuntimeStateData,
  ChannelData,
  ChannelMessageData,
  ChannelMessageRow,
  QueryOpts,
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
export { parseChannels, stringifyChannels } from './channels-codec';
export { parseFrontmatter, serializeFrontmatter } from './frontmatter';

// ─── FileStore 类 ───

export class FileStore extends FileStoreWorkUnitBase {

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
    const dir = path.join(this.baseDir, 'agents', id);
    try {
      await fs.promises.rm(dir, { recursive: true, force: true });
    } catch (err: unknown) {
      if (isErrnoError(err) && err.code === 'ENOENT') throw new Error(`AgentProfile not found: ${id}`);
      throw err;
    }
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

  /** 删除 RuntimeState（state.json）。保留同目录 profile.json。 */
  async deleteState(agentId: string): Promise<void> {
    const statePath = this.statePath(agentId);
    try {
      await fs.promises.unlink(statePath);
    } catch (err: unknown) {
      if (isErrnoError(err) && err.code === 'ENOENT') throw new Error(`RuntimeState not found for agent: ${agentId}`);
      throw err;
    }
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
    const dir = path.join(this.baseDir, 'channels', id);
    try {
      await fs.promises.rm(dir, { recursive: true, force: true });
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
      entries = await fs.promises.readdir(this.requirementsDir, { withFileTypes: true });
    } catch (err: unknown) {
      if (isErrnoError(err) && err.code === 'ENOENT') return [];
      throw err;
    }
    const requirements: RequirementData[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name === 'index.json') continue;
      const req = await this.readJson<RequirementData>(path.join(this.requirementsDir, entry.name));
      if (!req || typeof req.id !== 'string' || typeof req.seq !== 'number') continue; // skip malformed
      if (filter?.status && req.status !== filter.status) continue;
      if (filter?.channelId && req.channelId !== filter.channelId) continue;
      requirements.push(req);
    }
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
      entries = await fs.promises.readdir(this.evolutionDir, { withFileTypes: true });
    } catch (err: unknown) {
      if (isErrnoError(err) && err.code === 'ENOENT') return [];
      throw err;
    }
    const proposals: EvolutionProposalData[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/^EP-\d+\.json$/.test(entry.name)) continue;
      const p = await this.readJson<EvolutionProposalData>(path.join(this.evolutionDir, entry.name));
      if (!p || typeof p.id !== 'string' || typeof p.seq !== 'number') continue; // skip malformed
      if (filter?.status && p.status !== filter.status) continue;
      if (filter?.targetType && p.targetType !== filter.targetType) continue;
      proposals.push(p);
    }
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

  async queryIndex(dir: string, field: string, value: string): Promise<string[]> {
    try {
      const content = await fs.promises.readFile(path.join(dir, '_index.md'), 'utf-8');
      const headerLine = content.split('\n').find(l => l.startsWith('# filename|'));
      if (!headerLine) return [];
      const columns = headerLine.replace(/^#\s*/, '').split('|');
      const fieldIndex = columns.indexOf(field);
      if (fieldIndex === -1) return [];
      return content.split('\n').filter(l => l.trim() && !l.startsWith('#'))
        .filter(l => l.split('|')[fieldIndex] === value)
        .map(l => l.split('|')[0].replace(/\.md$/, ''));
    } catch (err: unknown) {
      if (isErrnoError(err) && err.code === 'ENOENT') return [];
      throw err;
    }
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

  async findByField(dir: string, field: string, value: string): Promise<string | null> {
    const results = await this.queryIndex(dir, field, value);
    return results.length > 0 ? results[0] : null;
  }

  // ═══ 版本管理 ═══

  async bumpVersion(dir: string, key: string, changeType: string, changeDesc: string): Promise<void> {
    const doc = await this.readDoc(dir, key);
    if (!doc) throw new Error(`Document not found: ${dir}/${key}`);
    const currentVersion = typeof doc.meta.version === 'number' ? doc.meta.version : 0;
    doc.meta.version = currentVersion + 1;
    doc.meta.changeType = changeType;
    doc.meta.changeDesc = changeDesc;
    doc.meta.updatedAt = new Date().toISOString();
    await this.writeDoc(dir, key, doc.meta, doc.body);
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
