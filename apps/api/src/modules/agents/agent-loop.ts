// AgentLoop — observe→resolveTarget→agentStep→recordResult decision loop (AS-025)
// Orchestration layer: zero LLM calls. Agent = external compute (Claude Code/OpenCode/Codex).
// Knowledge search analysis preserved as module-level exports.
import { logger, parseStreamEvents, extractToolCalls } from '@dommaker/studio-shared';
import { randomUUID } from 'crypto';
import { prisma } from '@dommaker/studio-prisma';
import { agentRunner } from '@dommaker/studio-agent';
import type { AgentTask, ExecutionResult } from '@dommaker/studio-agent';
import { TriggerScheduler } from '../triggers/trigger-scheduler.js';
import { WorkUnitService, type WorkUnitMetadata } from '../workunit/workunit.service.js';
import type { WorkUnit, AgentProfile, ChannelMessage } from '@prisma/client';

/** Result of analyzing agent log for knowledge search behavior */
export interface KnowledgeSearchAnalysis {
  searched: boolean;
  searchCalls: Array<{ tool: string; detail?: string }>;
}

/** Agent output action after parsing */
export interface StepResult {
  action: 'progress' | 'complete' | 'need_input';
  summary: string;
}

/** Observation collected from DB */
interface Observations {
  myActive: WorkUnit[];
  unassigned: WorkUnit[];
  newReplies: ChannelMessage[];
}

/** Resolved target for agentStep */
interface Target {
  workUnit: WorkUnit;
  newReplies?: ChannelMessage[];
}

interface RuntimeInstanceRow {
  id: string;
  roleId: string;
  sessionId: string | null;
  status: string;
  currentWorkUnitId: string | null;
  startedAt: Date;
  terminatedAt: Date | null;
  metadata: string | null;
}

export class AgentLoop {
  private role: AgentProfile;
  private workUnitService: WorkUnitService;
  private instance: RuntimeInstanceRow | null = null;
  private acceptedTypes: string[] = [];
  private alive = false;
  private myChannels: string[] = [];

  constructor(role: AgentProfile, _registry: TriggerScheduler) {
    this.role = role;
    this.workUnitService = new WorkUnitService(prisma);
    this.acceptedTypes = this.parseAcceptedTypes(role.description);
  }

