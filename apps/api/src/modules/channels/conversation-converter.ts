/**
 * Conversation → Pipeline Conversion (AS-020 §6.6 P10)
 *
 * Packages conversation context from a Channel and triggers the Analyst
 * agent to start a pipeline.
 */
import { prisma } from '@dommaker/studio-prisma';
import { logger } from '@dommaker/studio-shared';

/** Result of packaging conversation context */
export interface ConversionResult {
  messageCount: number;
  hasRequirementsDoc: boolean;
  contextLength: number;
}

/**
 * Package conversation messages and trigger Analyst pipeline.
 *
 * Filters human + agent messages, formats as dialogue text,
 * injects RequirementsDoc if present, then calls analystTriggerService.trigger().
 *
 * @param channelId - Channel to convert
 * @returns ConversionResult with packaging stats
 */
export async function convertConversationToPipeline(
  channelId: string,
): Promise<ConversionResult> {
  // Fetch all messages in chronological order
  const messages = await prisma.channelMessage.findMany({
    where: { channelId },
    orderBy: { createdAt: 'asc' },
  });

  // Filter human + agent messages (preserve discussion context)
  const dialogueMessages = messages.filter(
    (m) => m.authorType === 'human' || m.authorType === 'agent',
  );

  if (dialogueMessages.length === 0) {
    throw new Error('No conversation messages found in channel');
  }

  // Format as dialogue text
  const conversation = dialogueMessages
    .map((m) => {
      const meta = typeof m.meta === 'string' ? JSON.parse(m.meta) : m.meta;
      const role =
        m.authorType === 'human'
          ? '用户'
          : `@${m.agentName || meta?.agentName || 'Agent'}`;
      return `${role}: ${m.content}`;
    })
    .join('\n\n---\n\n');

  // Inject RequirementsDoc if one was generated during conversation
  const reqDocMessage = messages.find((m) => {
    const meta = typeof m.meta === 'string' ? JSON.parse(m.meta) : m.meta;
    return meta?.cardType === 'requirements_doc';
  });

  const context = reqDocMessage
    ? `${conversation}\n\n---\n\n[已生成 RequirementsDoc]\n${reqDocMessage.content}`
    : conversation;

  // Trigger Analyst (fire-and-forget, same as @Analyst in channel)
  const { analystTriggerService } = await import('./analyst-trigger.service.js');
  analystTriggerService
    .trigger(channelId, null, context)
    .catch((err: unknown) =>
      logger.error('[ConversationConverter] Analyst trigger failed', {
        error: String(err),
      }),
    );

  logger.info('[ConversationConverter] Pipeline triggered', {
    channelId,
    messageCount: dialogueMessages.length,
    hasRequirementsDoc: !!reqDocMessage,
    contextLength: context.length,
  });

  return {
    messageCount: dialogueMessages.length,
    hasRequirementsDoc: !!reqDocMessage,
    contextLength: context.length,
  };
}
