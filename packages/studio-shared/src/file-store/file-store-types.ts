/**
 * file-store 数据类型定义（从 file-store.ts 抽出）
 *
 * FileStore 各域（Agent/Channel/WorkUnit/Requirement/Evolution）的落盘数据模型，
 * 以及 REQ/EP 编号格式化。门面 file-store.ts 全量 re-export，导出面不变。
 */

// ─── 类型定义 ───

export interface AgentProfileData {
  id: string;
  name: string;
  description: string | null;
  channels: string;        // JSON: Channel ID[] — @deprecated §9.5: channel.members 为成员关系唯一事实源；写侧已停（B4，2026-09-27），读侧兼容链随 #696 验收后退役（2026-10-11），字段仅为历史数据残留保留
  status: string;          // active | inactive
  provider: string | null; // bound CLI: claude | kimi | codex | opencode | openclaw | null
  createdAt: string;       // ISO 8601
  updatedAt: string;       // ISO 8601
  /** 决策 9: 显式职能域（阶段词表，见 domain-vocab.ts）。创建时可从 .agents/roles/*.yaml 预设带入 */
  acceptedTypes?: string[];
  /** 决策 13: 角色自述（prompt「## 你的角色」段内容）；缺省回退 description */
  persona?: string;
  /** #91: 角色 preset 带入的 skill 声明（.agents/roles/*.yaml），prompt「## 你的角色」段消费 */
  skills?: string[];
  /** #91: 角色 preset 带入的工具声明，prompt「## 你的角色」段消费 */
  tools?: string[];
  /** #91: 角色 preset 带入的约束声明（键值对），prompt「## 你的角色」段消费 */
  constraints?: Record<string, unknown>;
  /**
   * #631: 角色种类——system=系统内置角色（不可停用/删除，list 默认排除），user=用户角色。
   * additive 字段：新写入必带；历史无字段记录由 isSystemRole 按 name==='studio' 兜底一次。
   */
  kind?: 'system' | 'user';
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
  /** #362: 更新统一口径②——updateState 自动补（历史数据缺省）。ISO 8601 */
  updatedAt?: string;
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
  /**
   * #466: 频道级「阶段→角色」路由表（plan/implement/review → AgentProfile ID）。
   * 未配置（undefined）或某档为空（null）= 该阶段回池涌现；配置了但角色 inactive/被移出频道
   * → 回池涌现 + 频道出声提醒（解析语义见 channels/routing.ts）。
   * defaultPipeline（AC-6.1，name 数组）已吞并迁移进 routing.implement；
   * 启动迁移（原 channels/migrate-routing.ts）已随存量消化退役（B6，2026-09-27）。
   */
  routing?: { plan?: string | null; implement?: string | null; review?: string | null };
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
  since?: string;          // ISO 8601，createdAt >= since
  before?: string;         // ISO 8601，createdAt < before（#576：倒序翻页游标，与 since 互补）
  limit?: number;
}

/** 频道消息分页查询选项（#319：before = 锚点消息 id 游标，不含锚点本身） */
export interface MessagePageOpts {
  before?: string;         // message id（替代原 timestamp 游标——同毫秒多条不漏不重）
  limit?: number;
  includeTotal?: boolean;  // #525 P2-4：缺省 false 完全跳过冷/热行数统计，total 恒 0；要总数的调用方显式开口
}

/** 频道消息分页结果（messages 按 createdAt 升序；total = 锚点过滤后的总数，includeTotal 未开启时 total 恒 0） */
export interface MessagePage {
  messages: ChannelMessageData[];
  total: number;
  hasMore: boolean;
}

/** 频道消息写侧压实阈值（#319；测试注入小阈值，生产用默认） */
export interface MessageCompactionOptions {
  checkInterval?: number;  // 每 N 次 append 评估一次
  minLines?: number;       // 总行数下限
  deadRatio?: number;      // 死行占比下限（0~1）
}

/** 频道消息生命周期归档配置（#327；测试注入小阈值/固定 now，生产用默认） */
export interface MessageArchiveOptions {
  maxAgeDays?: number;     // 超龄判据：计龄锚点距今 ≥ N 天即归档（默认 30）
  now?: () => Date;        // 计龄基准时刻（测试注入固定值）
}

export type WorkUnitEventType = 'created' | 'claimed' | 'updated' | 'completed' | 'closed' | 'blocked';

