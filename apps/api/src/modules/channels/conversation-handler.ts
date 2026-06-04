/**
 * ConversationHandler — Channel conversation mode (AS-020 §6.4)
 *
 * Async execution model:
 *   1. Get or create Claude sessionId
 *   2. Build prompt (knowledge injection + history)
 *   3. Create "thinking" placeholder message
 *   4. Submit async job (placeholder for P5 Daemon integration)
 *   5. Event-driven update via task events
 *
 * Concurrency: same Channel single agent, queue limit 5, 429 response.
 */

import { prisma } from '@dommaker/studio-prisma';
import type { Channel } from '@prisma/client';
import { logger, eventBus } from '@dommaker/studio-shared';
import { channelMessageService } from './channel-message.service.js';
import { buildAgentContext } from '../agents/agent-context.js';
import { knowledgeQuery } from '../knowledge/knowledge-query.service.js';
import { roleConfigService, type RoleType } from '../roles/role-config.service.js';
import { v4 as uuidv4 } from 'uuid';

// ── Types ──

interface ConversationJob {
  channelId: string;
  thinkingMsgId: string;
  content: string;
  sessionId: string;
}

// ── Concurrency Control (P1-04) ──

class ChannelLock {
  private locks = new Map<string, {
    running: boolean;
    queue: Array<{
      resolve: () => void;
      reject: (err: Error) => void;
    }>;
  }>();

  private readonly MAX_QUEUE = 5;

  /**
   * Acquire lock for a channel. Returns a release function.
   * If already running, queues the request (max 5).
   * Throws with status 429 if queue is full.
   */
  async acquire(channelId: string): Promise<() => void> {
    let state = this.locks.get(channelId);
    if (!state) {
      state = { running: false, queue: [] };
      this.locks.set(channelId, state);
    }

    if (!state.running) {
      state.running = true;
      return () => this.release(channelId);
    }

    // Queue depth check
    if (state.queue.length >= this.MAX_QUEUE) {
      throw new ConversationQueueFullError(channelId);
    }

    // Wait in queue
    return new Promise<() => void>((resolve, reject) => {
      state!.queue.push({
        resolve: () => resolve(() => this.release(channelId)),
        reject,
      });
    });
  }

  private release(channelId: string): void {
    const state = this.locks.get(channelId);
    if (!state) return;

    if (state.queue.length > 0) {
      const next = state.queue.shift()!;
      next.resolve();
    } else {
      state.running = false;
    }
  }

  /** Check if channel is currently processing */
  isRunning(channelId: string): boolean {
    return this.locks.get(channelId)?.running ?? false;
  }

  /** Get queue depth for a channel */
  getQueueDepth(channelId: string): number {
    return this.locks.get(channelId)?.queue.length ?? 0;
  }
}

export class ConversationQueueFullError extends Error {
  public readonly status = 429;
  public readonly channelId: string;

  constructor(channelId: string) {
    super(`Conversation queue full for channel ${channelId}`);
    this.name = 'ConversationQueueFullError';
    this.channelId = channelId;
  }
}

// ── Task Message Map (thinking → taskId) ──

class TaskMessageMap {
  private map = new Map<string, string>(); // taskId → thinkingMsgId

  set(taskId: string, thinkingMsgId: string): void {
    this.map.set(taskId, thinkingMsgId);
  }

  get(taskId: string): string | undefined {
    return this.map.get(taskId);
  }

  delete(taskId: string): void {
    this.map.delete(taskId);
  }
}

// ── Conversation Handler ──

class ConversationHandler {
  private lock = new ChannelLock();
  private taskMessageMap = new TaskMessageMap();

