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
export interface AgentProfileData {
    id: string;
    name: string;
    description: string | null;
    channels: string;
    status: string;
    provider: string | null;
    createdAt: string;
    updatedAt: string;
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
    status: string;
    currentWorkUnitId: string | null;
    startedAt: string;
    terminatedAt: string | null;
    lastHeartbeat: string | null;
    metadata: string | null;
    pid?: number;
    lastError?: string | null;
    lastErrorAt?: string | null;
}
export interface ChannelData {
    id: string;
    name: string;
    type: string;
    defaultWorkspaceId: string | null;
    defaultPath: string | null;
    discordChannelId: string | null;
    discordWebhookUrl: string | null;
    members: string;
    /** AC-6.1: 频道默认管线 AgentProfile name 数组。空数组=清除；undefined=未配置 */
    defaultPipeline?: string[];
    /** 决策 12: 无 @ 消息的默认认领角色（AgentProfile ID）。未配置（null/undefined）= 维持纯存储 */
    defaultProfileId?: string | null;
    createdAt: string;
    updatedAt: string;
}
export interface ChannelMessageData {
    id: string;
    channelId: string;
    workUnitId: string | null;
    authorType: string;
    agentName: string | null;
    content: string;
    replyToId: string | null;
    meta: string;
    createdAt: string;
}
/** 带删除标记的消息（JSONL tombstone） */
export interface ChannelMessageRow extends ChannelMessageData {
    deleted?: boolean;
}
export interface QueryOpts {
    workUnitId?: string;
    authorType?: string;
    since?: string;
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
    timestamp: string;
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
    workspaceId?: string | null;
    reqId?: string | null;
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
export type RequirementStatus = 'open' | 'in-progress' | 'done' | 'archived';
export interface RequirementData {
    id: string;
    seq: number;
    title: string;
    status: RequirementStatus;
    channelId?: string | null;
    createdAt: string;
    createdBy: string;
    docs?: string[];
    description?: string;
}
export interface RequirementFilter {
    status?: string;
    channelId?: string;
}
export type EvolutionTargetType = 'iron-law' | 'guideline' | 'prompt-template' | 'role-preset';
export type EvolutionProposalStatus = 'pending' | 'approved' | 'rejected' | 'applied';
export interface EvolutionProposalData {
    id: string;
    seq: number;
    targetType: EvolutionTargetType;
    targetId: string;
    action: 'add' | 'amend';
    /** 仅 iron-law/guideline：变更种类（message=改提示文案；exception=加例外；new-entry=新增约束条目） */
    constraintChange?: 'message' | 'exception' | 'new-entry';
    currentText: string;
    proposedText: string;
    rationale: string;
    evidence: {
        windowHours: number;
        eventCounts: Record<string, number>;
        samples?: string[];
    };
    status: EvolutionProposalStatus;
    source: string;
    createdAt: string;
    decidedBy?: string | null;
    decidedAt?: string | null;
    appliedAt?: string | null;
    rejectReason?: string | null;
}
export interface EvolutionProposalFilter {
    status?: string;
    targetType?: string;
}
/** 锁超时错误 */
export declare class LockTimeoutError extends Error {
    constructor(timeoutMs: number);
}
export declare class FileStore {
    private baseDir;
    constructor(baseDir?: string);
    /** 确保目录存在 */
    private ensureDir;
    /** 读取 JSON 文件，不存在或损坏返回 null */
    readJson<T>(filePath: string): Promise<T | null>;
    /**
     * 写入 JSON 文件（原子写）。
     * 同目录 tmp 文件 + rename（同分区 rename 原子），进程崩溃或并发读不会看到撕裂内容；
     * tmp 名含 pid + 随机串防并发冲突；rename 前 fsync 落盘；失败时清理 tmp。
     */
    writeJson(filePath: string, data: unknown): Promise<void>;
    /** 追加一行 JSONL */
    appendJsonl(filePath: string, data: unknown): Promise<void>;
    /** 写入全部 JSONL 行（覆盖） */
    writeJsonl(filePath: string, data: unknown[]): Promise<void>;
    /** 读取全部 JSONL 行（跳过解析失败的行） */
    readJsonl<T>(filePath: string): Promise<T[]>;
    /**
     * 基于 mkdir 原子性的跨进程文件锁。
     * 获取锁后执行 fn，释放锁后返回结果。
     * timeoutMs 为获取锁的超时时间。
     */
    withLock<T>(lockDir: string, fn: () => Promise<T>, timeoutMs?: number): Promise<T>;
    private get lockDir();
    private profilePath;
    private statePath;
    private channelConfigPath;
    private messagesPath;
    private get eventsPath();
    private get indexPath();
    private agentsDir;
    private channelsDir;
    getProfile(id: string): Promise<AgentProfileData | null>;
    listProfiles(filter?: {
        status?: string;
    }): Promise<AgentProfileData[]>;
    createProfile(data: AgentProfileData): Promise<void>;
    updateProfile(id: string, patch: Partial<AgentProfileData>): Promise<void>;
    deleteProfile(id: string): Promise<void>;
    /**
     * F3 一次性迁移：把所有 profile.json 的 channels 字段归一化为单层 JSON 编码
     * （修复历史双重编码 bug 的存量数据）。dryRun 时只统计不写盘。
     * 无法读取/非字符串 channels 的 profile 跳过（交给清洗脚本判定去留）。
     */
    migrateChannelsEncoding(opts?: {
        dryRun?: boolean;
    }): Promise<{
        scanned: number;
        rewritten: number;
    }>;
    getState(agentId: string): Promise<RuntimeStateData | null>;
    /** 列出所有 RuntimeState */
    listStates(): Promise<RuntimeStateData[]>;
    updateState(agentId: string, patch: Partial<RuntimeStateData>): Promise<void>;
    /** 删除 RuntimeState（state.json）。保留同目录 profile.json。 */
    deleteState(agentId: string): Promise<void>;
    /** 创建新的 RuntimeState（不是 upsert，确保第一次创建不会覆盖已有） */
    createState(agentId: string, data: RuntimeStateData): Promise<void>;
    getChannel(id: string): Promise<ChannelData | null>;
    listChannels(filter?: {
        name?: string;
        type?: string;
        excludeArchived?: boolean;
    }): Promise<ChannelData[]>;
    createChannel(data: ChannelData): Promise<void>;
    updateChannel(id: string, patch: Partial<ChannelData>): Promise<void>;
    deleteChannel(id: string): Promise<void>;
    appendMessage(channelId: string, msg: ChannelMessageData): Promise<void>;
    /**
     * §4.2 发言层新鲜度检查：频道版本快照（messages.jsonl 原始行数 + 最后一行的消息 id）。
     * 读取失败（频道不存在等）返回空版本 —— 调用方按「无变化」处理，绝不阻断发言。
     */
    getChannelVersion(channelId: string): Promise<{
        lineCount: number;
        lastMessageId: string | null;
    }>;
    /**
     * §4.2: 读取 messages.jsonl 中从 fromLine（原始行数下标）之后追加的消息（过滤 tombstone）。
     * 与 getChannelVersion 的 lineCount 口径一致（同一 readJsonl 原始行数组）。
     */
    getMessagesSinceLine(channelId: string, fromLine: number): Promise<ChannelMessageData[]>;
    /** 解析 JSONL，按 id 去重（最新条目生效），过滤已删除 */
    private resolveActiveMessages;
    queryMessages(channelId: string, opts?: QueryOpts): Promise<ChannelMessageData[]>;
    countMessages(channelId: string, opts?: CountOpts): Promise<number>;
    softDeleteMessage(channelId: string, messageId: string): Promise<void>;
    /**
     * 跨频道查询消息（扫描所有 channel 的 messages.jsonl）。
     * 支持按 workUnitId(s) 和 authorType 过滤。
     */
    queryAllMessages(filter?: {
        workUnitIds?: string[];
        workUnitId?: string;
        authorType?: string;
        agentName?: string;
        agentNames?: string[];
    }): Promise<ChannelMessageData[]>;
    /** 按全局 messageId 查找消息（跨频道扫描），返回消息及其所属 channelId */
    getMessageById(messageId: string): Promise<{
        channelId: string;
        message: ChannelMessageData;
    } | null>;
    appendEvent(event: WorkUnitEvent): Promise<void>;
    /**
     * 读取 workunits/index.json 原始快照数组。
     * 文件不存在 → null（调用方按空处理）；存在但 JSON 撕裂/非数组 → 抛出带路径的错误。
     * 损坏绝不静默当空数组——防止后续基于空数组回写把全部已有快照抹掉。
     */
    private readIndexFile;
    getIndex(filter?: WorkUnitFilter): Promise<WorkUnitSnapshot[]>;
    rebuildIndex(filter?: WorkUnitFilter): Promise<WorkUnitSnapshot[]>;
    claimWorkUnit(wuId: string, assigneeId: string): Promise<boolean>;
    /**
     * Upsert a single WorkUnit snapshot in index.json.
     * 用于 service 层 create/update 后同步更新快照。
     * read-modify-write 全程持有 workunits flock（与 claimWorkUnit 同一把锁），
     * 跨进程并发写不会丢更新。
     */
    upsertSnapshot(snapshot: WorkUnitSnapshot): Promise<void>;
    /**
     * upsertSnapshot 的无锁变体：仅供已持有 this.lockDir 的内部路径调用。
     * withLock（mkdir）不可重入，持锁方若调公共 upsertSnapshot 会自死锁。
     */
    private upsertSnapshotLocked;
    /**
     * Remove a WorkUnit snapshot from index.json by id.
     * 用于 service 层 delete 后清理快照。
     * 与 upsertSnapshot 同一把 workunits flock。
     */
    removeSnapshot(id: string): Promise<void>;
    /** removeSnapshot 的无锁变体：仅供已持有 this.lockDir 的内部路径调用 */
    private removeSnapshotLocked;
    private get requirementsDir();
    private get requirementsLockDir();
    private get requirementsIndexPath();
    private requirementPath;
    /** 读取目录中现存 REQ 文件的 seq 集合（容错：文件名不规范的跳过） */
    private listExistingRequirementSeqs;
    /**
     * 原子分配下一个需求序号（flock 保护，跨进程安全）。
     * index.json 缺失/损坏/落后时按现存文件恢复，保证 seq 唯一。
     */
    allocateRequirementSeq(): Promise<number>;
    createRequirement(data: RequirementData): Promise<void>;
    /** 读取单个需求（容错：文件缺失/损坏/结构异常 → null） */
    getRequirement(id: string): Promise<RequirementData | null>;
    /** 列出需求（容错读：损坏文件跳过），按 seq 升序 */
    listRequirements(filter?: RequirementFilter): Promise<RequirementData[]>;
    /** 更新需求（id/seq 不可变）。不存在时抛错。 */
    updateRequirement(id: string, patch: Partial<RequirementData>): Promise<RequirementData>;
    private get evolutionDir();
    private get evolutionLockDir();
    private get evolutionIndexPath();
    private evolutionProposalPath;
    /** 读取目录中现存 EP 文件的 seq 集合（容错：文件名不规范的跳过） */
    private listExistingEvolutionSeqs;
    /**
     * 原子分配下一个进化提案序号（flock 保护，跨进程安全）。
     * index.json 缺失/损坏/落后时按现存文件恢复，保证 seq 唯一。
     */
    allocateEvolutionSeq(): Promise<number>;
    createEvolutionProposal(data: EvolutionProposalData): Promise<void>;
    /** 读取单个提案（容错：文件缺失/损坏/结构异常 → null） */
    getEvolutionProposal(id: string): Promise<EvolutionProposalData | null>;
    /** 列出提案（容错读：损坏文件跳过），按 seq 升序 */
    listEvolutionProposals(filter?: EvolutionProposalFilter): Promise<EvolutionProposalData[]>;
    /** 更新提案（id/seq 不可变）。不存在时抛错。 */
    updateEvolutionProposal(id: string, patch: Partial<EvolutionProposalData>): Promise<EvolutionProposalData>;
    /**
     * 读取 markdown 文件，解析 frontmatter + body。
     * 文件不存在返回 null。
     */
    readDoc(dir: string, key: string): Promise<{
        meta: Record<string, unknown>;
        body: string;
    } | null>;
    /**
     * 写入 markdown 文件（含 YAML frontmatter）。
     * 目录不存在时自动创建。
     */
    writeDoc(dir: string, key: string, meta: Record<string, unknown>, body: string): Promise<void>;
    buildIndex(dir: string, fields: string[]): Promise<void>;
    queryIndex(dir: string, field: string, value: string): Promise<string[]>;
    listDocs(dir: string): Promise<string[]>;
    findByField(dir: string, field: string, value: string): Promise<string | null>;
    bumpVersion(dir: string, key: string, changeType: string, changeDesc: string): Promise<void>;
    appendChangelog(dir: string, key: string, entry: string): Promise<void>;
}
/**
 * F3: 容错解析「JSON 编码的字符串数组」字段（AgentProfile.channels / Channel.members）。
 * 历史写入 bug 曾把值二次 JSON 编码（"\"[\\\"id\\\"]\""），本函数最多解包 2 层编码；
 * 无法解析或不是字符串数组时返回 []。
 */
export declare function parseChannels(raw: unknown): string[];
/**
 * F3: 写入端归一化 — 接受 string[] 或（可能多次编码的）JSON 字符串，
 * 输出单层 JSON 编码，保证落盘的 channels/members 字段永远只有一层编码。
 */
export declare function stringifyChannels(raw: unknown): string;
/**
 * REQ 需求编号格式化（vision §5.3）：seq → `REQ-<zero-padded>`（至少 4 位）。
 * formatRequirementId(42) === 'REQ-0042'
 */
export declare function formatRequirementId(seq: number): string;
/**
 * E1 约束进化提案编号格式化（vision §6）：seq → `EP-<zero-padded>`（至少 4 位）。
 * formatEvolutionId(42) === 'EP-0042'
 */
export declare function formatEvolutionId(seq: number): string;
/**
 * 解析 markdown 文件的 YAML frontmatter。
 * 泛化版 parseSddFrontmatter：meta 使用 Record<string, unknown> 而非 SDD 专用类型。
 */
export declare function parseFrontmatter(content: string): {
    meta: Record<string, unknown>;
    body: string;
} | null;
/**
 * 序列化 meta + body 为 markdown 文件内容（含 YAML frontmatter）。
 */
export declare function serializeFrontmatter(meta: Record<string, unknown>, body: string): string;
//# sourceMappingURL=file-store.d.ts.map