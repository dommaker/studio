// ChannelMessageService integration test (SQLite, no Prisma mocks)
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { prisma } from '@dommaker/studio-prisma';
import { eventBus } from '@dommaker/studio-shared';
import { channelMessageService } from '../channel-message.service.js';

let channelId: string;
let createdChannel = false;

describe('ChannelMessageService', () => {
  beforeAll(async () => {
    // Always create a dedicated test channel — never reuse a default channel
    // (reusing #研发 then deleting it in afterAll breaks other tests)
    const channel = await prisma.channel.create({
      data: { name: `#test-service-${Date.now()}`, type: 'rnd' },
    });
    channelId = channel.id;
    createdChannel = true;
  });

  afterAll(async () => {
    await prisma.channelMessage.deleteMany({ where: { channelId } });
    if (createdChannel) {
      await prisma.channel.deleteMany({ where: { id: channelId } });
    }
  });

  beforeEach(async () => {
    await prisma.channelMessage.deleteMany({ where: { channelId } });
  });

  // ── createHumanMessage ──

  it('creates human message with correct authorType', async () => {
    const msg = await channelMessageService.createHumanMessage(channelId, 'Hello world');
    expect(msg.authorType).toBe('human');
    expect(msg.agentName).toBeNull();
    expect(msg.content).toBe('Hello world');
  });

  it('trims content and rejects empty', async () => {
    await expect(
      channelMessageService.createHumanMessage(channelId, '   ')
    ).rejects.toThrow('Content cannot be empty');
  });

  it('publishes channel.message_sent event', async () => {
    const events: any[] = [];
    const handler = (payload: any) => events.push(payload);
    eventBus.subscribe('channel.message_sent', handler);

    const msg = await channelMessageService.createHumanMessage(channelId, 'Event test');
    expect(events.length).toBe(1);
    expect(events[0].channelId).toBe(channelId);
    expect(events[0].message.id).toBe(msg.id);

    eventBus.unsubscribe('channel.message_sent', handler);
  });

  // ── createAgentMessage ──

  it('creates agent message with correct agentName', async () => {
    const msg = await channelMessageService.createAgentMessage(
      channelId, 'Triage', 'System alert', { meta: { status: 'diagnosing' } }
    );
    expect(msg.authorType).toBe('agent');
    expect(msg.agentName).toBe('Triage');
    expect(msg.content).toBe('System alert');
    expect(msg.meta).toMatchObject({ status: 'diagnosing' });
  });

  it('rejects missing agentName', async () => {
    await expect(
      channelMessageService.createAgentMessage(channelId, '', 'No agent')
    ).rejects.toThrow('agentName is required');
  });

  // ── updateMessageMeta ──

  it('merges meta and publishes channel.message_updated', async () => {
    const msg = await channelMessageService.createHumanMessage(channelId, 'Base');

    const events: any[] = [];
    const handler = (payload: any) => events.push(payload);
    eventBus.subscribe('channel.message_updated', handler);

    const updated = await channelMessageService.updateMessageMeta(msg.id, { status: 'confirmed' });
    expect(updated.meta).toMatchObject({ status: 'confirmed' });
    expect(events.length).toBe(1);
    expect(events[0].messageId).toBe(msg.id);

    eventBus.unsubscribe('channel.message_updated', handler);
  });

  it('deep-merges with existing meta', async () => {
    const msg = await channelMessageService.createAgentMessage(
      channelId, 'Executor', 'AC check', { meta: { goalId: 'g1', status: 'pending' } }
    );
    const updated = await channelMessageService.updateMessageMeta(msg.id, { status: 'done' });
    expect(updated.meta).toMatchObject({ goalId: 'g1', status: 'done' });
  });

  // ── updateMessage ──

  it('updates both content and meta', async () => {
    const msg = await channelMessageService.createAgentMessage(
      channelId, 'Analyst', 'Thinking...', { meta: { status: 'thinking' } }
    );
    const updated = await channelMessageService.updateMessage(msg.id, {
      content: 'Error occurred',
      meta: { status: 'error' },
    });
    expect(updated.content).toBe('Error occurred');
    expect(updated.meta).toMatchObject({ status: 'error' });
  });

  // ── deleteMessage ──

  it('deletes message from DB', async () => {
    const msg = await channelMessageService.createHumanMessage(channelId, 'To delete');
    await channelMessageService.deleteMessage(msg.id);
    const found = await prisma.channelMessage.findUnique({ where: { id: msg.id } });
    expect(found).toBeNull();
  });

  // ── createCardMessage ──

  it('creates card message with cardType and cardData in meta', async () => {
    const msg = await channelMessageService.createCardMessage(
      channelId, 'Analyst', '## Card Content', 'requirements_doc', { requirementsDocId: 'doc-123' }
    );
    expect(msg.authorType).toBe('agent');
    expect(msg.meta).toMatchObject({
      cardType: 'requirements_doc',
      cardData: { requirementsDocId: 'doc-123' },
      status: 'ready',
    });
  });
});
