/**
 * B3-002/B3-003: Shared command runner for CLI and Discord
 *
 * Both `studio run` CLI and `/studio run` Discord slash command
 * reuse this logic to submit a requirement to #研发 and trigger @Analyst.
 */
import { prisma } from '@dommaker/studio-prisma';
import { logger } from '@dommaker/studio-shared';
import { channelMessageService } from '../channels/channel-message.service.js';

/**
 * Submit a requirement to #研发 channel and trigger @Analyst analysis.
 * Returns a confirmation message suitable for display to the user.
 */
export async function triggerRequirement(requirement: string): Promise<string> {
  // Find #研发 channel
  const rndChannel = await prisma.channel.findFirst({ where: { type: 'rnd' } });
  if (!rndChannel) {
    throw new Error('#研发 channel not found. Start studio first.');
  }

  // Append @Analyst to trigger analysis (case-insensitive check to avoid double-append)
  const content = /@analyst/i.test(requirement) ? requirement : `${requirement} @Analyst`;

  // Create human message in the channel
  const message = await channelMessageService.createHumanMessage(rndChannel.id, content);

  // Fire Analyst trigger (the route handler normally does this for HTTP requests,
  // but since we call createHumanMessage directly, we need to trigger manually)
  const { analystTriggerService } = await import('../channels/analyst-trigger.service.js');
  analystTriggerService.trigger(rndChannel.id, message.id, content).catch(err =>
    logger.error('[CommandRunner] Analyst trigger failed', { error: String(err) }),
  );

  logger.info('[CommandRunner] Requirement submitted', { channelId: rndChannel.id, messageId: message.id });

  return `✅ 已提交到 #研发，Analyst 正在分析...\nMessage ID: ${message.id}`;
}
