/**
 * Message routing logic for channel messages (AC-B1-B4).
 *
 * Priority:
 * 1. replyToId present → thread reply (inherit workUnitId from parent)
 * 2. @mention detected → create WorkUnit
 * 3. plain text → store only
 */
import { prisma } from '@dommaker/studio-prisma';
import { logger } from '@dommaker/studio-shared';
import { channelMessageService } from './channel-message.service.js';
import { WorkUnitService } from '../workunit/workunit.service.js';

const workUnitService = new WorkUnitService(prisma);

/**
 * Detect @mention in message content.
 * Returns the first matched name, or null if no @mention found.
 */
export function detectMention(content: string): string | null {
  const match = content.match(/@([\w-]+)/);
  return match ? match[1] : null;
}

/**
 * Route a message based on its content and context.
 *
 * Priority order:
 * 1. replyToId → thread reply: inherit workUnitId from parent message
 * 2. @mention → create WorkUnit, associate with message
 * 3. plain text → store without workUnitId
 */
export async function routeMessage(
  channelId: string,
  content: string,
  replyToId?: string,
) {
  // Priority 1: Thread reply — inherit workUnitId from parent
  if (replyToId) {
    const originalMsg = await prisma.channelMessage.findUnique({
      where: { id: replyToId },
    });
    if (!originalMsg) {
      throw new Error(`Replied message ${replyToId} not found`);
    }
    const inheritedWorkUnitId = originalMsg.workUnitId ?? undefined;
    return channelMessageService.createHumanMessage(
      channelId,
      content,
      replyToId,
      inheritedWorkUnitId,
    );
  }

  // Priority 2: @mention → create WorkUnit
  const mentionName = detectMention(content);
  if (mentionName) {
    const agent = await prisma.agentProfile.findFirst({
      where: { name: mentionName, status: 'active' },
    });
    const scope = content.replace(/@[\w-]+\s*/, '');
    const workUnit = await workUnitService.create({
      scope,
      channelId,
      type: 'task',
      status: 'unassigned',
      metadata: {
        mentionName,
        matched: !!agent,
        creationMode: 'mention',
      },
    });
    logger.info('[MessageRouting] WorkUnit created from @mention', {
      channelId,
      workUnitId: workUnit.id,
      mentionName,
      matched: !!agent,
    });
    return channelMessageService.createHumanMessage(
      channelId,
      content,
      undefined,
      workUnit.id,
    );
  }

  // Priority 3: Plain storage
  return channelMessageService.createHumanMessage(channelId, content);
}
