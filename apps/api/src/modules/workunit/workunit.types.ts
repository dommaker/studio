/**
 * WorkUnit 类型契约 + 状态机表/超时常量（工单 30 自 workunit.service.ts 头部抽出，纯搬运零逻辑变更）。
 * 内容：WorkUnitMetadata / 输入输出 DTO / VALID_TRANSITIONS（+ #108 按 type 覆盖表 DECISION_SPEC_TYPES/TYPE_VALID_TRANSITIONS）/ 超时常量 / ANALYSIS_TASKS_MAX / resolveClaimTimeoutAt。
 * 零服务依赖（仅 wu-metadata 叶子），供 service 与跨模块类型级消费方直接引用。
 */

import type { WuAttestations } from '@dommaker/studio-shared';
import { parseWuMetadata } from './wu-metadata.js';

/** Metadata JSON schema — fields that don't warrant first-class columns */
export interface WorkUnitMetadata {
  files?: string[];              // 文件路径列表（文件冲突检查用）
  priority?: 'low' | 'normal' | 'high' | 'critical';
  createdBy?: string;
  description?: string;       // 从 WorkUnit.description 降级
  constraints?: string;       // 从 WorkUnit.constraints 降级
  context?: string;           // 从 WorkUnit.context 降级
  planVersion?: number;       // 从 WorkUnit.planVersion 降级
  planReasoning?: string;     // 从 WorkUnit.planReasoning 降级
  error?: string;             // 从 WorkUnit.error 降级
  input?: string;             // 从 WorkUnit.input 降级
  output?: string;            // 从 WorkUnit.output 降级
  goalId?: string;            // 从 WorkUnit.goalId 降级（Phase 3 迁移）
  title?: string;             // 从 WorkUnit.title 降级（Phase 3 迁移）
  _consecutiveReviewRejections?: number;  // 连续 review reject 计数（3x → auto-block）
  sourceMessageId?: string;   // createFromMessage 涌现路径来源
  creationMode?: string;      // 创建模式：from-message / manual
  _cumulativeTokens?: number; // 内部 token 累计追踪
  // Agent Loop session 追踪（AS-025 Agent Loop 重写）
  sessionId?: string;         // 当前关联的 Claude session
  stepCount?: number;         // 已执行步骤数
  startedAt?: string;         // 首次执行时间
  consecutiveStuck?: number;  // 连续无进展步数
  sessionResumes?: number;    // session 恢复次数
  sessionCount?: number;      // B5（2026-08-03 token-burn issue）：本 WU 已建立的独立会话数（≥2 转人工，防全文重放烧钱）
  lastSessionResumed?: boolean; // #94: 本步会话续用(true)/新建(false) 标记（内部状态，不上频道）
  blockReason?: string;       // B4（同上 P0-2）：最近一次转 blocked 的原因（恢复执行时清除，防事后无法诊断）
  testWorkUnitGuard?: boolean; // B2（同上 P0-1c）：测试特征 WU 被 daemon 守卫关闭的留痕
  lastInputTokens?: number;   // 最新一次 execution 的 input_tokens (cache 追踪)
  // F5 双向沟通：NEED_INPUT 挂起/恢复状态
  waitingForInput?: boolean;  // NEED_INPUT 挂起中（status=blocked，等待人类回复）
  waitingQuestion?: string;   // agent 提出的问题
  waitingSince?: string;      // 挂起时间 ISO 8601（超时提醒据此计算）
  waitingReminded?: boolean;  // 本次挂起已提醒过（每次挂起只提醒一次，恢复时重置）
  waitingReason?: string;     // 挂起原因：'ownership' = B3a 等待工程归属（缺省 = agent 提问）
  pendingReplies?: string[];  // 恢复后待注入下一轮 prompt 的人类回复（多条拼接，消费后清除）
  // B3a 工程归属链（决策 D2）：归属解析结果落档
  workspaceRoot?: string;     // 直接可用的工程根路径（Requirement→PMO gitRepo / 人工回复绑定；agent-loop 优先于 workspaceId 消费）
  ownershipSource?: string;   // 归属来源：explicit / requirement / channel-default / none / human-reply
  // 2026-08 归因统一：pmoId 是 canonical 创建期 PMO 归因戳（message-routing / project.service /
  // analysis-handoff 创建时落档；pmo-branch-resolver 与证据归属过滤的唯一直读 key）
  pmoId?: string;
  // #110（T4，#106 子票）：decision 单与探路地图 fog 条目的关联戳（T6 开图机制建单时落档；
  // pmo/decision-resolution 订阅器按 metadata.pmoId 找 PMO、按 fogId 定位 map.fog[] 条目）
  fogId?: string;
  ownershipProjectId?: string; // @deprecated legacy 同位名（原 B3a 审计字段），仅读兼容——wu-pmo-attribution 同级回退读；新写入一律用 pmoId
  // #109（T3，#106 子票）：接单规则机制化——依赖与验收标准
  blockedBy?: string[];       // 阻塞本 WU 的 WU id 列表（可跨 PMO）；任一未了结（非 done/closed）→ unassigned 对所有 loop 不可见（wu-dependencies.ts 判定；agent-loop observe 过滤 + 列表 claimable 标记消费）
  ac?: string[];              // 验收标准（验收闸对照用；机制只存不解释）
  // B3b-i 每 WU worktree 隔离（决策 D1）：代码类 WU 首个 step 创建并落档，后续 step 复用
  worktreePath?: string;      // 专属 worktree 路径（<worktreesDir>/wu-<wuId>；执行 cwd + 提交守卫 + 自动验证的消费点）
  worktreeBranch?: string;    // 专属分支名（task/<wuId>）
  worktreeBaseBranch?: string; // 创建时的 base 分支（origin/HEAD→main→master 探测；PMO-b：归属 PMO 时为 PMO 分支）
  worktreeBaseRepo?: string;  // 共享 git 仓库根（worktree 的母仓库）
  // PMO-b（决策 3）：WU 归属 PMO 的集成分支（agent-loop 首 step 落档；
  // 非空时 merge-on-review-pass 合到 PMO 分支的集成交合 worktree，而非 baseRepo 当前分支）
  pmoBranch?: string;
  // @deprecated 2026-08 归因统一：pmoProjectId 已移出解析链、agent-loop 不再落档
  // （原为 pmoBranch 同批的冗余缓存，生产存量为零）；归属项目 id 经 resolvePmoProjectIdForWU 重解析
  pmoProjectId?: string;
  // B3b-i COMPLETE 前自动验证（决策 D3 前半，约定优先可覆盖）
  verifyCommands?: string[];  // 覆盖验证命令（优先级高于 package.json scripts 约定；workspace 记录同名字段次之）
  verifyReport?: {            // 最近一次全绿的验证摘要（COMPLETE 接受前写入）
    commands: string[];
    source: 'override' | 'convention';
    passedAt: string;
  };
  verifyFailCount?: number;   // 自动验证连续失败计数（≥3 → blocked）
  verifyFailHint?: string;    // 验证失败提示（失败命令+输出尾部，注入下一轮 prompt 后清除）
  // B3b-ii 评审通过后自动合并（决策 D1/D3 后半，merge-on-review-pass.ts）
  mergedAt?: string;          // task 分支合并回 base 分支完成时间 ISO 8601（防重哨兵：存在即跳过合并）
  mergeCommit?: string;       // 合并后 baseRepo HEAD（merge commit 全哈希）
  mergeConflict?: boolean;    // 自动合并（含 rebase 重试）仍冲突，已转人工（WU 置 blocked）
  conflictFiles?: string[];   // 合并冲突文件清单（diff-filter=U）
  knowledgeExtractedAt?: string; // R3: 会话知识提取已触达时间戳（去重——同一 WorkUnit 只提取一次）
  matchedSkills?: string[];   // 决策 7: step 时域匹配命中并实际注入的 skill 名（agent-loop 落盘，度量用）
  lastCommitHash?: string;    // §10.5: PROGRESS 无提交监视 — 上次观察到的 worktree HEAD
  noCommitSteps?: number;     // §10.5: 连续无新提交步数（满 3 步频道提醒一次并归零）
  commitGuardHint?: string;   // §10.5: COMPLETE 被提交守卫打回时的提示（注入下一轮 prompt 后清除）
  // A2A 协作（2026-07-agent-to-agent-collab-design §5）
  collab?: {                  // 协作树追踪（DELEGATE 派生的 WU 携带；根 WU 首次委派后补记）
    rootId: string;           // 协作树根 WU id
    depth: number;            // 根=0，每跳 +1；上限见 §4.2（P1: 1）
    chain: string[];          // profile id 谱系（含自己），环检测输入 —— 必须用 profile id（§1.2-b）
    delegatedBy?: { profileId: string; workUnitId: string };  // 派出方（根 WU 无）
    delegationCount: number;  // 本 WU 已派出的子任务数（宽度上限输入）
  };
  childGuardHint?: string;    // §6-2 父 complete 守卫：存在未完结子 WU 被打回时的提示（注入下一轮 prompt 后清除）
  freshnessInterrupts?: number; // §4.2 发言层新鲜度检查：结果回帖被「房间已变」连续拦截次数（≥2 后照发并归零）
  // P0 修复（W-3 接线）：CLI 执行失败记录（agentStep success===false 显式分支写入，成功执行后清除）
  errorType?: string;         // 最近一次执行失败类型（如 execution_failed）
  errorDetail?: string;       // 最近一次执行失败详情（截断 500 字符）
  errorAt?: string;           // 最近一次执行失败时间 ISO 8601
  // P0 修复（WU 超时机制）：claim 写入 timeoutAt 列；metadata.timeoutAt 显式值优先于按 type 的默认时长
  timeoutAt?: string;         // 显式超时刻 ISO 8601（claim 时优先于默认时长）
  timeoutReleasedAt?: string; // 最近一次超时释放时间 ISO 8601
  timeoutReleaseCount?: number; // 超时释放次数（≥3 → blocked，不再自动回池）
  // 2026-07 PMO-flow UX（§4 terminate 语义修正）：AgentInstanceService.terminate 强制释放留痕
  manualRelease?: boolean;    // 强制停止实例后 WU 被置 blocked 转人工（blockForManualRelease 写入）
  manualReleaseReason?: string; // 强制释放原因（如 terminate instance <id>）
  /** AC-4.5: reviewer 角色 complete 时写入，ReviewDispatcher 据此调 reviewPassed/reviewRejected */
  reviewReport?: {
    approved: boolean;
    reason?: string;
    issues?: Array<{ severity: string; message: string }>;
  };
  // PMO 分析接力（analysis-handoff）：analysis WU COMPLETE 时 agent-loop 解析 TASK: 行落档；
  // 人工确认（reviewPassed → done）后由 analysis-handoff 据此建未指派 task 子 WU 派工
  analysisTasks?: string[];       // TASK: 拆分行解析结果（≤8 条，每条 ≤300 字符）
  analysisTasksSpawnedAt?: string; // 子 WU 已建时间戳（幂等哨兵：存在即不再重复派生）
  traceId?: string;           // P0 修复 6: 链路追踪 id（频道消息 req → WU → agent-loop 日志；与 audit requestId 同值）
  // F4 reviewer 解锚（2026-07-28 分析文档，决策 5）：评审 WU 未指派走 claim 涌现时的约束/标记
  excludeAssignee?: string;   // 禁止认领的 profile id（评审排除实现者；agent-loop observe 未指派过滤据此剔除）
  selfReview?: boolean;       // 本评审 WU 未排除实现者（频道内无其他 active 成员）→ 可能是自评，台账/提醒据此标记
  reviewInput?: { mode: string; skill: string };  // R3: 评审输入契约落档（diff-only + code-review），审计用
  // F6 信任证据模型（决策 1）：分层证据台账，l1 自动验证 / l2 agent 评审 / l3 人工确认。
  // 写入方：l1=agent-loop 验证守卫；l2/l3=reviewPassed/reviewRejected（attestation 入参）。
  // 消费铁律：展示/指标只准过 studio-shared 的 deriveDisplayState()，禁止各自解释。
  attestations?: WuAttestations;
  [key: string]: unknown;     // 允许扩展字段
}

