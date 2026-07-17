// AgentLoop — observe→resolveTarget→agentStep→recordResult decision loop (AS-025)
// Orchestration layer: zero LLM calls. Agent = external compute (Claude Code/OpenCode/Codex).
// Knowledge search analysis preserved as module-level exports.
import { execSync } from 'child_process';
import { logger, parseStreamEvents, extractToolCalls, FileStore, type RuntimeStateData, type ChannelMessageData } from '@dommaker/studio-shared';
import { randomUUID } from 'crypto';
import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { agentRunner } from '@dommaker/studio-agent';
import type { AgentTask, ExecutionResult } from '@dommaker/studio-agent';
import { WorkUnitService, type WorkUnitMetadata, type WorkUnitData } from '../workunit/workunit.service.js';
import type { AgentProfileData } from '@dommaker/studio-shared';
import { getTriggerScheduler } from '../triggers/trigger-registry.js';
import { knowledgeService } from '../knowledge/knowledge-service.js';

/** Threshold for input_tokens before session truncation (100K) */
const SESSION_TOKEN_LIMIT = 100_000;

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

  constructor(role: AgentProfileData, fileStore?: FileStore) {
    this.role = role;
    this.fileStore = fileStore ?? new FileStore();
    this.workUnitService = new WorkUnitService(undefined, this.fileStore);
    this.acceptedTypes = this.parseAcceptedTypes(role.description);
    // W-4 fix: parse channels from role.channels JSON
    try {
      const parsed = JSON.parse(role.channels || '[]');
      this.myChannels = Array.isArray(parsed) ? parsed : [];
    } catch {
      this.myChannels = [];
    }
  }

  /** Start the agent loop: create instance, register EVENT trigger, enter observe-decide-act cycle */
  async start(): Promise<void> {
    // AC-4.5: Health probe — verify Claude CLI is available
    try {
      execSync('claude --version', { timeout: 5000 });
    } catch {
      logger.error('[AgentLoop] Claude CLI not available');
      return;
    }

    // AC-4.6: Detect and clean up stale previous instances for this role
    const allStates = await this.fileStore.listStates();
    const stalePrev = allStates.find(s => s.roleId === this.role.id && s.pid && !isProcessAlive(s.pid));
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
  }

  /** Main observe→resolveTarget→agentStep→recordResult loop */
  private async runLoop(): Promise<void> {
    while (this.alive) {
      try {
        const observations = await this.observe();
        const target = resolveTarget(observations);

        if (!target) {
          // No work available → back to idle (fix: status stays correct after task completion)
          if (this.instance) {
            await this.fileStore.updateState(this.instance.id, { status: 'idle', currentWorkUnitId: null }).catch(() => {});
          }
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
      if (this.myChannels.length > 0 && s.channelId && !this.myChannels.includes(s.channelId)) return false;
      if (this.acceptedTypes.length > 0 && !this.acceptedTypes.includes(s.type)) return false;
      return true;
    }).sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      .slice(0, 5)
      .map(s => ({
        id: s.id, parentId: s.parentId, type: s.type, scope: s.scope,
        assigneeId: s.assigneeId, status: s.status, failureType: s.failureType,
        retryCount: s.retryCount, timeoutAt: s.timeoutAt ? new Date(s.timeoutAt) : null,
        channelId: s.channelId, projectPath: s.projectPath, metadata: s.metadata,
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

    const prompt = target.newReplies?.length
      ? buildReplyPrompt(wu, target.newReplies)
      : buildContinuePrompt(wu);

    // GAP-5: Knowledge injection — non-blocking
    let knowledgeContext = '';
    try {
      const ctx = await knowledgeService.injectContext(wu.type, {
        tags: [wu.type],
      });
      knowledgeContext = ctx.prompt;
    } catch {
      // Non-blocking: agent continues without knowledge context
    }

    // Session management — per-Agent session (GAP-2: RuntimeInstance.sessionId)
    const metadataUpdates: Partial<WorkUnitMetadata> = {};
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

    // AgentTask with new interface: provider, sessionId, maxTurns, knowledgeContext
    const task: AgentTask = {
      id: wu.id,
      executionId: `${wu.id}-${Date.now()}`,
      provider: (this.role.provider as 'claude' | 'codex' | 'opencode' | 'openclaw') || 'claude',
      prompt,
      parameters: {
        sessionId: agentSessionId ?? undefined,
        maxTurns: 50,
        knowledgeContext: knowledgeContext || undefined,
        agentRole: 'executor',
        workUnitId: wu.id,
        agentProfileId: this.role.id,
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

      // T-1.1: Record tool:call events for PatternMiner data source
      if (result.outputText) {
        try {
          writeToolCallEvents(result.outputText, join(DEFAULT_EVENTS_DIR, 'studio.jsonl'));
        } catch { /* non-blocking */ }
      }

      // GAP-6: recordOutcome + extractFromExecution (non-blocking)
      this.recordExecutionOutcome(wu, result).catch(() => {});

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

  /** Record execution outcome to knowledge service (GAP-6, non-blocking) */
  private async recordExecutionOutcome(wu: WorkUnitData, result: ExecutionResult): Promise<void> {
    try {
      await knowledgeService.recordOutcome({
        executionId: wu.id,
        agentType: 'claude',
        consumedKnowledge: [],
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
        consumedKnowledge: [],
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

    // Single atomic metadata write: merges agentStep updates (sessionId/startedAt/sessionResumes)
    // with monitoring counters (stepCount/consecutiveStuck) — fixes C-3 non-atomic write
    await this.workUnitService.update(wuId, {
      metadata: { ...metadata, ...result.metadataUpdates, stepCount, consecutiveStuck },
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
        await this.workUnitService.transitionStatus(wuId, 'blocked');
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

function buildReplyPrompt(wu: WorkUnitData, replies: ChannelMessageData[]): string {
  const replyText = replies.map(r => r.content).join('\n');
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

// ─── tool:call event recording ───

const DEFAULT_EVENTS_DIR = join(homedir(), 'events');

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
