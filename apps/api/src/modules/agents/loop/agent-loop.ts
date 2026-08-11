// AgentLoop — observe→resolveTarget→agentStep→recordResult decision loop (AS-025)
// Orchestration layer: zero LLM calls. Agent = external compute (Claude Code/OpenCode/Codex).
// 工单 28（2026-08）拆分：类型契约 → agent-loop.types.js；输出解析/prompt 模板 →
// agent-loop-parsers.js；token/tool:call 事件落盘 → agent-loop-events.js；B2/F4 守卫 →
// agent-loop-guards.js。知识搜索分析块（knowledge-search-analysis）零生产调用方，工单 43 已删。
// 工单 05（2026-08）：prompt/上下文组装（含 buildSkill/Persona/RosterSection）→ prompt-composer.js；
// DELEGATE 分支（建子单 + collab 元数据 + 降级文案）→ delegate-branch.js。
// 本文件保留 AgentLoop 类编排逻辑 + re-export（对外导出语义不变）。
import { execSync } from 'child_process';
import { eventBus, logger, FileStore, parseChannels, estimateTokens, withAttestation, type RuntimeStateData } from '@dommaker/studio-shared';
import { resolveProviderDefinition, buildHealthProbeCommand } from '@dommaker/studio-shared/node';
import { randomUUID } from 'crypto';
import type { AgentTask, ExecutionResult } from '@dommaker/studio-agent';
import { ensureWuWorktree, ensureBranchExists, getDefaultBranch } from '@dommaker/studio-agent';
import { LocalExecutor, type Executor } from './executor.js';
import { WorkUnitService, snapshotToData, type WorkUnitMetadata, type WorkUnitData } from '../../workunit/workunit.service.js';
import type { AgentProfileData } from '@dommaker/studio-shared';
import { getTriggerScheduler } from '../../triggers/trigger-registry.js';
import { knowledgeService } from '../../knowledge/knowledge-service.js';
import { eventStore } from '../../../core/event-store.js';
import { postWuSystemMessage } from '../../workunit/wu-messenger.js';
import { parseWuMetadata, mergedWuView } from '../../workunit/wu-metadata.js';
import { hasUnfinishedDeps, buildStatusById } from '../../workunit/wu-dependencies.js';
import { resolveWorkspaceRoot } from '../../workspaces/workspace-store.js';
import { resolvePmoBranchForWU } from '../../requirements/pmo-branch-resolver.js';
import { resolveStudioLogFile } from '../../../utils/studio-log-path.js';
import {
  tokenBudgetGuardEnabled, resolveDailyTokenBudget, getDailyTokenUsage,
  notifyBudgetTripped,
} from './daily-token-budget.js';
import { emitExecutionStepEvent, emitExecutionStreamLine, emitExecutionStreamStepStart } from './execution-step-events.js';
import { CODE_WORKTREE_TYPES, runWuVerification } from './wu-verification.js';
import { runCompletionGuards } from './completion-gates.js';
import type { StepResult, Observations, Target, RuntimeInstanceRow } from './agent-loop.types.js';
import {
  extractInputTokens, isProcessAlive, isGitRepoRoot, resolveWorktreesDir,
  resolveTarget, parseAgentOutput, dynamicInterval, parseReviewReport, parseTaskBreakdown,
  sleep,
} from './agent-loop-parsers.js';
import {
  resolveRealUsage, writeWorkunitTokenEvent,
  resolveToolTraceFile, writeToolCallEvents, type RealUsage,
} from './agent-loop-events.js';
import { testWuGuardEnabled, isTestLikeWorkUnit, parseExcludeAssignee } from './agent-loop-guards.js';
import { composeStepPrompt } from './prompt-composer.js';
import { handleDelegateBranch } from './delegate-branch.js';
import { shouldResumeSession, RESUME_FAILURE_RE } from './session-resume.js';

// 输出解析/prompt 构建纯函数已抽到 ./agent-loop-parsers.js（工单 28，行为不变）；
// re-export 保持对外导出语义不变
export {
  extractInputTokens, isProcessAlive, isGitRepoRoot, resolveWorktreesDir,
  resolveTarget, parseAgentOutput, dynamicInterval, parseReviewReport, parseTaskBreakdown,
} from './agent-loop-parsers.js';

// workunit:tokens / tool:call 事件落盘已抽到 ./agent-loop-events.js（工单 28，行为不变）；
// re-export 保持对外导出语义不变
export { resolveRealUsage, writeWorkunitTokenEvent, resolveToolTraceFile, writeToolCallEvents } from './agent-loop-events.js';
export type { WorkunitTokenEventArgs, RealUsage } from './agent-loop-events.js';

// B2 测试特征 WU 守卫 + F4 excludeAssignee 解析已抽到 ./agent-loop-guards.js（工单 28，行为不变）；
// re-export 保持对外导出语义不变
export { testWuGuardEnabled, isTestLikeWorkUnit } from './agent-loop-guards.js';

/** Threshold for input_tokens before session truncation (100K) */
const SESSION_TOKEN_LIMIT = 100_000;

/** M2: workunit:tokens 事件写入目标（与 knowledge consumption/outcome 事件同一事件流）。
 *  STUDIO_EVENTS_JSONL 环境变量可覆盖（测试隔离用）；缺省走 resolveStudioLogFile ——
 *  测试环境（VITEST/NODE_ENV=test）自动改写 tmpdir，防止测试污染生产事件流
 *  （2026-08-03 token-burn issue：生产 studio-events.jsonl 曾混入大量 wu-cumulative-tokens 测试行）。
 *  调用时惰性解析：测试在 import 本模块后仍可改 env 生效。 */
function studioEventsJsonlPath(): string {
  return process.env.STUDIO_EVENTS_JSONL || resolveStudioLogFile('studio-events.jsonl');
}

/** B3b-i: 代码类 WU 判定与验证实现已抽到 ./wu-verification.js（F6-c，供强制收口与 /verify 端点复用） */
/** 步骤数上限：超限强制 in_review 交人工。review WU 单独放宽——
 *  评审职责是读不是写，无提交守卫豁免后正常 ≤5 步收口；阈值仅是防死循环的安全阀 */
const STEP_LIMIT = 15;
const REVIEW_STEP_LIMIT = 30;

/** B5（2026-08-03 token-burn issue P1-1）：每 WU 独立会话数上限。
 *  会话反复重建（stuck 重开 / token 截断重开）意味着整段 transcript 全文重放重新烧一遍；
 *  超限说明自动执行已失控，转 need_input 等人工评估（#94 起人工回复不再重置预算——
 *  复活后凭 metadata.sessionId 优先续用旧会话，见 waiting-input.ts）。 */
const MAX_SESSIONS_PER_WU = 2;

/** F6-fix: 空闲分支心跳节流间隔 — agent-timeout-scan 阈值为 5min，45s 一次足够保活 */
const IDLE_HEARTBEAT_INTERVAL_MS = 45_000;
/** 单活实例守卫：心跳/启动时间新鲜度阈值（idle 心跳 45s 一跳，留近 3 跳余量） */
const LIVE_HOLDER_THRESHOLD_MS = 120_000;

// §10 P0 注入总预算（2K 红线）随 prompt 组装段一并迁到 ./prompt-composer.js（2026-08 工单 05）

// 类型契约已抽到 ./agent-loop.types.js（工单 28，行为不变）；re-export 保持对外导出语义不变
export type { StepResult } from './agent-loop.types.js';

export class AgentLoop {
  private role: AgentProfileData;
  private workUnitService: WorkUnitService;
  private fileStore: FileStore;
  private instance: RuntimeInstanceRow | null = null;
  private acceptedTypes: string[] = [];
  private alive = false;
  private myChannels: string[] = [];
  private triggerId: string | null = null;
  private loopPromise: Promise<void> | null = null;
  private lastIdleHeartbeatAt = 0;
  private executor: Executor;
  /** 2026-07 PMO-flow UX（§6-2）：最后一次已发布的 instance 状态（SSE 去重——状态不变不发） */
  private lastPublishedStatus: string | null = null;

  constructor(role: AgentProfileData, fileStore?: FileStore) {
    this.role = role;
    this.fileStore = fileStore ?? new FileStore();
    this.workUnitService = new WorkUnitService(this.fileStore);
    // 决策 9: acceptedTypes 取 profile 显式字段（description 关键词解析已退役）
    this.acceptedTypes = role.acceptedTypes ?? [];
    // W-4 fix + F3: parse channels from role.channels JSON（容错历史双重编码值）
    this.myChannels = parseChannels(role.channels);
    // §9.6: 执行面走 Executor 接口。远程节点方向已放弃（origin/master bdaf0dd3：生产无
    // nodeId profile、无 WS 客户端活路径），统一 LocalExecutor；profile.nodeId 仅为数据兼容保留。
    this.executor = new LocalExecutor();
  }