/** F6: reviewPassed/reviewRejected 的证据来源——agent-review 写 l2，human-confirm 写 l3 */
export interface ReviewAttestationSource {
  by: string;                 // l2: 评审者 profile id；l3: 人类用户名
  kind: 'agent-review' | 'human-confirm';
  selfReview?: boolean;       // l2 自评兜底标记（决策 5）
  ref?: string;               // l2: 评审子 WU id
  summary?: string;
}

export interface CreateWorkUnitInput {
  type?: string;
  scope: string;
  assigneeId?: string;
  status?: string;
  channelId?: string | null;
  parentId?: string | null;
  projectPath?: string | null;
  workspaceId?: string | null;  // F6: 绑定工程（显式指定或频道默认）
  reqId?: string | null;        // REQ 需求编号（vision §5.3：显式/#REQ-XXXX/自动新建）
  failureType?: string;
  retryCount?: number;
  timeoutAt?: Date | null;
  completedAt?: Date | null;
  metadata?: WorkUnitMetadata;
}

export interface UpdateWorkUnitInput {
  type?: string;
  scope?: string;
  assigneeId?: string | null;
  channelId?: string | null;
  parentId?: string | null;
  projectPath?: string | null;
  workspaceId?: string | null;
  reqId?: string | null;        // REQ 需求编号
  failureType?: string | null;
  retryCount?: number;
  timeoutAt?: Date | null;
  completedAt?: Date | null;
  metadata?: WorkUnitMetadata;
}

