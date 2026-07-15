// ChannelMessageService integration test (FileStore)
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eventBus, FileStore } from '@dommaker/studio-shared';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ChannelMessageService } from '../channel-message.service.js';

let channelId: string;
let tmpDir: string;
let fileStore: FileStore;
let service: ChannelMessageService;

describe('ChannelMessageService', () => {
  beforeAll(async () => {
    // Temporary directory for FileStore
    tmpDir = path.join(os.tmpdir(), `channel-msg-test-${Date.now()}`);
    fileStore = new FileStore(tmpDir);
    service = new ChannelMessageService(fileStore);

    // Create a dedicated test channel in FileStore
    channelId = `test-channel-${Date.now()}`;
    await fileStore.createChannel({
      id: channelId,
      name: `#test-service-${Date.now()}`,
      type: 'rnd',
      defaultWorkspaceId: null,
      defaultPath: null,
      discordChannelId: null,
      discordWebhookUrl: null,
      members: '[]',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  });

  afterAll(async () => {
    // 清理临时目录
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // 清理 messages.jsonl（保留 config.json）
    const msgsPath = path.join(tmpDir, 'channels', channelId, 'messages.jsonl');
    try { fs.unlinkSync(msgsPath); } catch { /* ignore */ }
  });

  // ── createHumanMessage ──

  it('creates human message with correct authorType', async () => {
    const msg = await service.createHumanMessage(channelId, 'Hello world');
    expect(msg.authorType).toBe('human');
    expect(msg.agentName).toBeNull();
    expect(msg.content).toBe('Hello world');
  });

  it('trims content and rejects empty', async () => {
    await expect(
      service.createHumanMessage(channelId, '   ')
    ).rejects.toThrow('Content cannot be empty');
  });

  it('publishes channel.message_sent event', async () => {
    const events: any[] = [];
    const handler = (payload: any) => events.push(payload);
    eventBus.subscribe('channel.message_sent', handler);

    const msg = await service.createHumanMessage(channelId, 'Event test');
    expect(events.length).toBe(1);
    expect(events[0].channelId).toBe(channelId);
    expect(events[0].message.id).toBe(msg.id);

    eventBus.unsubscribe('channel.message_sent', handler);
  });

  // ── createAgentMessage ──

  it('creates agent message with correct agentName', async () => {
    const msg = await service.createAgentMessage(
      channelId, 'Triage', 'System alert', { meta: { status: 'diagnosing' } }
    );
    expect(msg.authorType).toBe('agent');
    expect(msg.agentName).toBe('Triage');
    expect(msg.content).toBe('System alert');
    expect(msg.meta).toMatchObject({ status: 'diagnosing' });
  });

  it('rejects missing agentName', async () => {
    await expect(
      service.createAgentMessage(channelId, '', 'No agent')
    ).rejects.toThrow('agentName is required');
  });

  // ── updateMessageMeta ──

  it('merges meta and publishes channel.message_updated', async () => {
    const msg = await service.createHumanMessage(channelId, 'Base');

    const events: any[] = [];
    const handler = (payload: any) => events.push(payload);
    eventBus.subscribe('channel.message_updated', handler);

    const updated = await service.updateMessageMeta(msg.id, { status: 'confirmed' });
    expect(updated.meta).toMatchObject({ status: 'confirmed' });
    expect(events.length).toBe(1);
    expect(events[0].messageId).toBe(msg.id);

    eventBus.unsubscribe('channel.message_updated', handler);
  });

  it('deep-merges with existing meta', async () => {
    const msg = await service.createAgentMessage(
      channelId, 'Executor', 'AC check', { meta: { goalId: 'g1', status: 'pending' } }
    );
    const updated = await service.updateMessageMeta(msg.id, { status: 'done' });
    expect(updated.meta).toMatchObject({ goalId: 'g1', status: 'done' });
  });

  // ── updateMessage ──

  it('updates both content and meta', async () => {
    const msg = await service.createAgentMessage(
      channelId, 'Analyst', 'Thinking...', { meta: { status: 'thinking' } }
    );
    const updated = await service.updateMessage(msg.id, {
      content: 'Error occurred',
      meta: { status: 'error' },
    });
    expect(updated.content).toBe('Error occurred');
    expect(updated.meta).toMatchObject({ status: 'error' });
  });

  // ── deleteMessage ──

  it('soft-deletes message via tombstone', async () => {
    const msg = await service.createHumanMessage(channelId, 'To delete');
    await service.deleteMessage(msg.id);
    const found = await fileStore.getMessageById(msg.id);
    expect(found).toBeNull();
  });

  // ── createCardMessage ──

  it('creates card message with cardType and cardData in meta', async () => {
    const msg = await service.createCardMessage(
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
