// Seed default channels on startup (B1-001)
import { prisma } from '@dommaker/studio-prisma';
import { logger } from '@dommaker/studio-shared';

const DEFAULT_CHANNELS = [
  { name: '#研发', type: 'rnd' },
  { name: '#决策', type: 'decision' },
  { name: '#系统', type: 'system' },
];

export async function ensureDefaultChannels(): Promise<void> {
  for (const ch of DEFAULT_CHANNELS) {
    await prisma.channel.upsert({
      where: { name: ch.name },
      update: {},
      create: ch,
    });
  }
  logger.info('[Channel] Default channels ensured');
}
