/**
 * WorkUnit Service — 状态机流转 + 查询 + 评审验收收口（继承 WorkUnitCrudService 的 CRUD + Claim）
 *
 * AS-025 §3.28c-1 Task 2-4
 * 存储迁移: 已从 Prisma 迁移到 FileStore (Event Sourcing)
 *
 * 拆分说明（纯代码移动，行为不变）：create/update/delete、claim/unclaim、
 * workunit.created/status_changed 事件发布与父状态聚合已迁至 workunit-crud.ts
 * （WorkUnitCrudService 基类）；本文件保留 metadata 契约（WorkUnitMetadata）、
 * 查询（getById/list）、状态机迁移（transitionStatus）与评审验收（reviewPassed/
 * reviewRejected/attestation 补写/recordL1Verification/markMergeConflict/
 * blockForManualRelease），并 re-export 全部迁出符号，导入面不变。
 */

import { logger, withAttestation, deriveDisplayState, type WorkUnitSnapshot, type WorkUnitEvent, type WuAttestations } from '@dommaker/studio-shared';
import { mergeWorktreeBranchOnReviewPass } from './merge-on-review-pass.js';
import { WorkUnitCrudService, snapshotToData, type WorkUnitData } from './workunit-crud.js';

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
  ownershipProjectId?: string; // 经 Requirement 解析到的 PMO 项目 id（审计用）
  // B3b-i 每 WU worktree 隔离（决策 D1）：代码类 WU 首个 step 创建并落档，后续 step 复用
  worktreePath?: string;      // 专属 worktree 路径（<worktreesDir>/wu-<wuId>；执行 cwd + 提交守卫 + 自动验证的消费点）
  worktreeBranch?: string;    // 专属分支名（task/<wuId>）
  worktreeBaseBranch?: string; // 创建时的 base 分支（origin/HEAD→main→master 探测；PMO-b：归属 PMO 时为 PMO 分支）
  worktreeBaseRepo?: string;  // 共享 git 仓库根（worktree 的母仓库）
  // PMO-b（决策 3）：WU 归属的 PMO 项目与集成分支（agent-loop 首 step 落档；
  // 非空时 merge-on-review-pass 合到 PMO 分支的集成交合 worktree，而非 baseRepo 当前分支）
  pmoProjectId?: string;
  pmoBranch?: string;
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

/** Valid status transitions map */
const VALID_TRANSITIONS: Record<string, string[]> = {
  unassigned: ['active', 'closed'],
  active: ['in_review', 'closed', 'blocked'],
  in_review: ['done', 'active', 'closed'],
  done: ['closed'],
  blocked: ['active', 'closed', 'unassigned'],
  closed: ['unassigned'],
};

/** analysis 任务拆分上限（agent-loop 解析 TASK: 行 / analysis-handoff 派生子 WU 共用） */
export const ANALYSIS_TASKS_MAX = 8;

export class WorkUnitService extends WorkUnitCrudService {

  /**
   * Get a WorkUnit by id. Returns null if not found.
   */
  async getById(id: string): Promise<WorkUnitData | null> {
    const snapshots = await this.fileStore.getIndex();
    const found = snapshots.find(s => s.id === id);
    return found ? snapshotToData(found) : null;
  }

  /**
   * List WorkUnits with optional filters and pagination.
   */
  async list(options?: {
    type?: string;
    status?: string;
    assigneeId?: string;
    channelId?: string;
    parentId?: string;
    failureType?: string;
    timedOutBefore?: Date;
    page?: number;
    limit?: number;
  }): Promise<{ data: WorkUnitData[]; total: number }> {
    const { type, status, assigneeId, channelId, parentId, failureType, timedOutBefore, page = 1, limit = 20 } = options ?? {};

    let snapshots = await this.fileStore.getIndex();

    // In-memory filter
    if (type) snapshots = snapshots.filter(s => s.type === type);
    if (status) snapshots = snapshots.filter(s => s.status === status);
    if (assigneeId) snapshots = snapshots.filter(s => s.assigneeId === assigneeId);
    if (channelId) snapshots = snapshots.filter(s => s.channelId === channelId);
    if (parentId) snapshots = snapshots.filter(s => s.parentId === parentId);
    if (failureType) snapshots = snapshots.filter(s => s.failureType === failureType);
    if (timedOutBefore) {
      const cutoff = timedOutBefore.getTime();
      snapshots = snapshots.filter(s => s.timeoutAt && new Date(s.timeoutAt).getTime() <= cutoff);
    }

    // Sort by createdAt desc
    snapshots.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const total = snapshots.length;

    // Paginate
    const start = (page - 1) * limit;
    const paged = snapshots.slice(start, start + limit);

    return { data: paged.map(snapshotToData), total };
  }