  /** Start the agent loop: create instance, enter observe-decide-act cycle */
  async start(): Promise<void> {
    this.instance = await prisma.runtimeInstance.create({
      data: { roleId: this.role.id, status: 'idle' },
    }) as RuntimeInstanceRow;

    this.alive = true;
    logger.info(`[AgentLoop] Started for role ${this.role.name} (instance=${this.instance.id})`);

    // Main loop (non-blocking — fire and forget like original)
    this.runLoop().catch(err =>
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
          await sleep(15_000);
          continue;
        }

        // Claim if unassigned
        if (target.workUnit.status === 'unassigned') {
          try {
            await this.workUnitService.claim(target.workUnit.id, this.instance!.id);
            target.workUnit = await prisma.workUnit.findUniqueOrThrow({
              where: { id: target.workUnit.id },
            });
          } catch {
            await sleep(1_000);
            continue;
          }
        }

        // Update heartbeat
        if (this.instance) {
          await prisma.runtimeInstance.update({
            where: { id: this.instance.id },
            data: { lastHeartbeat: new Date(), currentWorkUnitId: target.workUnit.id },
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
    if (this.instance) {
      prisma.runtimeInstance.update({
        where: { id: this.instance.id },
        data: { status: 'terminated', terminatedAt: new Date() },
      }).catch(err => logger.error(`[AgentLoop] Failed to terminate instance: ${err.message}`));
    }
  }

  /** Observe: collect state from DB (zero token) */
  private async observe(): Promise<Observations> {
    const myActive = await prisma.workUnit.findMany({
      where: {
        assigneeId: this.instance?.id,
        status: { in: ['active', 'blocked'] },
      },
    });

    const unassigned = await prisma.workUnit.findMany({
      where: {
        status: 'unassigned',
        channelId: this.myChannels.length > 0 ? { in: this.myChannels } : undefined,
        type: this.acceptedTypes.length > 0 ? { in: this.acceptedTypes } : undefined,
      },
      orderBy: { createdAt: 'asc' },
      take: 5,
    });

    const allReplies: ChannelMessage[] = [];
    for (const wu of myActive) {
      const msgs = await prisma.channelMessage.findMany({
        where: {
          workUnitId: wu.id,
          authorType: 'human',
          createdAt: { gt: wu.updatedAt },
        },
      });
      allReplies.push(...msgs);
    }

    return { myActive, unassigned, newReplies: allReplies };
  }

  /** Execute one step via Agent process (Agent's token) */
  private async agentStep(target: Target): Promise<StepResult> {
    const wu = target.workUnit;
    const metadata = (wu.metadata ? JSON.parse(wu.metadata) : {}) as WorkUnitMetadata;

    const prompt = target.newReplies?.length
      ? buildReplyPrompt(wu, target.newReplies)
      : buildContinuePrompt(wu);

    // Session management
    let sessionFlags: string;
    if (metadata.sessionId) {
      sessionFlags = `--resume ${metadata.sessionId}`;
    } else {
      const newId = randomUUID();
      sessionFlags = `--session-id ${newId}`;
      await prisma.workUnit.update({
        where: { id: wu.id },
        data: { metadata: JSON.stringify({ ...metadata, sessionId: newId, startedAt: new Date().toISOString() }) },
      });
    }

    const task: AgentTask = {
      id: wu.id,
      executionId: `${wu.id}-${Date.now()}`,
      agentType: 'claude',
      prompt,
      parameters: {
        sessionFlags,
        agentRole: 'executor',
        workUnitId: wu.id,
        extraEnv: {
          STUDIO_WORKUNIT_ID: wu.id,
          STUDIO_CHANNEL_ID: wu.channelId ?? '',
        },
      },
      model: 'standard',
      timeoutMs: 120_000,
    };

    const result: ExecutionResult = await agentRunner.executeLightweight(task);
    return parseAgentOutput(result.outputText ?? '');
  }

  /** Record result: monitoring checkpoints + state transitions (zero token) */
  private async recordResult(target: Target, result: StepResult): Promise<void> {
    const wuId = target.workUnit.id;
    const wu = await prisma.workUnit.findUnique({ where: { id: wuId } });
    if (!wu) return;

    const metadata = (wu.metadata ? JSON.parse(wu.metadata) : {}) as WorkUnitMetadata;
    const stepCount = (metadata.stepCount ?? 0) + 1;
    let consecutiveStuck = result.action === 'progress' ? 0 : (metadata.consecutiveStuck ?? 0) + 1;

    await prisma.workUnit.update({
      where: { id: wuId },
      data: { metadata: JSON.stringify({ ...metadata, stepCount, consecutiveStuck }) },
    });

    // Monitoring: step limit
    if (stepCount > 15) {
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
    const wu = await prisma.workUnit.findUnique({ where: { id: workUnitId } });
    if (!wu?.channelId) return;

    await prisma.channelMessage.create({
      data: {
        content,
        workUnitId,
        channelId: wu.channelId,
        authorType: 'agent',
        agentName: this.role.name,
      },
    });
  }

  /** Parse accepted WorkUnit types from role description */
  private parseAcceptedTypes(description: string | null): string[] {
    if (!description) return [];
    const typeKeywords = ['task', 'bug', 'feature', 'refactor', 'test', 'docs', 'review', 'analysis'];
    return typeKeywords.filter(kw => description.toLowerCase().includes(kw));
  }
}

// ─── Exported pure functions (testable) ───

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

function buildContinuePrompt(wu: WorkUnit): string {
  return `## 当前工作

${wu.scope}

## 要求

继续上次工作。每步结束后输出：
  ACTION: PROGRESS:<summary>      完成一步，继续中
  ACTION: COMPLETE:<summary>      全部完成
  ACTION: NEED_INPUT:<需要什么>   需要人类输入`;
}

function buildReplyPrompt(wu: WorkUnit, replies: ChannelMessage[]): string {
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
