// AgentLoop — observe→resolveTarget→agentStep→recordResult decision loop (AS-025)
// Orchestration layer: zero LLM calls. Agent = external compute (Claude Code/OpenCode/Codex).
// Knowledge search analysis preserved as module-level exports.
import { execSync } from 'child_process';
import { eventBus, logger, parseStreamEvents, extractToolCalls, FileStore, parseChannels, resolveEventsDir, estimateTokens, type RuntimeStateData, type ChannelMessageData } from '@dommaker/studio-shared';
import { resolveProviderDefinition, buildHealthProbeCommand } from '@dommaker/studio-shared/node';
import { randomUUID } from 'crypto';
import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import * as os from 'os';
import { agentRunner } from '@dommaker/studio-agent';
import type { AgentTask, ExecutionResult } from '@dommaker/studio-agent';
import { WorkUnitService, type WorkUnitMetadata, type WorkUnitData } from '../workunit/workunit.service.js';
import type { AgentProfileData } from '@dommaker/studio-shared';
import { getTriggerScheduler } from '../triggers/trigger-registry.js';
import { knowledgeService } from '../knowledge/knowledge-service.js';
import { eventStore } from '../../core/event-store.js';
import { resolveWorkspaceRoot } from '../workspaces/workspace-store.js';

/** Threshold for input_tokens before session truncation (100K) */
const SESSION_TOKEN_LIMIT = 100_000;

/** M2: workunit:tokens 事件写入目标（与 knowledge consumption/outcome 事件同一事件流） */
const STUDIO_EVENTS_JSONL = join(os.homedir(), '.studio', 'logs', 'studio-events.jsonl');
const metricsFileStore = new FileStore();

/** F6-fix: 空闲分支心跳节流间隔 — agent-timeout-scan 阈值为 5min，45s 一次足够保活 */
const IDLE_HEARTBEAT_INTERVAL_MS = 45_000;

/** Result of analyzing agent log for knowledge search behavior */
export interface KnowledgeSearchAnalysis {
  searched: boolean;
  searchCalls: Array<{ tool: string; detail?: string }>;
}

/** Agent output action after parsing */
export interface StepResult {
  action: 'progress' | 'complete' | 'need_input';
  summary: string;
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