  /**
   * Transition WorkUnit status with state machine validation.
   * @throws Error if transition is not allowed
   */
  async transitionStatus(id: string, newStatus: string): Promise<WorkUnitData> {
    const snapshots = await this.fileStore.getIndex();
    const current = snapshots.find(s => s.id === id);
    if (!current) {
      throw new Error('WorkUnit not found');
    }

    const allowed = VALID_TRANSITIONS[current.status];
    if (!allowed || !allowed.includes(newStatus)) {
      throw new Error(
        `Invalid status transition: ${current.status} → ${newStatus}`
      );
    }

    const now = new Date();
    const isoNow = now.toISOString();

    const eventType: WorkUnitEvent['type'] =
      newStatus === 'done' || newStatus === 'closed' ? 'completed' :
      newStatus === 'blocked' ? 'blocked' : 'updated';

    const updated: WorkUnitSnapshot = {
      ...current,
      status: newStatus,
      completedAt: (newStatus === 'done' || newStatus === 'closed') ? isoNow : current.completedAt,
      updatedAt: isoNow,
    };

    const event: WorkUnitEvent = {
      type: eventType,
      wuId: id,
      timestamp: isoNow,
      data: updated as unknown as Record<string, unknown>,
    };
    await this.fileStore.appendEvent(event);
    await this.fileStore.upsertSnapshot(updated);

    // Publish status-change event（REQ roll-up 等订阅消费，best-effort）
    this.publishStatusChanged(updated);

    // Cascade: parent status aggregation on any status change that affects parent
    if (['active', 'blocked', 'done', 'closed'].includes(newStatus)) {
      this.aggregateParentStatus(id).catch(err =>
        logger.warn('[WorkUnit] aggregateParentStatus failed', { workUnitId: id, error: String(err) })
      );
    }

    return snapshotToData(updated);
  }

  /**
   * Review passed: in_review → done. Emits workunit.review.passed.
   * Resets consecutive rejection counter.
   * B3b-ii：收口处触发 worktree 分支自动合并（best-effort，不阻断 done 迁移）。
   * F6（决策 1）：attestation 入参带来源时写台账——agent-review → l2，human-confirm → l3。
   * F6-b：human-confirm 且当前已是 done → 幂等补写 l3（agent 评审通过的 WU 等人工确认，
   * 人类待办 = done ∧ ¬l3 必须有确认出口），不改状态、不重复触发合并。
   * F6-c（断点 3）：agent-review 且当前已是 done 且 l2 缺失 → 幂等补写 l2
   * （人工直推 done 抢跑评审链，迟到的评审结论无处落账的补票口），同不改状态、不触发合并。
   */
  async reviewPassed(id: string, attestation?: ReviewAttestationSource): Promise<WorkUnitData> {
    const snapshots = await this.fileStore.getIndex();
    const current = snapshots.find(s => s.id === id);
    if (!current) throw new Error('WorkUnit not found');
    if (current.status !== 'in_review') {
      // F6-b 豁免：done + human-confirm → 只补台账 l3
      if (current.status === 'done' && attestation?.kind === 'human-confirm') {
        return this.writeHumanConfirmation(current, attestation);
      }
      // F6-c 豁免：done + agent-review + l2 缺失（approved 口径，同 deriveDisplayState）→ 只补台账 l2；
      // l2 已达成时重复回传仍是非法迁移（不放宽状态机）
      if (current.status === 'done' && attestation?.kind === 'agent-review'
        && !deriveDisplayState({ status: current.status, metadata: current.metadata }).evidence.l2) {
        return this.writeAgentReviewAttestation(current, attestation);
      }
      throw new Error(`Cannot review: current status is ${current.status}, expected in_review`);
    }

    const metadata: WorkUnitMetadata = current.metadata ? JSON.parse(current.metadata) : {};
    delete metadata._consecutiveReviewRejections;
    if (attestation) {
      const level = attestation.kind === 'agent-review' ? 'l2' : 'l3';
      metadata.attestations = withAttestation(metadata.attestations, level, {
        verdict: 'approved',
        by: attestation.by,
        at: new Date().toISOString(),
        kind: attestation.kind,
        ...(attestation.summary ? { summary: attestation.summary } : {}),
        ...(attestation.selfReview === true ? { selfReview: true } : {}),
        ...(attestation.ref ? { ref: attestation.ref } : {}),
      });
    }

    const now = new Date();
    const isoNow = now.toISOString();
    const updated: WorkUnitSnapshot = {
      ...current,
      status: 'done',
      metadata: JSON.stringify(metadata),
      completedAt: isoNow,
      updatedAt: isoNow,
    };

    const event: WorkUnitEvent = {
      type: 'completed',
      wuId: id,
      timestamp: isoNow,
      data: updated as unknown as Record<string, unknown>,
    };
    await this.fileStore.appendEvent(event);
    await this.fileStore.upsertSnapshot(updated);

    // Publish status-change event（REQ roll-up 等订阅消费，best-effort）
    this.publishStatusChanged(updated);

    // Cascade: parent aggregation (best-effort)
    this.aggregateParentStatus(id).catch(err =>
      logger.warn('[WorkUnit] aggregateParentStatus failed', { workUnitId: id, error: String(err) })
    );

    // B3b-ii（决策 D1/D3 后半）：评审通过 → task 分支自动合并回 base 分支。
    // best-effort：无 worktree 落档的 WU 在 merge 模块内旁路；冲突由模块自行置 blocked 转人工；
    // 任何失败只记日志，不阻断本方法的 done 迁移。
    mergeWorktreeBranchOnReviewPass(this, snapshotToData(updated), this.fileStore).catch(err =>
      logger.warn('[WorkUnit] merge-on-review-pass failed (non-blocking)', { workUnitId: id, error: String(err) })
    );

    return snapshotToData(updated);
  }

