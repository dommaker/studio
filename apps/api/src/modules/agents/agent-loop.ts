// AgentLoop — observe→resolveTarget→agentStep→recordResult decision loop (AS-025)
// Orchestration layer: zero LLM calls. Agent = external compute (Claude Code/OpenCode/Codex).
// Knowledge search analysis preserved as module-level exports.
import { execSync } from 'child_process';
import { eventBus, logger, parseStreamEvents, extractToolCalls, FileStore, parseChannels, estimateTokens, type RuntimeStateData, type ChannelMessageData } from '@dommaker/studio-shared';
import { resolveProviderDefinition, buildHealthProbeCommand, execSh } from '@dommaker/studio-shared/node';
import { randomUUID } from 'crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import * as os from 'os';
import type { AgentTask, ExecutionResult } from '@dommaker/studio-agent';
import { ensureWuWorktree } from '@dommaker/studio-agent';
import { LocalExecutor, type Executor } from './executor.js';
import { RemoteExecutor, RemoteNodeUnreachableError } from './remote-executor.js';
import { WorkUnitService, type WorkUnitMetadata, type WorkUnitData } from '../workunit/workunit.service.js';
import { checkDelegation, effectiveParentCollab, resolveMaxDepth, MAX_DELEGATIONS_PER_PARENT, type CollabMeta } from '../workunit/delegation-gate.js';
import type { AgentProfileData } from '@dommaker/studio-shared';
import { getTriggerScheduler } from '../triggers/trigger-registry.js';
import { knowledgeService } from '../knowledge/knowledge-service.js';
import { loadManifest } from '../skills/manifest-loader.js';
import { eventStore } from '../../core/event-store.js';
import { getWorkspaceRecord, resolveWorkspaceRoot } from '../workspaces/workspace-store.js';
import { resolveStudioLogFile } from '../../utils/studio-log-path.js';
import { resolveStudioEventsFile } from '../../utils/studio-events.js';

/** Threshold for input_tokens before session truncation (100K) */
const SESSION_TOKEN_LIMIT = 100_000;

/** B3b-i: 代码类 WU（执行面强制专属 worktree 隔离） */
const CODE_WORKTREE_TYPES = new Set(['task', 'bug', 'feature', 'refactor']);
/** 步骤数上限：超限强制 in_review 交人工。review WU 单独放宽——
 *  评审职责是读不是写，无提交守卫豁免后正常 ≤5 步收口；阈值仅是防死循环的安全阀 */
const STEP_LIMIT = 15;
const REVIEW_STEP_LIMIT = 30;
/** B3b-i: 单条验证命令超时 10min；失败注入 prompt 的输出尾部上限 */
const VERIFY_COMMAND_TIMEOUT_MS = 600_000;
const VERIFY_FAIL_TAIL_CHARS = 2_000;

/** M2: workunit:tokens 事件写入目标（与 knowledge consumption/outcome 事件同一事件流） */
const STUDIO_EVENTS_JSONL = resolveStudioLogFile('studio-events.jsonl');
const metricsFileStore = new FileStore();

/** F6-fix: 空闲分支心跳节流间隔 — agent-timeout-scan 阈值为 5min，45s 一次足够保活 */
const IDLE_HEARTBEAT_INTERVAL_MS = 45_000;

/**
 * §10 P0: 注入总预算（skill 段 + 知识段共用的 2K 红线）。
 * 必须与 knowledge-service 的 INJECT_TOKEN_BUDGET 保持一致——
 * 不从 knowledge-service import：现有测试以 vi.mock 工厂替换整个 knowledge-service
 * 模块（只暴露 knowledgeService），新增命名导入会在 mock 模块上访问不到而抛错。
 */
const INJECT_TOKEN_BUDGET = 2_000;

/** Result of analyzing agent log for knowledge search behavior */
export interface KnowledgeSearchAnalysis {
  searched: boolean;
  searchCalls: Array<{ tool: string; detail?: string }>;
}

/** Agent output action after parsing */
export interface StepResult {
  // 'failed': CLI 执行失败（runner 返回 success:false）的显式分支——记 consecutiveStuck、
  // 不发频道消息，达到 3 次走既有 blocked 路径（W-3 接线，见 agentStep）
  action: 'progress' | 'complete' | 'need_input' | 'delegate' | 'failed';
  summary: string;
  /** A2A §4.1: DELEGATE 协议解析结果（action='delegate' 时存在） */
  delegate?: { targetName: string; scope: string };
  /** §4.2 发言层新鲜度检查：step 开始时捕获的频道版本（agentStep 写入，recordResult 比对） */
  channelVersion?: { lineCount: number; lastMessageId: string | null };
  /** Metadata fields to merge into WorkUnit.metadata (set by agentStep, written atomically by recordResult) */
  metadataUpdates?: Partial<WorkUnitMetadata>;
}

/** Observation collected from DB */
interface Observations {
  myActive: WorkUnitData[];
  unassigned: WorkUnitData[];
  newReplies: ChannelMessageData[];
}

/** Resolved target for agentStep */
interface Target {
  workUnit: WorkUnitData;
  newReplies?: ChannelMessageData[];
}

