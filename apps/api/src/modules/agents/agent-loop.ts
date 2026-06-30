// AgentLoop — autonomous WorkUnit discovery + claim + execute cycle (AS-026)
// Subscribes to EventBus for new WorkUnits, claims matching ones, executes, submits for review.
// Skill injection handled by session-manager (formatForPrompt + loadSkill MCP tool).
// Post-execution: analyzes agent log for knowledge search behavior (analyzeKnowledgeSearch).
import { eventBus, logger, parseStreamEvents, extractToolCalls } from '@dommaker/studio-shared';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { prisma } from '@dommaker/studio-prisma';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { agentExecutor } from '@dommaker/studio-agent';
import { registerExecuteHandler, unregisterExecuteHandler } from '../triggers/trigger-action.js';
import { TriggerScheduler } from '../triggers/trigger-scheduler.js';
import { WorkUnitService } from '../workunit/workunit.service.js';
import type { TriggerConfig } from '../triggers/trigger.types.js';
import type { WorkUnit, AgentProfile } from '@prisma/client';

/** Result from agentExecutor.execute() */
interface ExecutionResult {
  success: boolean;
  worktree: string;
  outputFiles: string[];
  error?: string;
  failureLog?: string;
  logFile: string;
  sessionCount: number;
  totalDurationMs?: number;
  sessionIds?: string[];
  outputText?: string;
}

/** Path to project knowledge base — injected into Agent prompt for on-demand retrieval */
const KNOWLEDGE_BASE_PATH = `${homedir()}/.studio/knowledge/`;

/** Result of analyzing agent log for knowledge search behavior */
export interface KnowledgeSearchAnalysis {
  searched: boolean;
  searchCalls: Array<{ tool: string; detail?: string }>;
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
  private registry: TriggerScheduler;
  private workUnitService: WorkUnitService;
  private instance: RuntimeInstanceRow | null = null;
  private processing = false;
  private acceptedTypes: string[] = [];
  private scanInterval: ReturnType<typeof setInterval> | null = null;

  private static readonly SCAN_INTERVAL_MS = 30_000; // 30 seconds

  constructor(role: AgentProfile, registry: TriggerScheduler) {
    this.role = role;
    this.registry = registry;
    this.workUnitService = new WorkUnitService(prisma);
    this.acceptedTypes = this.parseAcceptedTypes(role.description);
  }

  /** Start the agent loop: create instance, register triggers, scan for work */
  async start(): Promise<void> {
    // 1. Create RuntimeInstance
    this.instance = await prisma.runtimeInstance.create({
      data: {
        roleId: this.role.id,
        status: 'idle',
      },
    }) as RuntimeInstanceRow;

    // 2. Register EVENT trigger for workunit.created
    this.registerAgentTriggers();

    // 3. Register EXECUTE handlers so trigger-action can call us
    registerExecuteHandler('agent-loop', (context: unknown) => {
      const workUnit = context as WorkUnit;
      return this.onNewWorkUnit(workUnit);
    });
    registerExecuteHandler('agent-scan-workunits', () => {
      return this.scanForWork();
    });

    // 4. Initial scan (non-blocking — don't await, let server start first)
    this.scanForWork().catch(err =>
      logger.error(`[AgentLoop] Initial scan failed for ${this.role.name}: ${err.message}`)
    );

    // 5. Periodic scan (bypasses cron — EventBus is in-process only)
    this.scanInterval = setInterval(() => {
      this.scanForWork().catch(err =>
        logger.error(`[AgentLoop] Periodic scan failed for ${this.role.name}: ${err.message}`)
      );
    }, AgentLoop.SCAN_INTERVAL_MS);

    logger.info(`[AgentLoop] Started for role ${this.role.name} (instance=${this.instance.id}, scanEvery=${AgentLoop.SCAN_INTERVAL_MS}ms)`);
  }