  /**
   * F6-b：done WU 的人工确认（l3 补写）——只更新台账，不动状态/.completedAt，不触发合并。
   * 幂等：重复确认覆盖 l3 最新值。
   * 2026-07-30 起补写后发 status_changed（状态值不变也发）——pmo progress-rollup 已改为
   * 证据感知（证据不齐置 in_review），l3 常是最后一块证据，不发事件项目状态无法即时翻转。
   */
  private async writeHumanConfirmation(
    current: WorkUnitSnapshot,
    attestation: ReviewAttestationSource,
  ): Promise<WorkUnitData> {
    const metadata: WorkUnitMetadata = current.metadata ? JSON.parse(current.metadata) : {};
    metadata.attestations = withAttestation(metadata.attestations, 'l3', {
      verdict: 'approved',
      by: attestation.by,
      at: new Date().toISOString(),
      kind: 'human-confirm',
      ...(attestation.summary ? { summary: attestation.summary } : {}),
    });

    const updated: WorkUnitSnapshot = {
      ...current,
      metadata: JSON.stringify(metadata),
      updatedAt: new Date().toISOString(),
    };
    const event: WorkUnitEvent = {
      type: 'updated',
      wuId: current.id,
      timestamp: updated.updatedAt,
      data: updated as unknown as Record<string, unknown>,
    };
    await this.fileStore.appendEvent(event);
    await this.fileStore.upsertSnapshot(updated);
    this.publishStatusChanged(updated); // 状态值不变也发：让 pmo rollup 即时重估交付证据
    return snapshotToData(updated);
  }

  /**
   * F6-c（断点 3）：done WU 的迟到 agent 评审（l2 补写）——与 writeHumanConfirmation 同模式：
   * 只更新台账，不动状态/completedAt，不触发合并。幂等：l2 缺失（含 stale rejected）时补写/覆盖。
   * 与 l3 路径的差异：补写完发 status_changed（状态值不变也发）——
   * pmo/progress-rollup 按证据齐备度重估项目状态，缺事件则永远按缺 l2 的旧口径。
   */
  private async writeAgentReviewAttestation(
    current: WorkUnitSnapshot,
    attestation: ReviewAttestationSource,
  ): Promise<WorkUnitData> {
    const metadata: WorkUnitMetadata = current.metadata ? JSON.parse(current.metadata) : {};
    metadata.attestations = withAttestation(metadata.attestations, 'l2', {
      verdict: 'approved',
      by: attestation.by,
      at: new Date().toISOString(),
      kind: 'agent-review',
      ...(attestation.summary ? { summary: attestation.summary } : {}),
      ...(attestation.selfReview === true ? { selfReview: true } : {}),
      ...(attestation.ref ? { ref: attestation.ref } : {}),
    });

    const updated: WorkUnitSnapshot = {
      ...current,
      metadata: JSON.stringify(metadata),
      updatedAt: new Date().toISOString(),
    };
    const event: WorkUnitEvent = {
      type: 'updated',
      wuId: current.id,
      timestamp: updated.updatedAt,
      data: updated as unknown as Record<string, unknown>,
    };
    await this.fileStore.appendEvent(event);
    await this.fileStore.upsertSnapshot(updated);
    this.publishStatusChanged(updated);
    return snapshotToData(updated);
  }

