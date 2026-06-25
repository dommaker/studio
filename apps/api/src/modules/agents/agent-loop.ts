// AgentLoop — autonomous WorkUnit discovery + claim + execute cycle (AS-026)
// Subscribes to EventBus for new WorkUnits, claims matching ones, executes, submits for review.
// Skill injection handled by session-manager (formatForPrompt + loadSkill MCP tool).
import { eventBus, logger } from '@dommaker/studio-shared';
import { prisma } from '@dommaker/studio-prisma';
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
      await this.tryClaim(workUnits[0]);
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
      // Claim with optimistic lock
      await prisma.workUnit.update({
        where: { id: workUnit.id, assigneeId: null, status: 'unassigned' },
        data: { assigneeId: this.instance!.id, status: 'active', claimedAt: new Date() },
      });
    } catch (err: unknown) {
      this.processing = false;
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof Object && 'code' in (err as any) ? (err as any).code : undefined;
      if (code === 'P2025' || message.includes('Record to update not found')) {
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
        await prisma.workUnit.update({
          where: { id: workUnit.id },
          data: { status: 'in_review' },
        });
        logger.info(`[AgentLoop] WorkUnit ${workUnit.id} submitted for review`);
      } else {
        // Execution failed — unclaim (state machine doesn't support active→unassigned)
        logger.error(`[AgentLoop] Execution failed for ${workUnit.id}: ${result.error}`);
        await this.unclaim(workUnit.id);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[AgentLoop] Execution failed for ${workUnit.id}: ${message}`);
      await this.unclaim(workUnit.id);
    } finally {
      this.processing = false;
    }
  }

  /** Execute WorkUnit — skill injection handled by session-manager */
  private async execute(workUnit: WorkUnit): Promise<ExecutionResult> {
    const prompt = `## Task\nWorkUnit: ${workUnit.id}\nType: ${workUnit.type}\nScope: ${workUnit.scope}`;

    const result: ExecutionResult = await agentExecutor.execute({
      id: workUnit.id,
      executionId: `${workUnit.id}-${Date.now()}`,
      agentType: 'claude',
      prompt,
      timeoutMs: 5 * 60_000, // 5 minutes default
    });

    // Post result to discussion space
    if (result.outputText) {
      await this.postToDiscussionSpace(workUnit.id, result.outputText);
    }

    return result;
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