export type AssignmentStatus = 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'superseded' | 'cancelled';

export interface AssignmentProgress {
  step: number;
  action: string;
  summary: string;
  at: string;
}

export interface AssignmentEvidence {
  level: string;
  verdict: string;
  at: string;
}

/** #714：已呈现 prompt 段的内容 revision；真实 CLI session 身份由所属 Assignment 绑定。 */
export type PresentedContextCursor = Record<string, string>;

/** WU 的一次执行轮次；历史保存在 WU 事件流中，不放进开放 metadata。 */
export interface AssignmentRecord {
  id: string;
  workUnitId: string;
  attempt: number;
  previousAssignmentId: string | null;
  status: AssignmentStatus;
  reason: 'claim' | 'retry' | 'recovery' | 'need-input-reply' | 'session-replacement';
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  waitingAt?: string;
  endedAt?: string;
  provider?: string;
  sessionId?: string;
  cliSessionId?: string;
  /** #714：最后成功呈现的段 revision；仅允许同 cliSessionId 的 linked Assignment 继承。 */
  presentedContext?: PresentedContextCursor;
  worktreePath?: string;
  worktreeBranch?: string;
  lastError?: string;
  tokenCount: number;
  transcriptCount: number;
  progress: AssignmentProgress[];
  evidence: AssignmentEvidence[];
}

export interface StepAcProgress {
  ac: string;
  status: 'pending' | 'in_progress' | 'completed';
  note?: string;
}

export interface StepCommandRecord {
  command: string;
  status: 'passed' | 'failed' | 'unknown';
}

export interface StepVerificationRecord {
  status: 'passed' | 'failed';
  commands: string[];
  at: string;
}

/** Agent 可报告的执行详情；id、步号、Assignment 与时间由服务端写入。 */
export interface StepRecordDetails {
  acProgress?: StepAcProgress[];
  modifiedFiles?: string[];
  commands?: StepCommandRecord[];
  verification?: StepVerificationRecord | null;
  decisions?: string[];
  artifacts?: string[];
  nextStep?: string;
  transcriptRefs?: string[];
}

/** #711：一个执行步的结构化工作记录；只能追加，随 WU 事件流持久化。 */
export interface StepRecord extends Required<Omit<StepRecordDetails, 'verification' | 'nextStep'>> {
  id: string;
  workUnitId: string;
  assignmentId: string;
  step: number;
  action: string;
  result: string;
  at: string;
  verification: StepVerificationRecord | null;
  nextStep: string | null;
}

export type MandatePrincipalType = 'Operator' | 'System';

export interface MandatePrincipal {
  id: string;
  type: MandatePrincipalType;
}

export interface MandateSource {
  kind: 'channel' | 'api' | 'derived' | 'system';
  channelId?: string;
  messageId?: string;
  parentWorkUnitId?: string;
}

export interface MandateHistoryEntry {
  revision: number;
  action: 'issued' | 'expanded' | 'reauthorized' | 'revoked';
  actor: MandatePrincipal;
  at: string;
  reason?: string;
}

/** WU 的长期授权事实；随 WU 事件流持久化，不放进开放 metadata。 */
export interface MandateRecord {
  workUnitId: string;
  revision: number;
  policyVersion: '1';
  requestedBy: MandatePrincipal;
  grantedBy: MandatePrincipal;
  grantedAt: string;
  source: MandateSource;
  reqId: string | null;
  pmoId: string | null;
  repositories: Array<{ repo: string; leg: string | null }>;
  deliveryActions: Array<'merge' | 'deliver' | 'mark-delivered'>;
  budget: { tokens: number | null; planSteps: number | null };
  expansionPrincipals: MandatePrincipal[];
  history: MandateHistoryEntry[];
  revokedAt?: string;
  revokedBy?: MandatePrincipal;
  revokeReason?: string;
}

export type EffectStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'needs_reconciliation';

/** #707：提交后执行的持久副作用意图；随所属 WU 的同一事件提交落盘。 */
export interface EffectRecord {
  id: string;
  workUnitId: string;
  kind: 'review-dispatch' | 'merge' | 'external-reply' | 'knowledge-extraction';
  idempotencyKey: string;
  /** #709：external-reply 等副作用的执行载荷；随意图一起持久化。 */
  payload?: Record<string, unknown>;
  trigger: 'automatic' | 'manual';
  status: EffectStatus;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
  nextAttemptAt?: string;
  startedAt?: string;
  lastError?: string;
}