interface RuntimeInstanceRow {
  id: string;
  roleId: string;
  sessionId: string | null;
  status: string;
  currentWorkUnitId: string | null;
  startedAt: string;
  terminatedAt: string | null;
  metadata: string | null;
  lastHeartbeat: string | null;
}

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

  constructor(role: AgentProfileData, fileStore?: FileStore) {
    this.role = role;
    this.fileStore = fileStore ?? new FileStore();
    this.workUnitService = new WorkUnitService(this.fileStore);
    this.acceptedTypes = this.parseAcceptedTypes(role.description);
    // W-4 fix + F3: parse channels from role.channels JSON（容错历史双重编码值）
    this.myChannels = parseChannels(role.channels);
    // §9.6: 执行面走 Executor 接口。profile.nodeId: undefined/'local' → LocalExecutor
    // 其他 → RemoteExecutor(nodeId)。P1 WS 通道留桩，RemoteExecutor 暂抛不可达错误。
    if (role.nodeId && role.nodeId !== 'local') {
      this.executor = new RemoteExecutor(role.nodeId);
      logger.info('[AgentLoop] RemoteExecutor selected', { role: role.name, nodeId: role.nodeId });
    } else {
      this.executor = new LocalExecutor();
    }
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
      const stalePrev = allStates.find(s => s.roleId === this.role.id && s.status !== 'error' && s.pid && !isProcessAlive(s.pid));
      if (stalePrev) {
        logger.info(`[AgentLoop] Cleaning up stale instance ${stalePrev.id} (PID ${stalePrev.pid})`);
        await this.fileStore.updateState(stalePrev.id, { status: 'terminated' }).catch(() => {});
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
    // W-6 fix: batch query for newReplies instead of N+1
    const myActive = (await this.workUnitService.list({
      assigneeId: this.instance?.id,
    })).data.filter(wu => wu.status === 'active' || wu.status === 'blocked');

    const allSnapshots = await this.fileStore.getIndex();
    // §9.5: channel.members 为成员关系唯一事实源 — observe 每轮加载一次频道配置
    // （FileStore 规模小，成本可忽略）。
    const channelMembers = await this.loadChannelMembers();
    const unassigned = allSnapshots.filter(s => {
      if (s.status !== 'unassigned') return false;
      // Assignee-aware claiming（@mention 语义，docs/vision-2026.md §3）：
      // 显式指派给某个 profile 的 WorkUnit 只能被该 profile 的 loop 认领；
      // 未指派的保持频道作用域（§9.5: 频道 members 含本 profile + acceptedTypes 匹配）。
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
      if (this.acceptedTypes.length > 0 && !this.acceptedTypes.includes(s.type)) return false;
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
    const metadata = (wu.metadata ? JSON.parse(wu.metadata) : {}) as WorkUnitMetadata;
    // P0 修复 6: traceId 贯穿 — 频道消息 → WU metadata → 执行参数（extraEnv）与日志行
    const traceId = typeof metadata.traceId === 'string' && metadata.traceId ? metadata.traceId : undefined;

    // §4.2 发言层新鲜度检查：step 开始记录频道版本（recordResult 回帖前比对）。
    // 读取失败按 undefined 处理 —— 跳过检查直接发帖，绝不阻断执行。
    const channelVersion = wu.channelId
      ? await this.fileStore.getChannelVersion(wu.channelId).catch(() => undefined)
      : undefined;

    // F5: 恢复挂起时由 message-routing 写入的人类回复（优先级最高，注入后即消费）
    const pendingReplies = Array.isArray(metadata.pendingReplies)
      ? metadata.pendingReplies.filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
      : [];

    // §10.5 提交守卫：上一轮 COMPLETE 被打回时 recordResult 写入的提示（注入后即消费）
    const commitGuardHint = typeof metadata.commitGuardHint === 'string' && metadata.commitGuardHint.length > 0
      ? metadata.commitGuardHint
      : null;

    // B3b-i 自动验证：上一轮 COMPLETE 因验证失败被打回时 recordResult 写入的提示（注入后即消费）
    const verifyFailHint = typeof metadata.verifyFailHint === 'string' && metadata.verifyFailHint.length > 0
      ? metadata.verifyFailHint
      : null;

    // §6-2 父 complete 守卫：上一轮 COMPLETE 因子任务未完结被打回时的提示（注入后即消费）
    const childGuardHint = typeof metadata.childGuardHint === 'string' && metadata.childGuardHint.length > 0
      ? metadata.childGuardHint
      : null;

    const basePrompt = pendingReplies.length > 0
      ? buildReplyPrompt(wu, pendingReplies)
      : target.newReplies?.length
        ? buildReplyPrompt(wu, target.newReplies.map(r => r.content))
        : buildContinuePrompt(wu);
    let prompt = basePrompt;
    if (commitGuardHint) prompt = `${prompt}\n\n## 提交提醒\n\n${commitGuardHint}`;
    if (verifyFailHint) prompt = `${prompt}\n\n## 验证失败\n\n${verifyFailHint}`;
    if (childGuardHint) prompt = `${prompt}\n\n## 子任务提醒\n\n${childGuardHint}`;

    // GAP-5: Knowledge injection — non-blocking
    // R1 反馈环: 接住 injectContext 返回的 injectedIds，贯穿到 recordOutcome /
    // extractFromExecution 的 consumedKnowledge（断点 A：此前注入 id 被丢弃，
    // outcome 永远上报 consumedKnowledge: []，飞轮无反馈数据）。
    // §10 P0: skill 索引段（## 本次任务 Skills）先于知识段注入，共用 2K 红线——
    // skill 先占预算，剩余额度传给 injectContext（skill 是本次任务的主动指令）。
    // A2A §4.1 机制 2: 成员花名册段（## 频道成员与委派）在 skill 之后、知识之前，
    // 共用 2K 红线（优先级：skills index > roster > knowledge）。
    let skillSection = '';
    let skillTokens = 0;
    try {
      const composed = await this.buildSkillSection(wu, metadata);
      skillSection = composed.section;
      skillTokens = composed.tokens;
    } catch {
      // Non-blocking: agent continues without skill section
    }

    let rosterSection = '';
    let rosterTokens = 0;
    try {
      const roster = await this.buildRosterSection(wu, Math.max(0, INJECT_TOKEN_BUDGET - skillTokens));
      rosterSection = roster.section;
      rosterTokens = roster.tokens;
    } catch {
      // Non-blocking: agent continues without roster section
    }

    let knowledgeContext = '';
    let injectedKnowledgeIds: string[] = [];
    try {
      const ctx = await knowledgeService.injectContext(wu.type, {
        tags: [wu.type],
        maxTokens: Math.max(0, INJECT_TOKEN_BUDGET - skillTokens - rosterTokens),
      });
      knowledgeContext = ctx.prompt;
      injectedKnowledgeIds = ctx.injectedIds ?? [];
    } catch {
      // Non-blocking: agent continues without knowledge context
    }
    const leadSections = [skillSection, rosterSection].filter(s => s.length > 0).join('\n\n');
    if (leadSections) {
      knowledgeContext = knowledgeContext
        ? `${leadSections}\n\n## 项目上下文\n${knowledgeContext}`
        : leadSections;
    }

    // Session management — per-Agent session (GAP-2: RuntimeInstance.sessionId)
    const metadataUpdates: Partial<WorkUnitMetadata> = {};
    if (pendingReplies.length > 0) {
      // F5: 回复已注入 prompt，清除避免后续步骤重复注入（undefined 在 JSON 序列化时丢弃）
      metadataUpdates.pendingReplies = undefined;
    }
    if (commitGuardHint) {
      // §10.5: 提示已注入 prompt，清除避免后续步骤重复注入
      metadataUpdates.commitGuardHint = undefined;
    }
    if (verifyFailHint) {
      // B3b-i: 提示已注入 prompt，清除避免后续步骤重复注入
      metadataUpdates.verifyFailHint = undefined;
    }
    if (childGuardHint) {
      // §6-2: 提示已注入 prompt，清除避免后续步骤重复注入
      metadataUpdates.childGuardHint = undefined;
    }
    // 续用判定（fix/guard-and-resume）：同一 WU 内才续用。claude 会话按 (HOME, cwd) 存储
    // （2.1.80 实测：异 cwd --resume 报 "No conversation found with session ID"），
    // B3b-i 每 WU 独立 worktree → 跨 WU 续用必失败；WU metadata.sessionId 由本 WU 首 step
    // 写入，与 instance.sessionId 相等才说明会话是在本 WU（同一 worktree/cwd）建立的。
    const resumeSessionId = this.instance?.sessionId && metadata.sessionId === this.instance.sessionId
      ? this.instance.sessionId
      : null;
    let newSessionId: string | null = null;
    if (!resumeSessionId) {
      newSessionId = randomUUID();
      metadataUpdates.sessionId = newSessionId;
      metadataUpdates.startedAt = new Date().toISOString();
      // Persist sessionId to RuntimeInstance for cross-WorkUnit continuity
      if (this.instance) {
        await this.fileStore.updateState(this.instance.id, { sessionId: newSessionId });
        this.instance.sessionId = newSessionId;
      }
    } else {
      metadataUpdates.sessionResumes = (metadata.sessionResumes ?? 0) + 1;
    }

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
        const info = await ensureWuWorktree({
          wuId: wu.id,
          repoDir: workspaceRoot,
          worktreesDir: resolveWorktreesDir(),
          baseBranch: typeof metadata.worktreeBaseBranch === 'string' && metadata.worktreeBaseBranch.length > 0
            ? metadata.worktreeBaseBranch
            : undefined,
        });
        if (metadata.worktreePath !== info.worktreePath) {
          metadataUpdates.worktreePath = info.worktreePath;
          metadataUpdates.worktreeBranch = info.branch;
          metadataUpdates.worktreeBaseBranch = info.baseBranch;
          metadataUpdates.worktreeBaseRepo = info.baseRepo;
        }
        workspaceRoot = info.worktreePath;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`[AgentLoop] Worktree creation failed for ${wu.id}: ${message}`, { traceId });
        // 首 step 失败：会话未建立，重置避免下步 --resume 空 id
        if (newSessionId) await this.resetUnestablishedSession(metadataUpdates);
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
    const taskProvider = (this.role.provider || 'claude') as AgentTask['provider'];
    const task: AgentTask = {
      id: wu.id,
      executionId: `${wu.id}-${Date.now()}`,
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
    };

    try {
      // §9.6: 经 Executor 接口执行（P0 恒为 LocalExecutor → agentRunner.executeLightweight）
      const result: ExecutionResult = await this.executor.execute(task);

      // W-3 接线：runner 失败时返回 { success:false } 而不抛错、且无 outputText ——
      // 直接落入 parseAgentOutput 会得到默认 progress（空 summary），导致 consecutiveStuck
      // 被清零、每 3s 重试、往频道发空消息。显式失败分支：action='failed'，由 recordResult
      // 记 consecutiveStuck + errorType/errorDetail，不发频道消息；连续 3 次走 blocked 路径。
      // 不带 channelVersion —— 失败不是发言，无需新鲜度检查（避免被降级为 progress）。
      if (result.success === false) {
        const detail = (result.error ?? '未知错误').slice(0, 500);
        logger.error(`[AgentLoop] agentStep execution failed for ${wu.id}: ${detail}`, { traceId });
        // 首 step 失败：会话未必已建立，重置避免下步 --resume 一个从未建立的会话
        if (newSessionId) await this.resetUnestablishedSession(metadataUpdates);
        return {
          action: 'failed' as const,
          summary: `CLI 执行失败: ${detail}`,
          metadataUpdates: {
            ...metadataUpdates,
            errorType: 'execution_failed',
            errorDetail: detail,
            errorAt: new Date().toISOString(),
          },
        };
      }

      const stepResult = parseAgentOutput(result.outputText ?? '');

      // 执行成功 → 清除上一轮失败标记（undefined 在 JSON 序列化时丢弃）
      metadataUpdates.errorType = undefined;
      metadataUpdates.errorDetail = undefined;
      metadataUpdates.errorAt = undefined;

      // M2 成本红线度量: 每次 CLI 执行完成记一条 workunit:tokens 事件
      // （注入估算 chars/4 vs 2K 红线；执行 tokens 取自 CLI usage，未回报则记 null 不编造）。
      // fire-and-forget：绝不影响任务流程。
      const executionTokens = result.usage && (result.usage.inputTokens + result.usage.outputTokens) > 0
        ? result.usage.inputTokens + result.usage.outputTokens
        : null;
      void writeWorkunitTokenEvent(STUDIO_EVENTS_JSONL, {
        workUnitId: wu.id,
        executionId: task.executionId,
        injectedTokens: estimateTokens(knowledgeContext.length),
        executionTokens,
        // D16: 缓存命中率数据源（CLI 回报 usage 时才有；未回报则缺省不编造）
        ...(result.usage ? {
          inputTokens: result.usage.inputTokens,
          cacheReadTokens: result.usage.cacheReadTokens,
          cacheCreationTokens: result.usage.cacheCreationTokens,
        } : {}),
      }).catch(() => {});

      // wireup④ token 预算数据源: 本次 executionTokens 累加进 metadata._cumulativeTokens，
      // 随 metadataUpdates 由 recordResult 单次原子写入（与 knowledgeExtractedAt 同路径）。
      // CLI 未回报 usage（executionTokens=null）按 0 累加——即保持既有累计值不变。
      metadataUpdates._cumulativeTokens = (metadata._cumulativeTokens ?? 0) + (executionTokens ?? 0);

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
      this.checkSessionTruncation(result.outputText, metadataUpdates);

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
      if (newSessionId) await this.resetUnestablishedSession(metadataUpdates);
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[AgentLoop] agentStep execute failed: ${message}`, { traceId });
      // AC-8.7: 远程节点不可达 → need_input，由人工评估是否需要切换节点
      if (err instanceof RemoteNodeUnreachableError) {
        return {
          action: 'need_input' as const,
          summary: `远程节点不可达: ${message}`,
          metadataUpdates: { ...metadataUpdates, lastError: `remote-unreachable: ${this.executor instanceof RemoteExecutor ? (this.executor as any).nodeId : 'unknown'}` },
        };
      }
      return {
        action: 'need_input' as const, // increments consecutiveStuck
        summary: `Agent execution failed: ${message}`,
        metadataUpdates,
      };
    }
  }

  /**
   * §10 P0: 组装 `## 本次任务 Skills` 段（claim 时域匹配命中的 skill 索引）。
   * index-on-demand：只放 name + 一句话 description + 全文指针
   * （`.studio/skills/<name>/SKILL.md` 由 worktree-resolver 落盘，agent 按需阅读），不注入正文。
   * 内存快照缺 matchedSkills 时回读一次 FileStore（claim 的匹配落盘是 fire-and-forget）。
   * 预算：skill 段单独超过 2K 红线时按 chars/4 口径截断（知识段额度随之归零）。
   */
  private async buildSkillSection(wu: WorkUnitData, metadata: WorkUnitMetadata): Promise<{ section: string; tokens: number }> {
    const asNames = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.length > 0) : [];

    let matchedSkills = asNames(metadata.matchedSkills);
    if (matchedSkills.length === 0) {
      try {
        const snapshots = await this.fileStore.getIndex();
        const fresh = snapshots.find(s => s.id === wu.id);
        const freshMeta: WorkUnitMetadata = fresh?.metadata ? JSON.parse(fresh.metadata) : {};
        matchedSkills = asNames(freshMeta.matchedSkills);
      } catch { /* non-blocking — 回读失败按无 skill 处理 */ }
    }
    if (matchedSkills.length === 0) return { section: '', tokens: 0 };

    const manifest = loadManifest();
    const blocks: string[] = [];
    for (const name of matchedSkills) {
      const entry = manifest.find(e => e.name === name);
      if (!entry) continue;
      blocks.push(`### ${name}\n${entry.description || '（无描述）'}\n全文：.studio/skills/${name}/SKILL.md（按需阅读）`);
    }
    if (blocks.length === 0) return { section: '', tokens: 0 };

    let section = `## 本次任务 Skills\n\n${blocks.join('\n\n')}`;
    let tokens = estimateTokens(section.length);
    if (tokens > INJECT_TOKEN_BUDGET) {
      section = section.slice(0, INJECT_TOKEN_BUDGET * 4);
      tokens = INJECT_TOKEN_BUDGET;
    }
    return { section, tokens };
  }

  /**
   * A2A §4.1 机制 2: 组装 `## 频道成员与委派` 段（成员花名册 + DELEGATE 协议教学）。
   * 花名册 = 本频道 active 成员的 name + description + provider（排除自己——委派质量取决于
   * 模型对角色能力的理解，没有花名册的 DELEGATE 是盲派）；members 为空（历史频道未回填）
   * 时回退到全部 active profile，与 DelegationGate 的过渡期口径一致。
   * 预算：与 skill/知识段共用 2K 红线，优先级 skills index > roster > knowledge——
   * 调用方传入 skill 之后的剩余额度，超出按 chars/4 口径截断。
   */
  private async buildRosterSection(wu: WorkUnitData, tokenBudget: number): Promise<{ section: string; tokens: number }> {
    if (!wu.channelId || tokenBudget <= 0) return { section: '', tokens: 0 };

    const channel = await this.fileStore.getChannel(wu.channelId);
    const memberIds = parseChannels(channel?.members);
    let members: AgentProfileData[];
    if (memberIds.length > 0) {
      const resolved = await Promise.all(memberIds.map(id => this.fileStore.getProfile(id).catch(() => null)));
      members = resolved.filter((p): p is AgentProfileData => !!p && p.status === 'active');
    } else {
      members = await this.fileStore.listProfiles({ status: 'active' });
    }
    members = members.filter(p => p.id !== this.role.id);
    if (members.length === 0) return { section: '', tokens: 0 };

    const rosterLines = members.map(p =>
      `- ${p.name}（provider: ${p.provider ?? 'claude'}）：${p.description || '（无描述）'}`
    );
    let section = `## 频道成员与委派

本频道可协作成员：
${rosterLines.join('\n')}

如需把一部分工作交给更合适的成员，输出一行：ACTION: DELEGATE:@<成员名>:<子任务 scope>（scope 为该行剩余内容）。仅可委派给上述成员，不可委派给自己；委派深度上限 ${resolveMaxDepth()} 跳（根任务 depth=0），同一任务最多委派 ${MAX_DELEGATIONS_PER_PARENT} 次，不可对同一成员重复委派。系统校验通过后会创建子任务并在频道发卡片，你继续按 PROGRESS 推进自己的部分；校验不通过则转为 NEED_INPUT 请人裁决。`;

    let tokens = estimateTokens(section.length);
    if (tokens > tokenBudget) {
      section = section.slice(0, tokenBudget * 4);
      tokens = tokenBudget;
    }
    return { section, tokens };
  }

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
      const parentMeta: WorkUnitMetadata = parent?.metadata ? JSON.parse(parent.metadata) : {};
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
   * §10.5 提交守卫：worktree 是否有未提交改动。
   * git 调用失败返回 false —— 守卫静默跳过，绝不因基础设施故障阻断完成。
   */
  private hasUncommittedChanges(cwd: string): boolean {
    try {
      const out = execSync('git status --porcelain', { cwd, timeout: 5000, encoding: 'utf-8' });
      return out.trim().length > 0;
    } catch {
      return false;
    }
  }

  /** §10.5: 读取 worktree 当前 HEAD hash（失败返回 null —— 无提交监视静默跳过） */
  private readHeadHash(cwd: string): string | null {
    try {
      return execSync('git rev-parse HEAD', { cwd, timeout: 5000, encoding: 'utf-8' }).trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * B3b-i（决策 D3 前半）: 解析 WU 的验证命令 —— 覆盖优先于约定。
   * 覆盖：metadata.verifyCommands > workspace 记录 verifyCommands（字符串数组）；
   * 约定：worktree package.json scripts 存在 test/typecheck/lint 则依次跑
   * （按 lockfile 选 pnpm/npm）；都没有 → 空数组（跳过验证，维持现状）。
   */
  private async resolveVerifyCommands(
    wu: WorkUnitData,
    metadata: WorkUnitMetadata,
    worktreePath: string,
  ): Promise<{ commands: string[]; source: 'override' | 'convention' }> {
    const asCommands = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((c): c is string => typeof c === 'string' && c.trim().length > 0) : [];

    const fromMeta = asCommands(metadata.verifyCommands);
    if (fromMeta.length > 0) return { commands: fromMeta, source: 'override' };

    if (wu.workspaceId) {
      try {
        const ws = await getWorkspaceRecord(wu.workspaceId);
        const fromWs = asCommands(ws?.verifyCommands);
        if (fromWs.length > 0) return { commands: fromWs, source: 'override' };
      } catch { /* 记录读取失败按无覆盖处理 */ }
    }

    try {
      const pkgRaw = readFileSync(join(worktreePath, 'package.json'), 'utf-8');
      const scripts = (JSON.parse(pkgRaw) as { scripts?: Record<string, unknown> }).scripts ?? {};
      const names = ['test', 'typecheck', 'lint'].filter(n => typeof scripts[n] === 'string');
      if (names.length === 0) return { commands: [], source: 'convention' };
      const pm = existsSync(join(worktreePath, 'pnpm-lock.yaml')) ? 'pnpm' : 'npm';
      return { commands: names.map(n => `${pm} run ${n}`), source: 'convention' };
    } catch {
      return { commands: [], source: 'convention' };
    }
  }

  /**
   * B3b-i: 在 WU 的 worktree 里依次跑验证命令（单条 10min 超时）。
   * 任一失败 → 返回 failure（命令 + 输出尾部截 2000 字符）；全过 → ran 为全部命令。
   */
  private async runWuVerification(
    wu: WorkUnitData,
    metadata: WorkUnitMetadata,
    worktreePath: string,
  ): Promise<{
    ran: string[];
    source: 'override' | 'convention';
    failure?: { command: string; tail: string };
  }> {
    const { commands, source } = await this.resolveVerifyCommands(wu, metadata, worktreePath);
    const ran: string[] = [];
    for (const command of commands) {
      try {
        await execSh(command, { cwd: worktreePath, timeoutMs: VERIFY_COMMAND_TIMEOUT_MS });
        ran.push(command);
      } catch (err) {
        return { ran, source, failure: { command, tail: extractExecOutputTail(err, VERIFY_FAIL_TAIL_CHARS) } };
      }
    }
    return { ran, source };
  }

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
   * 首 step（新建会话）执行失败时重置 sessionId：CLI 会话未必已建立（可能根本没 spawn 到），
   * 不重置则下一步按续用发 `--resume <从未建立的 id>`（claude 必报 "No conversation found"）。
   * 续用 step 失败不调用 —— 会话已存在，保留下一步继续 resume。
   */
  private async resetUnestablishedSession(metadataUpdates: Partial<WorkUnitMetadata>): Promise<void> {
    if (this.instance) {
      this.instance.sessionId = null;
      await this.fileStore.updateState(this.instance.id, { sessionId: null }).catch(() => {});
    }
    delete metadataUpdates.sessionId;
  }

  /** Check execution output for input_tokens exceeding threshold, reset session if needed */
  private checkSessionTruncation(outputText: string | undefined, metadataUpdates: Partial<WorkUnitMetadata>): void {
    if (!outputText || !this.instance) return;
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
              this.instance.sessionId = null;
              this.fileStore.updateState(this.instance.id, { sessionId: null }).catch(() => {});
              delete metadataUpdates.sessionId;
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
    const wuId = target.workUnit.id;
    const wu = await this.workUnitService.getById(wuId);
    if (!wu) return;

    const persisted = (wu.metadata ? JSON.parse(wu.metadata) : {}) as WorkUnitMetadata;
    // 提交守卫/自动验证必须以「持久化 + 本 step metadataUpdates」的合并视图为准：
    // 首个 step 的 worktreePath 等字段由 agentStep 经 result.metadataUpdates 传入、
    // 此刻尚未落库；只看持久化值会让首 step 的 COMPLETE 退到主仓库（干净）做检查而漏拦
    // （e2e 实测：dev 在 worktree 改了未提交，守卫查主仓库放行 → 假 complete）。
    const metadata: WorkUnitMetadata = { ...persisted, ...result.metadataUpdates };
    // P0 修复 6: traceId（与 agentStep 同一来源，供日志行携带）
    const traceId = typeof metadata.traceId === 'string' && metadata.traceId ? metadata.traceId : undefined;

    // §10.5 提交守卫（发生在状态迁移之前，与 stepCount 守卫同层 —— 不动 VALID_TRANSITIONS）。
    // 路径解析或 git 调用失败一律静默跳过，绝不因基础设施故障阻断完成。
    // B3b-i: cwd 改走 resolveExecutionCwd —— 代码类 WU 在专属 worktree 下跑 git status。
    // review WU 整体豁免：评审职责是读不是写（cwd 解析到父 WU worktree，dev 的提交/
    // 工具产物与评审无关），工作区洁净不是它的责任——否则 COMPLETE 被反复打回空转。
    let action = result.action;
    const guardUpdates: Partial<WorkUnitMetadata> = {};
    let noCommitNotice = false;
    const workspaceRoot = wu.type === 'review' ? null : await this.resolveExecutionCwd(wu, metadata);
    if (workspaceRoot) {
      if (action === 'complete' && this.hasUncommittedChanges(workspaceRoot)) {
        // COMPLETE 守卫：有未提交改动 → 打回按 PROGRESS 处理，提示注入下一轮 prompt
        action = 'progress';
        guardUpdates.commitGuardHint = '有未提交改动，请先 git add/commit 再报告完成';
        logger.info(`[AgentLoop] Commit guard: COMPLETE downgraded for ${wuId} (uncommitted changes)`);
      }
      if (action === 'progress') {
        // PROGRESS 无提交监视：HEAD 不变 → 累计；连续 3 步发一次频道提醒并归零
        const head = this.readHeadHash(workspaceRoot);
        if (head) {
          if (metadata.lastCommitHash === head) {
            const next = (metadata.noCommitSteps ?? 0) + 1;
            if (next >= 3) {
              noCommitNotice = true;
              guardUpdates.noCommitSteps = 0;
            } else {
              guardUpdates.noCommitSteps = next;
            }
          } else {
            guardUpdates.lastCommitHash = head;
            guardUpdates.noCommitSteps = 0;
          }
        }
      }
    }

    // §6-2 父 complete 守卫（与提交守卫同层，同一降级为 progress 的模式）：
    // 存在未完结（unassigned/active/blocked/in_review）子 WU 时不允许 complete ——
    // 父一旦抢先 in_review，聚合的状态序防回退会让「子后完成」无法改写父状态（收口顺序：父必须等子）。
    if (action === 'complete') {
      const unfinishedChildren = await this.listUnfinishedChildren(wuId);
      if (unfinishedChildren.length > 0) {
        action = 'progress';
        guardUpdates.childGuardHint = `存在未完结子任务（${unfinishedChildren.join(', ')}），等待其全部完成后再报告 COMPLETE`;
        logger.info(`[AgentLoop] Child guard: COMPLETE downgraded for ${wuId} (unfinished children: ${unfinishedChildren.length})`);
      }
    }

    // B3b-i（决策 D3 前半）: COMPLETE 前自动验证 —— 仅代码类 WU（有专属 worktree）。
    // 提交守卫/子任务守卫已通过（action 仍为 complete）才跑；命令解析：覆盖 > 约定（见 resolveVerifyCommands）。
    // 全绿 → verifyReport 落档 + 频道简报；任一失败 → 降级 progress，失败命令+输出尾部注入下一轮 prompt，
    // verifyFailCount ≥3 → blocked。无 worktree / 无命令可跑 → 跳过（维持现状）。
    let verifyBlocked = false;
    let verifyPassNotice: string | null = null;
    if (action === 'complete'
      && CODE_WORKTREE_TYPES.has(wu.type)
      && typeof metadata.worktreePath === 'string' && metadata.worktreePath.length > 0) {
      const outcome = await this.runWuVerification(wu, metadata, metadata.worktreePath);
      if (outcome.failure) {
        const failCount = (metadata.verifyFailCount ?? 0) + 1;
        guardUpdates.verifyFailCount = failCount;
        guardUpdates.verifyFailHint = [
          `自动验证未通过（第 ${failCount} 次），请先修复再报告完成`,
          `失败命令: ${outcome.failure.command}`,
          `输出尾部:\n${outcome.failure.tail}`,
        ].join('\n');
        action = 'progress';
        verifyBlocked = failCount >= 3;
        logger.info(`[AgentLoop] Verify guard: COMPLETE downgraded for ${wuId} (command failed: ${outcome.failure.command}, count ${failCount})`);
      } else {
        guardUpdates.verifyFailCount = 0;
        if (outcome.ran.length > 0) {
          guardUpdates.verifyReport = {
            commands: outcome.ran,
            source: outcome.source,
            passedAt: new Date().toISOString(),
          };
          verifyPassNotice = `✅ 自动验证通过（${outcome.ran.length} 条）：${outcome.ran.join('；')}`;
          logger.info(`[AgentLoop] Verify guard: all passed for ${wuId}`, { commands: outcome.ran, source: outcome.source });
        }
      }
    }

    // A2A §4.1: DELEGATE 分支 —— DelegationGate 纯代码校验（零 LLM）。
    // 通过：建子单 + collab 元数据 + delegate 卡片（父 WU 状态不变，按 progress 继续）；
    // 拒绝：降级 NEED_INPUT（现有 blocked 路径），频道发「拟委派…需人工确认」请人裁决。
    if (action === 'delegate' && result.delegate) {
      const gate = await checkDelegation({
        fileStore: this.fileStore,
        parent: wu,
        delegator: this.role,
        targetName: result.delegate.targetName,
      });
      if (gate.pass && gate.target) {
        const parentCollab = effectiveParentCollab(wu, this.role.id);
        const childCollab: CollabMeta = {
          rootId: parentCollab.rootId,
          depth: parentCollab.depth + 1,
          chain: [...parentCollab.chain, gate.target.id],
          delegatedBy: { profileId: this.role.id, workUnitId: wuId },
          delegationCount: 0,
        };
        await this.workUnitService.create({
          scope: result.delegate.scope,
          type: wu.type,
          parentId: wuId,
          assigneeId: gate.target.id, // unassigned 语义 = 目标 profile id（同 @mention 点名，§1.2-b）
          channelId: wu.channelId,
          projectPath: wu.projectPath,
          workspaceId: wu.workspaceId ?? null,
          reqId: wu.reqId ?? null,
          status: 'unassigned',
          metadata: { creationMode: 'agent-delegate', collab: childCollab },
        });
        // 父 WU 补记/累加 collab（根 WU 首次委派时从无 collab 合并为 depth=0 的根记录）
        guardUpdates.collab = { ...parentCollab, delegationCount: (parentCollab.delegationCount ?? 0) + 1 };
        action = 'progress';
        // delegate 卡片即本步的 progress 消息（走下方统一回帖路径，含新鲜度检查）
        result.summary = `@${this.role.name} 委派 @${gate.target.name}：${result.delegate.scope}（深度 ${childCollab.depth}/${resolveMaxDepth()}）`;
        logger.info(`[AgentLoop] Delegation created: ${wuId} → @${gate.target.name} (depth ${childCollab.depth})`);
      } else {
        action = 'need_input';
        result.summary = `拟委派 @${result.delegate.targetName}：${result.delegate.scope}，因 ${gate.reason ?? '未知原因'} 需人工确认`;
        logger.info(`[AgentLoop] Delegation rejected for ${wuId}: ${gate.reason}`);
      }
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

    // Single atomic metadata write: merges agentStep updates (sessionId/startedAt/sessionResumes)
    // with monitoring counters (stepCount/consecutiveStuck) — fixes C-3 non-atomic write
    await this.workUnitService.update(wuId, {
      metadata: { ...metadata, ...result.metadataUpdates, ...waitingUpdates, ...guardUpdates, ...freshnessUpdates, stepCount, consecutiveStuck },
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
      await this.postToDiscussionSpace(
        wuId,
        `自动验证连续失败 ${guardUpdates.verifyFailCount} 次，任务已转 blocked，等待人类介入。最近失败命令与输出已记录到任务上下文`,
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
      await this.postToDiscussionSpace(wuId, `连续 3 步无进展${stuckReason}，等待人类介入`);
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
        if (!skipResultPost && result.summary.trim().length > 0) await this.postToDiscussionSpace(wuId, result.summary);
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
        if (!skipResultPost) await this.postToDiscussionSpace(wuId, `需要输入: ${result.summary}`);
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

  /** Post message directly to discussion space (no EventBus) */
  private async postToDiscussionSpace(workUnitId: string, content: string): Promise<void> {
    const wu = await this.workUnitService.getById(workUnitId);
    if (!wu?.channelId) return;

    const anchor = await findAnchorMessage(workUnitId, this.fileStore);

    const now = new Date().toISOString();
    const msg: ChannelMessageData = {
      id: randomUUID(),
      channelId: wu.channelId,
      authorType: 'agent',
      agentName: this.role.name,
      content,
      replyToId: anchor?.id ?? null,
      meta: '{}',
      workUnitId,
      createdAt: now,
    };
    await this.fileStore.appendMessage(wu.channelId, msg);
  }

  /** Parse accepted WorkUnit types from role description */
  private parseAcceptedTypes(description: string | null): string[] {
    if (!description) return [];
    const typeKeywords = ['task', 'bug', 'feature', 'refactor', 'test', 'docs', 'review', 'analysis'];
    return typeKeywords.filter(kw => description.toLowerCase().includes(kw));
  }
}

// ─── Exported pure functions (testable) ───

/** Extract input_tokens from stream-json result events */
export function extractInputTokens(outputText: string): number | null {
  const lines = outputText.split('\n');
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type === 'result' && typeof event.input_tokens === 'number') {
        return event.input_tokens as number;
      }
    } catch {
      // Skip non-JSON lines
    }
  }
  return null;
}

/** Check if a process is alive by sending signal 0 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** B3b-i: 判断路径是否 git 仓库根（.git 存在即可，与 createWorktree 校验口径一致） */
export function isGitRepoRoot(root: string): boolean {
  try {
    return existsSync(join(root, '.git'));
  } catch {
    return false;
  }
}

/** B3b-i: worktrees 根目录解析（与 AgentRunner config 口径一致：WORKTREES_DIR > ~/worktrees） */
export function resolveWorktreesDir(): string {
  return process.env.WORKTREES_DIR || join(os.homedir(), 'worktrees');
}

/** B3b-i: 从 execSh 拒绝错误提取输出尾部（stderr/stdout/message 拼接后截 maxChars） */
export function extractExecOutputTail(err: unknown, maxChars: number): string {
  let text = '';
  if (err && typeof err === 'object') {
    const rec = err as Record<string, unknown>;
    text = [rec.stderr, rec.stdout, rec.message]
      .filter((s): s is string => typeof s === 'string' && s.length > 0)
      .join('\n');
  } else {
    text = String(err);
  }
  return text.slice(-maxChars);
}

/** Find the anchor message (first message, no replyToId) for a WorkUnit */
export async function findAnchorMessage(workUnitId: string, fileStore?: FileStore): Promise<ChannelMessageData | null> {
  const fs = fileStore ?? new FileStore();
  const messages = await fs.queryAllMessages({ workUnitId });
  const anchors = messages
    .filter(m => !m.replyToId)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  return anchors[0] ?? null;
}

/** Resolve target from observations (pure code, zero LLM) */
export function resolveTarget(obs: Observations): Target | null {
  // Priority 1: human reply (including blocked WorkUnit)
  if (obs.newReplies.length > 0) {
    const repliedWuId = obs.newReplies[0].workUnitId;
    const wu = obs.myActive.find(w => w.id === repliedWuId);
    if (wu) return { workUnit: wu, newReplies: obs.newReplies };
  }

  // Priority 2: active WorkUnit continues
  const activeWu = obs.myActive.find(w => w.status === 'active');
  if (activeWu) return { workUnit: activeWu };

  // Priority 3: idle, take earliest unassigned
  if (obs.unassigned.length > 0) {
    return { workUnit: obs.unassigned[0] };
  }

  // No target
  return null;
}

/** Parse agent output for ACTION protocol */
export function parseAgentOutput(text: string): StepResult {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    // A2A §4.1: ACTION: DELEGATE:@<profileName>:<scope>（scope = 该行剩余内容，必填）。
    // 解析失败（@名字缺失、scope 为空、格式不对）落到下方默认 progress，与现有容错一致。
    const delegateMatch = lines[i].match(/ACTION:\s*DELEGATE:@([\w-]+):(\s*\S.*)$/);
    if (delegateMatch) {
      const scope = delegateMatch[2].trim();
      return { action: 'delegate', summary: scope, delegate: { targetName: delegateMatch[1], scope } };
    }
    const match = lines[i].match(/ACTION:\s*(PROGRESS|COMPLETE|NEED_INPUT):(.*)/);
    if (match) {
      const actionMap: Record<string, StepResult['action']> = {
        PROGRESS: 'progress',
        COMPLETE: 'complete',
        NEED_INPUT: 'need_input',
      };
      return { action: actionMap[match[1]], summary: match[2].trim() };
    }
  }
  return { action: 'progress', summary: text.trim() };
}

/** Dynamic sleep interval based on result */
export function dynamicInterval(result: { action: string }): number {
  switch (result.action) {
    case 'progress':   return 3_000;
    case 'delegate':   return 3_000; // A2A: 委派后父按 progress 继续
    case 'complete':   return 10_000;
    case 'need_input': return 30_000;
    case 'failed':     return 15_000; // W-3: 失败重试降速（原误判 progress 时每 3s 重试）
    default:           return 15_000;
  }
}

/**
 * P0 修复（reviewReport 回传断链）：解析 reviewer 最终输出为结构化审查结论。
 * 约定格式（已写入 review 子 WU scope）：输出以
 *   REVIEW_RESULT: {"verdict":"pass"|"reject","summary":"...","issues":[...]}
 * 结尾的行。宽松策略：优先解析 REVIEW_RESULT 行 JSON；失败则从输出尾部提取
 * verdict 关键词；仍失败 → null（不写 reviewReport，由 ReviewDispatcher 转人工）。
 */
export function parseReviewReport(text: string): { approved: boolean; reason?: string; issues?: Array<{ severity: string; message: string }> } | null {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = lines[i].match(/REVIEW_RESULT:\s*(\{.*\})\s*$/);
    if (!match) continue;
    try {
      const parsed = JSON.parse(match[1]) as { verdict?: unknown; summary?: unknown; issues?: unknown };
      if (parsed.verdict === 'pass' || parsed.verdict === 'reject') {
        return {
          approved: parsed.verdict === 'pass',
          reason: typeof parsed.summary === 'string' ? parsed.summary : undefined,
          issues: normalizeReviewIssues(parsed.issues),
        };
      }
    } catch { /* JSON 损坏 → 落到关键词兜底 */ }
    break; // 已找到（最末一条）REVIEW_RESULT 行，不再向上扫描更早的行
  }

  // 兜底：输出尾部 verdict 关键词（ reviewer 未按约定格式但给出了结论词）
  const tail = lines.slice(-10).join('\n');
  if (/verdict["'\s:]+reject/i.test(tail)) {
    return { approved: false, reason: '（关键词兜底判定）' };
  }
  if (/verdict["'\s:]+pass/i.test(tail)) {
    return { approved: true, reason: '（关键词兜底判定）' };
  }
  return null;
}

/** REVIEW_RESULT issues 字段归一化：只保留 { severity, message } 形状，非法项丢弃 */
function normalizeReviewIssues(raw: unknown): Array<{ severity: string; message: string }> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const issues = raw
    .filter((i): i is Record<string, unknown> => i !== null && typeof i === 'object')
    .map(i => ({
      severity: typeof i.severity === 'string' ? i.severity : 'info',
      message: typeof i.message === 'string' ? i.message : JSON.stringify(i),
    }))
    .filter(i => i.message.length > 0);
  return issues.length > 0 ? issues : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Prompt builders ───

function buildContinuePrompt(wu: WorkUnitData): string {
  return `## 当前工作

${wu.scope}

## 要求

继续上次工作。若 .studio/AGENTS.generated.md 存在，先阅读（工作区指南：可用 skill 索引 + SDD 落盘要求）；仓库根有 AGENTS.md/CLAUDE.md 时以它们为准。每步结束后输出：
  ACTION: PROGRESS:<summary>      完成一步，继续中
  ACTION: COMPLETE:<summary>      全部完成
  ACTION: NEED_INPUT:<需要什么>   需要人类输入

当做出设计决策（选型、架构选择、方案取舍）时，用 Write 工具追加到 ~/.studio/knowledge/decision-YYYY-MM-DD.md 记录：话题、候选方案、选择、理由。`;
}

function buildReplyPrompt(wu: WorkUnitData, replies: string[]): string {
  const replyText = replies.join('\n');
  return `## 当前工作

${wu.scope}

## 人类新回复

${replyText}

## 要求

根据回复调整方案，继续工作。若 .studio/AGENTS.generated.md 存在，先阅读（工作区指南：可用 skill 索引 + SDD 落盘要求）；仓库根有 AGENTS.md/CLAUDE.md 时以它们为准。每步结束后输出：
  ACTION: PROGRESS:<summary>      完成一步，继续中
  ACTION: COMPLETE:<summary>      全部完成
  ACTION: NEED_INPUT:<需要什么>   需要人类输入`;
}

// ─── Knowledge search analysis (preserved from original) ───

/**
 * Analyze agent log for knowledge search behavior.
 * Pure function — takes log content string, no file I/O.
 */
export function analyzeKnowledgeSearch(logContent: string): KnowledgeSearchAnalysis {
  const events = parseStreamEvents(logContent);
  const toolCalls = extractToolCalls(events);

  const searchCalls: Array<{ tool: string; detail?: string }> = [];
  for (const call of toolCalls) {
    const detail = getKnowledgeSearchDetail(call.name, call.input);
    if (detail !== null) {
      searchCalls.push({ tool: call.name, detail });
    }
  }

  return { searched: searchCalls.length > 0, searchCalls };
}

function getKnowledgeSearchDetail(toolName: string, input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const inp = input as Record<string, unknown>;

  if (toolName === 'Read') {
    const fp = inp.file_path;
    if (typeof fp === 'string' && fp.includes('.studio/knowledge')) return fp;
  }
  if (toolName === 'Bash') {
    const cmd = inp.command;
    if (typeof cmd === 'string' && cmd.includes('.studio/knowledge')) return cmd;
  }
  if (toolName === 'Glob') {
    const pattern = inp.pattern;
    if (typeof pattern === 'string' && pattern.includes('.studio/knowledge')) return pattern;
  }

  return null;
}

/**
 * Extract knowledge entry IDs from search analysis results.
 * Parses file paths from Read/Bash tool call details.
 */
export function extractKnowledgeEntryIds(analysis: KnowledgeSearchAnalysis): string[] {
  const ids: string[] = [];
  for (const call of analysis.searchCalls) {
    if (!call.detail) continue;
    const match = call.detail.match(/\.studio\/knowledge\/([^/\s]+(?:\/[^/\s]+)?\.md)/);
    if (match) {
      const filePart = match[1];
      if (filePart === '_index.md' || filePart.endsWith('/_index.md')) continue;
      ids.push(filePart.replace(/\.md$/, ''));
    }
  }
  return Array.from(new Set(ids));
}

// ─── workunit:tokens event recording (M2) ───

export interface WorkunitTokenEventArgs {
  workUnitId: string;
  executionId?: string;
  /** 注入上下文估算 tokens（调用方按 chars/4 约定估算，与 estimateTokens 一致） */
  injectedTokens: number;
  /**
   * 执行总 tokens（CLI usage input+output）。CLI 未回报 usage 时传 null ——
   * 聚合端据此把该事件排除在执行 tokens/开销比均值外（executionSource='unavailable'），不编造 0。
   */
  executionTokens: number | null;
  /** LLM 提取 tokens（可选；R3 提取异步入库，通常由 knowledge:extraction 事件单独度量） */
  extractionTokens?: number;
  /** D16: CLI usage 的 input tokens（缓存命中率分子分母用；有 usage 时写入） */
  inputTokens?: number;
  /** D16: CLI usage 的 cache read / creation tokens（缓存命中率用；有 usage 时写入） */
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

/**
 * M2: 写一条 workunit:tokens 事件（模块级函数，供 agent-loop 与单测直接调用）。
 * totalTokens = injectedTokens + executionTokens（execution 未知时仅计注入部分）。
 */
export async function writeWorkunitTokenEvent(eventsFile: string, args: WorkunitTokenEventArgs): Promise<void> {
  const executionTokens = typeof args.executionTokens === 'number' && Number.isFinite(args.executionTokens)
    ? args.executionTokens
    : null;
  await metricsFileStore.appendJsonl(eventsFile, {
    type: 'workunit:tokens',
    source: 'agent-loop',
    payload: JSON.stringify({
      workUnitId: args.workUnitId,
      executionId: args.executionId,
      injectedTokens: args.injectedTokens,
      injectedSource: 'estimate:chars/4',
      executionTokens,
      executionSource: executionTokens !== null ? 'cli-usage' : 'unavailable',
      totalTokens: args.injectedTokens + (executionTokens ?? 0),
      ...(typeof args.extractionTokens === 'number' ? { extractionTokens: args.extractionTokens } : {}),
      ...(typeof args.inputTokens === 'number' ? { inputTokens: args.inputTokens } : {}),
      ...(typeof args.cacheReadTokens === 'number' ? { cacheReadTokens: args.cacheReadTokens } : {}),
      ...(typeof args.cacheCreationTokens === 'number' ? { cacheCreationTokens: args.cacheCreationTokens } : {}),
    }),
    createdAt: new Date().toISOString(),
  });
}

// ─── tool:call event recording ───

/**
 * D18 事件入口统一: tool:call trace 写入统一事件文件
 * （~/.studio/logs/studio-events.jsonl，测试期经 studio-log-path 隔离）。
 * 懒解析以支持运行时/测试注入 env。
 */
export function resolveToolTraceFile(): string {
  return resolveStudioEventsFile();
}

/**
 * Write tool:call events extracted from stream-json output to a JSONL file.
 * Returns the count of tool calls written.
 * T-1.1: Wiring tool:call recording for PatternMiner data source.
 * D18: StudioEvent 形态（payload 嵌套），与 daemon/task-executor 的 tool:call 一致。
 */
export function writeToolCallEvents(outputText: string, filePath: string): number {
  const events = parseStreamEvents(outputText);
  const toolCalls = extractToolCalls(events);
  if (toolCalls.length === 0) return 0;

  const dir = filePath.substring(0, filePath.lastIndexOf('/'));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const now = Date.now();
  for (const call of toolCalls) {
    const event = JSON.stringify({
      type: 'tool:call',
      source: 'agent-loop',
      payload: JSON.stringify({
        tool: call.name,
        success: true,
        durationMs: 0,
        timestamp: now,
        caller: 'agent-loop',
      }),
      createdAt: new Date(now).toISOString(),
    });
    appendFileSync(filePath, event + '\n', 'utf-8');
  }

  return toolCalls.length;
}
