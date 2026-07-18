/**
 * B3-002/B3-003: Shared command runner for CLI and Discord
 *
 * Both `studio run` CLI and `/studio run` Discord slash command
 * reuse this logic to submit a requirement to #研发 and create a WorkUnit.
 */
import { logger, FileStore } from '@dommaker/studio-shared';
import { channelMessageService } from '../channels/channel-message.service.js';
import { WorkUnitService } from '../workunit/workunit.service.js';

const fileStore = new FileStore();
const workUnitService = new WorkUnitService();

/**
 * Submit a requirement to #研发 channel and create a WorkUnit.
 * Returns a confirmation message suitable for display to the user.
 */
export async function triggerRequirement(requirement: string): Promise<string> {
  // Find #研发 channel
  const rndChannels = await fileStore.listChannels({ type: 'rnd' });
  const rndChannel = rndChannels[0] ?? null;
  if (!rndChannel) {
    throw new Error('#研发 channel not found. Start studio first.');
  }

  const content = requirement.trim();

  // Create human message in the channel
  const message = await channelMessageService.createHumanMessage(rndChannel.id, content);

  // Create WorkUnit for the requirement
  await workUnitService.create({
    scope: content,
    channelId: rndChannel.id,
    type: 'task',
    status: 'unassigned',
    metadata: { creationMode: 'discord' },
  });

  logger.info('[CommandRunner] Requirement submitted', { channelId: rndChannel.id, messageId: message.id });

  return `✅ 已提交到 #研发，WorkUnit 已创建\nMessage ID: ${message.id}`;
}
