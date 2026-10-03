/**
 * bootstrap/channels 测试（P2-a）：ensureDefaultChannels 被调用；失败不阻断启动。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../modules/channels/channel-init.js', () => ({
  ensureDefaultChannels: vi.fn(async () => {}),
}));

import { ensureDefaultChannels } from '../../modules/channels/channel-init.js';
import { initChannels } from '../channels.js';

const ensureMock = vi.mocked(ensureDefaultChannels);

beforeEach(() => {
  ensureMock.mockReset();
});

describe('initChannels', () => {
  it('调用 ensureDefaultChannels', async () => {
    await initChannels();
    expect(ensureMock).toHaveBeenCalledOnce();
  });

  it('失败只 log 不阻断（resolves，不 rethrow）', async () => {
    ensureMock.mockRejectedValue(new Error('channel store broken'));
    await expect(initChannels()).resolves.toBeUndefined();
  });
});
