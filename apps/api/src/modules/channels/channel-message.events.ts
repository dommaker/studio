// Channel Message Events — EventBus subscriber for AgentLoop discussion space (MVP-4)
// Subscribes to channel.message.created and writes to ChannelMessage table
import { eventBus, logger } from '@dommaker/studio-shared';
import { prisma } from '@dommaker/studio-prisma';

interface ChannelMessageCreatedPayload {
  workUnitId?: string;
  content: string;
  authorType: string;
  authorId?: string;
}

export function registerChannelMessageEvents(): void {
  eventBus.subscribe('channel.message.created', async (payload: ChannelMessageCreatedPayload) => {
    if (!payload.workUnitId) return;

    try {
      // Resolve channelId from WorkUnit
      const workUnit = await prisma.workUnit.findUnique({
        where: { id: payload.workUnitId },
      });
      if (!workUnit) {
        logger.warn('[ChannelMessageEvents] WorkUnit not found', { workUnitId: payload.workUnitId });
        return;
      }

      let channelId = workUnit.channelId;
      if (!channelId) {
        // Fallback to first 'rnd' channel
        const rndChannel = await prisma.channel.findFirst({ where: { type: 'rnd' } });
        channelId = rndChannel?.id;
      }

      if (!channelId) {
        logger.warn('[ChannelMessageEvents] No channel found for WorkUnit', { workUnitId: payload.workUnitId });
        return;
      }

      await prisma.channelMessage.create({
        data: {
          channelId,
          authorType: payload.authorType || 'agent',
          content: payload.content,
          workUnitId: payload.workUnitId,
        },
      });

      logger.debug('[ChannelMessageEvents] Message written', { workUnitId: payload.workUnitId, channelId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[ChannelMessageEvents] Failed to write message', { workUnitId: payload.workUnitId, error: message });
    }
  });

  logger.info('[ChannelMessageEvents] Registered channel.message.created subscriber');
}
