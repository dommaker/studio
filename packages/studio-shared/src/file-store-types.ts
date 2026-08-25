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
  channels: string;        // JSON: Channel ID[] — @deprecated §9.5: channel.members 为成员关系唯一事实源；过渡期保留可读，新代码勿写入
  status: string;          // active | inactive
  provider: string | null; // bound CLI: claude | kimi | codex | opencode | openclaw | null
  createdAt: string;       // ISO 8601
  updatedAt: string;       // ISO 8601
  /** @deprecated §9.6 远程节点方向已放弃（2026-08）：字段仅为数据兼容保留，执行面恒为本地执行。 */
  nodeId?: string;
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

/** 频道消息分页查询选项（#319：before = 锚点消息 id 游标，不含锚点本身） */
export interface MessagePageOpts {
  before?: string;         // message id（替代原 timestamp 游标——同毫秒多条不漏不重）
  limit?: number;
}

/** 频道消息分页结果（messages 按 createdAt 升序；total = 锚点过滤后的总数） */
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
  /** #327: 关闭时刻（ISO 8601，可选——旧快照无此字段仍可加载）。频道消息归档的计龄锚点：
      仅 status=closed 时有值，reopen（closed→unassigned）清除为 null */
  closedAt?: string | null;
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
  /** 仅 iron-law/guideline：变更种类（message=改提示文案；exception=加例外；new-entry=新增约束条目；retire=退役既有 custom 条目，#82 D6 落 retired 元数据段） */
  constraintChange?: 'message' | 'exception' | 'new-entry' | 'retire';
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