  /**
   * Handle a conversation mode message.
   *
   * @param channel - Channel record (must have mode='conversation' and agentName)
   * @param userMessage - The human message record (from channelMessageService)
   * @param content - Trimmed message content
   */
  async handle(
    channel: Channel,
    userMessage: { id: string; [key: string]: unknown },
    content: string,
  ): Promise<void> {
    // Acquire per-channel lock
    let release: (() => void) | undefined;
    try {
      release = await this.lock.acquire(channel.id);
    } catch (err) {
      if (err instanceof ConversationQueueFullError) {
        // Update user message meta with queue full status
        await channelMessageService.updateMessageMeta(userMessage.id, {
          status: 'queue_full',
        });
        logger.warn('[ConversationHandler] Queue full', {
          channelId: channel.id,
          queueDepth: this.lock.getQueueDepth(channel.id),
        });
        return;
      }
      throw err;
    }

    try {
      await this.processMessage(channel, content);
    } finally {
      release();
    }
  }

  private async processMessage(
    channel: Channel,
    content: string,
  ): Promise<void> {
    // 1. Get or create Claude sessionId
    let sessionId = channel.sessionId;
    if (!sessionId) {
      sessionId = uuidv4();
      await prisma.channel.update({
        where: { id: channel.id },
        data: { sessionId },
      });
      logger.info('[ConversationHandler] Created session', { channelId: channel.id, sessionId });
    }

    // 2. Build prompt (knowledge injection + history)
    const prompt = await this.buildPrompt(channel, content);

    // 3. "thinking" placeholder message
    const thinkingMsg = await channelMessageService.createAgentMessage(
      channel.id,
      channel.agentName!,
      '...',
      { meta: { cardType: 'thinking', status: 'thinking' } },
    );

    // 4. Submit async job
    //    P1: placeholder — actual Daemon integration is P5
    //    For now, simulate with a direct call to the local agent
    const taskId = uuidv4();
    this.taskMessageMap.set(taskId, thinkingMsg.id);

    logger.info('[ConversationHandler] Submitted job', {
      channelId: channel.id,
      taskId,
      thinkingMsgId: thinkingMsg.id,
      sessionId,
    });

    // Register event listener for task completion
    this.registerTaskEventListener(channel.id, taskId, thinkingMsg.id);

    // P5 integration point: submit to Daemon
    // For now, emit a placeholder event that simulates async completion
    this.submitPlaceholderJob(channel, taskId, prompt, sessionId);
  }

  /**
   * Build prompt with knowledge injection and conversation history.
   */
  async buildPrompt(channel: Channel, userContent: string): Promise<string> {
    const parts: string[] = [];

    // 1. Agent identity from RoleConfig
    if (channel.agentName) {
      try {
        const companies = await prisma.company.findMany({ take: 1 });
        if (companies.length > 0) {
          const roleType = this.mapAgentNameToRoleType(channel.agentName);
          const roleConfig = await roleConfigService.get(roleType, companies[0].id);
          if (roleConfig?.systemPrompt) {
            parts.push(`# Agent: ${channel.agentName}\n\n${roleConfig.systemPrompt}`);
          }
        }
      } catch (err) {
        logger.warn('[ConversationHandler] Failed to load role config', { error: String(err) });
      }
    }

    // 2. Agent context (harness constraints + skills)
    try {
      const agentCtx = buildAgentContext({
        agentType: channel.agentName?.toLowerCase() || 'analyst',
        trigger: 'goal_start',
        compact: true,
      });
      if (agentCtx.prompt) {
        parts.push(agentCtx.prompt);
      }
    } catch (err) {
      logger.warn('[ConversationHandler] Failed to build agent context', { error: String(err) });
    }

    // 3. Knowledge injection from local knowledge base (unified via buildKnowledgeContext)
    try {
      const { buildKnowledgeContext } = await import('../knowledge/consumers/prompt-builder.js');
      const knowledgePrompt = await buildKnowledgeContext(channel.agentName?.toLowerCase());
      if (knowledgePrompt) {
        parts.push(`# Knowledge Context\n${knowledgePrompt}`);
      }
    } catch (err) {
      logger.warn('[ConversationHandler] Failed to load knowledge', { error: String(err) });
    }

    // 4. Conversation history (last 10 rounds = 20 messages)
    try {
      const history = await prisma.channelMessage.findMany({
        where: { channelId: channel.id },
        orderBy: { createdAt: 'desc' },
        take: 20,
      });

      if (history.length > 0) {
        // Reverse to chronological order
        history.reverse();
        const historyText = history
          .map(m => {
            const role = m.authorType === 'human' ? 'User' : `@${m.agentName || 'Agent'}`;
            return `${role}: ${m.content}`;
          })
          .join('\n');
        parts.push(`# Conversation History\n${historyText}`);
      }
    } catch (err) {
      logger.warn('[ConversationHandler] Failed to load history', { error: String(err) });
    }

    // 5. Current user message
    parts.push(`# User Message\n${userContent}`);

    return parts.join('\n\n---\n\n');
  }