/**
 * WorkUnitData — 与 Prisma WorkUnit 类型兼容的平面字段（无 relations）。
 * 日期字段使用 Date 对象（与 Prisma 行为一致），来源是 FileStore 的字符串日期。
 */
export interface WorkUnitData {
  id: string;
  parentId: string | null;
  type: string;
  scope: string;
  assigneeId: string | null;
  status: string;
  failureType: string | null;
  retryCount: number;
  timeoutAt: Date | null;
  channelId: string | null;
  projectPath: string | null;
  workspaceId?: string | null;  // F6: 绑定工程（旧 WorkUnit 无此字段 → null）
  reqId?: string | null;        // REQ 需求编号（旧 WorkUnit 无此字段 → null）
  metadata: string | null;
  createdAt: Date;
  updatedAt: Date;
  claimedAt: Date | null;
  completedAt: Date | null;
}

/** Valid status transitions map */
export const VALID_TRANSITIONS: Record<string, string[]> = {
  unassigned: ['active', 'closed'],
  active: ['in_review', 'closed', 'blocked'],
  in_review: ['done', 'active', 'closed'],
  done: ['closed'],
  blocked: ['active', 'closed', 'unassigned'],
  closed: ['unassigned'],
};

/**
 * #108（T2，#106 子票）：决策单/成文单类型集——人工验收类工单。
 * 无 worktree、无证据台账齐缺要求、无合并（不落 worktree 落档 → merge-on-review-pass 自然旁路）；
 * ReviewDispatcher 不自动派评审子 WU（同 analysis 先例，验收闸 = 人工 in_review）。
 */
