// AgentLoop — observe→resolveTarget→agentStep→recordResult decision loop (AS-025)
// Orchestration layer: zero LLM calls. Agent = external compute (Claude Code/OpenCode/Codex).
// 2026-08-04 拆分：协作模块见 CONTEXT.md 核心导出；本文件保留循环主流程 + 全部 re-export（导出面不变）。
import { execSync } from 'child_process';
import { logger, FileStore, parseChannels, estimateTokens, type RuntimeStateData } from '@dommaker/studio-shared';
import { resolveProviderDefinition, buildHealthProbeCommand } from '@dommaker/studio-shared/node';
import { randomUUID } from 'crypto';
import type { AgentTask, ExecutionResult } from '@dommaker/studio-agent';
import { LocalExecutor, type Executor } from './executor.js';
import { RemoteExecutor, RemoteNodeUnreachableError } from './remote-executor.js';
import { WorkUnitService, type WorkUnitMetadata, type WorkUnitData } from '../workunit/workunit.service.js';
import type { AgentProfileData } from '@dommaker/studio-shared';
import { getTriggerScheduler } from '../triggers/trigger-registry.js';
import { knowledgeService } from '../knowledge/knowledge-service.js';
import {
  emitExecutionStepEvent, emitExecutionStreamLine, emitExecutionStreamStepStart,
} from './execution-step-events.js';
import { evaluatePreStepGuards } from './agent-loop-step-guards.js';
import {
  INJECT_TOKEN_BUDGET,
  buildContinuePrompt, buildReplyPrompt,
  buildSkillSection, buildPersonaSection, buildRosterSection,
} from './agent-loop-prompts.js';
import { resolveSessionForStep, resetUnestablishedSession, checkSessionTruncation } from './agent-loop-session.js';
import { prepareExecutionWorkspace } from './agent-loop-workspace.js';
import { recordResult as recordStepResult } from './agent-loop-record-result.js';
import {
  recordStartupFailure as writeStartupFailure,
  updateIdleState as writeIdleState,
  publishInstanceStatus as publishStatusChanged,
} from './agent-loop-instance-state.js';
import {
  studioEventsJsonlPath, writeWorkunitTokenEvent, resolveRealUsage,
  resolveToolTraceFile, writeToolCallEvents, extractInputTokens,
  type RealUsage,
} from './workunit-token-events.js';
import { parseAgentOutput, parseReviewReport, parseTaskBreakdown, dynamicInterval, type StepResult } from './agent-output-parser.js';
import { resolveTarget, type Observations, type Target } from './agent-targeting.js';
import { isProcessAlive } from './agent-loop-utils.js';

/** 单活实例守卫：心跳/启动时间新鲜度阈值（idle 心跳 45s 一跳，留近 3 跳余量） */
const LIVE_HOLDER_THRESHOLD_MS = 120_000;

/** F4（reviewer 解锚，决策 5）：安全解析 WU metadata.excludeAssignee ——
 *  评审 WU 禁止认领的 profile id；缺失/损坏/非字符串一律 null（不排除） */
