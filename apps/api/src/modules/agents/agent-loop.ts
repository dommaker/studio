// AgentLoop — autonomous WorkUnit discovery + claim + execute cycle (AS-026)
// Subscribes to EventBus for new WorkUnits, claims matching ones, loads skills, executes, submits for review.
import { eventBus, logger } from '@dommaker/studio-shared';
import { prisma } from '@dommaker/studio-prisma';
import { skillLoader } from '@dommaker/studio-skill';
import { agentExecutor } from '@dommaker/studio-agent';
import { registerExecuteHandler, unregisterExecuteHandler } from '../triggers/trigger-action.js';
import { TriggerScheduler } from '../triggers/trigger-scheduler.js';
import type { TriggerConfig } from '../triggers/trigger.types.js';
import type { WorkUnit, AgentProfile } from '@prisma/client';
import type { SkillDefinition } from '@dommaker/studio-skill';

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
  private instance: RuntimeInstanceRow | null = null;
  private processing = false;
  private acceptedTypes: string[] = [];

  constructor(role: AgentProfile, registry: TriggerScheduler) {
    this.role = role;
    this.registry = registry;
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

    // 3. Register EXECUTE handler so trigger-action can call us
    registerExecuteHandler('agent-loop', (context: unknown) => {
      const workUnit = context as WorkUnit;
      return this.onNewWorkUnit(workUnit);
    });

    // 4. Initial scan
    await this.scanForWork();

    logger.info(`[AgentLoop] Started for role ${this.role.name} (instance=${this.instance.id})`);
  }

  /** Stop the agent loop and clean up */
  stop(): void {
    unregisterExecuteHandler('agent-loop');
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
      await this.tryClaim(workUnits[0] as WorkUnit);
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
    } catch (err: any) {
      this.processing = false;
      if (err?.code === 'P2025' || err?.status === 409) {
        // Already claimed by someone else — skip
        logger.debug(`[AgentLoop] WorkUnit ${workUnit.id} already claimed, skipping`);
        return;
      }
      throw err;
    }

    try {
      // Load skills (degrade to no-skill on failure)
      let skills: SkillDefinition[] = [];
      try {
        skills = await this.loadSkills(workUnit);
      } catch (err: any) {
        logger.warn(`[AgentLoop] Skill load failed for ${workUnit.id}, degrading: ${err.message}`);
      }

      // Execute
      await this.executeWithSkills(workUnit, skills);

      // Submit for review
      await prisma.workUnit.update({
        where: { id: workUnit.id },
        data: { status: 'in_review' },
      });

      logger.info(`[AgentLoop] WorkUnit ${workUnit.id} submitted for review`);
    } catch (err: any) {
      // Execution failed — unclaim
      logger.error(`[AgentLoop] Execution failed for ${workUnit.id}: ${err.message}`);
      await prisma.workUnit.update({
        where: { id: workUnit.id },
        data: { assigneeId: null, status: 'unassigned' },
      }).catch(unclaimErr => {
        logger.error(`[AgentLoop] Unclaim failed for ${workUnit.id}: ${unclaimErr.message}`);
      });
    } finally {
      this.processing = false;
    }
  }

  /** Load skills matching WorkUnit scope */
  private async loadSkills(workUnit: WorkUnit): Promise<SkillDefinition[]> {
    const allSkills = skillLoader.listAll();
    const scope = workUnit.scope?.toLowerCase() || '';

    const matched = allSkills.filter(s => {
      const desc = s.description?.toLowerCase() || '';
      const name = s.name?.toLowerCase() || '';
      return desc.includes(scope) || name.includes(scope) || scope.includes(name);
    });

    // Load full prompts for matched skills
    const loaded: SkillDefinition[] = [];
    for (const skill of matched) {
      const full = skillLoader.loadSingle(skill.name);
      if (full) loaded.push(full);
    }
    return loaded;
  }

  /** Execute WorkUnit with loaded skills */
  private async executeWithSkills(workUnit: WorkUnit, skills: SkillDefinition[]): Promise<void> {
    const skillPrompt = skills.length > 0
      ? `\n\n## Available Skills\n${skills.map(s => `### ${s.name}\n${s.prompt}`).join('\n\n')}`
      : '';

    const prompt = `## Task\nWorkUnit: ${workUnit.id}\nType: ${workUnit.type}\nScope: ${workUnit.scope}${skillPrompt}`;

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