  /**
   * Register event listener for task completion.
   * Listens for task events to update the thinking message.
   */
  private registerTaskEventListener(
    channelId: string,
    taskId: string,
    thinkingMsgId: string,
  ): void {
    const handler = async (event: { taskId: string; type: string; content?: string; error?: string }) => {
      if (event.taskId !== taskId) return;

      try {
        if (event.type === 'output' && event.content) {
          // Update thinking message with streaming content
          await channelMessageService.updateMessage(thinkingMsgId, {
            content: event.content,
            meta: { cardType: null, status: 'streaming' },
          });
        } else if (event.type === 'done') {
          // Final update
          await channelMessageService.updateMessage(thinkingMsgId, {
            content: event.content || 'No response',
            meta: { cardType: null, status: 'done' },
          });
          this.taskMessageMap.delete(taskId);
          eventBus.unsubscribe('task.event', handler);
          logger.info('[ConversationHandler] Task done', { taskId, thinkingMsgId });
        } else if (event.type === 'error') {
          // Error update
          await channelMessageService.updateMessage(thinkingMsgId, {
            content: `Error: ${event.error || 'Unknown error'}`,
            meta: { cardType: 'error', status: 'error' },
          });
          this.taskMessageMap.delete(taskId);
          eventBus.unsubscribe('task.event', handler);
          logger.error('[ConversationHandler] Task failed', { taskId, error: event.error });
        }
      } catch (err) {
        logger.error('[ConversationHandler] Event handler error', { taskId, error: String(err) });
      }
    };

    eventBus.subscribe('task.event', handler);

    // Auto-cleanup after 5 minutes
    setTimeout(() => {
      eventBus.unsubscribe('task.event', handler);
      this.taskMessageMap.delete(taskId);
    }, 5 * 60 * 1000);
  }

  /**
   * Placeholder job submission (P1 stub).
   * In P5, this will be replaced by Daemon integration.
   * For now, simulates a response after a short delay.
   */
  private submitPlaceholderJob(
    channel: Channel,
    taskId: string,
    prompt: string,
    sessionId: string,
  ): void {
    // Simulate async completion after 1s
    setTimeout(async () => {
      try {
        const thinkingMsgId = this.taskMessageMap.get(taskId);
        if (!thinkingMsgId) return;

        // Simulate a response
        const response = `[Placeholder] Agent ${channel.agentName} received your message. ` +
          `Session: ${sessionId.slice(0, 8)}. ` +
          `Full Daemon integration coming in P5.`;

        eventBus.publish('task.event', {
          taskId,
          type: 'done',
          content: response,
        });
      } catch (err) {
        logger.error('[ConversationHandler] Placeholder job error', { taskId, error: String(err) });
      }
    }, 1000);
  }

  /**
   * Map agent name to RoleType for role config lookup.
   */
  private mapAgentNameToRoleType(agentName: string): RoleType {
    const normalized = agentName.toLowerCase();
    const mapping: Record<string, RoleType> = {
      analyst: 'analyst',
      executor: 'executor',
      reviewer: 'reviewer',
      kk: 'knowledge_keeper',
      knowledge_keeper: 'knowledge_keeper',
      auditor: 'auditor',
      triage: 'triage',
      deploy: 'deploy',
    };
    return mapping[normalized] || 'analyst';
  }

  /**
   * Get concurrency status for a channel (for API responses).
   */
  getStatus(channelId: string): { running: boolean; queueDepth: number } {
    return {
      running: this.lock.isRunning(channelId),
      queueDepth: this.lock.getQueueDepth(channelId),
    };
  }
}

export const conversationHandler = new ConversationHandler();
