// ── Channel 初始化（Goal 管线需要）──
// P2-a：自 apps/api/src/index.ts 拆出。失败只 log，不阻断启动。
import { logger } from '@dommaker/studio-shared';

export async function initChannels(): Promise<void> {
  await import('../modules/channels/index.js').then(({ ensureDefaultChannels }) =>
    ensureDefaultChannels()
  ).catch(e => logger.warn('Channel init unavailable', { error: String(e) }));
}