  /** Start the agent loop: create instance, register EVENT trigger, enter observe-decide-act cycle.
   *  Returns true when the loop started; false on startup-fatal failure (recorded for UI/monitoring, F2). */
  async start(): Promise<boolean> {
    try {
      // AC-4.5 + F4: Health probe — verify the profile's provider CLI is available
      const providerId = this.role.provider || 'claude';
      const probeCmd = buildHealthProbeCommand(providerId);
      try {
        execSync(probeCmd, { timeout: 5000 });
      } catch {
        const message = `${resolveProviderDefinition(providerId).displayName} CLI not available (health probe \`${probeCmd}\` failed)`;
        logger.error(`[AgentLoop] ${message} — agent ${this.role.name} unavailable`);
        await this.recordStartupFailure(message);
        return false;
      }

      const allStates = await this.fileStore.listStates();

      // 2026-07-30 走查修复：清理该 roleId 的 terminated 历史实例（防累积）
      // 每次 API 重启都创建新 idle 实例，旧 terminated state.json 不清理会无限累积
      // （~/.studio/data/agents/<id>/state.json 残留，监控/频道侧栏显示历史噪音）
      for (const s of allStates.filter(s => s.roleId === this.role.id && s.status === 'terminated')) {
        await this.fileStore.deleteState(s.id).catch(() => {});
      }

      // F2: recovery — a successful probe clears previous error states for this role
      for (const s of allStates.filter(s => s.roleId === this.role.id && s.status === 'error')) {
        await this.fileStore.updateState(s.id, {
          status: 'terminated',
          terminatedAt: new Date().toISOString(),
          lastError: null,
          lastErrorAt: null,
        }).catch(() => {});
      }

      // AC-4.6: Detect and clean up stale previous instances for this role
      const stalePrev = allStates.find(s => s.roleId === this.role.id && s.status !== 'error' && s.status !== 'terminated' && s.pid && !isProcessAlive(s.pid));
      if (stalePrev) {
        logger.info(`[AgentLoop] Cleaning up stale instance ${stalePrev.id} (PID ${stalePrev.pid})`);
        await this.fileStore.updateState(stalePrev.id, { status: 'terminated' }).catch(() => {});
      }

      // 同角色单活实例守卫（2026-07-30 走查修复）：另一进程持有的活实例存在时 standby。
      // 判活 = 异 pid 进程存活 且 心跳新鲜（lastHeartbeat/startedAt 在阈值内）。
      // 防 dev/prod 双实例共享同一 ~/.studio 时同 profile 被重复挂载（认领竞争、频道重复
      // 回复、会话续用错位命中）。持有者死亡/心跳停摆后，下次挂载（重启或 profile 生命周期
      // 事件）自动接管。stale 清理只管死 pid，管不了两个活进程——本守卫补这一层。
      const liveHolder = allStates.find(s => {
        if (s.roleId !== this.role.id) return false;
        if (s.status === 'error' || s.status === 'terminated') return false;
        if (!s.pid || s.pid === process.pid || !isProcessAlive(s.pid)) return false;
        const beat = s.lastHeartbeat ?? s.startedAt;
        return !!beat && (Date.now() - new Date(beat).getTime()) < LIVE_HOLDER_THRESHOLD_MS;
      });
      if (liveHolder) {
        const message = `role 已有活实例 ${liveHolder.id}（pid ${liveHolder.pid}，心跳新鲜）持有，本实例 standby —— 持有者退出后重启本实例即可接管`;
        logger.warn(`[AgentLoop] ${this.role.name}: ${message}`);
        await this.recordStartupFailure(message);
        return false;
      }

      const now = new Date().toISOString();
      const instanceId = randomUUID();
      const state: RuntimeStateData = {
        id: instanceId,
        roleId: this.role.id,
        sessionId: null,
        status: 'idle',
        currentWorkUnitId: null,
        startedAt: now,
        terminatedAt: null,
        lastHeartbeat: null,
        metadata: null,
        pid: process.pid,
      };
      await this.fileStore.createState(instanceId, state);
      this.instance = state;

      this.alive = true;
      logger.info(`[AgentLoop] Started for role ${this.role.name} (instance=${this.instance.id})`);

      // AC-3: Register EVENT trigger for workunit.created
      const scheduler = getTriggerScheduler();
      this.triggerId = `agent-loop-${this.role.id}-workunit-created`;
      const handlerTarget = `agent-loop-${this.role.id}-observe`;

      scheduler.registerExecuteHandler(handlerTarget, async () => {
        if (this.alive) {
          this.observe().catch(err =>
            logger.warn(`[AgentLoop] EVENT-triggered observe failed: ${err.message}`)
          );
        }
      });

      scheduler.registerTrigger({
        id: this.triggerId,
        name: `Agent ${this.role.name} observe on workunit.created`,
        condition: { type: 'EVENT', event: 'workunit.created' },
        action: { type: 'EXECUTE', target: handlerTarget },
        enabled: true,
        scope: 'agent',
      });

      // Main loop (non-blocking — fire and forget like original)
      this.loopPromise = this.runLoop().catch(err =>
        logger.error(`[AgentLoop] Loop failed for ${this.role.name}: ${err.message}`)
      );
      return true;
    } catch (err) {
      // F2: any other startup-fatal failure is also surfaced
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[AgentLoop] Startup failed for ${this.role.name}: ${message}`);
      await this.recordStartupFailure(message).catch(() => {});
      return false;
    }
  }

  /** F2: Record a startup-fatal failure to runtime state (state.json) + notify via eventBus and SSE */
  private async recordStartupFailure(message: string): Promise<void> {
    const now = new Date().toISOString();
    try {
      // Reuse this role's existing error state if any (avoid one record per retry)
      const allStates = await this.fileStore.listStates();
      const existing = allStates.find(s => s.roleId === this.role.id && s.status === 'error');
      if (existing) {
        await this.fileStore.updateState(existing.id, { lastError: message, lastErrorAt: now });
      } else {
        const instanceId = randomUUID();
        const state: RuntimeStateData = {
          id: instanceId,
          roleId: this.role.id,
          sessionId: null,
          status: 'error',
          currentWorkUnitId: null,
          startedAt: now,
          terminatedAt: null,
          lastHeartbeat: null,
          metadata: null,
          pid: process.pid,
          lastError: message,
          lastErrorAt: now,
        };
        await this.fileStore.createState(instanceId, state);
      }
    } catch (err) {
      logger.warn(`[AgentLoop] Failed to record startup failure state: ${err instanceof Error ? err.message : String(err)}`);
    }

    const payload = { profileId: this.role.id, name: this.role.name, provider: this.role.provider ?? 'claude', error: message };
    eventBus.publish('agent.health.failed', payload);
    // SSE 'events' topic (same shape as channel-message.service.ts publishSSE)
    eventStore.publish('events', JSON.stringify({
      event_type: 'agent.health.failed',
      event_id: randomUUID(),
      timestamp: now,
      data: payload,
    })).catch(() => {}); // best-effort
  }

  /** Main observe→resolveTarget→agentStep→recordResult loop */
  private async runLoop(): Promise<void> {
    while (this.alive) {
      try {
        const observations = await this.observe();
        const target = resolveTarget(observations);

        if (!target) {
          // No work available → back to idle (fix: status stays correct after task completion)
          await this.updateIdleState();
          await sleep(15_000);
          continue;
        }

        // Claim if unassigned
        if (target.workUnit.status === 'unassigned') {
          try {
            await this.workUnitService.claim(target.workUnit.id, this.instance!.id);
            const afterClaim = await this.workUnitService.getById(target.workUnit.id);
            if (afterClaim) target.workUnit = afterClaim;
          } catch {
            await sleep(1_000);
            continue;
          }
        }

        // Update heartbeat + status=active (fix: monitoring.active was always 0)
        if (this.instance) {
          await this.fileStore.updateState(this.instance.id, {
            lastHeartbeat: new Date().toISOString(),
            currentWorkUnitId: target.workUnit.id,
            status: 'active',
          }).catch(() => {});
          // 2026-07 PMO-flow UX（§6-2）：忙闲变化 SSE（仅状态实际变化时发一次）
          this.publishInstanceStatus('active', target.workUnit.id);
        }

        const result = await this.agentStep(target);
        await this.recordResult(target, result);
        await sleep(dynamicInterval(result));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`[AgentLoop] Loop iteration error: ${message}`);
        await sleep(15_000);
      }
    }
  }

  /**
   * Idle branch state update. F6-fix: 空闲也要刷新 lastHeartbeat（按
   * IDLE_HEARTBEAT_INTERVAL_MS 节流），否则 agent-timeout-scan 会把
   * 空闲 >5min 的实例标记 terminated（内存 loop 仍在跑，监控却显示已终止）。
   */
  private async updateIdleState(): Promise<void> {
    if (!this.instance) return;
    const update: { status: string; currentWorkUnitId: null; lastHeartbeat?: string } = {
      status: 'idle',
      currentWorkUnitId: null,
    };
    const nowMs = Date.now();
    if (nowMs - this.lastIdleHeartbeatAt >= IDLE_HEARTBEAT_INTERVAL_MS) {
      update.lastHeartbeat = new Date(nowMs).toISOString();
      this.lastIdleHeartbeatAt = nowMs;
    }
    await this.fileStore.updateState(this.instance.id, update).catch(() => {});
    // 2026-07 PMO-flow UX（§6-2）：进入 idle 发一次 SSE；45s 节流心跳重入不重复发
    this.publishInstanceStatus('idle', null);
  }

  /**
   * 2026-07 PMO-flow UX（§6-2）：instance 忙闲变化发 SSE（agent.instance.status_changed）。
   * 形状与 recordStartupFailure 的 agent.health.failed 一致（events topic 信封；
   * sse.routes 无 agent.* 显式映射 → 落 all topic，前端订阅 all 即收，无需改路由）。
   * 仅在 status 相对上次发布实际变化时发（lastPublishedStatus 去重）——
   * updateIdleState 的 45s 节流分支反复进入 idle 不刷屏。best-effort，绝不阻断主循环。
   */
  private publishInstanceStatus(status: string, currentWorkUnitId: string | null): void {
    if (!this.instance || this.lastPublishedStatus === status) return;
    this.lastPublishedStatus = status;
    eventStore.publish('events', JSON.stringify({
      event_type: 'agent.instance.status_changed',
      event_id: randomUUID(),
      timestamp: new Date().toISOString(),
      data: {
        profileId: this.role.id,
        instanceId: this.instance.id,
        name: this.role.name,
        status,
        currentWorkUnitId,
      },
    })).catch(() => {}); // best-effort
  }

  /** Stop the agent loop and clean up */
  stop(): void {
    this.alive = false;
    if (this.triggerId) {
      getTriggerScheduler().unregisterTrigger(this.triggerId);
    }
    if (this.instance) {
      this.fileStore.updateState(this.instance.id, {
        status: 'terminated',
        terminatedAt: new Date().toISOString(),
      }).catch(err => logger.error(`[AgentLoop] Failed to terminate instance: ${err.message}`));
    }
  }

  /** Wait for the runLoop promise to fully settle (for test cleanup) */
  async waitForStop(): Promise<void> {
    if (this.loopPromise) {
      try { await this.loopPromise; } catch { /* loop errors already logged */ }
    }
  }

  /**
   * §9.5: 加载全部频道的 members（channelId → member profile ids）。
   * 每次 observe 调用一次；读取失败按空表处理（全量走 profile.channels 回退，不致停摆）。
   */
  private async loadChannelMembers(): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    try {
      const channels = await this.fileStore.listChannels();
      for (const ch of channels) {
        map.set(ch.id, parseChannels(ch.members));
      }
    } catch { /* non-blocking — 回退到 profile.channels 口径 */ }
    return map;
  }

  /** Observe: collect state from DB (zero token) */
  private async observe(): Promise<Observations> {
    // 工单 27：index.json 每轮只读一次——myActive 由同一批快照本地派生，
    // 过滤/排序/分页口径与 workUnitService.list({assigneeId}) 完全一致
    // （含先按 createdAt desc 取前 20 条、再按状态过滤的顺序）。
    const allSnapshots = await this.fileStore.getIndex();
    const myAssigneeId = this.instance?.id;
    const mine = myAssigneeId
      ? allSnapshots.filter(s => s.assigneeId === myAssigneeId)
      : [...allSnapshots];
    const myActive = mine
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 20)
      .map(snapshotToData)
      .filter(wu => wu.status === 'active' || wu.status === 'blocked');
    // §9.5: channel.members 为成员关系唯一事实源 — observe 每轮加载一次频道配置
    // （FileStore 规模小，成本可忽略）。
    const channelMembers = await this.loadChannelMembers();
    // #109（M4 接单过滤）：全局 id→status 映射（FileStore index 天然跨 PMO）
    const statusById = buildStatusById(allSnapshots);
    const unassigned = allSnapshots.filter(s => {
      if (s.status !== 'unassigned') return false;
      // Assignee-aware claiming（@mention 语义，docs/vision-2026.md §3）：
      // 显式指派给某个 profile 的 WorkUnit 只能被该 profile 的 loop 认领；
      // 未指派的保持频道作用域（§9.5: 频道 members 含本 profile）。
      // 决策 10：认领纯显式，不再有 acceptedTypes 类型过滤（推断只用于 skill 排序，不否决路由）。
      if (s.assigneeId) {
        if (s.assigneeId !== this.role.id) return false;
      } else if (s.channelId) {
        const members = channelMembers.get(s.channelId);
        if (members && members.length > 0) {
          // members 非空 → 唯一事实源：仅频道成员可见
          if (!members.includes(this.role.id)) return false;
        } else if (this.myChannels.length > 0 && !this.myChannels.includes(s.channelId)) {
          // 过渡期回退：频道无 members（历史数据未回填）时沿用旧 profile.channels 口径
          return false;
        }
      }
      // F4（reviewer 解锚，决策 5）：评审 WU 排除实现者 —— metadata.excludeAssignee
      // 命中的 profile 不可见（自评兜底场景 dispatcher 不设该字段，此处自然放行）
      if (parseExcludeAssignee(s.metadata) === this.role.id) return false;
      // #109（M4 接单过滤）：metadata.blockedBy 中有未 done 的 WU → 对所有 loop 不可见
      if (hasUnfinishedDeps(s.metadata, statusById)) return false;
      return true;
    }).sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      .slice(0, 5)
      .map(s => ({
        id: s.id, parentId: s.parentId, type: s.type, scope: s.scope,
        assigneeId: s.assigneeId, status: s.status, failureType: s.failureType,
        retryCount: s.retryCount, timeoutAt: s.timeoutAt ? new Date(s.timeoutAt) : null,
        channelId: s.channelId, projectPath: s.projectPath, workspaceId: s.workspaceId ?? null, metadata: s.metadata,
        createdAt: new Date(s.createdAt), updatedAt: new Date(s.updatedAt),
        claimedAt: s.claimedAt ? new Date(s.claimedAt) : null,
        completedAt: s.completedAt ? new Date(s.completedAt) : null,
      }));

    const activeWuIds = myActive.map(wu => wu.id);
    const allReplies = activeWuIds.length > 0
      ? (await this.fileStore.queryAllMessages({
          workUnitIds: activeWuIds,
          authorType: 'human',
        })).filter(msg => {
          const wu = myActive.find(w => w.id === msg.workUnitId);
          return wu && new Date(msg.createdAt).getTime() > wu.updatedAt.getTime();
        })
      : [];

    return { myActive, unassigned, newReplies: allReplies };
  }

  /** Execute one step via Agent process (Agent's token) */
  private async agentStep(target: Target): Promise<StepResult> {
    const wu = target.workUnit;
    const metadata = parseWuMetadata(wu.metadata);

    // B2 守卫（2026-08-03 token-burn issue P0-1c）：测试特征 WU 不起会话、直接关闭。
    // 历史事故：路由测试经共享数据根把测试 WU 写进生产 FileStore，daemon 当真任务逐个
    // 起 Claude 会话执行（16 个会话 420 万 token）。关闭留痕 testWorkUnitGuard + blockReason。
    if (testWuGuardEnabled() && isTestLikeWorkUnit(wu, metadata)) {
      logger.warn('[AgentLoop] Test-like WorkUnit guarded — closing without execution', {
        workUnitId: wu.id, scope: wu.scope,
      });
      await this.workUnitService.update(wu.id, {
        metadata: { ...metadata, testWorkUnitGuard: true, blockReason: 'test-wu-guard: 测试特征任务，守卫关闭' },
      }).catch(err => logger.warn('[AgentLoop] test-wu guard metadata write failed', { workUnitId: wu.id, error: String(err) }));
      if (wu.status !== 'closed') {
        await this.workUnitService.transitionStatus(wu.id, 'closed')
          .catch(err => logger.warn('[AgentLoop] test-wu guard close failed', { workUnitId: wu.id, error: String(err) }));
      }
      await this.postToDiscussionSpace(wu.id, '检测到测试特征任务，已跳过执行并关闭（防止测试数据空烧 token）')
        .catch(() => {});
      return { action: 'skipped', summary: '' };
    }

    // C3 守卫（2026-08-03 token-burn issue P2-2，决策记录 #4）：每日 token 预算熔断。
    // 当日 billed 口径消耗 ≥ 预算（默认 2M/日，STUDIO_DAILY_TOKEN_BUDGET 覆盖，<=0 关闭）→
    // 不起会话，WU 经 need_input 挂起（recordResult 落 waitingForInput + blockReason），
    // 等次日本地零点预算复位或人工处置；全局当日只告警一次（studio:budget-tripped 事件留痕）。
    // 用量走进程内计数器（daily-token-budget），仅首次/跨天全量扫一次事件文件，不拖慢热路径。
    if (tokenBudgetGuardEnabled()) {
      const dailyBudget = resolveDailyTokenBudget();
      if (dailyBudget > 0) {
        const eventsFile = studioEventsJsonlPath();
        const daily = await getDailyTokenUsage({ eventsFile });
        if (daily.usedTokens >= dailyBudget) {
          logger.warn('[AgentLoop] Daily token budget tripped — pausing automatic execution', {
            workUnitId: wu.id, usedTokens: daily.usedTokens, budget: dailyBudget,
          });
          if (!daily.notified) {
            await notifyBudgetTripped({ eventsFile, usedTokens: daily.usedTokens, budget: dailyBudget });
          }
          return {
            action: 'need_input' as const,
            summary: `每日 token 预算已熔断（当日已用 ${daily.usedTokens.toLocaleString()} / 上限 ${dailyBudget.toLocaleString()}，billed 口径含 cache_read）：已暂停自动执行、不再起会话。次日（本地零点）预算复位后回复任意内容继续，或直接关闭任务`,
          };
        }
      }
    }
    // P0 修复 6: traceId 贯穿 — 频道消息 → WU metadata → 执行参数（extraEnv）与日志行
    const traceId = typeof metadata.traceId === 'string' && metadata.traceId ? metadata.traceId : undefined;

    // §4.2 发言层新鲜度检查：step 开始记录频道版本（recordResult 回帖前比对）。
    // 读取失败按 undefined 处理 —— 跳过检查直接发帖，绝不阻断执行。
    const channelVersion = wu.channelId
      ? await this.fileStore.getChannelVersion(wu.channelId).catch(() => undefined)
      : undefined;

    // prompt 组装与上下文注入（hint 读取/注入/消费清除、skill > persona > roster > knowledge
    // 共用 2K 预算注入、三个 build 段函数）已抽到 ./prompt-composer.js（2026-08 工单 05，
    // 行为一字不改，事故档案注释随代码迁走）——agentStep 只保留编排。
    const composed = await composeStepPrompt(
      { wu, metadata, newReplies: target.newReplies?.map(r => r.content) },
      { role: this.role, acceptedTypes: this.acceptedTypes, fileStore: this.fileStore, resolveEventsFile: studioEventsJsonlPath },
    );
    const { prompt, pendingReplies, knowledgeContext, skillMatched, injectedKnowledgeIds } = composed;

    // Session management — #94 会话号 per-WU 化：只信档案 metadata.sessionId，
    // 实例单槽位（RuntimeInstance.sessionId）废弃（并行互踩 + 重启孤儿化）。
    // 续用判定在 worktree 解析之后进行（此时 workspaceRoot 才是本步真实 cwd），见下方。
    const metadataUpdates: Partial<WorkUnitMetadata> = {};
    if (skillMatched.length > 0) {
      // 决策 7: step 时匹配名单落盘 metadata.matchedSkills（随 recordResult 原子写入，
      // 供 skill-demotion 成功率与被无视率度量——替代原 claim 时 fire-and-forget 落盘，消竞态）
      metadataUpdates.matchedSkills = skillMatched;
    }
    // 已消费 hint（pendingReplies/commitGuardHint/verifyFailHint/childGuardHint）的清除增量
    // （undefined 在 JSON 序列化时丢弃，清除避免后续步骤重复注入）
    Object.assign(metadataUpdates, composed.consumedHintUpdates);

    // F6 → B3a: WorkUnit 绑定工程 → 解析执行根目录，经 parameters.workspaceRoot
    // 传给 agent-runner（resolveWorkspace Priority 1：直接以该目录为 cwd）。
    // metadata.workspaceRoot（B3a 归属链：Requirement→PMO gitRepo / 人工回复绑定）优先；
    // 否则按 wu.workspaceId 查 workspace 记录（F6 旧路径）；都没有 → 不传，保持现有 fallback。
    //
    // B3b-i（决策 D1）：代码类 WU（task/bug/feature/refactor）解析出 git 仓库根后，
    // 不再直接改共享目录 —— 执行 cwd 换成该仓库的专属 worktree
    // （<worktreesDir>/wu-<wuId>，分支 task/<wuId>）。同一 WU 跨 step 复用：
    // 首个 step 创建并把 worktreePath/branch/baseBranch/baseRepo 记入 metadata，
    // 后续 step 经 ensureWuWorktree 按目录存在性复用。创建失败走 B1 失败分支
    // （action='failed' → consecutiveStuck → 3 次 blocked），绝不静默退回共享目录。
    // 解析不出 git 仓库（无绑定根 / 根目录无 .git）→ 维持现状。
    let workspaceRoot = await this.resolveExecutionWorkspaceRoot(wu, metadata);
    if (CODE_WORKTREE_TYPES.has(wu.type) && workspaceRoot && isGitRepoRoot(workspaceRoot)) {
      try {
        // PMO-b（决策 3）：WU 归属 PMO → base 从默认分支改为 PMO 分支（分支名 = PMO id），
        // per-WU 临时分支从 PMO 分支拉、向 PMO 分支合（merge-on-review-pass 消费 pmoBranch 落档）。
        // 解析/建支失败回落默认 base，绝不阻断执行。
        let pmoBaseBranch: string | null = null;
        const pmoResolution = await resolvePmoBranchForWU(wu, this.fileStore).catch(() => null);
        if (pmoResolution) {
          try {
            await ensureBranchExists({
              repoDir: workspaceRoot,
              branch: pmoResolution.branch,
              baseBranch: typeof metadata.worktreeBaseBranch === 'string' && metadata.worktreeBaseBranch.length > 0
                ? metadata.worktreeBaseBranch
                : getDefaultBranch(workspaceRoot),
            });
            pmoBaseBranch = pmoResolution.branch;
          } catch (err) {
            logger.warn(`[AgentLoop] PMO branch ensure failed, falling back to default base: ${err instanceof Error ? err.message : String(err)}`, { traceId });
          }
        }
        const info = await ensureWuWorktree({
          wuId: wu.id,
          repoDir: workspaceRoot,
          worktreesDir: resolveWorktreesDir(),
          baseBranch: pmoBaseBranch
            ?? (typeof metadata.worktreeBaseBranch === 'string' && metadata.worktreeBaseBranch.length > 0
              ? metadata.worktreeBaseBranch
              : undefined),
        });
        if (metadata.worktreePath !== info.worktreePath) {
          metadataUpdates.worktreePath = info.worktreePath;
          metadataUpdates.worktreeBranch = info.branch;
          metadataUpdates.worktreeBaseBranch = info.baseBranch;
          metadataUpdates.worktreeBaseRepo = info.baseRepo;
          if (pmoResolution && pmoBaseBranch) {
            // 2026-08 归因统一：只落 pmoBranch（merge-on-review-pass 的合并目标）；
            // 项目 id 不再缓存落档（原 pmoProjectId 为冗余缓存），消费方经
            // resolvePmoProjectIdForWU 从创建期戳（metadata.pmoId / reqId）重解析
            metadataUpdates.pmoBranch = pmoResolution.branch;
          }
        }
        workspaceRoot = info.worktreePath;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`[AgentLoop] Worktree creation failed for ${wu.id}: ${message}`, { traceId });
        // 会话签发在 worktree 解析之后（#94），此处尚无会话簿记需重置
        return {
          action: 'failed' as const,
          summary: `worktree 创建失败: ${message.slice(0, 500)}`,
          metadataUpdates: {
            ...metadataUpdates,
            errorType: 'worktree_creation_failed',
            errorDetail: message.slice(0, 500),
            errorAt: new Date().toISOString(),
          },
        };
      }
    } else if (wu.type === 'review') {
      // B3b-i: review WU 继承父 WU worktree（评审能看到 diff）；父无 worktree → 维持现状
      const parentWorktree = await this.resolveParentWorktreePath(wu);
      if (parentWorktree) workspaceRoot = parentWorktree;
    }

    // AgentTask with new interface: provider, sessionId, maxTurns, knowledgeContext
    // F4: profile provider (registry id) → AgentTask. Cast via AgentTask['provider'] because
    // apps/api tsc resolves studio-agent types from its (possibly stale) dist/index.d.ts.
    // （取值前移：续用判定需要 provider）
    const taskProvider = (this.role.provider || 'claude') as AgentTask['provider'];
    // 续用判定（#94 per-WU 化）：只信档案 metadata.sessionId，不再读 instance 槽位。
    // claude 会话按 (HOME, cwd) 存储（2.1.80 实测：异 cwd --resume 报
    // "No conversation found with session ID"）——cwd 取本步最终 workspaceRoot（此时已是
    // 真实执行 cwd），会话文件 ~/.claude/projects/<cwd-slug>/<id>.jsonl 不在 → 直接走新建；
    // kimi/codex/opencode 为 cwd 维度续用（无 id 文件可查），档案有号即续用（cli-adapter 头部实证）。
    const resumeSessionId = shouldResumeSession(taskProvider, metadata.sessionId, workspaceRoot)
      ? metadata.sessionId!
      : null;
    let newSessionId: string | null = null;
    // B5（2026-08-03 token-burn issue P1-1，决策记录 #3）：每 WU 会话数上限。
    // 新建会话 = 从零重读 SKILL.md/探索文件 + 后续 step 全文重放，是最大的 token 放大器；
    // 超限转 need_input 等人工评估，替代静默重开。旧数据无 sessionCount 字段：已有 sessionId 的按已用 1 个计。
    const sessionsUsed = metadata.sessionCount ?? (metadata.sessionId ? 1 : 0);
    if (!resumeSessionId) {
      if (sessionsUsed >= MAX_SESSIONS_PER_WU) {
        logger.warn('[AgentLoop] Session limit reached — need human evaluation', {
          workUnitId: wu.id, sessionsUsed, max: MAX_SESSIONS_PER_WU,
        });
        return {
          action: 'need_input' as const,
          summary: `会话重建已达上限（${sessionsUsed}/${MAX_SESSIONS_PER_WU}）：反复从零重开会话会全文重放烧钱，已暂停自动执行。请人工评估后回复任意内容继续，或直接关闭任务`,
          metadataUpdates,
        };
      }
      newSessionId = randomUUID();
      metadataUpdates.sessionId = newSessionId;
      metadataUpdates.sessionCount = sessionsUsed + 1;
      metadataUpdates.startedAt = new Date().toISOString();
      metadataUpdates.lastSessionResumed = false;
    } else {
      // sessionResumes 不在此预增——#94 起只计实际续用成功的步（见成功路径统一落账）
      metadataUpdates.lastSessionResumed = true;
    }
    // 本步最终实际会话形态（续用降级重试后会被改写：换新号 + resumed=false）
    let effectiveSessionId: string | null = resumeSessionId ?? newSessionId;
    let sessionResumed = resumeSessionId !== null;
    const executionId = `${wu.id}-${Date.now()}`;
    // 本步步号（与 recordResult 的 stepCount+1 同口径）——Layer A 执行步事件与 Layer B 步内流式共用
    const stepNo = (metadata.stepCount ?? 0) + 1;
    const task: AgentTask = {
      id: wu.id,
      executionId,
      // F4: profile provider (registry id) → AgentTask. Cast via AgentTask['provider'] because
      // apps/api tsc resolves studio-agent types from its (possibly stale) dist/index.d.ts.
      provider: taskProvider,
      prompt,
      parameters: {
        // 续用：sessionId + sessionResume → cli-adapter 按 provider 换续用形态
        // （claude --resume <id>；kimi/opencode --continue、codex exec resume --last ——
        // Studio UUID 对这三家无意义，靠 CLI 自己的 cwd 维度会话记录续用，实证见 cli-adapter 头部）。
        // 新建：仅 claude 把新 sessionId 传给 CLI（--session-id 建会话 —— 不建则后续 --resume
        // 找不到会话，2.1.80 实测报 "No conversation found"）；kimi/codex/opencode 的 session
        // 参数均续用语义（实测未知 id 报 Session not found）→ 新建不传，CLI 自建会话。
        sessionId: resumeSessionId ?? (newSessionId && taskProvider === 'claude' ? newSessionId : undefined),
        ...(resumeSessionId ? { sessionResume: true } : {}),
        maxTurns: 50,
        knowledgeContext: knowledgeContext || undefined,
        agentRole: 'executor',
        workUnitId: wu.id,
        agentProfileId: this.role.id,
        ...(workspaceRoot ? { workspaceRoot } : {}),
        extraEnv: {
          STUDIO_WORKUNIT_ID: wu.id,
          STUDIO_CHANNEL_ID: wu.channelId ?? '',
          STUDIO_TRACE_ID: traceId ?? '',
        },
      },
      timeoutMs: 120_000,
      // Layer B（WU 过程可视化）：步内 stream-json 行级透传 → SSE 实时过程。
      // fire-and-forget；仅 LocalExecutor 同进程有效。
      onStreamLine: (line) => {
        void emitExecutionStreamLine({ workUnitId: wu.id, executionId, step: stepNo, line }).catch(() => {});
      },
    };

    // M2 成本红线度量 + B6 真实 token 记账（2026-08-03 token-burn issue P1-2）：
    // 成功与失败执行都记 workunit:tokens（失败照样烧 token）。fire-and-forget，绝不影响任务流程。
    const recordTokenEvent = (res: ExecutionResult): RealUsage | null => {
      const real = resolveRealUsage(res);
      void writeWorkunitTokenEvent(studioEventsJsonlPath(), {
        workUnitId: wu.id,
        executionId: task.executionId,
        injectedTokens: estimateTokens(knowledgeContext.length),
        executionTokens: real ? real.inputTokens + real.outputTokens : null,
        // D16/B6: 缓存命中与真实账单数据源（CLI 回报 usage 时才有；未回报则缺省不编造）
        ...(real ? {
          inputTokens: real.inputTokens,
          outputTokens: real.outputTokens,
          cacheReadTokens: real.cacheReadTokens,
          cacheCreationTokens: real.cacheCreationTokens,
          billedTokens: real.billedTokens,
          ...(real.costUsd ? { costUsd: real.costUsd } : {}),
          ...(real.numTurns ? { numTurns: real.numTurns } : {}),
        } : {}),
        // B6: 触发器来源落盘（按触发器聚合的输入）
        ...(typeof metadata.triggerId === 'string' && metadata.triggerId ? { triggerId: metadata.triggerId } : {}),
      }).catch(() => {});
      return real;
    };

    try {
      // Layer B: step 开始信号（CLI 首行到达前抽屉即有反馈）
      void emitExecutionStreamStepStart({ workUnitId: wu.id, executionId, step: stepNo }).catch(() => {});
      // §9.6: 经 Executor 接口执行（P0 恒为 LocalExecutor → agentRunner.executeLightweight）
      let result: ExecutionResult = await this.executor.execute(task);

      // W-3 接线：runner 失败时返回 { success:false } 而不抛错、且无 outputText ——
      // 直接落入 parseAgentOutput 会得到默认 progress（空 summary），导致 consecutiveStuck
      // 被清零、每 3s 重试、往频道发空消息。显式失败分支：action='failed'，由 recordResult
      // 记 consecutiveStuck + errorType/errorDetail，不发频道消息；连续 3 次走 blocked 路径。
      // 不带 channelVersion —— 失败不是发言，无需新鲜度检查（避免被降级为 progress）。
      if (result.success === false) {
        const failResult = (detail: string) => ({
          action: 'failed' as const,
          summary: `CLI 执行失败: ${detail}`,
          metadataUpdates: {
            ...metadataUpdates,
            errorType: 'execution_failed',
            errorDetail: detail,
            errorAt: new Date().toISOString(),
          },
        });
        let detail = (result.error ?? '未知错误').slice(0, 500);
        logger.error(`[AgentLoop] agentStep execution failed for ${wu.id}: ${detail}`, { traceId });
        // B6: 失败执行同样记账（CLI 已跑的轮次照样烧了 token，runner error 路径透出 usage）
        recordTokenEvent(result);
        // #94 续用降级：仅续用步 + 「会话不存在」错误（档案 sessionId 对应会话已被清理）→
        // 换发新 sessionId 重试一次（claude 传 --session-id、不带 sessionResume）。
        // 非续用类错误（超时/业务失败）与 catch 分支（spawn 异常）不触发；每步至多烧一次重试。
        if (resumeSessionId && RESUME_FAILURE_RE.test(detail)) {
          const fallbackSessionId = randomUUID();
          logger.warn(`[AgentLoop] Resume target session lost for ${wu.id} — falling back to a new session`, { traceId });
          task.parameters!.sessionId = taskProvider === 'claude' ? fallbackSessionId : undefined;
          delete task.parameters!.sessionResume;
          const retryResult: ExecutionResult = await this.executor.execute(task);
          if (retryResult.success === false) {
            // 降级重试仍失败 → 既有 failed 返回；新会话未建立，清掉未落盘的新会话簿记
            detail = (retryResult.error ?? '未知错误').slice(0, 500);
            logger.error(`[AgentLoop] agentStep fallback retry failed for ${wu.id}: ${detail}`, { traceId });
            recordTokenEvent(retryResult);
            this.resetUnestablishedSession(metadataUpdates);
            return failResult(detail);
          }
          // 降级成功：走正常成功路径；换新号落盘（sessionCount+1；绕过 MAX 上限一次——
          // 预算防线针对「反复从零重开」，降级是单次自愈）
          result = retryResult;
          effectiveSessionId = fallbackSessionId;
          sessionResumed = false;
          metadataUpdates.sessionId = fallbackSessionId;
          metadataUpdates.sessionCount = sessionsUsed + 1;
          metadataUpdates.lastSessionResumed = false;
        } else {
          // 首 step 失败：会话未必已建立，重置避免下步 --resume 一个从未建立的会话
          if (newSessionId) this.resetUnestablishedSession(metadataUpdates);
          return failResult(detail);
        }
      }

      // #94: sessionResumes 只计「实际续用成功」的步（续用尝试但降级/失败的步不计，防计数失真）
      if (sessionResumed) {
        metadataUpdates.sessionResumes = (metadata.sessionResumes ?? 0) + 1;
      }

      const stepResult = parseAgentOutput(result.outputText ?? '');

      // 执行成功 → 清除上一轮失败标记（undefined 在 JSON 序列化时丢弃）
      metadataUpdates.errorType = undefined;
      metadataUpdates.errorDetail = undefined;
      metadataUpdates.errorAt = undefined;

      // M2 成本红线度量 + B6 真实记账: 每次 CLI 执行完成记一条 workunit:tokens 事件
      // （注入估算 chars/4 vs 2K 红线；执行 tokens 取 CLI 真实 usage，未回报记 null 不编造）。
      const realUsage = recordTokenEvent(result);

      // wireup④ token 预算数据源: 本次真实消耗（billed 口径，含 cache）累加进
      // metadata._cumulativeTokens，随 metadataUpdates 由 recordResult 单次原子写入。
      // CLI 未回报 usage（realUsage=null）按 0 累加——即保持既有累计值不变。
      metadataUpdates._cumulativeTokens = (metadata._cumulativeTokens ?? 0) + (realUsage?.billedTokens ?? 0);

      // T-1.1: Record tool:call events for PatternMiner data source
      // D18: 写入统一事件文件（~/.studio/logs/studio-events.jsonl）
      // R2-fix: outputText 是 extractResult 后的纯文本（不含 stream-json 事件行），
      // 必须优先取 rawOutput（原始 stdout）——否则 parseStreamEvents 恒产 0 条。
      const toolTraceSource = result.rawOutput ?? result.outputText;
      if (toolTraceSource) {
        try {
          writeToolCallEvents(toolTraceSource, resolveToolTraceFile());
        } catch { /* non-blocking */ }
      }

      // WU 过程可视化：执行步事件（本步思考/工具调用/skill 注入/用量 → 事件流落盘 + SSE，
      // WU 详情抽屉消费；不进频道、不写 metadata 防膨胀）。fire-and-forget。
      void emitExecutionStepEvent({
        workUnitId: wu.id,
        executionId: task.executionId,
        sessionId: effectiveSessionId ?? undefined,
        // #94: 本步最终实际的续用形态（续用降级重试后 = false）
        sessionResumed,
        step: stepNo,
        action: stepResult.action,
        rawOutput: toolTraceSource,
        skills: skillMatched,
      }).catch(() => {});

      // GAP-6: recordOutcome + extractFromExecution (non-blocking)
      // R1: 携带本次注入的知识条目 id，反馈环才有数据
      this.recordExecutionOutcome(wu, result, injectedKnowledgeIds).catch(() => {});

      // R3 会话提取（断点 B）：任务 COMPLETE → 触发一次 LLM 知识提取（proposal 入库，
      // 审核前不注入）。模板式 extractFromExecution 保留为始终在线的兜底，两条链路独立。
      // fire-and-forget：无 LLM 配置/提取失败仅记日志，绝不影响任务完成。
      // 去重：metadata.knowledgeExtractedAt 标记后不再重复提取（随 recordResult 原子写入持久化）。
      if (stepResult.action === 'complete' && !metadata.knowledgeExtractedAt) {
        metadataUpdates.knowledgeExtractedAt = new Date().toISOString();
        const conversation = [
          { role: 'user', content: wu.scope ?? '' },
          ...pendingReplies.map(content => ({ role: 'user', content })),
          { role: 'assistant', content: stepResult.summary },
        ];
        try {
          void knowledgeService.extractFromConversation?.(conversation, { workUnitId: wu.id })
            ?.catch((err: unknown) =>
              logger.warn(`[AgentLoop] extractFromConversation failed: ${err instanceof Error ? err.message : String(err)}`)
            );
        } catch { /* non-blocking */ }
      }

      // Session truncation: detect input_tokens exceeding threshold
      this.checkSessionTruncation(result.outputText);

      // P0 修复（reviewReport 回传断链）：review 子 WU 报告 COMPLETE 时，把 reviewer
      // 最终输出解析为结构化结论写入 metadata.reviewReport —— 这是 ReviewDispatcher
      // 路径 B 判定父 WU 过/拒的唯一数据源。解析失败不写（dispatcher 转人工，不误拒）。
      if (wu.type === 'review' && stepResult.action === 'complete') {
        const report = parseReviewReport(result.outputText ?? '');
        if (report) {
          metadataUpdates.reviewReport = report;
        } else {
          logger.warn(`[AgentLoop] Review WU ${wu.id} completed without parseable REVIEW_RESULT — 由 ReviewDispatcher 转人工`);
        }
      }

      // PMO 分析接力（analysis-handoff）：analysis WU COMPLETE 时解析 TASK: 拆分行
      // 写入 metadata.analysisTasks —— 人工确认（reviewPassed → done）后由
      // analysis-handoff 据此建未指派 task 子 WU（频道成员涌现认领 = 派工）。
      // 解析失败/无 TASK 行不写（确认后仅提示可手动拆，不阻断完成）。
      if (wu.type === 'analysis' && stepResult.action === 'complete') {
        const tasks = parseTaskBreakdown(result.outputText ?? '');
        if (tasks.length > 0) {
          metadataUpdates.analysisTasks = tasks;
        }
      }

      // AC-4.3/4.4: Cache tracking — extract input_tokens from result events
      const tokens = extractInputTokens(result.outputText ?? '');
      if (tokens !== null) {
        metadataUpdates.lastInputTokens = tokens;
      }

      return { ...stepResult, metadataUpdates, channelVersion };
    } catch (err) {
      // W-3 fix: executeLightweight 失败返回 { success:false } 不抛错 —— 已在上方
      // success===false 显式分支接线（consecutiveStuck → blocked）；本 catch 只覆盖
      // 真正抛出的异常（如 spawn 失败），保持 need_input 语义。
      // 首 step 抛异常：会话未建立，重置避免下步 --resume 空 id
      if (newSessionId) this.resetUnestablishedSession(metadataUpdates);
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[AgentLoop] agentStep execute failed: ${message}`, { traceId });
      // AC-8.7 远程节点不可达分支已随 RemoteExecutor 一并删除（远程方向放弃，bdaf0dd3）。
      return {
        action: 'need_input' as const, // increments consecutiveStuck
        summary: `Agent execution failed: ${message}`,
        metadataUpdates,
      };
    }
  }

  // §10 P0 + 决策 7/11/13 + A2A §4.1 机制 2: buildSkillSection / buildPersonaSection /
  // buildRosterSection 已随 prompt 组装段一并抽到 ./prompt-composer.js（2026-08 工单 05，行为不变）。

  /**
   * B3a 归属链：执行根目录解析 — metadata.workspaceRoot（Requirement→PMO gitRepo /
   * 人工回复绑定的直接路径）优先；否则按 wu.workspaceId 查 workspace 记录（F6 旧路径）。
   */
  private async resolveExecutionWorkspaceRoot(wu: WorkUnitData, metadata: WorkUnitMetadata): Promise<string | null> {
    if (typeof metadata.workspaceRoot === 'string' && metadata.workspaceRoot.length > 0) {
      return metadata.workspaceRoot;
    }
    return wu.workspaceId ? this.resolveBoundWorkspaceRoot(wu.workspaceId) : null;
  }

  /**
   * F6: 解析 WorkUnit 绑定工程的执行根目录（workspace.workspaceRoot）。
   * 记录缺失/无 workspaceRoot/读取失败 → null（保持未绑定的默认行为）。
   */
  private async resolveBoundWorkspaceRoot(workspaceId: string): Promise<string | null> {
    try {
      const root = await resolveWorkspaceRoot(workspaceId);
      if (!root) {
        logger.warn(`[AgentLoop] Bound workspace ${workspaceId} unresolved, falling back to default cwd`);
      }
      return root;
    } catch (err) {
      logger.warn(`[AgentLoop] Workspace resolution failed for ${workspaceId}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * B3b-i: review WU 继承父 WU 的 worktree 路径（评审在父 worktree 里执行，能看到 diff）。
   * 父缺失/无 worktreePath/读取失败 → null（维持现状）。
   */
  private async resolveParentWorktreePath(wu: WorkUnitData): Promise<string | null> {
    if (!wu.parentId) return null;
    try {
      const parent = await this.workUnitService.getById(wu.parentId);
      const parentMeta: WorkUnitMetadata = parseWuMetadata(parent?.metadata);
      return typeof parentMeta.worktreePath === 'string' && parentMeta.worktreePath.length > 0
        ? parentMeta.worktreePath
        : null;
    } catch {
      return null;
    }
  }

  /**
   * B3b-i: 提交守卫/自动验证的 git cwd 解析（recordResult 侧只读消费，不创建）。
   * 代码类 WU 有专属 worktree → 在 worktree 下跑 git status；
   * review WU → 父 WU worktree；否则回退 B3a/F6 的共享根解析。
   */
  private async resolveExecutionCwd(wu: WorkUnitData, metadata: WorkUnitMetadata): Promise<string | null> {
    if (CODE_WORKTREE_TYPES.has(wu.type)
      && typeof metadata.worktreePath === 'string' && metadata.worktreePath.length > 0) {
      return metadata.worktreePath;
    }
    if (wu.type === 'review') {
      const parentWorktree = await this.resolveParentWorktreePath(wu);
      if (parentWorktree) return parentWorktree;
    }
    return this.resolveExecutionWorkspaceRoot(wu, metadata);
  }

  /**
   * B3b-i（决策 D3 前半）验证命令解析与执行已抽到 ./wu-verification.js（F6-c）——
   * resolveVerifyCommands / runWuVerification 为模块级导出，行为不变。
   * §10.5 提交守卫的 git 探针（hasUncommittedChanges/readHeadHash）与收口守卫链
   * 已抽到 ./completion-gates.js（2026-08，行为不变）；resolveExecutionCwd /
   * listUnfinishedChildren 因绑定 workUnitService/fileStore 留在本类，经 deps 下传。
   */

  /** Record execution outcome to knowledge service (GAP-6, non-blocking).
   *  R1: consumedKnowledge = 本次 agentStep 经 injectContext 实际注入的知识条目 id。 */
  private async recordExecutionOutcome(wu: WorkUnitData, result: ExecutionResult, consumedKnowledge: string[] = []): Promise<void> {
    try {
      await knowledgeService.recordOutcome({
        executionId: wu.id,
        agentType: 'claude',
        consumedKnowledge,
        success: result.success,
        details: result.outputText?.slice(0, 500) ?? '',
        timestamp: new Date().toISOString(),
      });
    } catch {
      // Non-blocking
    }
    try {
      await knowledgeService.extractFromExecution({
        task: wu.scope ?? '',
        diff: result.outputText ?? '',
        success: result.success,
        duration: result.totalDurationMs ?? 0,
        agentType: 'claude',
        consumedKnowledge,
      });
    } catch {
      // Non-blocking
    }
  }

  /**
   * 首 step（新建会话）执行失败 / 续用降级重试仍失败时重置会话簿记：CLI 会话未必已建立
   * （可能根本没 spawn 到），不重置则下一步按续用发 `--resume <从未建立的 id>`
   * （claude 必报 "No conversation found"）。续用 step 失败不调用 —— 会话已存在，
   * 保留下一步继续 resume。（#94：实例槽位清除已随 per-WU 化一并移除）
   */
  private resetUnestablishedSession(metadataUpdates: Partial<WorkUnitMetadata>): void {
    delete metadataUpdates.sessionId;
    // B5: 会话未建立不计入会话预算（失败重试由 consecutiveStuck>=3 → blocked 兜底）
    delete metadataUpdates.sessionCount;
    delete metadataUpdates.lastSessionResumed;
  }

  /** Check execution output for input_tokens exceeding threshold（#94 起仅留观测日志，不再清会话） */
  private checkSessionTruncation(outputText: string | undefined): void {
    if (!outputText) return;
    try {
      // Parse stream JSON events for usage data
      const lines = outputText.split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          if (event.type === 'usage' && typeof event.input_tokens === 'number') {
            const inputTokens = event.input_tokens as number;
            if (inputTokens > SESSION_TOKEN_LIMIT) {
              logger.info(`[AgentLoop] Session truncation: ${inputTokens} tokens exceeds limit ${SESSION_TOKEN_LIMIT}`);
            }
          }
        } catch {
          // Skip non-JSON lines
        }
      }
    } catch {
      // Non-blocking
    }
  }

  /** Record result: monitoring checkpoints + state transitions (zero token) */
  private async recordResult(target: Target, result: StepResult): Promise<void> {
    // B2: 测试特征 WU 守卫已在 agentStep 自行关闭 WU 并留痕，无需任何簿记/状态迁移
    if (result.action === 'skipped') return;
    const wuId = target.workUnit.id;
    const wu = await this.workUnitService.getById(wuId);
    if (!wu) return;

    // 提交守卫/自动验证必须以「持久化 + 本 step metadataUpdates」的合并视图为准
    // （首 step 的 worktreePath 尚未落库，只看持久化值会漏拦 → 假 complete；
    //   完整事故实录与 undefined-清除口径见 workunit/wu-metadata.ts mergedWuView）
    const metadata: WorkUnitMetadata = mergedWuView(wu.metadata, result.metadataUpdates);
    // P0 修复 6: traceId（与 agentStep 同一来源，供日志行携带）
    const traceId = typeof metadata.traceId === 'string' && metadata.traceId ? metadata.traceId : undefined;

    // 收口守卫链（§10.5 提交守卫 → §6-2 子任务守卫 → B3b-i 自动验证守卫）已抽到
    // ./completion-gates.js（行为一字不改，含守卫顺序/hint 写法/l1 台账/合并视图口径）——
    // recordResult 只保留编排：构建合并视图（上方）→ 跑守卫 → delegate/新鲜度/强制收口 →
    // 单次原子写 → 状态迁移与频道通知。git/子任务查询经 deps 注入（loop 绑定的两个方法下传）。
    const guards = await runCompletionGuards(
      { wu, wuId, metadata, action: result.action, roleId: this.role.id },
      {
        resolveExecutionCwd: (w, m) => this.resolveExecutionCwd(w, m),
        listUnfinishedChildren: id => this.listUnfinishedChildren(id),
      },
    );
    let action = guards.action;
    const guardUpdates = guards.guardUpdates;
    const noCommitNotice = guards.notices.noCommit;
    const verifyBlocked = guards.notices.verifyBlocked;
    const verifyPassNotice = guards.notices.verifyPassed;
    // F6-c：本 step COMPLETE 守卫是否已跑过验证 —— 下方步骤超限强制收口路径据此避免重复跑
    const verifyGuardRan = guards.notices.verifyGuardRan;

    // A2A §4.1: DELEGATE 分支 —— DelegationGate 纯代码校验（零 LLM）后的委派政策
    // （通过：建子单 + collab 元数据 + delegate 卡片，父 WU 按 progress 继续；
    //  拒绝：降级 NEED_INPUT 请人裁决）已抽到 ./delegate-branch.js（2026-08 工单 05，行为不变）。
    if (action === 'delegate' && result.delegate) {
      const d = await handleDelegateBranch(
        { wu, wuId, delegate: result.delegate },
        { fileStore: this.fileStore, role: this.role, createWorkUnit: input => this.workUnitService.create(input) },
      );
      action = d.action;
      result.summary = d.summary;
      if (d.collabUpdate) guardUpdates.collab = d.collabUpdate;
    }

    // §4.2 发言层新鲜度检查（仅 recordResult → postToDiscussionSpace 结果回帖路径，系统通知不受影响）：
    // step 期间房间有外部新消息 → 不直接发帖，新消息写入 pendingReplies 注入下一轮 prompt，
    // 本步按 progress 处理；同一结果连续 2 次被拦截仍判定要发 → 照发并注明「发送时房间有新消息」。
    let skipResultPost = false;
    const freshnessUpdates: Partial<WorkUnitMetadata> = {};
    if (result.channelVersion && wu.channelId) {
      const arrived = await this.fileStore.getMessagesSinceLine(wu.channelId, result.channelVersion.lineCount);
      // 本 loop 自己发的消息（如 delegate 卡片）不算「房间已变」
      const external = arrived.filter(m => !(m.authorType === 'agent' && m.agentName === this.role.name));
      const interrupts = metadata.freshnessInterrupts ?? 0;
      if (external.length > 0 && interrupts < 2) {
        skipResultPost = true;
        action = 'progress';
        freshnessUpdates.pendingReplies = external.map(m =>
          m.authorType === 'agent' ? `[${m.agentName ?? 'agent'}]: ${m.content}` : m.content
        );
        freshnessUpdates.freshnessInterrupts = interrupts + 1;
        logger.info(`[AgentLoop] Freshness: result post held for ${wuId} (${external.length} new message(s), interrupt ${interrupts + 1}/2)`);
      } else {
        if (external.length > 0) {
          result.summary = `${result.summary}（发送时房间有新消息）`;
        }
        if (interrupts > 0) {
          freshnessUpdates.freshnessInterrupts = 0;
        }
      }
    }

    const stepCount = (metadata.stepCount ?? 0) + 1;
    let consecutiveStuck = action === 'progress' ? 0 : (metadata.consecutiveStuck ?? 0) + 1;

    // F6-c（断点 1）：步骤超限强制收口前补跑 L1 —— COMPLETE 验证守卫只在 action=complete 时跑，
    // 超限路径（任意 action）此前完全跳过验证，代码类 WU 被强制 in_review 时永远缺 l1。
    // 台账写法与 COMPLETE 守卫同结构（approved 全绿 + verifyReport / rejected 留痕），
    // 但不计 verifyFailCount、不改 blocked 语义——仍按原计划进 in_review 交人工。
    // 本 step COMPLETE 守卫已跑过验证时不重复跑；无命令可跑 → 不写 attestation（维持现状）。
    // attestation 合进下方同一次 metadata 原子写回，不单独写库（防竞态）。
    const forceClosing = stepCount > (wu.type === 'review' ? REVIEW_STEP_LIMIT : STEP_LIMIT);
    if (forceClosing && !verifyGuardRan
      && CODE_WORKTREE_TYPES.has(wu.type)
      && typeof metadata.worktreePath === 'string' && metadata.worktreePath.length > 0) {
      const outcome = await runWuVerification(wu, metadata, metadata.worktreePath);
      if (outcome.failure) {
        guardUpdates.attestations = withAttestation(metadata.attestations, 'l1', {
          verdict: 'rejected',
          by: this.role.id,
          at: new Date().toISOString(),
          kind: 'verify',
          summary: `失败命令: ${outcome.failure.command}`.slice(0, 300),
        });
        logger.info(`[AgentLoop] Force-close verify: l1 rejected for ${wuId} (command failed: ${outcome.failure.command})`);
      } else if (outcome.ran.length > 0) {
        guardUpdates.verifyReport = {
          commands: outcome.ran,
          source: outcome.source,
          passedAt: new Date().toISOString(),
        };
        guardUpdates.attestations = withAttestation(metadata.attestations, 'l1', {
          verdict: 'approved',
          by: this.role.id,
          at: new Date().toISOString(),
          kind: 'verify',
          summary: outcome.ran.join('；').slice(0, 300),
        });
        logger.info(`[AgentLoop] Force-close verify: all passed for ${wuId}`, { commands: outcome.ran, source: outcome.source });
      }
    }

    // F5: NEED_INPUT 挂起标记（等待人类回复）；其他结果清除挂起标记（恢复后继续执行）
    const waitingUpdates: Partial<WorkUnitMetadata> = action === 'need_input'
      ? {
          waitingForInput: true,
          waitingQuestion: result.summary,
          waitingSince: new Date().toISOString(),
          waitingReminded: false,
        }
      : metadata.waitingForInput
        ? { waitingForInput: false, waitingReminded: false }
        : {};

    // B4（2026-08-03 token-burn issue P0-2）：blocked 原因落盘 —— 审计类 WU 全部 blocked
    // 却无据可查的事故教训；本步不走 blocked 路径时清除陈旧原因（恢复执行即翻篇）。
    const blockReasonUpdates: Partial<WorkUnitMetadata> = {};
    if (verifyBlocked) {
      blockReasonUpdates.blockReason = `verify-failed x${guardUpdates.verifyFailCount}: 自动验证连续失败`;
    } else if (consecutiveStuck >= 3) {
      blockReasonUpdates.blockReason = action === 'failed' && result.summary
        ? `stuck: 连续 3 步无进展（${result.summary.slice(0, 200)}）`
        : 'stuck: 连续 3 步无进展';
    } else if (action === 'need_input') {
      blockReasonUpdates.blockReason = `need-input: ${result.summary.slice(0, 200)}`;
    } else if (metadata.blockReason) {
      blockReasonUpdates.blockReason = undefined; // undefined 在 JSON 序列化时丢弃 → 清除
    }

    // Single atomic metadata write: merges agentStep updates (sessionId/startedAt/sessionResumes)
    // with monitoring counters (stepCount/consecutiveStuck) — fixes C-3 non-atomic write
    await this.workUnitService.update(wuId, {
      metadata: { ...metadata, ...result.metadataUpdates, ...waitingUpdates, ...guardUpdates, ...freshnessUpdates, ...blockReasonUpdates, stepCount, consecutiveStuck },
    });

    // P0 修复 6: trace 锚点 — 有 traceId 的 WU（频道消息链路）每步留一条可 grep 日志
    if (traceId) {
      logger.info(`[AgentLoop] Step recorded for ${wuId}`, { traceId, action, stepCount });
    }

    // §10.5: 连续 3 步无新提交 → 频道提醒一次（计数已归零，之后每 3 步再提醒）
    if (noCommitNotice) {
      await this.postToDiscussionSpace(wuId, `任务 ${wuId} 连续 3 步无新提交，请注意及时 commit`);
    }

    // B3b-i: 自动验证连续失败 ≥3 次 → blocked 并频道说明（优先于 step limit / 状态迁移）
    if (verifyBlocked) {
      if (wu.status !== 'blocked') {
        await this.workUnitService.transitionStatus(wuId, 'blocked');
      }
      // 2026-07 PMO-flow UX（§6-3）：验证失败打回/转人工里程碑 —— meta 带 pmoId（可解析时）+ atHuman
      await this.postToDiscussionSpace(
        wuId,
        `自动验证连续失败 ${guardUpdates.verifyFailCount} 次，任务已转 blocked，等待人类介入。最近失败命令与输出已记录到任务上下文`,
        wu,
      );
      return;
    }

    // B3b-i: 验证全绿 → 频道简报（跑了哪几条；仅当 COMPLETE 未被其他守卫拦截）
    if (verifyPassNotice && action === 'complete') {
      await this.postToDiscussionSpace(wuId, verifyPassNotice);
    }

    // Monitoring: step limit（review WU 用放宽阈值，见 REVIEW_STEP_LIMIT 注释）
    if (stepCount > (wu.type === 'review' ? REVIEW_STEP_LIMIT : STEP_LIMIT)) {
      // C-2 fix: blocked→in_review is not in VALID_TRANSITIONS, go through active first
      if (wu.status === 'blocked') {
        await this.workUnitService.transitionStatus(wuId, 'active');
      }
      await this.workUnitService.transitionStatus(wuId, 'in_review');
      await this.postToDiscussionSpace(wuId, '步骤数超限，强制提交审查');
      return;
    }
    // Monitoring: stuck detection
    if (consecutiveStuck >= 3) {
      await this.workUnitService.transitionStatus(wuId, 'blocked');
      // W-3 接线：执行失败导致的 blocked 在频道说明失败原因（summary 含 CLI 错误详情）
      const stuckReason = action === 'failed' && result.summary ? `（${result.summary}）` : '';
      // 2026-07 PMO-flow UX（§6-3）：blocked 转人工里程碑 —— meta 带 pmoId（可解析时）+ atHuman
      await this.postToDiscussionSpace(wuId, `连续 3 步无进展${stuckReason}，等待人类介入`, wu);
      return;
    }

    // State transitions by action (§10.5: 使用守卫降级后的 action；§4.2: 新鲜度拦截时不发帖)
    // 非空守卫：summary 为空（如 CLI 成功但无文本输出）不发帖，避免频道空消息。
    switch (action) {
      case 'progress':
        if (!skipResultPost && result.summary.trim().length > 0) await this.postToDiscussionSpace(wuId, result.summary);
        if (wu.status === 'blocked') {
          await this.workUnitService.transitionStatus(wuId, 'active');
        }
        break;
      case 'complete':
        // 2026-07 PMO-flow UX（§6-3）：COMPLETE 完成汇报里程碑 —— meta 带 pmoId（可解析时）+ atHuman
        if (!skipResultPost && result.summary.trim().length > 0) {
          await this.postToDiscussionSpace(wuId, result.summary, wu);
        }
        // C-2 fix: blocked→in_review is not in VALID_TRANSITIONS, go through active first
        if (wu.status === 'blocked') {
          await this.workUnitService.transitionStatus(wuId, 'active');
        }
        await this.workUnitService.transitionStatus(wuId, 'in_review');
        // P0 修复（reviewReport 回传断链）：review 子 WU 不再被二次评审
        // （ReviewDispatcher 路径 A 跳过 type=review），complete 后直接收口 done，
        // 触发路径 B 读取 metadata.reviewReport 判定父 WU reviewPassed/reviewRejected。
        if (wu.type === 'review') {
          await this.workUnitService.transitionStatus(wuId, 'done');
        }
        break;
      case 'need_input':
        // 2026-07 PMO-flow UX（§6-3）：NEED_INPUT 里程碑 —— meta 带 pmoId（可解析时）+ atHuman
        if (!skipResultPost) {
          await this.postToDiscussionSpace(wuId, `需要输入: ${result.summary}`, wu);
        }
        // F5: 挂起 — 守卫重复 NEED_INPUT（blocked → blocked 不在 VALID_TRANSITIONS 中）
        if (wu.status !== 'blocked') {
          await this.workUnitService.transitionStatus(wuId, 'blocked');
        }
        break;
      case 'failed':
        // W-3 接线：CLI 执行失败 —— 不发频道消息、不做状态迁移（保持 active 待重试）；
        // consecutiveStuck 已在上方累计，满 3 次走 blocked 路径并说明失败原因。
        break;
    }
  }

  /** §6-2 父 complete 守卫：未完结（unassigned/active/blocked/in_review）子 WU 的 id 列表 */
  private async listUnfinishedChildren(wuId: string): Promise<string[]> {
    const snapshots = await this.fileStore.getIndex();
    return snapshots
      .filter(s => s.parentId === wuId && !['done', 'closed'].includes(s.status))
      .map(s => s.id);
  }

  /** Post message to discussion space（经 wu-messenger → ChannelMessageService：eventBus + SSE，频道页实时可见）。
   *  milestoneWu 存在时按里程碑消息处理（2026-07 PMO-flow UX §6-3：meta 带 pmoId?/atHuman，普通 progress 不带）；
   *  2026-08 归因统一后解析链只读创建期持久化数据（metadata.pmoId / reqId），调用方直接传持久化 wu 本体，
   *  不再需要「持久化 + 本 step metadataUpdates」合并视图。 */
  private async postToDiscussionSpace(workUnitId: string, content: string, milestoneWu?: WorkUnitData): Promise<void> {
    if (!content.trim()) return;
    const wu = milestoneWu ?? await this.workUnitService.getById(workUnitId);
    if (!wu) return;

    // 绑定本 loop 的 fileStore（测试注入临时 store；生产与全局同目录），事件形状与全局 service 一致
    await postWuSystemMessage(wu, content, {
      agentName: this.role.name,
      fileStore: this.fileStore,
      ...(milestoneWu ? { milestone: true } : {}),
    });
  }

}
