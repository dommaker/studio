// ChannelMessageService integration test (FileStore)
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { eventBus, FileStore } from '@dommaker/studio-shared';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ChannelMessageService } from '../channel-message.service.js';
import { eventStore } from '../../../core/event-store.js';

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

  // ── #311：channel.message_updated 负载带全量 message 本体（ADR 2026-08-24 D1/D2）──

  it('updateMessageMeta: payload carries full shaped message body', async () => {
    const msg = await service.createAgentMessage(
      channelId, 'Auditor', 'Card body', { meta: { cardType: 'auditor_suggestion', status: 'ready' } }
    );

    const events: any[] = [];
    const handler = (payload: any) => events.push(payload);
    eventBus.subscribe('channel.message_updated', handler);

    await service.updateMessageMeta(msg.id, { status: 'confirmed' });
    eventBus.unsubscribe('channel.message_updated', handler);

    expect(events.length).toBe(1);
    const p = events[0];
    expect(p.channelId).toBe(channelId);
    expect(p.messageId).toBe(msg.id);
    // 新增 message 字段 = 落库后完整 shaped message（meta 为合并后全量、content 原样）
    expect(p.message).toBeDefined();
    expect(p.message.id).toBe(msg.id);
    expect(p.message.channelId).toBe(channelId);
    expect(p.message.content).toBe('Card body');
    expect(p.message.meta).toMatchObject({ cardType: 'auditor_suggestion', status: 'confirmed' });
    // D2：既有顶层字段语义不变（meta 仍是合并后全量）
    expect(p.meta).toMatchObject({ cardType: 'auditor_suggestion', status: 'confirmed' });
  });

  it('updateMessage: payload carries full shaped body for content-only / meta-only / both', async () => {
    const base = await service.createAgentMessage(
      channelId, 'Analyst', 'Thinking...', { meta: { status: 'thinking', goalId: 'g1' } }
    );

    const events: any[] = [];
    const handler = (payload: any) => events.push(payload);
    eventBus.subscribe('channel.message_updated', handler);

    await service.updateMessage(base.id, { content: 'Half done' });
    await service.updateMessage(base.id, { meta: { status: 'error' } });
    await service.updateMessage(base.id, { content: 'Final', meta: { status: 'done' } });
    eventBus.unsubscribe('channel.message_updated', handler);

    expect(events.length).toBe(3);

    // content-only：message 为 patch 后全量；顶层 content/meta 仍是增量（D2 不动）
    expect(events[0].message.content).toBe('Half done');
    expect(events[0].message.meta).toMatchObject({ status: 'thinking', goalId: 'g1' });
    expect(events[0].content).toBe('Half done');
    expect(events[0].meta).toBeUndefined();

    // meta-only：message.meta 为合并后全量（后端真值）；顶层 meta 仍是增量
    expect(events[1].message.content).toBe('Half done');
    expect(events[1].message.meta).toMatchObject({ goalId: 'g1', status: 'error' });
    expect(events[1].content).toBeUndefined();
    expect(events[1].meta).toEqual({ status: 'error' });

    // both
    expect(events[2].message.content).toBe('Final');
    expect(events[2].message.meta).toMatchObject({ goalId: 'g1', status: 'done' });
    expect(events[2].content).toBe('Final');
    expect(events[2].meta).toEqual({ status: 'done' });
  });

  it('SSE channel.message_updated payload carries the same message body', async () => {
    const spy = vi.spyOn(eventStore, 'publish').mockResolvedValue(undefined);
    try {
      const msg = await service.createHumanMessage(channelId, 'SSE body');
      spy.mockClear();

      await service.updateMessageMeta(msg.id, { status: 'done' });

      const call = spy.mock.calls.find(([channel]) => channel === 'events');
      expect(call).toBeDefined();
      const envelope = JSON.parse(call![1]);
      expect(envelope.event_type).toBe('channel.message_updated');
      expect(envelope.data.message).toBeDefined();
      expect(envelope.data.message.id).toBe(msg.id);
      expect(envelope.data.message.content).toBe('SSE body');
      expect(envelope.data.message.meta).toMatchObject({ status: 'done' });
    } finally {
      spy.mockRestore();
    }
  });

  // ── #317：createdAt = 诞生时刻，更新不可变 ──

  it('updateMessageMeta preserves the original createdAt', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-08-24T08:00:00.000Z'));
      const msg = await service.createHumanMessage(channelId, 'Original');

      vi.setSystemTime(new Date('2026-08-24T09:00:00.000Z'));
      const updated = await service.updateMessageMeta(msg.id, { status: 'done' });

      expect(updated.createdAt.toISOString()).toBe('2026-08-24T08:00:00.000Z');
      // 落库行同样保留原值（REST 刷新路径读到的是它）
      const stored = await fileStore.getMessageById(msg.id);
      expect(stored!.message.createdAt).toBe('2026-08-24T08:00:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });

  it('updateMessage preserves the original createdAt', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-08-24T08:00:00.000Z'));
      const msg = await service.createAgentMessage(
        channelId, 'Analyst', 'Thinking...', { meta: { status: 'thinking' } }
      );

      vi.setSystemTime(new Date('2026-08-24T09:00:00.000Z'));
      const updated = await service.updateMessage(msg.id, {
        content: 'Error occurred',
        meta: { status: 'error' },
      });

      expect(updated.createdAt.toISOString()).toBe('2026-08-24T08:00:00.000Z');
      const stored = await fileStore.getMessageById(msg.id);
      expect(stored!.message.createdAt).toBe('2026-08-24T08:00:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });

  it('anchor stays before its replies in REST listing after updateMessageMeta', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-08-24T08:00:00.000Z'));
      const anchor = await service.createHumanMessage(channelId, 'anchor', undefined, 'WU-317');
      vi.setSystemTime(new Date('2026-08-24T08:01:00.000Z'));
      const reply = await service.createHumanMessage(channelId, 'reply', anchor.id, 'WU-317');

      // anchor 被更新（如卡片决策回写）——即使更新时刻晚于 reply，归位仍按诞生时刻
      vi.setSystemTime(new Date('2026-08-24T09:00:00.000Z'));
      await service.updateMessageMeta(anchor.id, { status: 'confirmed' });

      const { data } = await service.listByWorkUnitId('WU-317');
      expect(data.map(m => m.id)).toEqual([anchor.id, reply.id]);
    } finally {
      vi.useRealTimers();
    }
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
