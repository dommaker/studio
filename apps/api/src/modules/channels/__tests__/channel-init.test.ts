/**
 * Channel Init tests — ensureDefaultChannels (FileStore-based)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { listChannelsMock, createChannelMock } = vi.hoisted(() => ({
  listChannelsMock: vi.fn().mockResolvedValue([]),
  createChannelMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@dommaker/studio-shared', async () => {
  const actual = await vi.importActual<typeof import('@dommaker/studio-shared')>('@dommaker/studio-shared');
  return {
    ...actual,
    FileStore: vi.fn(function () { return {
      listChannels: listChannelsMock,
      createChannel: createChannelMock,
    }; }),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});

import { ensureDefaultChannels } from '../channel-init.js';

describe('ensureDefaultChannels', () => {
  beforeEach(() => {
    listChannelsMock.mockClear();
    createChannelMock.mockClear();
  });

  it('creates 3 default channels when none exist', async () => {
    await ensureDefaultChannels();
    expect(createChannelMock).toHaveBeenCalledTimes(3);
  });

  it('creates #研发, #决策, #系统', async () => {
    await ensureDefaultChannels();
    const calls = createChannelMock.mock.calls.map((c: any[]) => ({
      name: c[0].name,
      type: c[0].type,
    }));
    expect(calls).toEqual([
      { name: '#研发', type: 'rnd' },
      { name: '#决策', type: 'decision' },
      { name: '#系统', type: 'system' },
    ]);
  });

  it('skips existing channels (no duplicate)', async () => {
    listChannelsMock.mockResolvedValue([{ id: 'existing' }]);
    await ensureDefaultChannels();
    expect(createChannelMock).not.toHaveBeenCalled();
  });

  it('does not throw on success', async () => {
    await expect(ensureDefaultChannels()).resolves.toBeUndefined();
  });

  it('handles FileStore errors gracefully (non-blocking)', async () => {
    createChannelMock.mockRejectedValue(new Error('FileStore error'));
    await expect(ensureDefaultChannels()).resolves.toBeUndefined();
  });
});