export const DECISION_SPEC_TYPES = new Set(['decision', 'spec']);

/**
 * #108：decision/spec 的裁剪状态机 —— `unassigned → active ⇄ waitingForInput → in_review → done`。
 * 现有实现里 waitingForInput 挂起 = status blocked + metadata.waitingForInput（F5 双向沟通），
 * 故表内体现为 active ⇄ blocked；无 closed（决策单可能等关键人多天，不进死信/超时关闭路径；
 * 死信关闭机制 #57 尚待实现，届时需对齐本豁免）。
 */
const DECISION_SPEC_TRANSITIONS: Record<string, string[]> = {
  unassigned: ['active'],
  active: ['in_review', 'blocked'],
  blocked: ['active'],
  in_review: ['done', 'active'],
  done: [],
};

/** 按 WU type 的状态机覆盖表（未列出的 type 用全局 VALID_TRANSITIONS） */
export const TYPE_VALID_TRANSITIONS: Record<string, Record<string, string[]>> = {
  decision: DECISION_SPEC_TRANSITIONS,
  spec: DECISION_SPEC_TRANSITIONS,
};

/** transitionStatus 查表入口：type 覆盖优先，缺省回落全局表 */
export function resolveValidTransitions(wuType: string, status: string): string[] | undefined {
  return (TYPE_VALID_TRANSITIONS[wuType] ?? VALID_TRANSITIONS)[status];
}

/**
 * P0 修复（WU 超时机制）：WU 被认领进入 active 时的默认超时时长（分钟），按 type 区分。
 * metadata.timeoutAt 显式值优先于此表；未知 type 回落 WU_DEFAULT_TIMEOUT_MINUTES。
 */
export const WU_TIMEOUT_MINUTES: Record<string, number> = {
  task: 60,
  bug: 60,
  feature: 60,
  review: 30,
  analysis: 30,
};
export const WU_DEFAULT_TIMEOUT_MINUTES = 60;

/** analysis 任务拆分上限（agent-loop 解析 TASK: 行 / analysis-handoff 派生子 WU 共用） */
export const ANALYSIS_TASKS_MAX = 8;

/** claim 时的 timeoutAt 决策：metadata.timeoutAt 显式值优先，否则按 WU type 给默认时长 */
export function resolveClaimTimeoutAt(wuType: string, metadataRaw: string | null): Date {
  const meta = parseWuMetadata(metadataRaw);
  if (typeof meta.timeoutAt === 'string') {
    const explicit = new Date(meta.timeoutAt);
    if (!Number.isNaN(explicit.getTime())) return explicit;
  }
  const minutes = WU_TIMEOUT_MINUTES[wuType] ?? WU_DEFAULT_TIMEOUT_MINUTES;
  return new Date(Date.now() + minutes * 60_000);
}
