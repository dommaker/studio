// ConversationHandler integration test — route branching (P1-02)
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { prisma } from '@dommaker/studio-prisma';
import { channelMessageService } from '../channel-message.service.js';

describe('Channel conversation mode routing (P1-02)', () => {
  let convChannelId: string;
  let broadcastChannelId: string;

  beforeAll(async () => {
    // Create conversation mode channel
    const conv = await prisma.channel.create({
      data: {
        name: `#test-conv-route-${Date.now()}`,
        type: 'rnd',
        mode: 'conversation',
        agentName: 'analyst',
      },
    });
    convChannelId = conv.id;

    // Create broadcast mode channel
    const bc = await prisma.channel.create({
      data: {
        name: `#test-bc-route-${Date.now()}`,
        type: 'rnd',
      },
    });
    broadcastChannelId = bc.id;
  });

  afterAll(async () => {
    await prisma.channelMessage.deleteMany({ where: { channelId: { in: [convChannelId, broadcastChannelId] } } });
    await prisma.channel.deleteMany({ where: { id: { in: [convChannelId, broadcastChannelId] } } });
  });

  beforeEach(async () => {
    await prisma.channelMessage.deleteMany({ where: { channelId: { in: [convChannelId, broadcastChannelId] } } });
  });

  it('conversation channel stores messages with correct metadata', async () => {
    const msg = await channelMessageService.createHumanMessage(convChannelId, 'Hello in conversation mode');
    expect(msg.authorType).toBe('human');
    expect(msg.content).toBe('Hello in conversation mode');

    const channel = await prisma.channel.findUniqueOrThrow({ where: { id: convChannelId } });
    expect(channel.mode).toBe('conversation');
    expect(channel.agentName).toBe('analyst');
  });

  it('broadcast channel stores messages normally', async () => {
    const msg = await channelMessageService.createHumanMessage(broadcastChannelId, 'Hello in broadcast mode');
    expect(msg.authorType).toBe('human');
    expect(msg.content).toBe('Hello in broadcast mode');

    const channel = await prisma.channel.findUniqueOrThrow({ where: { id: broadcastChannelId } });
    expect(channel.mode).toBe('broadcast');
    expect(channel.agentName).toBeNull();
  });

  it('conversation channel can be queried by mode', async () => {
    const convChannels = await prisma.channel.findMany({
      where: { mode: 'conversation', agentName: { not: null } },
    });
    expect(convChannels.length).toBeGreaterThanOrEqual(1);
    expect(convChannels.some(c => c.id === convChannelId)).toBe(true);
  });
});
