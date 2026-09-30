// Seed default channels on startup (B1-001)
import { randomUUID } from 'crypto';
import { logger, FileStore } from '@dommaker/studio-shared';
import { getStore } from '../../core/store.js';



const DEFAULT_CHANNELS: Array<{ name: string; type: string }> = [
  { name: '#研发', type: 'rnd' },
  { name: '#决策', type: 'decision' },
  { name: '#系统', type: 'system' },
];

export async function ensureDefaultChannels(): Promise<void> {
  for (const ch of DEFAULT_CHANNELS) {
    // Check if exists in FileStore
    const existing = await getStore().listChannels({ name: ch.name });
    if (existing.length === 0) {
      const now = new Date().toISOString();
      await getStore().createChannel({
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
