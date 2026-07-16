/**
 * Message routing logic for channel messages (AC-B1-B4).
 *
 * Priority:
 * 1. replyToId present → thread reply (inherit workUnitId from parent)
 * 2. @mention detected → create WorkUnit
 * 3. plain text → store only
 */
import { logger, FileStore } from '@dommaker/studio-shared';
import { channelMessageService } from './channel-message.service.js';
import { WorkUnitService } from '../workunit/workunit.service.js';

const fileStore = new FileStore();
const workUnitService = new WorkUnitService();

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
  fs?: FileStore,
) {
  const resolvedFs = fs ?? fileStore;
  // Use resolved FileStore for WorkUnitService (supports test injection)
  const wuService = new WorkUnitService(undefined, resolvedFs);

  // Priority 1: Thread reply — inherit workUnitId from parent
  if (replyToId) {
    const found = await resolvedFs.getMessageById(replyToId);
    if (!found) {
      throw new Error(`Replied message ${replyToId} not found`);
    }
    const inheritedWorkUnitId = found.message.workUnitId ?? undefined;
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
    const allProfiles = await resolvedFs.listProfiles({ status: 'active' });
    const agent = allProfiles.find(p => p.name === mentionName) ?? null;
    const scope = content.replace(/@[\w-]+\s*/, '');
    const workUnit = await wuService.create({
      scope,
      channelId,
      type: 'task',
      status: 'unassigned',
      assigneeId: agent?.id ?? null,
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