  constructor(role: AgentProfileData, fileStore?: FileStore) {
    this.role = role;
    this.fileStore = fileStore ?? new FileStore();
    this.workUnitService = new WorkUnitService(this.fileStore);
    this.acceptedTypes = this.parseAcceptedTypes(role.description);
    // W-4 fix + F3: parse channels from role.channels JSON（容错历史双重编码值）
    this.myChannels = parseChannels(role.channels);
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

  /** Observe: collect state from DB (zero token) */
  private async observe(): Promise<Observations> {
    // W-6 fix: batch query for newReplies instead of N+1
    const myActive = (await this.workUnitService.list({
      assigneeId: this.instance?.id,
    })).data.filter(wu => wu.status === 'active' || wu.status === 'blocked');

    const allSnapshots = await this.fileStore.getIndex();
    const unassigned = allSnapshots.filter(s => {
      if (s.status !== 'unassigned') return false;
      // Assignee-aware claiming（@mention 语义，docs/vision-2026.md §3）：
      // 显式指派给某个 profile 的 WorkUnit 只能被该 profile 的 loop 认领；
      // 未指派的保持既有频道作用域（我的频道内 + acceptedTypes 匹配）。
      if (s.assigneeId) {
        if (s.assigneeId !== this.role.id) return false;
      } else if (this.myChannels.length > 0 && s.channelId && !this.myChannels.includes(s.channelId)) {
        return false;
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

    // F5: 恢复挂起时由 message-routing 写入的人类回复（优先级最高，注入后即消费）
    const pendingReplies = Array.isArray(metadata.pendingReplies)
      ? metadata.pendingReplies.filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
      : [];

    const prompt = pendingReplies.length > 0
      ? buildReplyPrompt(wu, pendingReplies)
      : target.newReplies?.length
        ? buildReplyPrompt(wu, target.newReplies.map(r => r.content))
        : buildContinuePrompt(wu);

    // GAP-5: Knowledge injection — non-blocking
    // R1 反馈环: 接住 injectContext 返回的 injectedIds，贯穿到 recordOutcome /
    // extractFromExecution 的 consumedKnowledge（断点 A：此前注入 id 被丢弃，
    // outcome 永远上报 consumedKnowledge: []，飞轮无反馈数据）。
    let knowledgeContext = '';
    let injectedKnowledgeIds: string[] = [];
    try {
      const ctx = await knowledgeService.injectContext(wu.type, {
        tags: [wu.type],
      });
      knowledgeContext = ctx.prompt;
      injectedKnowledgeIds = ctx.injectedIds ?? [];
    } catch {
      // Non-blocking: agent continues without knowledge context
    }

    // Session management — per-Agent session (GAP-2: RuntimeInstance.sessionId)
    const metadataUpdates: Partial<WorkUnitMetadata> = {};
    if (pendingReplies.length > 0) {
      // F5: 回复已注入 prompt，清除避免后续步骤重复注入（undefined 在 JSON 序列化时丢弃）
      metadataUpdates.pendingReplies = undefined;
    }
    const agentSessionId = this.instance?.sessionId;
    if (!agentSessionId) {
      const newId = randomUUID();
      metadataUpdates.sessionId = newId;
      metadataUpdates.startedAt = new Date().toISOString();
      // Persist sessionId to RuntimeInstance for cross-WorkUnit continuity
      if (this.instance) {
        await this.fileStore.updateState(this.instance.id, { sessionId: newId });
        this.instance.sessionId = newId;
      }
    } else {
      metadataUpdates.sessionResumes = (metadata.sessionResumes ?? 0) + 1;
    }

    // F6: WorkUnit 绑定工程 → 解析 workspace 的 repo 路径，经 parameters.workspaceRoot
    // 传给 agent-runner（resolveWorkspace Priority 1：直接以该目录为 cwd）。
    // 未绑定或解析失败 → 不传，保持现有 fallback 行为。
    const workspaceRoot = wu.workspaceId ? await this.resolveBoundWorkspaceRoot(wu.workspaceId) : null;

    // AgentTask with new interface: provider, sessionId, maxTurns, knowledgeContext
    const task: AgentTask = {
      id: wu.id,
      executionId: `${wu.id}-${Date.now()}`,
      // F4: profile provider (registry id) → AgentTask. Cast via AgentTask['provider'] because
      // apps/api tsc resolves studio-agent types from its (possibly stale) dist/index.d.ts.
      provider: (this.role.provider || 'claude') as AgentTask['provider'],
      prompt,
      parameters: {
        sessionId: agentSessionId ?? undefined,
        maxTurns: 50,
        knowledgeContext: knowledgeContext || undefined,
        agentRole: 'executor',
        workUnitId: wu.id,
        agentProfileId: this.role.id,
        ...(workspaceRoot ? { workspaceRoot } : {}),
        extraEnv: {
          STUDIO_WORKUNIT_ID: wu.id,
          STUDIO_CHANNEL_ID: wu.channelId ?? '',
        },
      },
      model: 'standard',
      timeoutMs: 120_000,
    };

    try {
      const result: ExecutionResult = await agentRunner.executeLightweight(task);
      const stepResult = parseAgentOutput(result.outputText ?? '');

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
      }).catch(() => {});

      // wireup④ token 预算数据源: 本次 executionTokens 累加进 metadata._cumulativeTokens，
      // 随 metadataUpdates 由 recordResult 单次原子写入（与 knowledgeExtractedAt 同路径）。
      // CLI 未回报 usage（executionTokens=null）按 0 累加——即保持既有累计值不变。
      metadataUpdates._cumulativeTokens = (metadata._cumulativeTokens ?? 0) + (executionTokens ?? 0);

      // T-1.1: Record tool:call events for PatternMiner data source
      // R2: 写入统一事件目录（STUDIO_EVENTS_DIR > EVENTS_DIR > ~/.studio/events）
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

      // AC-4.3/4.4: Cache tracking — extract input_tokens from result events
      const tokens = extractInputTokens(result.outputText ?? '');
      if (tokens !== null) {
        metadataUpdates.lastInputTokens = tokens;
      }

      return { ...stepResult, metadataUpdates };
    } catch (err) {
      // W-3 fix: executeLightweight failure returns error result instead of throwing
      // This allows recordResult to update metadata and monitoring to handle it (consecutiveStuck → blocked)
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[AgentLoop] agentStep executeLightweight failed: ${message}`);
      return {
        action: 'need_input' as const, // increments consecutiveStuck
        summary: `Agent execution failed: ${message}`,
        metadataUpdates,
      };
    }
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

    const metadata = (wu.metadata ? JSON.parse(wu.metadata) : {}) as WorkUnitMetadata;
    const stepCount = (metadata.stepCount ?? 0) + 1;
    let consecutiveStuck = result.action === 'progress' ? 0 : (metadata.consecutiveStuck ?? 0) + 1;

    // F5: NEED_INPUT 挂起标记（等待人类回复）；其他结果清除挂起标记（恢复后继续执行）
    const waitingUpdates: Partial<WorkUnitMetadata> = result.action === 'need_input'
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
      metadata: { ...metadata, ...result.metadataUpdates, ...waitingUpdates, stepCount, consecutiveStuck },
    });

    // Monitoring: step limit
    if (stepCount > 15) {
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
      await this.postToDiscussionSpace(wuId, '连续 3 步无进展，等待人类介入');
      return;
    }

    // State transitions by action
    switch (result.action) {
      case 'progress':
        await this.postToDiscussionSpace(wuId, result.summary);
        if (wu.status === 'blocked') {
          await this.workUnitService.transitionStatus(wuId, 'active');
        }
        break;
      case 'complete':
        await this.postToDiscussionSpace(wuId, result.summary);
        // C-2 fix: blocked→in_review is not in VALID_TRANSITIONS, go through active first
        if (wu.status === 'blocked') {
          await this.workUnitService.transitionStatus(wuId, 'active');
        }
        await this.workUnitService.transitionStatus(wuId, 'in_review');
        break;
      case 'need_input':
        await this.postToDiscussionSpace(wuId, `需要输入: ${result.summary}`);
        // F5: 挂起 — 守卫重复 NEED_INPUT（blocked → blocked 不在 VALID_TRANSITIONS 中）
        if (wu.status !== 'blocked') {
          await this.workUnitService.transitionStatus(wuId, 'blocked');
        }
        break;
    }
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
    case 'complete':   return 10_000;
    case 'need_input': return 30_000;
    default:           return 15_000;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Prompt builders ───

function buildContinuePrompt(wu: WorkUnitData): string {
  return `## 当前工作

${wu.scope}

## 要求

继续上次工作。每步结束后输出：
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

根据回复调整方案，继续工作。每步结束后输出：
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
    }),
    createdAt: new Date().toISOString(),
  });
}

// ─── tool:call event recording ───

/**
 * R2: tool trace 文件路径 — 经统一 resolver 解析
 * （STUDIO_EVENTS_DIR > EVENTS_DIR > ~/.studio/events）。懒解析以支持运行时/测试注入 env。
 */
export function resolveToolTraceFile(): string {
  return join(resolveEventsDir(), 'studio.jsonl');
}

/**
 * Write tool:call events extracted from stream-json output to a JSONL file.
 * Returns the count of tool calls written.
 * T-1.1: Wiring tool:call recording for PatternMiner data source.
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
      tool: call.name,
      success: true,
      durationMs: 0,
      timestamp: now,
      caller: 'agent-loop',
    });
    appendFileSync(filePath, event + '\n', 'utf-8');
  }

  return toolCalls.length;
}