  /** Stop the agent loop and clean up */
  stop(): void {
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }
    unregisterExecuteHandler('agent-loop');
    unregisterExecuteHandler('agent-scan-workunits');
    if (this.instance) {
      prisma.runtimeInstance.update({
        where: { id: this.instance.id },
        data: { status: 'terminated', terminatedAt: new Date() },
      }).catch(err => logger.error(`[AgentLoop] Failed to terminate instance: ${err.message}`));
    }
  }

  /** Handle new WorkUnit event from EventBus via trigger */
  async onNewWorkUnit(workUnit: WorkUnit): Promise<void> {
    if (!this.canClaim(workUnit)) return;
    await this.tryClaim(workUnit);
  }

  /** Scan for unassigned WorkUnits matching acceptedTypes */
  async scanForWork(): Promise<void> {
    if (this.processing) return;

    // Update heartbeat
    if (this.instance) {
      await prisma.runtimeInstance.update({
        where: { id: this.instance.id },
        data: { lastHeartbeat: new Date() },
      }).catch(() => {}); // best-effort
    }

    logger.info(`[AgentLoop] Scanning for work: role=${this.role.name} acceptedTypes=${JSON.stringify(this.acceptedTypes)}`);

    const workUnits = await prisma.workUnit.findMany({
      where: {
        status: 'unassigned',
        assigneeId: null,
        type: { in: this.acceptedTypes.length > 0 ? this.acceptedTypes : undefined },
      },
      orderBy: { createdAt: 'asc' },
      take: 1,
    });

    if (workUnits.length > 0) {
      logger.info(`[AgentLoop] Found unassigned WorkUnit: ${workUnits[0].id} type=${workUnits[0].type}`);
      await this.tryClaim(workUnits[0]);
    } else {
      logger.info(`[AgentLoop] No unassigned WorkUnits found for role=${this.role.name}`);
    }
  }

  /** Register EVENT trigger for workunit.created */
  private registerAgentTriggers(): void {
    const trigger: TriggerConfig = {
      id: `agent-discover-${this.role.id}`,
      name: `Auto-discover for ${this.role.name}`,
      condition: { type: 'EVENT', event: 'workunit.created' },
      action: { type: 'EXECUTE', target: 'agent-loop' },
      enabled: true,
      scope: 'system',
    };
    this.registry.registerTrigger(trigger);
  }

  /** Check if this agent can claim the given WorkUnit */
  private canClaim(workUnit: WorkUnit): boolean {
    if (this.processing) return false;
    if (!this.instance) return false;
    if (workUnit.status !== 'unassigned') return false;
    if (this.acceptedTypes.length > 0 && !this.acceptedTypes.includes(workUnit.type)) return false;
    return true;
  }

  /** Try to claim and execute a WorkUnit */
  private async tryClaim(workUnit: WorkUnit): Promise<void> {
    this.processing = true;
    try {
      // Claim via WorkUnitService (triggers autoLoadSkillsForAgent)
      await this.workUnitService.claim(workUnit.id, this.instance!.id);
    } catch (err: unknown) {
      this.processing = false;
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('Claim failed') || message.includes('already claimed')) {
        logger.debug(`[AgentLoop] WorkUnit ${workUnit.id} already claimed, skipping`);
        return;
      }
      throw err;
    }

    try {
      // Execute — skill injection handled by session-manager (formatForPrompt + loadSkill MCP)
      const result = await this.execute(workUnit);

      if (result.success) {
        // Submit for review
        await this.workUnitService.transitionStatus(workUnit.id, 'in_review');
        logger.info(`[AgentLoop] WorkUnit ${workUnit.id} submitted for review`);
      } else {
        // Execution failed — unclaim
        logger.error(`[AgentLoop] Execution failed for ${workUnit.id}: ${result.error}`);
        await this.workUnitService.unclaim(workUnit.id);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[AgentLoop] Execution failed for ${workUnit.id}: ${message}`);
      await this.workUnitService.unclaim(workUnit.id);
    } finally {
      this.processing = false;
    }
  }

  /** Execute WorkUnit — skill injection by session-manager; post-execution knowledge analysis */
  private async execute(workUnit: WorkUnit): Promise<ExecutionResult> {
    // [Skill Discovery] Log WorkUnit context for analysis
    logger.info(`[SkillDiscovery] workUnit=${workUnit.id} type=${workUnit.type} role=${this.role.name} scope="${workUnit.scope?.substring(0, 100)}"`);

    const prompt = [
      `## Task`,
      `WorkUnit: ${workUnit.id}`,
      `Type: ${workUnit.type}`,
      `Scope: ${workUnit.scope}`,
      ``,
      `## Knowledge`,
      `Project knowledge base: ${KNOWLEDGE_BASE_PATH}`,
      `Search the INDEX first (one-line-per-entry, 80-96% less output):`,
      `  grep -i "<keyword>" ${KNOWLEDGE_BASE_PATH}_index.md`,
      `Then Read the matching file for full content:`,
      `  Read ${KNOWLEDGE_BASE_PATH}<filename>`,
      `Fallback: grep -r "<keyword>" ${KNOWLEDGE_BASE_PATH} only if index misses.`,
    ].join('\n');

    const result: ExecutionResult = await agentExecutor.execute({
      id: workUnit.id,
      executionId: `${workUnit.id}-${Date.now()}`,
      agentType: 'claude',
      prompt,
      timeoutMs: 5 * 60_000, // 5 minutes default
    });

    // Analyze knowledge search behavior from agent log
    if (result.logFile) {
      const analysis = this.analyzeKnowledgeSearchFromLog(result.logFile);
      if (analysis.searched) {
        logger.info(`[AgentLoop] Knowledge search detected for ${workUnit.id}: ${analysis.searchCalls.length} call(s) [${analysis.searchCalls.map(c => c.tool).join(', ')}]`);
      }
    }

    // Post result to discussion space
    if (result.outputText) {
      await this.postToDiscussionSpace(workUnit.id, result.outputText);
    }

    return result;
  }

  /** Read agent log file and analyze for knowledge search behavior */
  private analyzeKnowledgeSearchFromLog(logFile: string): KnowledgeSearchAnalysis {
    try {
      const logContent = readFileSync(logFile, 'utf-8');
      return analyzeKnowledgeSearch(logContent);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.debug(`[AgentLoop] Failed to read log file for knowledge analysis: ${message}`);
      return { searched: false, searchCalls: [] };
    }
  }

  /** Unclaim WorkUnit (direct prisma — state machine doesn't support active→unassigned) */
  private async unclaim(workUnitId: string): Promise<void> {
    await prisma.workUnit.update({
      where: { id: workUnitId },
      data: { assigneeId: null, status: 'unassigned' },
    }).catch(unclaimErr => {
      logger.error(`[AgentLoop] Unclaim failed for ${workUnitId}: ${unclaimErr.message}`);
    });
  }

  /** Post execution result to WorkUnit discussion space */
  private async postToDiscussionSpace(workUnitId: string, content: string): Promise<void> {
    eventBus.publish('channel.message.created', {
      workUnitId,
      content,
      authorType: 'agent',
      authorId: this.instance?.id,
    });
  }

  /** Parse accepted WorkUnit types from role description */
  private parseAcceptedTypes(description: string | null): string[] {
    if (!description) return [];
    // Extract types from description like "handles tasks and bugs"
    const typeKeywords = ['task', 'bug', 'feature', 'refactor', 'test', 'docs', 'review'];
    return typeKeywords.filter(kw => description.toLowerCase().includes(kw));
  }
}

/**
 * Analyze agent log for knowledge search behavior.
 * Checks if the agent used Read/Bash/Glob on knowledge base paths, or called mcp__local-rag tools.
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

/** Returns a detail string if the tool call targets the knowledge base, null otherwise */
function getKnowledgeSearchDetail(toolName: string, input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const inp = input as Record<string, unknown>;

  // Read — check file_path
  if (toolName === 'Read') {
    const fp = inp.file_path;
    if (typeof fp === 'string' && fp.includes('.studio/knowledge')) return fp;
  }

  // Bash — check command for knowledge base paths
  if (toolName === 'Bash') {
    const cmd = inp.command;
    if (typeof cmd === 'string' && cmd.includes('.studio/knowledge')) return cmd;
  }

  // Glob — check pattern for knowledge base paths
  if (toolName === 'Glob') {
    const pattern = inp.pattern;
    if (typeof pattern === 'string' && pattern.includes('.studio/knowledge')) return pattern;
  }

  return null;
}
