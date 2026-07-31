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
/** 锁超时错误 */
export class LockTimeoutError extends Error {
    constructor(timeoutMs) {
        super(`Lock acquisition timed out after ${timeoutMs}ms`);
        this.name = 'LockTimeoutError';
    }
}
// ─── 常量 ───
const LOCK_RETRY_INTERVAL_MS = 10;
const DEFAULT_LOCK_TIMEOUT_MS = 5000;
// ─── FileStore 类 ───
export class FileStore {
    baseDir;
    constructor(baseDir) {
        // CWD 陷阱修复：baseDir 解耦 HOME。
        // buildSessionEnv 把 claude CLI 子进程 HOME 设成 agentHome（GAP-2 隔离），
        // 子进程里 new FileStore() 无参构造时 os.homedir() 返回 agentHome，baseDir 漂移到
        // ~/.studio/data/agents/<profile-id>/.studio/data 产生嵌套。STUDIO_DATA_DIR env
        // 由 API server bootstrap 显式设置并经 buildSessionEnv 透传，提供绝对路径锚点。
        this.baseDir = baseDir ?? process.env.STUDIO_DATA_DIR ?? path.join(os.homedir(), '.studio', 'data');
    }
    // ─── 内部工具方法 ───
    /** 确保目录存在 */
    async ensureDir(dir) {
        await fs.promises.mkdir(dir, { recursive: true });
    }
    /** 读取 JSON 文件，不存在或损坏返回 null */
    async readJson(filePath) {
        try {
            const content = await fs.promises.readFile(filePath, 'utf-8');
            try {
                return JSON.parse(content);
            }
            catch {
                return null; // corrupt JSON → treat as missing
            }
        }
        catch (err) {
            if (isErrnoError(err) && err.code === 'ENOENT')
                return null;
            throw err;
        }
    }
    /**
     * 写入 JSON 文件（原子写）。
     * 同目录 tmp 文件 + rename（同分区 rename 原子），进程崩溃或并发读不会看到撕裂内容；
     * tmp 名含 pid + 随机串防并发冲突；rename 前 fsync 落盘；失败时清理 tmp。
     */
    async writeJson(filePath, data) {
        await this.ensureDir(path.dirname(filePath));
        const tmpPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
        try {
            const fh = await fs.promises.open(tmpPath, 'w');
            try {
                await fh.writeFile(JSON.stringify(data, null, 2), 'utf-8');
                await fh.sync();
            }
            finally {
                await fh.close();
            }
            await fs.promises.rename(tmpPath, filePath);
        }
        catch (err) {
            await fs.promises.unlink(tmpPath).catch(() => { });
            throw err;
        }
    }
    /** 追加一行 JSONL */
    async appendJsonl(filePath, data) {
        await this.ensureDir(path.dirname(filePath));
        await fs.promises.appendFile(filePath, JSON.stringify(data) + '\n', 'utf-8');
    }
    /** 写入全部 JSONL 行（覆盖） */
    async writeJsonl(filePath, data) {
        await this.ensureDir(path.dirname(filePath));
        const content = data.map(item => JSON.stringify(item)).join('\n') + (data.length > 0 ? '\n' : '');
        await fs.promises.writeFile(filePath, content, 'utf-8');
    }
    /** 读取全部 JSONL 行（跳过解析失败的行） */
    async readJsonl(filePath) {
        try {
            const content = await fs.promises.readFile(filePath, 'utf-8');
            const lines = content.split('\n').filter(l => l.trim().length > 0);
            const results = [];
            for (const line of lines) {
                try {
                    results.push(JSON.parse(line));
                }
                catch {
                    // skip corrupt lines
                }
            }
            return results;
        }
        catch (err) {
            if (isErrnoError(err) && err.code === 'ENOENT')
                return [];
            throw err;
        }
    }
    // ─── 文件锁 ───
    /**
     * 基于 mkdir 原子性的跨进程文件锁。
     * 获取锁后执行 fn，释放锁后返回结果。
     * timeoutMs 为获取锁的超时时间。
     */
    async withLock(lockDir, fn, timeoutMs = DEFAULT_LOCK_TIMEOUT_MS) {
        // 确保父目录存在，防止 mkdir 因 ENOENT 失败
        await fs.promises.mkdir(path.dirname(lockDir), { recursive: true });
        const start = Date.now();
        while (true) {
            try {
                // 原子性创建锁目录（没有 recursive，存在即失败）
                await fs.promises.mkdir(lockDir);
                break;
            }
            catch (err) {
                // EEXIST 是预期中的锁冲突，其他错误直接抛
                if (isErrnoError(err) && err.code !== 'EEXIST')
                    throw err;
                if (Date.now() - start > timeoutMs) {
                    throw new LockTimeoutError(timeoutMs);
                }
                await sleep(LOCK_RETRY_INTERVAL_MS);
            }
        }
        try {
            return await fn();
        }
        finally {
            await fs.promises.rmdir(lockDir).catch(() => { });
        }
    }
    get lockDir() {
        return path.join(this.baseDir, 'workunits', 'lock');
    }
    // ─── 路径生成 ───
    profilePath(id) {
        return path.join(this.baseDir, 'agents', id, 'profile.json');
    }
    statePath(agentId) {
        return path.join(this.baseDir, 'agents', agentId, 'state.json');
    }
    channelConfigPath(id) {
        return path.join(this.baseDir, 'channels', id, 'config.json');
    }
    messagesPath(channelId) {
        return path.join(this.baseDir, 'channels', channelId, 'messages.jsonl');
    }
    get eventsPath() {
        return path.join(this.baseDir, 'workunits', 'events.jsonl');
    }
    get indexPath() {
        return path.join(this.baseDir, 'workunits', 'index.json');
    }
    agentsDir() {
        return path.join(this.baseDir, 'agents');
    }
    channelsDir() {
        return path.join(this.baseDir, 'channels');
    }
    // ═══════════════════════
    // AgentProfile
    // ═══════════════════════
    async getProfile(id) {
        return this.readJson(this.profilePath(id));
    }
    async listProfiles(filter) {
        const dir = this.agentsDir();
        try {
            await fs.promises.mkdir(dir, { recursive: true });
            const entries = await fs.promises.readdir(dir, { withFileTypes: true });
            const profiles = [];
            for (const entry of entries) {
                if (!entry.isDirectory())
                    continue;
                const profile = await this.readJson(this.profilePath(entry.name));
                if (profile && (!filter?.status || profile.status === filter.status)) {
                    profiles.push(profile);
                }
            }
            return profiles;
        }
        catch (err) {
            if (isErrnoError(err) && err.code === 'ENOENT')
                return [];
            throw err;
        }
    }
    async createProfile(data) {
        await this.writeJson(this.profilePath(data.id), data);
    }
    async updateProfile(id, patch) {
        const existing = await this.getProfile(id);
        if (!existing)
            throw new Error(`AgentProfile not found: ${id}`);
        await this.writeJson(this.profilePath(id), {
            ...existing,
            ...patch,
            updatedAt: new Date().toISOString(),
        });
    }
    async deleteProfile(id) {
        const dir = path.join(this.baseDir, 'agents', id);
        try {
            await fs.promises.rm(dir, { recursive: true, force: true });
        }
        catch (err) {
            if (isErrnoError(err) && err.code === 'ENOENT')
                throw new Error(`AgentProfile not found: ${id}`);
            throw err;
        }
    }
    /**
     * F3 一次性迁移：把所有 profile.json 的 channels 字段归一化为单层 JSON 编码
     * （修复历史双重编码 bug 的存量数据）。dryRun 时只统计不写盘。
     * 无法读取/非字符串 channels 的 profile 跳过（交给清洗脚本判定去留）。
     */
    async migrateChannelsEncoding(opts) {
        const dir = this.agentsDir();
        let scanned = 0;
        let rewritten = 0;
        let entries;
        try {
            entries = await fs.promises.readdir(dir, { withFileTypes: true });
        }
        catch (err) {
            if (isErrnoError(err) && err.code === 'ENOENT')
                return { scanned, rewritten };
            throw err;
        }
        for (const entry of entries) {
            if (!entry.isDirectory())
                continue;
            const profile = await this.readJson(this.profilePath(entry.name));
            if (!profile || typeof profile.channels !== 'string')
                continue;
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
    async getState(agentId) {
        return this.readJson(this.statePath(agentId));
    }
    /** 列出所有 RuntimeState */
    async listStates() {
        const dir = this.agentsDir();
        try {
            await fs.promises.mkdir(dir, { recursive: true });
            const entries = await fs.promises.readdir(dir, { withFileTypes: true });
            const states = [];
            for (const entry of entries) {
                if (!entry.isDirectory())
                    continue;
                const state = await this.readJson(this.statePath(entry.name));
                if (state)
                    states.push(state);
            }
            return states;
        }
        catch (err) {
            if (isErrnoError(err) && err.code === 'ENOENT')
                return [];
            throw err;
        }
    }
    async updateState(agentId, patch) {
        const existing = await this.getState(agentId);
        if (!existing)
            throw new Error(`RuntimeState not found for agent: ${agentId}`);
        await this.writeJson(this.statePath(agentId), { ...existing, ...patch });
    }
    /** 删除 RuntimeState（state.json）。保留同目录 profile.json。 */
    async deleteState(agentId) {
        const statePath = this.statePath(agentId);
        try {
            await fs.promises.unlink(statePath);
        }
        catch (err) {
            if (isErrnoError(err) && err.code === 'ENOENT')
                throw new Error(`RuntimeState not found for agent: ${agentId}`);
            throw err;
        }
    }
    /** 创建新的 RuntimeState（不是 upsert，确保第一次创建不会覆盖已有） */
    async createState(agentId, data) {
        const statePath = this.statePath(agentId);
        await this.ensureDir(path.dirname(statePath));
        // 检查文件是否已存在
        try {
            await fs.promises.access(statePath, fs.constants.F_OK);
            throw new Error(`RuntimeState already exists for agent: ${agentId}`);
        }
        catch (err) {
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
    async getChannel(id) {
        return this.readJson(this.channelConfigPath(id));
    }
    async listChannels(filter) {
        const dir = this.channelsDir();
        try {
            await fs.promises.mkdir(dir, { recursive: true });
            const entries = await fs.promises.readdir(dir, { withFileTypes: true });
            const channels = [];
            for (const entry of entries) {
                if (!entry.isDirectory())
                    continue;
                const ch = await this.readJson(this.channelConfigPath(entry.name));
                if (ch) {
                    if (filter?.name && ch.name !== filter.name)
                        continue;
                    if (filter?.type && ch.type !== filter.type)
                        continue;
                    if (filter?.excludeArchived && /-archived-\d+$/.test(ch.name))
                        continue;
                    channels.push(ch);
                }
            }
            return channels;
        }
        catch (err) {
            if (isErrnoError(err) && err.code === 'ENOENT')
                return [];
            throw err;
        }
    }
    async createChannel(data) {
        await this.writeJson(this.channelConfigPath(data.id), data);
    }
    async updateChannel(id, patch) {
        const existing = await this.getChannel(id);
        if (!existing)
            throw new Error(`Channel not found: ${id}`);
        await this.writeJson(this.channelConfigPath(id), {
            ...existing,
            ...patch,
            updatedAt: new Date().toISOString(),
        });
    }
    async deleteChannel(id) {
        const dir = path.join(this.baseDir, 'channels', id);
        try {
            await fs.promises.rm(dir, { recursive: true, force: true });
        }
        catch (err) {
            if (isErrnoError(err) && err.code === 'ENOENT')
                throw new Error(`Channel not found: ${id}`);
            throw err;
        }
    }
    // ═══════════════════════
    // ChannelMessage (JSONL)
    // ═══════════════════════
    async appendMessage(channelId, msg) {
        await this.appendJsonl(this.messagesPath(channelId), msg);
    }
    /**
     * §4.2 发言层新鲜度检查：频道版本快照（messages.jsonl 原始行数 + 最后一行的消息 id）。
     * 读取失败（频道不存在等）返回空版本 —— 调用方按「无变化」处理，绝不阻断发言。
     */
    async getChannelVersion(channelId) {
        try {
            const rows = await this.readJsonl(this.messagesPath(channelId));
            return { lineCount: rows.length, lastMessageId: rows.length > 0 ? rows[rows.length - 1].id : null };
        }
        catch {
            return { lineCount: 0, lastMessageId: null };
        }
    }
    /**
     * §4.2: 读取 messages.jsonl 中从 fromLine（原始行数下标）之后追加的消息（过滤 tombstone）。
     * 与 getChannelVersion 的 lineCount 口径一致（同一 readJsonl 原始行数组）。
     */
    async getMessagesSinceLine(channelId, fromLine) {
        try {
            const rows = await this.readJsonl(this.messagesPath(channelId));
            const result = [];
            for (const row of rows.slice(Math.max(0, fromLine))) {
                if (row.deleted)
                    continue;
                const { deleted, ...rest } = row;
                result.push(rest);
            }
            return result;
        }
        catch {
            return [];
        }
    }
    /** 解析 JSONL，按 id 去重（最新条目生效），过滤已删除 */
    resolveActiveMessages(channelId) {
        return this.readJsonl(this.messagesPath(channelId)).then(rows => {
            const latest = new Map();
            for (const row of rows) {
                latest.set(row.id, row);
            }
            const active = [];
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
    async queryMessages(channelId, opts) {
        const resolved = await this.resolveActiveMessages(channelId);
        let filtered = resolved;
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
    async countMessages(channelId, opts) {
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
    async softDeleteMessage(channelId, messageId) {
        const all = await this.readJsonl(this.messagesPath(channelId));
        const msg = all.find(m => m.id === messageId && !m.deleted);
        if (!msg)
            throw new Error(`Message not found: ${messageId}`);
        // append tombstone
        const tombstone = {
            ...msg,
            deleted: true,
        };
        await this.appendJsonl(this.messagesPath(channelId), tombstone);
    }
    /**
     * 跨频道查询消息（扫描所有 channel 的 messages.jsonl）。
     * 支持按 workUnitId(s) 和 authorType 过滤。
     */
    async queryAllMessages(filter) {
        const result = [];
        const dir = this.channelsDir();
        try {
            const entries = await fs.promises.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory())
                    continue;
                const active = await this.resolveActiveMessages(entry.name);
                for (const msg of active) {
                    if (filter?.workUnitId && msg.workUnitId !== filter.workUnitId)
                        continue;
                    if (filter?.workUnitIds && msg.workUnitId && !filter.workUnitIds.includes(msg.workUnitId))
                        continue;
                    if (filter?.authorType && msg.authorType !== filter.authorType)
                        continue;
                    if (filter?.agentName && msg.agentName !== filter.agentName)
                        continue;
                    if (filter?.agentNames && msg.agentName && !filter.agentNames.includes(msg.agentName))
                        continue;
                    result.push(msg);
                }
            }
        }
        catch {
            // channels dir 不存在 → 空结果
        }
        return result;
    }
    /** 按全局 messageId 查找消息（跨频道扫描），返回消息及其所属 channelId */
    async getMessageById(messageId) {
        const dir = this.channelsDir();
        try {
            const entries = await fs.promises.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory())
                    continue;
                const rows = await this.readJsonl(this.messagesPath(entry.name));
                const latest = new Map();
                for (const row of rows)
                    latest.set(row.id, row);
                for (const msg of latest.values()) {
                    if (msg.id === messageId && !msg.deleted) {
                        const { deleted, ...rest } = msg;
                        return { channelId: entry.name, message: rest };
                    }
                }
            }
        }
        catch {
            // channels dir 不存在 → 无消息
        }
        return null;
    }
    // ═══════════════════════
    // WorkUnit Event Sourcing
    // ═══════════════════════
    async appendEvent(event) {
        await this.appendJsonl(this.eventsPath, event);
    }
    /**
     * 读取 workunits/index.json 原始快照数组。
     * 文件不存在 → null（调用方按空处理）；存在但 JSON 撕裂/非数组 → 抛出带路径的错误。
     * 损坏绝不静默当空数组——防止后续基于空数组回写把全部已有快照抹掉。
     */
    async readIndexFile() {
        let content;
        try {
            content = await fs.promises.readFile(this.indexPath, 'utf-8');
        }
        catch (err) {
            if (isErrnoError(err) && err.code === 'ENOENT')
                return null;
            throw err;
        }
        let parsed;
        try {
            parsed = JSON.parse(content);
        }
        catch (err) {
            throw new Error(`WorkUnit index corrupted (JSON parse failed): ${this.indexPath}` +
                `${err instanceof Error ? ` — ${err.message}` : ''}`);
        }
        if (!Array.isArray(parsed)) {
            throw new Error(`WorkUnit index corrupted (not an array): ${this.indexPath}`);
        }
        return parsed;
    }
    async getIndex(filter) {
        const snapshots = (await this.readIndexFile()) ?? [];
        return applyFilter(snapshots, filter);
    }
    async rebuildIndex(filter) {
        const events = await this.readJsonl(this.eventsPath);
        const snapshotMap = new Map();
        for (const event of events) {
            switch (event.type) {
                case 'created':
                    snapshotMap.set(event.wuId, event.data);
                    break;
                case 'claimed':
                case 'updated':
                case 'completed':
                case 'closed':
                case 'blocked': {
                    const existing = snapshotMap.get(event.wuId);
                    if (existing && event.data) {
                        snapshotMap.set(event.wuId, { ...existing, ...event.data });
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
    async claimWorkUnit(wuId, assigneeId) {
        return this.withLock(this.lockDir, async () => {
            // 读取当前 index（不存在 → 空；撕裂/损坏 → 抛错，不再幻影 "not found"）
            const snapshots = (await this.readIndexFile()) ?? [];
            const wu = snapshots.find(s => s.id === wuId);
            if (!wu || wu.status !== 'unassigned') {
                return false;
            }
            // append claim event
            const timestamp = new Date().toISOString();
            const claimEvent = {
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
            const updated = snapshots.map(s => s.id === wuId
                ? { ...s, assigneeId, status: 'active', claimedAt: timestamp, updatedAt: timestamp }
                : s);
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
    async upsertSnapshot(snapshot) {
        return this.withLock(this.lockDir, () => this.upsertSnapshotLocked(snapshot));
    }
    /**
     * upsertSnapshot 的无锁变体：仅供已持有 this.lockDir 的内部路径调用。
     * withLock（mkdir）不可重入，持锁方若调公共 upsertSnapshot 会自死锁。
     */
    async upsertSnapshotLocked(snapshot) {
        // index 不存在 → 从空开始；撕裂/损坏 → 抛错，绝不基于空数组回写
        const snapshots = (await this.readIndexFile()) ?? [];
        const idx = snapshots.findIndex(s => s.id === snapshot.id);
        if (idx >= 0) {
            snapshots[idx] = snapshot;
        }
        else {
            snapshots.push(snapshot);
        }
        await this.writeJson(this.indexPath, snapshots);
    }
    /**
     * Remove a WorkUnit snapshot from index.json by id.
     * 用于 service 层 delete 后清理快照。
     * 与 upsertSnapshot 同一把 workunits flock。
     */
    async removeSnapshot(id) {
        return this.withLock(this.lockDir, () => this.removeSnapshotLocked(id));
    }
    /** removeSnapshot 的无锁变体：仅供已持有 this.lockDir 的内部路径调用 */
    async removeSnapshotLocked(id) {
        // index 不存在 → nothing to remove；撕裂/损坏 → 抛错
        const snapshots = await this.readIndexFile();
        if (!snapshots)
            return;
        const filtered = snapshots.filter(s => s.id !== id);
        await this.writeJson(this.indexPath, filtered);
    }
    // ═══════════════════════
    // Requirement（REQ 需求编号体系, vision §5.3）
    // ═══════════════════════
    get requirementsDir() {
        return path.join(this.baseDir, 'requirements');
    }
    get requirementsLockDir() {
        return path.join(this.baseDir, 'requirements', 'lock');
    }
    get requirementsIndexPath() {
        return path.join(this.baseDir, 'requirements', 'index.json');
    }
    requirementPath(id) {
        return path.join(this.requirementsDir, `${id}.json`);
    }
    /** 读取目录中现存 REQ 文件的 seq 集合（容错：文件名不规范的跳过） */
    async listExistingRequirementSeqs() {
        try {
            const entries = await fs.promises.readdir(this.requirementsDir, { withFileTypes: true });
            const seqs = [];
            for (const entry of entries) {
                if (!entry.isFile())
                    continue;
                const m = entry.name.match(/^REQ-(\d+)\.json$/);
                if (m)
                    seqs.push(parseInt(m[1], 10));
            }
            return seqs;
        }
        catch (err) {
            if (isErrnoError(err) && err.code === 'ENOENT')
                return [];
            throw err;
        }
    }
    /**
     * 原子分配下一个需求序号（flock 保护，跨进程安全）。
     * index.json 缺失/损坏/落后时按现存文件恢复，保证 seq 唯一。
     */
    async allocateRequirementSeq() {
        return this.withLock(this.requirementsLockDir, async () => {
            const index = await this.readJson(this.requirementsIndexPath);
            const fromIndex = index && Number.isInteger(index.nextSeq) && index.nextSeq > 0 ? index.nextSeq : 1;
            const existing = await this.listExistingRequirementSeqs();
            const seq = Math.max(fromIndex, existing.length > 0 ? Math.max(...existing) + 1 : 1);
            await this.writeJson(this.requirementsIndexPath, { nextSeq: seq + 1 });
            return seq;
        });
    }
    async createRequirement(data) {
        await this.writeJson(this.requirementPath(data.id), data);
    }
    /** 读取单个需求（容错：文件缺失/损坏/结构异常 → null） */
    async getRequirement(id) {
        const req = await this.readJson(this.requirementPath(id));
        if (!req || typeof req.id !== 'string' || typeof req.seq !== 'number')
            return null;
        return req;
    }
    /** 列出需求（容错读：损坏文件跳过），按 seq 升序 */
    async listRequirements(filter) {
        let entries;
        try {
            await this.ensureDir(this.requirementsDir);
            entries = await fs.promises.readdir(this.requirementsDir, { withFileTypes: true });
        }
        catch (err) {
            if (isErrnoError(err) && err.code === 'ENOENT')
                return [];
            throw err;
        }
        const requirements = [];
        for (const entry of entries) {
            if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name === 'index.json')
                continue;
            const req = await this.readJson(path.join(this.requirementsDir, entry.name));
            if (!req || typeof req.id !== 'string' || typeof req.seq !== 'number')
                continue; // skip malformed
            if (filter?.status && req.status !== filter.status)
                continue;
            if (filter?.channelId && req.channelId !== filter.channelId)
                continue;
            requirements.push(req);
        }
        requirements.sort((a, b) => a.seq - b.seq);
        return requirements;
    }
    /** 更新需求（id/seq 不可变）。不存在时抛错。 */
    async updateRequirement(id, patch) {
        const existing = await this.getRequirement(id);
        if (!existing)
            throw new Error(`Requirement not found: ${id}`);
        const updated = { ...existing, ...patch, id: existing.id, seq: existing.seq };
        await this.writeJson(this.requirementPath(id), updated);
        return updated;
    }
    // ═══════════════════════
    // Evolution（E1 约束进化提案存储，复制 Requirement 模式）
    // ═══════════════════════
    get evolutionDir() {
        return path.join(this.baseDir, 'evolution');
    }
    get evolutionLockDir() {
        return path.join(this.baseDir, 'evolution', 'lock');
    }
    get evolutionIndexPath() {
        return path.join(this.baseDir, 'evolution', 'index.json');
    }
    evolutionProposalPath(id) {
        return path.join(this.evolutionDir, `${id}.json`);
    }
    /** 读取目录中现存 EP 文件的 seq 集合（容错：文件名不规范的跳过） */
    async listExistingEvolutionSeqs() {
        try {
            const entries = await fs.promises.readdir(this.evolutionDir, { withFileTypes: true });
            const seqs = [];
            for (const entry of entries) {
                if (!entry.isFile())
                    continue;
                const m = entry.name.match(/^EP-(\d+)\.json$/);
                if (m)
                    seqs.push(parseInt(m[1], 10));
            }
            return seqs;
        }
        catch (err) {
            if (isErrnoError(err) && err.code === 'ENOENT')
                return [];
            throw err;
        }
    }
    /**
     * 原子分配下一个进化提案序号（flock 保护，跨进程安全）。
     * index.json 缺失/损坏/落后时按现存文件恢复，保证 seq 唯一。
     */
    async allocateEvolutionSeq() {
        return this.withLock(this.evolutionLockDir, async () => {
            const index = await this.readJson(this.evolutionIndexPath);
            const fromIndex = index && Number.isInteger(index.nextSeq) && index.nextSeq > 0 ? index.nextSeq : 1;
            const existing = await this.listExistingEvolutionSeqs();
            const seq = Math.max(fromIndex, existing.length > 0 ? Math.max(...existing) + 1 : 1);
            await this.writeJson(this.evolutionIndexPath, { nextSeq: seq + 1 });
            return seq;
        });
    }
    async createEvolutionProposal(data) {
        await this.writeJson(this.evolutionProposalPath(data.id), data);
    }
    /** 读取单个提案（容错：文件缺失/损坏/结构异常 → null） */
    async getEvolutionProposal(id) {
        const p = await this.readJson(this.evolutionProposalPath(id));
        if (!p || typeof p.id !== 'string' || typeof p.seq !== 'number')
            return null;
        return p;
    }
    /** 列出提案（容错读：损坏文件跳过），按 seq 升序 */
    async listEvolutionProposals(filter) {
        let entries;
        try {
            await this.ensureDir(this.evolutionDir);
            entries = await fs.promises.readdir(this.evolutionDir, { withFileTypes: true });
        }
        catch (err) {
            if (isErrnoError(err) && err.code === 'ENOENT')
                return [];
            throw err;
        }
        const proposals = [];
        for (const entry of entries) {
            if (!entry.isFile() || !/^EP-\d+\.json$/.test(entry.name))
                continue;
            const p = await this.readJson(path.join(this.evolutionDir, entry.name));
            if (!p || typeof p.id !== 'string' || typeof p.seq !== 'number')
                continue; // skip malformed
            if (filter?.status && p.status !== filter.status)
                continue;
            if (filter?.targetType && p.targetType !== filter.targetType)
                continue;
            proposals.push(p);
        }
        proposals.sort((a, b) => a.seq - b.seq);
        return proposals;
    }
    /** 更新提案（id/seq 不可变）。不存在时抛错。 */
    async updateEvolutionProposal(id, patch) {
        const existing = await this.getEvolutionProposal(id);
        if (!existing)
            throw new Error(`Evolution proposal not found: ${id}`);
        const updated = { ...existing, ...patch, id: existing.id, seq: existing.seq };
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
    async readDoc(dir, key) {
        const filePath = path.join(dir, `${key}.md`);
        try {
            const content = await fs.promises.readFile(filePath, 'utf-8');
            const parsed = parseFrontmatter(content);
            // 无 frontmatter fence → 整文件视为 body，meta 为空
            if (!parsed)
                return { meta: {}, body: content.trim() };
            return parsed;
        }
        catch (err) {
            if (isErrnoError(err) && err.code === 'ENOENT')
                return null;
            throw err;
        }
    }
    /**
     * 写入 markdown 文件（含 YAML frontmatter）。
     * 目录不存在时自动创建。
     */
    async writeDoc(dir, key, meta, body) {
        const filePath = path.join(dir, `${key}.md`);
        await this.ensureDir(path.dirname(filePath));
        const content = serializeFrontmatter(meta, body);
        await fs.promises.writeFile(filePath, content, 'utf-8');
    }
    // ═══ 索引管理 ═══
    async buildIndex(dir, fields) {
        await this.ensureDir(dir);
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        const mdFiles = entries.filter(e => e.isFile() && e.name.endsWith('.md') && e.name !== '_index.md').map(e => e.name);
        const header = `# Directory Index\n# Auto-generated\n# Total: ${mdFiles.length} entries\n#\n# filename|${fields.join('|')}`;
        const dataLines = [];
        for (const filename of mdFiles) {
            const doc = await this.readDoc(dir, filename.replace(/\.md$/, ''));
            const values = fields.map(f => {
                const v = doc?.meta[f];
                if (v === undefined || v === null)
                    return '';
                if (Array.isArray(v))
                    return v.join(';');
                return String(v);
            });
            dataLines.push(`${filename}|${values.join('|')}`);
        }
        await fs.promises.writeFile(path.join(dir, '_index.md'), header + '\n' + dataLines.join('\n') + '\n', 'utf-8');
    }
    async queryIndex(dir, field, value) {
        try {
            const content = await fs.promises.readFile(path.join(dir, '_index.md'), 'utf-8');
            const headerLine = content.split('\n').find(l => l.startsWith('# filename|'));
            if (!headerLine)
                return [];
            const columns = headerLine.replace(/^#\s*/, '').split('|');
            const fieldIndex = columns.indexOf(field);
            if (fieldIndex === -1)
                return [];
            return content.split('\n').filter(l => l.trim() && !l.startsWith('#'))
                .filter(l => l.split('|')[fieldIndex] === value)
                .map(l => l.split('|')[0].replace(/\.md$/, ''));
        }
        catch (err) {
            if (isErrnoError(err) && err.code === 'ENOENT')
                return [];
            throw err;
        }
    }
    async listDocs(dir) {
        try {
            const content = await fs.promises.readFile(path.join(dir, '_index.md'), 'utf-8');
            return content.split('\n').filter(l => l.trim() && !l.startsWith('#'))
                .map(l => l.split('|')[0].replace(/\.md$/, ''));
        }
        catch (err) {
            if (isErrnoError(err) && err.code === 'ENOENT') {
                try {
                    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
                    return entries.filter(e => e.isFile() && e.name.endsWith('.md') && e.name !== '_index.md')
                        .map(e => e.name.replace(/\.md$/, ''));
                }
                catch {
                    return [];
                }
            }
            throw err;
        }
    }
    async findByField(dir, field, value) {
        const results = await this.queryIndex(dir, field, value);
        return results.length > 0 ? results[0] : null;
    }
    // ═══ 版本管理 ═══
    async bumpVersion(dir, key, changeType, changeDesc) {
        const doc = await this.readDoc(dir, key);
        if (!doc)
            throw new Error(`Document not found: ${dir}/${key}`);
        const currentVersion = typeof doc.meta.version === 'number' ? doc.meta.version : 0;
        doc.meta.version = currentVersion + 1;
        doc.meta.changeType = changeType;
        doc.meta.changeDesc = changeDesc;
        doc.meta.updatedAt = new Date().toISOString();
        await this.writeDoc(dir, key, doc.meta, doc.body);
    }
    async appendChangelog(dir, key, entry) {
        const changelogDir = path.join(dir, key);
        await this.ensureDir(changelogDir);
        const filePath = path.join(changelogDir, 'CHANGELOG.md');
        const newEntry = `\n## ${new Date().toISOString()}\n\n${entry}\n`;
        try {
            const existing = await fs.promises.readFile(filePath, 'utf-8');
            await fs.promises.writeFile(filePath, existing + newEntry, 'utf-8');
        }
        catch (err) {
            if (isErrnoError(err) && err.code === 'ENOENT') {
                await fs.promises.writeFile(filePath, `# CHANGELOG\n${newEntry}`, 'utf-8');
            }
            else {
                throw err;
            }
        }
    }
}
// ─── 工具函数 ───
/**
 * F3: 容错解析「JSON 编码的字符串数组」字段（AgentProfile.channels / Channel.members）。
 * 历史写入 bug 曾把值二次 JSON 编码（"\"[\\\"id\\\"]\""），本函数最多解包 2 层编码；
 * 无法解析或不是字符串数组时返回 []。
 */
export function parseChannels(raw) {
    let value = raw;
    for (let depth = 0; depth <= 2; depth++) {
        if (Array.isArray(value)) {
            return value.filter((v) => typeof v === 'string');
        }
        if (typeof value !== 'string' || value.trim() === '')
            return [];
        try {
            value = JSON.parse(value);
        }
        catch {
            return [];
        }
    }
    return [];
}
/**
 * F3: 写入端归一化 — 接受 string[] 或（可能多次编码的）JSON 字符串，
 * 输出单层 JSON 编码，保证落盘的 channels/members 字段永远只有一层编码。
 */
export function stringifyChannels(raw) {
    return JSON.stringify(parseChannels(raw));
}
function isErrnoError(err) {
    return err instanceof Error && 'code' in err;
}
/**
 * REQ 需求编号格式化（vision §5.3）：seq → `REQ-<zero-padded>`（至少 4 位）。
 * formatRequirementId(42) === 'REQ-0042'
 */
export function formatRequirementId(seq) {
    return `REQ-${String(seq).padStart(4, '0')}`;
}
/**
 * E1 约束进化提案编号格式化（vision §6）：seq → `EP-<zero-padded>`（至少 4 位）。
 * formatEvolutionId(42) === 'EP-0042'
 */
export function formatEvolutionId(seq) {
    return `EP-${String(seq).padStart(4, '0')}`;
}
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
function applyFilter(snapshots, filter) {
    if (!filter)
        return snapshots;
    return snapshots.filter(s => {
        if (filter.status && s.status !== filter.status)
            return false;
        if (filter.type && s.type !== filter.type)
            return false;
        if (filter.assigneeId && s.assigneeId !== filter.assigneeId)
            return false;
        if (filter.channelId && s.channelId !== filter.channelId)
            return false;
        return true;
    });
}
// ─── 通用 Markdown / Frontmatter ───
/**
 * 解析 markdown 文件的 YAML frontmatter。
 * 泛化版 parseSddFrontmatter：meta 使用 Record<string, unknown> 而非 SDD 专用类型。
 */
export function parseFrontmatter(content) {
    const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!match)
        return null;
    const yaml = match[1];
    const body = match[2].trim();
    const meta = {};
    for (const line of yaml.split('\n')) {
        const kv = line.match(/^(\w+):\s*(.+)$/);
        if (!kv)
            continue;
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
export function serializeFrontmatter(meta, body) {
    const lines = [];
    for (const [key, val] of Object.entries(meta)) {
        if (val === undefined || val === null)
            continue;
        if (Array.isArray(val)) {
            if (val.length > 0) {
                lines.push(`${key}: [${val.map(v => `"${String(v)}"`).join(', ')}]`);
            }
        }
        else if (typeof val === 'number') {
            lines.push(`${key}: ${val}`);
        }
        else {
            lines.push(`${key}: "${String(val)}"`);
        }
    }
    return `---\n${lines.join('\n')}\n---\n\n${body}`;
}
//# sourceMappingURL=file-store.js.map