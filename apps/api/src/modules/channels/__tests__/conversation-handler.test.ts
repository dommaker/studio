// ConversationHandler test (P1-03 + P1-04)
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { prisma } from '@dommaker/studio-prisma';
import { eventBus } from '@dommaker/studio-shared';

// Import after mocks are set up
import { conversationHandler, ConversationQueueFullError } from '../conversation-handler.js';

let channelId: string;

describe('ConversationHandler', () => {
  beforeAll(async () => {
    // Create a conversation mode channel
    const channel = await prisma.channel.create({
      data: {
        name: `#test-conv-${Date.now()}`,
        type: 'rnd',
        mode: 'conversation',
        agentName: 'analyst',
      },
    });
    channelId = channel.id;
  });

  afterAll(async () => {
    await prisma.channelMessage.deleteMany({ where: { channelId } });
    await prisma.channel.deleteMany({ where: { id: channelId } });
  });

  beforeEach(async () => {
    await prisma.channelMessage.deleteMany({ where: { channelId } });
    // Reset session
    await prisma.channel.update({
      where: { id: channelId },
      data: { sessionId: null },
    });
  });

  // ── P1-03: Basic handle ──

  it('creates thinking placeholder message', async () => {
    const channel = await prisma.channel.findUniqueOrThrow({ where: { id: channelId } });
    const userMsg = { id: 'test-user-msg' };

    await conversationHandler.handle(channel, userMsg, 'Hello agent');

    // Check that a thinking message was created
    const messages = await prisma.channelMessage.findMany({
      where: { channelId, authorType: 'agent' },
    });
    expect(messages.length).toBeGreaterThanOrEqual(1);

    const thinkingMsg = messages.find(m => {
      const meta = typeof m.meta === 'string' ? JSON.parse(m.meta) : m.meta;
      return meta?.cardType === 'thinking';
    });
    expect(thinkingMsg).toBeDefined();
    expect(thinkingMsg?.agentName).toBe('analyst');
  });

  it('creates sessionId on first message', async () => {
    const channel = await prisma.channel.findUniqueOrThrow({ where: { id: channelId } });
    expect(channel.sessionId).toBeNull();

    await conversationHandler.handle(channel, { id: 'test' }, 'First message');

    const updated = await prisma.channel.findUniqueOrThrow({ where: { id: channelId } });
    expect(updated.sessionId).not.toBeNull();
    expect(typeof updated.sessionId).toBe('string');
  });

  it('reuses existing sessionId', async () => {
    // Set a session ID
    await prisma.channel.update({
      where: { id: channelId },
      data: { sessionId: 'existing-session-id' },
    });

    const channel = await prisma.channel.findUniqueOrThrow({ where: { id: channelId } });
    await conversationHandler.handle(channel, { id: 'test' }, 'Second message');

    const updated = await prisma.channel.findUniqueOrThrow({ where: { id: channelId } });
    expect(updated.sessionId).toBe('existing-session-id');
  });

  // ── P1-04: Concurrency control ──

  it('getStatus returns running state', () => {
    const status = conversationHandler.getStatus(channelId);
    expect(status).toHaveProperty('running');
    expect(status).toHaveProperty('queueDepth');
    expect(typeof status.running).toBe('boolean');
    expect(typeof status.queueDepth).toBe('number');
  });

  // ── buildPrompt ──

  it('buildPrompt includes conversation history', async () => {
    // Create some history messages
    await prisma.channelMessage.create({
      data: {
        channelId,
        authorType: 'human',
        content: 'Previous question',
      },
    });
    await prisma.channelMessage.create({
      data: {
        channelId,
        authorType: 'agent',
        agentName: 'analyst',
        content: 'Previous answer',
      },
    });

    const channel = await prisma.channel.findUniqueOrThrow({ where: { id: channelId } });
    const prompt = await conversationHandler.buildPrompt(channel, 'New question');

    expect(prompt).toContain('Previous question');
    expect(prompt).toContain('Previous answer');
    expect(prompt).toContain('New question');
  });

  it('buildPrompt includes agent identity or context', async () => {
    const channel = await prisma.channel.findUniqueOrThrow({ where: { id: channelId } });
    const prompt = await conversationHandler.buildPrompt(channel, 'Test');

    // Should contain either agent name or User Message section
    expect(prompt).toContain('User Message');
    expect(prompt).toContain('Test');
  });
});