function parseExcludeAssignee(metadata: unknown): string | null {
  try {
    const m = typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
    const v = (m as { excludeAssignee?: unknown } | null)?.excludeAssignee;
    return typeof v === 'string' && v ? v : null;
  } catch {
    return null;
  }
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

  /** F2: Record a startup-fatal failure to runtime state (state.json) + notify via eventBus and SSE
   *  —— 实现见 ./agent-loop-instance-state.js */
  private async recordStartupFailure(message: string): Promise<void> {
    return writeStartupFailure(this.fileStore, this.role, message);
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
   * —— 实现见 ./agent-loop-instance-state.js
   */
  private async updateIdleState(): Promise<void> {
    const r = await writeIdleState(this.fileStore, this.instance, this.role, this.lastIdleHeartbeatAt, this.lastPublishedStatus);
    this.lastIdleHeartbeatAt = r.lastIdleHeartbeatAt;
    this.lastPublishedStatus = r.lastPublishedStatus;
  }

  /**
   * 2026-07 PMO-flow UX（§6-2）：instance 忙闲变化发 SSE（agent.instance.status_changed）——
   * 实现见 ./agent-loop-instance-state.js（仅状态实际变化时发一次，best-effort 不阻断主循环）。
   */
  private publishInstanceStatus(status: string, currentWorkUnitId: string | null): void {
    this.lastPublishedStatus = publishStatusChanged(this.instance, this.role, this.lastPublishedStatus, status, currentWorkUnitId);
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

    // B2（测试特征 WU 关闭）+ C3（每日 token 预算熔断）前置守卫 —— 实现见 ./agent-loop-step-guards.js
    const preStepGuard = await evaluatePreStepGuards(
      { workUnitService: this.workUnitService, fileStore: this.fileStore, role: this.role },
      wu, metadata,
    );
    if (preStepGuard) return preStepGuard;

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
    // §10 P0 + 决策 7/13: 注入段共用 2K 红线，优先级 skills > persona > roster > knowledge——
    // skill 段（## 本次任务 Skills）step 时计算，先占预算；persona 段（## 你的角色）次之；
    // 成员花名册段（## 频道成员与委派）再次；剩余额度传给 injectContext。
    let skillSection = '';
    let skillTokens = 0;
    let skillMatched: string[] = [];
    try {
      const composed = await buildSkillSection(this.acceptedTypes, wu);
      skillSection = composed.section;
      skillTokens = composed.tokens;
      skillMatched = composed.matched;
    } catch {
      // Non-blocking: agent continues without skill section
    }

    // 决策 13: `## 你的角色` 段（persona ?? description；为空则省略）。纯字符串组装，不抛错
    const persona = buildPersonaSection(this.role, Math.max(0, INJECT_TOKEN_BUDGET - skillTokens));
    const personaSection = persona.section;
    const personaTokens = persona.tokens;

    let rosterSection = '';
    let rosterTokens = 0;
    try {
      const roster = await buildRosterSection(this.fileStore, this.role, wu, Math.max(0, INJECT_TOKEN_BUDGET - skillTokens - personaTokens));
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
        maxTokens: Math.max(0, INJECT_TOKEN_BUDGET - skillTokens - personaTokens - rosterTokens),
      });
      knowledgeContext = ctx.prompt;
      injectedKnowledgeIds = ctx.injectedIds ?? [];
    } catch {
      // Non-blocking: agent continues without knowledge context
    }
    const leadSections = [skillSection, personaSection, rosterSection].filter(s => s.length > 0).join('\n\n');
    if (leadSections) {
      knowledgeContext = knowledgeContext
        ? `${leadSections}\n\n## 项目上下文\n${knowledgeContext}`
        : leadSections;
    }

    // Session management — per-WU session (RuntimeInstance.sessionId, cwd-scoped)
    const metadataUpdates: Partial<WorkUnitMetadata> = {};
    if (skillMatched.length > 0) {
      // 决策 7: step 时匹配名单落盘 metadata.matchedSkills（随 recordResult 原子写入，
      // 供 skill-demotion 成功率与被无视率度量——替代原 claim 时 fire-and-forget 落盘，消竞态）
      metadataUpdates.matchedSkills = skillMatched;
    }
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
    // 会话续用/新建 + B5 每 WU 会话数上限 —— 实现见 ./agent-loop-session.js
    const session = await resolveSessionForStep(
      { fileStore: this.fileStore, instance: this.instance },
      wu.id, metadata, metadataUpdates,
    );
    if (session.earlyResult) return session.earlyResult;
    const { resumeSessionId, newSessionId } = session;

    // 执行根目录/worktree 准备（F6 → B3a 归属链 → B3b-i 专属 worktree）—— 实现见 ./agent-loop-workspace.js
    const prepared = await prepareExecutionWorkspace(
      { fileStore: this.fileStore, workUnitService: this.workUnitService, instance: this.instance },
      wu, metadata, metadataUpdates, newSessionId, traceId,
    );
    if (prepared.earlyResult) return prepared.earlyResult;
    const workspaceRoot = prepared.workspaceRoot;

    // AgentTask with new interface: provider, sessionId, maxTurns, knowledgeContext
    const taskProvider = (this.role.provider || 'claude') as AgentTask['provider'];
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
      // fire-and-forget；仅 LocalExecutor 同进程有效（RemoteExecutor 函数不可序列化，丢弃）。
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
      const result: ExecutionResult = await this.executor.execute(task);

      // W-3 接线：runner 失败时返回 { success:false } 而不抛错、且无 outputText ——
      // 直接落入 parseAgentOutput 会得到默认 progress（空 summary），导致 consecutiveStuck
      // 被清零、每 3s 重试、往频道发空消息。显式失败分支：action='failed'，由 recordResult
      // 记 consecutiveStuck + errorType/errorDetail，不发频道消息；连续 3 次走 blocked 路径。
      // 不带 channelVersion —— 失败不是发言，无需新鲜度检查（避免被降级为 progress）。
      if (result.success === false) {
        const detail = (result.error ?? '未知错误').slice(0, 500);
        logger.error(`[AgentLoop] agentStep execution failed for ${wu.id}: ${detail}`, { traceId });
        // B6: 失败执行同样记账（CLI 已跑的轮次照样烧了 token，runner error 路径透出 usage）
        recordTokenEvent(result);
        // 首 step 失败：会话未必已建立，重置避免下步 --resume 一个从未建立的会话
        if (newSessionId) await resetUnestablishedSession(this.instance, this.fileStore, metadataUpdates);
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
        sessionId: resumeSessionId ?? newSessionId ?? undefined,
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
      checkSessionTruncation(this.instance, this.fileStore, result.outputText, metadataUpdates);

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
      if (newSessionId) await resetUnestablishedSession(this.instance, this.fileStore, metadataUpdates);
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

  /** Record result: monitoring checkpoints + state transitions (zero token)
   *  —— 实现见 ./agent-loop-record-result.js（§10.5 提交守卫 / §6-2 父 complete 守卫 /
   *  B3b-i 自动验证 / A2A DELEGATE / §4.2 新鲜度检查 / F6-c 强制收口补跑 L1 / 状态迁移） */
  private async recordResult(target: Target, result: StepResult): Promise<void> {
    return recordStepResult(
      { workUnitService: this.workUnitService, fileStore: this.fileStore, role: this.role },
      target, result,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Re-exports（2026-08-04 拆分后保持对外导出面不变；实现见各子模块）───

export { parseAgentOutput, dynamicInterval, parseReviewReport, parseTaskBreakdown } from './agent-output-parser.js';
export type { StepResult } from './agent-output-parser.js';
export { analyzeKnowledgeSearch, extractKnowledgeEntryIds } from './agent-knowledge-analysis.js';
export type { KnowledgeSearchAnalysis } from './agent-knowledge-analysis.js';
export { extractInputTokens, resolveRealUsage, writeWorkunitTokenEvent, resolveToolTraceFile, writeToolCallEvents } from './workunit-token-events.js';
export type { RealUsage, WorkunitTokenEventArgs } from './workunit-token-events.js';
export { isProcessAlive, isGitRepoRoot, resolveWorktreesDir } from './agent-loop-utils.js';
export { findAnchorMessage, resolveTarget } from './agent-targeting.js';
export type { Observations, Target } from './agent-targeting.js';
export { testWuGuardEnabled, isTestLikeWorkUnit } from './wu-test-guards.js';