  /**
   * F6-c（断点 2）：人工触发 L1 验证（POST /:id/verify）的结果落台账——
   * 只补写 l1（approved/rejected 留痕），全绿时同写 verifyReport（与 agent-loop 守卫同结构；
   * 失败不写——verifyReport 语义是全绿摘要，metrics 按存在计通过），
   * 不动状态机/verifyFailCount。写完发 status_changed（状态值不变也发）让 pmo rollup 重估。
   */
  async recordL1Verification(id: string, input: {
    by: string;
    ran: string[];
    source: 'override' | 'convention';
    failure?: { command: string; tail: string };
  }): Promise<WorkUnitData> {
    const snapshots = await this.fileStore.getIndex();
    const current = snapshots.find(s => s.id === id);
    if (!current) throw new Error('WorkUnit not found');

    const now = new Date().toISOString();
    const metadata: WorkUnitMetadata = current.metadata ? JSON.parse(current.metadata) : {};
    metadata.attestations = withAttestation(metadata.attestations, 'l1', input.failure
      ? {
          verdict: 'rejected',
          by: input.by,
          at: now,
          kind: 'verify',
          summary: `失败命令: ${input.failure.command}`.slice(0, 300),
        }
      : {
          verdict: 'approved',
          by: input.by,
          at: now,
          kind: 'verify',
          summary: input.ran.join('；').slice(0, 300),
        });
    if (!input.failure) {
      metadata.verifyReport = { commands: input.ran, source: input.source, passedAt: now };
    }

    const updated: WorkUnitSnapshot = {
      ...current,
      metadata: JSON.stringify(metadata),
      updatedAt: now,
    };
    const event: WorkUnitEvent = {
      type: 'updated',
      wuId: current.id,
      timestamp: now,
      data: updated as unknown as Record<string, unknown>,
    };
    await this.fileStore.appendEvent(event);
    await this.fileStore.upsertSnapshot(updated);
    this.publishStatusChanged(updated);
    return snapshotToData(updated);
  }
  async markMergeConflict(id: string, conflictFiles: string[]): Promise<WorkUnitData> {
    const snapshots = await this.fileStore.getIndex();
    const current = snapshots.find(s => s.id === id);
    if (!current) throw new Error('WorkUnit not found');

    const metadata: WorkUnitMetadata = current.metadata ? JSON.parse(current.metadata) : {};
    metadata.mergeConflict = true;
    metadata.conflictFiles = conflictFiles;
    // B4: blocked 原因落盘（2026-08-03 token-burn issue P0-2）
    metadata.blockReason = `merge-conflict: 自动合并冲突（${conflictFiles.length} 个文件）`;

    const now = new Date();
    const isoNow = now.toISOString();
    const updated: WorkUnitSnapshot = {
      ...current,
      status: 'blocked',
      metadata: JSON.stringify(metadata),
      updatedAt: isoNow,
    };

    const event: WorkUnitEvent = {
      type: 'blocked',
      wuId: id,
      timestamp: isoNow,
      data: updated as unknown as Record<string, unknown>,
    };
    await this.fileStore.appendEvent(event);
    await this.fileStore.upsertSnapshot(updated);

    this.publishStatusChanged(updated);

    this.aggregateParentStatus(id).catch(err =>
      logger.warn('[WorkUnit] aggregateParentStatus failed', { workUnitId: id, error: String(err) })
    );

    return snapshotToData(updated);
  }

