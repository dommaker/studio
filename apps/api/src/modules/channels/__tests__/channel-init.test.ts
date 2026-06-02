/**
 * Channel Init tests — ensureDefaultChannels
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { upsertMock } = vi.hoisted(() => ({
  upsertMock: vi.fn().mockResolvedValue({}),
}));

vi.mock('@dommaker/studio-prisma', () => ({
  prisma: {
    channel: { upsert: upsertMock },
  },
}));

vi.mock('@dommaker/studio-shared', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { ensureDefaultChannels } from '../channel-init.js';

describe('ensureDefaultChannels', () => {
  beforeEach(() => {
    upsertMock.mockClear();
  });

  it('creates 3 default channels', async () => {
    await ensureDefaultChannels();
    expect(upsertMock).toHaveBeenCalledTimes(3);
  });

  it('upserts #研发, #决策, #系统', async () => {
    await ensureDefaultChannels();
    const calls = upsertMock.mock.calls.map((c: any[]) => c[0].create);
    expect(calls).toEqual([
      { name: '#研发', type: 'rnd' },
      { name: '#决策', type: 'decision' },
      { name: '#系统', type: 'system' },
    ]);
  });

  it('uses name as unique where clause', async () => {
    await ensureDefaultChannels();
    for (const call of upsertMock.mock.calls) {
      const arg = call[0] as any;
      expect(arg.where).toHaveProperty('name');
      expect(arg.update).toEqual({});
    }
  });

  it('does not throw on success', async () => {
    await expect(ensureDefaultChannels()).resolves.toBeUndefined();
  });

  it('propagates prisma errors', async () => {
    upsertMock.mockRejectedValueOnce(new Error('DB error'));
    await expect(ensureDefaultChannels()).rejects.toThrow('DB error');
  });
});