/** #707：Effect 的终局或重试回执；恢复核查结果也留在同一 WU 事件流。 */
export interface EffectReceipt {
  id: string;
  effectId: string;
  idempotencyKey: string;
  outcome: 'succeeded' | 'retrying' | 'failed' | 'cancelled';
  at: string;
  attempts: number;
  result?: Record<string, unknown>;
  error?: string;
  recovery?: 'queued-restarted' | 'running-reconciled' | 'revocation';
}

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
  assigneeRoleId?: string | null;  // 认领时冗余的认领方 roleId 快照（可选 — 旧事件/快照无此字段仍可加载）
  metadata: string | null;
  createdAt: string;
  updatedAt: string;
  claimedAt: string | null;
  completedAt: string | null;
  /** #706：长期授权是 WU 的 typed 内部事实；旧事件缺省为无 Mandate。 */
  mandate?: MandateRecord;
  /** #705：执行轮次是 WU 的 typed 内部历史；旧事件缺省为无 Assignment。 */
  currentAssignmentId?: string | null;
  assignments?: AssignmentRecord[];
  /** #711：逐步结构化事实与 Assignment 同事务追加；旧事件缺省为空。 */
  stepRecords?: StepRecord[];
  /** #707：副作用意图与回执随 WU 同一事件流提交；旧事件缺省为空。 */
  effects?: EffectRecord[];
  effectReceipts?: EffectReceipt[];
  /** #327: 关闭时刻（ISO 8601，可选——旧快照无此字段仍可加载）。频道消息归档的计龄锚点：
      仅 status=closed 时有值，reopen（closed→unassigned）清除为 null */
  closedAt?: string | null;
}

export interface WorkUnitFilter {
  id?: string;
  status?: string;
  /** 多状态 OR；与 status/其他字段按 AND 组合。空数组不匹配任何行。 */
  statuses?: readonly string[];
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
/** stale：pending/approved 超期未审（TTL，#602 D2）惰性转 stale，不再阻塞同目标新提案 */
export type EvolutionProposalStatus = 'pending' | 'approved' | 'rejected' | 'applied' | 'stale';

export interface EvolutionProposalData {
  id: string;                 // EP-<zero-padded seq>，如 EP-0042
  seq: number;                // 递增序号（flock 原子分配）
  targetType: EvolutionTargetType;
  targetId: string;           // 约束 id | prompt templateId | role 名（.agents/roles/<name>.yaml）
  action: 'add' | 'amend';    // add=新增条目（或 shadow 覆盖内置约束）；amend=修改既有条目
  /** 仅 iron-law/guideline：变更种类，收敛到 config.yml 装得下的唯二动作（M3.2，
   *  docs/plans/2026-09-flywheel-e1-remediation.md）——retire=退役（enabled:false +
   *  retired 墓碑 + 知识条目，走 harness constraints retire）；disable=临时停用
   *  （enabled:false 无墓碑）。message/exception/new-entry 无生效落点已删除（harness
   *  1.10.0 ADR-0029 关停文本注入层、ADR-0005 删例外机制），存量历史提案落笔前拒绝。 */
  constraintChange?: 'retire' | 'disable';
  currentText: string;        // 当前文本（add 时可为空串）
  proposedText: string;       // 提案文本（message/模板/persona 全量替换内容）
  rationale: string;          // 理由（含预期效果）
  evidence: {                 // 证据（事件计数/样例）
    windowHours: number;
    eventCounts: Record<string, number>;
    samples?: string[];
  };
  status: EvolutionProposalStatus;
  // 历史数据可能含 'harness-autoEvolve'（0.17.0 已删除 autoEvolve，ADR-0001 决策 8），
  // 该值仅为兼容存量记录保留，新提案不再产生此 source。
  source: string;             // 'harness-autoEvolve' | 'heuristic:prompt-failure' | 'heuristic:role-failure'
  createdAt: string;          // ISO 8601
  decidedBy?: string | null;  // 'channel' | 'api:<user>' 等
  decidedAt?: string | null;
  appliedAt?: string | null;
  rejectReason?: string | null;
  staledAt?: string | null;   // 超期未审转 stale 的时间（#602 D2）
}

export interface EvolutionProposalFilter {
  status?: string;
  targetType?: string;
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
