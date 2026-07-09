/**
 * AC-E2: Convert to Task Service
 *
 * Handles conversion of channel messages to WorkUnits (AC-E1)
 * and LLM-based suggestions for task creation (AC-E2).
 */
import { Prisma, type WorkUnit } from '@prisma/client';
import { logger } from '@dommaker/studio-shared';
import type { ExtendedPrismaClient } from '@dommaker/studio-prisma';

export interface ConvertInput {
  title?: string;
  description?: string;
  assigneeId?: string;
  projectPath?: string;
}

export interface ConvertSuggestion {
  title?: string;
  description?: string;
  suggestedAssigneeId?: string;
  suggestedProjectPath?: string;
}

export class ConvertToTaskService {
  constructor(private prisma: ExtendedPrismaClient) {}

  /**
   * AC-E1: Convert a message to a WorkUnit.
   * Creates WorkUnit, links message as thread anchor.
   */
  async convert(channelId: string, messageId: string, input: ConvertInput): Promise<WorkUnit> {
    // 1. Fetch original message
    const message = await this.prisma.channelMessage.findUnique({ where: { id: messageId } });
    if (!message) {
      throw new Error(`Message ${messageId} not found`);
    }
    if (message.workUnitId) {
      throw new Error(`Message already has WorkUnit ${message.workUnitId}`);
    }

    // 2. Create WorkUnit
    const workUnit = await this.prisma.workUnit.create({
      data: {
        scope: input.title || message.content.slice(0, 500),
        channelId,
        type: 'task',
        status: input.assigneeId ? 'active' : 'unassigned',
        assigneeId: input.assigneeId ?? null,
        projectPath: input.projectPath ?? null,
        metadata: JSON.stringify({
          creationMode: 'convert',
          originalMessageId: messageId,
          description: input.description,
        }),
      },
    });

    // 3. Link message as thread anchor
    await this.prisma.channelMessage.update({
      where: { id: messageId },
      data: { workUnitId: workUnit.id },
    });

    return workUnit;
  }

  /**
   * AC-E2: LLM-based suggestion for converting a message to a task.
   * Returns empty suggestion on failure (non-blocking).
   */
  async suggest(
    messageContent: string,
    agents: Array<{ id: string; name: string; description?: string }>,
    projects: Array<{ name: string; path: string }>,
  ): Promise<ConvertSuggestion> {
    if (!messageContent || !messageContent.trim()) {
      return {};
    }

    try {
      const result = await this.callLLM(messageContent, agents, projects);
      return result;
    } catch (error) {
      logger.warn('[ConvertToTask] LLM suggestion failed (non-blocking)', { error: String(error) });
      return {};
    }
  }

  /** Internal LLM call — exposed for testing */
  async callLLM(
    messageContent: string,
    agents: Array<{ id: string; name: string; description?: string }>,
    projects: Array<{ name: string; path: string }>,
  ): Promise<ConvertSuggestion> {
    const LLM_API_URL = process.env.LLM_API_URL || `http://localhost:${process.env.PORT || 3001}/api/v1/llm/chat`;

    const agentList = agents.map(a => `- ${a.name} (id: ${a.id})${a.description ? `: ${a.description}` : ''}`).join('\n');
    const projectList = projects.map(p => `- ${p.name} (${p.path})`).join('\n');

    const systemPrompt = `You are a task creation assistant. Analyze the message and suggest:
- title: a short task title
- description: a brief description
- suggestedAssigneeId: the best agent ID from the list (or null)
- suggestedProjectPath: the best project path from the list (or null)

Available agents:
${agentList || '(none)'}

Available projects:
${projectList || '(none)'}

Return JSON only: {"title":"...","description":"...","suggestedAssigneeId":"...","suggestedProjectPath":"..."}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const res = await fetch(LLM_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: messageContent },
          ],
          temperature: 0.3,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!res.ok) return {};

      const data = await res.json() as Record<string, unknown>;
      const content = (data.content as string) || (data.choices as Array<{ message?: { content?: string } }>)?.[0]?.message?.content || '';

      // Parse JSON from response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return {};

      const parsed = JSON.parse(jsonMatch[0]);
      return {
        title: parsed.title || undefined,
        description: parsed.description || undefined,
        suggestedAssigneeId: parsed.suggestedAssigneeId || undefined,
        suggestedProjectPath: parsed.suggestedProjectPath || undefined,
      };
    } catch (error) {
      clearTimeout(timeout);
      throw error;
    }
  }
}