  /**
   * 2026-07 PMO-flow UX（§4 terminate 语义修正）：强制释放转人工——
   * AgentInstanceService.terminate 在 unclaim 之后调用，WU 直接置 blocked
   * （unassigned → blocked 不在 VALID_TRANSITIONS，活 loop 不认领 blocked WU，
   * 避免 terminate 后 ≤15s 被同一 loop 重新认领回弹；事件溯源形态同 markMergeConflict）。
   * assigneeId/claimedAt 清空 + metadata.manualRelease 留痕（语义同 mergeConflict 审计字段）。
   * 终态（done/closed）WU 不动——工作已收口，无可释放（terminate 与完成的竞态防护）。
   */
  async blockForManualRelease(id: string, reason: string): Promise<WorkUnitData> {
    const snapshots = await this.fileStore.getIndex();
    const current = snapshots.find(s => s.id === id);
    if (!current) throw new Error('WorkUnit not found');

    if (current.status === 'done' || current.status === 'closed') {
      return snapshotToData(current);
    }

    const metadata: WorkUnitMetadata = current.metadata ? JSON.parse(current.metadata) : {};
    metadata.manualRelease = true;
    metadata.manualReleaseReason = reason;
    // B4: blocked 原因落盘（2026-08-03 token-burn issue P0-2）
    metadata.blockReason = `manual-release: ${reason}`;

    const now = new Date();
    const isoNow = now.toISOString();
    const updated: WorkUnitSnapshot = {
      ...current,
      status: 'blocked',
      assigneeId: null,
      claimedAt: null,
      metadata: JSON.stringify(metadata),
      updatedAt: isoNow,
    };

    const event: WorkUnitEvent = {
      type: 'blocked',
      wuId: id,
      timestamp: isoNow,
      data: updated as unknown as Record<string, unknown>,
    };
    await this.fileStore.appendEvent(event);
    await this.fileStore.upsertSnapshot(updated);

    this.publishStatusChanged(updated);

    this.aggregateParentStatus(id).catch(err =>
      logger.warn('[WorkUnit] aggregateParentStatus failed', { workUnitId: id, error: String(err) })
    );

    return snapshotToData(updated);
  }

  /**
   * Review rejected: in_review → active (or → blocked after 3 consecutive rejections).
   * Emits workunit.review.rejected.
   * F6（决策 1）：attestation 入参带来源时写台账（verdict=rejected 留痕；返工后重审 approved 覆盖）。
   */
  async reviewRejected(id: string, reason?: string, attestation?: ReviewAttestationSource): Promise<WorkUnitData> {
    const snapshots = await this.fileStore.getIndex();
    const current = snapshots.find(s => s.id === id);
    if (!current) throw new Error('WorkUnit not found');
    if (current.status !== 'in_review') {
      throw new Error(`Cannot review: current status is ${current.status}, expected in_review`);
    }

    const metadata: WorkUnitMetadata = current.metadata ? JSON.parse(current.metadata) : {};
    const rejections = (metadata._consecutiveReviewRejections ?? 0) + 1;
    metadata._consecutiveReviewRejections = rejections;
    if (reason) metadata._lastRejectionReason = reason;
    if (attestation) {
      const level = attestation.kind === 'agent-review' ? 'l2' : 'l3';
      metadata.attestations = withAttestation(metadata.attestations, level, {
        verdict: 'rejected',
        by: attestation.by,
        at: new Date().toISOString(),
        kind: attestation.kind,
        ...(attestation.summary ?? reason ? { summary: attestation.summary ?? reason } : {}),
        ...(attestation.selfReview === true ? { selfReview: true } : {}),
        ...(attestation.ref ? { ref: attestation.ref } : {}),
      });
    }

    // 3 consecutive rejections → auto-block
    const newStatus = rejections >= 3 ? 'blocked' : 'active';
    if (newStatus === 'blocked') {
      // B4: blocked 原因落盘（2026-08-03 token-burn issue P0-2）
      metadata.blockReason = `review-rejected x${rejections}: ${reason ?? metadata._lastRejectionReason ?? '连续评审拒绝'}`.slice(0, 300);
    }

    const now = new Date();
    const isoNow = now.toISOString();
    const updated: WorkUnitSnapshot = {
      ...current,
      status: newStatus,
      metadata: JSON.stringify(metadata),
      updatedAt: isoNow,
    };

    const eventType: WorkUnitEvent['type'] = newStatus === 'blocked' ? 'blocked' : 'updated';
    const event: WorkUnitEvent = {
      type: eventType,
      wuId: id,
      timestamp: isoNow,
      data: updated as unknown as Record<string, unknown>,
    };
    await this.fileStore.appendEvent(event);
    await this.fileStore.upsertSnapshot(updated);

    // in_review → active/blocked 也是状态变化：补发 status_changed（列表实时刷新）
    this.publishStatusChanged(updated);

    if (newStatus === 'blocked') {
      logger.warn('[WorkUnit] Auto-blocked after 3 consecutive review rejections', { workUnitId: id });
    }

    return snapshotToData(updated);
  }

}

// 拆分后兼容 re-export（原导入方零改动）：以下符号已迁至 workunit-crud.ts
export { WU_TIMEOUT_MINUTES, WU_DEFAULT_TIMEOUT_MINUTES } from './workunit-crud.js';
export type { CreateWorkUnitInput, UpdateWorkUnitInput, WorkUnitData } from './workunit-crud.js';

export type { WorkUnitSnapshot, WorkUnitFilter } from '@dommaker/studio-shared';
