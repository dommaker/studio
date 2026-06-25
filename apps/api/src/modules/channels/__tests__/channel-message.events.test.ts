// Contract test: channel.message.created EventBus subscriber — MVP-4 Discussion Space
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies
vi.mock('@dommaker/studio-shared', () => ({
  eventBus: {
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    publish: vi.fn(),
  },
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@dommaker/studio-prisma', () => ({
  prisma: {
    workUnit: { findUnique: vi.fn() },
    channel: { findFirst: vi.fn() },
    channelMessage: { create: vi.fn() },
  },
}));

import { eventBus } from '@dommaker/studio-shared';
import { prisma } from '@dommaker/studio-prisma';

describe('channel.message.created subscriber', () => {
  let handler: (payload: any) => Promise<void>;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Import and register the subscriber
    const { registerChannelMessageEvents } = await import('../channel-message.events.js');
    registerChannelMessageEvents();
    // Extract the registered handler
    const subscribeCalls = (eventBus.subscribe as any).mock.calls;
    const channelCall = subscribeCalls.find((c: any[]) => c[0] === 'channel.message.created');
    handler = channelCall[1];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should write agent message to DB when event fires with workUnitId', async () => {
    const mockWorkUnit = { id: 'wu-1', channelId: 'ch-1' };
    const mockMessage = { id: 'msg-1', content: 'Agent output', authorType: 'agent' };

    (prisma.workUnit.findUnique as any).mockResolvedValue(mockWorkUnit);
    (prisma.channelMessage.create as any).mockResolvedValue(mockMessage);

    await handler({
      workUnitId: 'wu-1',
      content: 'Agent output text',
      authorType: 'agent',
      authorId: 'instance-1',
    });

    expect(prisma.workUnit.findUnique).toHaveBeenCalledWith({ where: { id: 'wu-1' } });
    expect(prisma.channelMessage.create).toHaveBeenCalled();
  });

  it('should ignore events without workUnitId', async () => {
    await handler({
      content: 'no workunit',
      authorType: 'agent',
    });

    expect(prisma.workUnit.findUnique).not.toHaveBeenCalled();
    expect(prisma.channelMessage.create).not.toHaveBeenCalled();
  });

  it('should resolve channelId from WorkUnit', async () => {
    const mockWorkUnit = { id: 'wu-1', channelId: 'ch-1' };
    (prisma.workUnit.findUnique as any).mockResolvedValue(mockWorkUnit);
    (prisma.channelMessage.create as any).mockResolvedValue({ id: 'msg-1' });

    await handler({
      workUnitId: 'wu-1',
      content: 'test',
      authorType: 'agent',
    });

    expect(prisma.channelMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ channelId: 'ch-1' }),
      })
    );
  });

  it('should fallback to rnd channel when WorkUnit has no channelId', async () => {
    const mockWorkUnit = { id: 'wu-1', channelId: null };
    const mockChannel = { id: 'ch-rnd', type: 'rnd' };

    (prisma.workUnit.findUnique as any).mockResolvedValue(mockWorkUnit);
    (prisma.channel.findFirst as any).mockResolvedValue(mockChannel);
    (prisma.channelMessage.create as any).mockResolvedValue({ id: 'msg-1' });

    await handler({
      workUnitId: 'wu-1',
      content: 'test',
      authorType: 'agent',
    });

    expect(prisma.channel.findFirst).toHaveBeenCalledWith({ where: { type: 'rnd' } });
    expect(prisma.channelMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ channelId: 'ch-rnd' }),
      })
    );
  });

  it('should skip when WorkUnit not found', async () => {
    (prisma.workUnit.findUnique as any).mockResolvedValue(null);

    await handler({
      workUnitId: 'wu-nonexistent',
      content: 'test',
      authorType: 'agent',
    });

    expect(prisma.channelMessage.create).not.toHaveBeenCalled();
  });
});
