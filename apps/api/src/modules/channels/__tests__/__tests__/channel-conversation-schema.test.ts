// Channel conversation mode schema test (P1-01)
import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '@dommaker/studio-prisma';

describe('Channel conversation mode schema', () => {
  const testChannels: string[] = [];

  afterAll(async () => {
    await prisma.channel.deleteMany({ where: { id: { in: testChannels } } });
  });

  it('creates channel with default broadcast mode', async () => {
    const channel = await prisma.channel.create({
      data: { name: `#test-broadcast-${Date.now()}`, type: 'rnd' },
    });
    testChannels.push(channel.id);

    expect(channel.mode).toBe('broadcast');
    expect(channel.agentName).toBeNull();
    expect(channel.sessionId).toBeNull();
    expect(channel.defaultWorkspaceId).toBeNull();
    expect(channel.defaultPath).toBeNull();
  });

  it('creates channel with conversation mode', async () => {
    const channel = await prisma.channel.create({
      data: {
        name: `#test-conv-${Date.now()}`,
        type: 'rnd',
        mode: 'conversation',
        agentName: 'analyst',
      },
    });
    testChannels.push(channel.id);

    expect(channel.mode).toBe('conversation');
    expect(channel.agentName).toBe('analyst');
  });

  it('creates channel with all conversation fields', async () => {
    const channel = await prisma.channel.create({
      data: {
        name: `#test-full-${Date.now()}`,
        type: 'rnd',
        mode: 'conversation',
        agentName: 'executor',
        sessionId: 'test-session-id',
        defaultWorkspaceId: 'ws_test',
        defaultPath: 'src/modules',
      },
    });
    testChannels.push(channel.id);

    expect(channel.mode).toBe('conversation');
    expect(channel.agentName).toBe('executor');
    expect(channel.sessionId).toBe('test-session-id');
    expect(channel.defaultWorkspaceId).toBe('ws_test');
    expect(channel.defaultPath).toBe('src/modules');
  });

  it('updates channel mode fields', async () => {
    const channel = await prisma.channel.create({
      data: { name: `#test-update-${Date.now()}`, type: 'rnd' },
    });
    testChannels.push(channel.id);

    expect(channel.mode).toBe('broadcast');

    const updated = await prisma.channel.update({
      where: { id: channel.id },
      data: {
        mode: 'conversation',
        agentName: 'reviewer',
        sessionId: 'new-session',
      },
    });

    expect(updated.mode).toBe('conversation');
    expect(updated.agentName).toBe('reviewer');
    expect(updated.sessionId).toBe('new-session');
  });

  it('query channels by mode', async () => {
    const convChannel = await prisma.channel.create({
      data: {
        name: `#test-query-${Date.now()}`,
        type: 'rnd',
        mode: 'conversation',
        agentName: 'kk',
      },
    });
    testChannels.push(convChannel.id);

    const convChannels = await prisma.channel.findMany({
      where: { mode: 'conversation' },
    });

    expect(convChannels.length).toBeGreaterThanOrEqual(1);
    expect(convChannels.some(c => c.id === convChannel.id)).toBe(true);
  });
});
