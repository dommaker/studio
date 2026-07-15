// Seed default channels on startup (B1-001)
import { randomUUID } from 'crypto';
import { logger, FileStore } from '@dommaker/studio-shared';

const fileStore = new FileStore();

const DEFAULT_CHANNELS: Array<{ name: string; type: string }> = [
  { name: '#研发', type: 'rnd' },
  { name: '#决策', type: 'decision' },
  { name: '#系统', type: 'system' },
];

export async function ensureDefaultChannels(): Promise<void> {
  for (const ch of DEFAULT_CHANNELS) {
    // Check if exists in FileStore
    const existing = await fileStore.listChannels({ name: ch.name });
    if (existing.length === 0) {
      const now = new Date().toISOString();
      await fileStore.createChannel({
        id: randomUUID(),
        name: ch.name,
        type: ch.type,
        defaultWorkspaceId: null,
        defaultPath: null,
        discordChannelId: null,
        discordWebhookUrl: null,
        members: '[]',
        createdAt: now,
        updatedAt: now,
      });
    }
  }
  logger.info('[Channel] Default channels ensured');
}
