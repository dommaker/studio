// ChannelMessage Service — centralized message creation + event publishing
import { prisma } from '@dommaker/studio-prisma';
import { eventBus, logger } from '@dommaker/studio-shared';
import { eventStore } from '../../core/event-store.js';
import { v4 as uuidv4 } from 'uuid';

export interface MessageMeta {
  status?: string;
  goalId?: string;
  requirementsDocId?: string;
  cardType?: string;
  cardData?: Record<string, unknown>;
  crossChannelRef?: string;
  atHuman?: boolean;
  risks?: string[];
  [key: string]: unknown;
}

export interface AgentMessageOptions {
  replyToId?: string;
  meta?: MessageMeta;
}

interface MessageRecord {
  id: string;
  channelId: string;
  authorType: string;
  agentName: string | null;
  content: string;
  replyToId: string | null;
  meta: unknown;
  createdAt: Date;
}

class ChannelMessageService {
  /** B2: 发布 SSE 事件到 events channel（供前端 EventSource 消费） */
  private publishSSE(eventType: string, data: Record<string, unknown>) {
    eventStore.publish('events', JSON.stringify({
      event_type: eventType,
      event_id: uuidv4(),
      timestamp: new Date().toISOString(),
      data,
    })).catch(() => {}); // best-effort
  }

  async createHumanMessage(
    channelId: string,
    content: string,
    replyToId?: string,
  ): Promise<MessageRecord> {
    const trimmed = content.trim();
    if (!trimmed) throw new Error('Content cannot be empty');

    const message = await prisma.channelMessage.create({
      data: {
        channelId,
        authorType: 'human',
        content: trimmed,
        replyToId: replyToId || null,
      },
    });

    const shaped = this.shape(message);
    eventBus.publish('channel.message_sent', { channelId, message: shaped });
    this.publishSSE('channel.message_sent', { channelId, message: shaped });
    return shaped;
  }

  async createAgentMessage(
    channelId: string,
    agentName: string,
    content: string,
    options?: AgentMessageOptions,
  ): Promise<MessageRecord> {
    const trimmed = content.trim();
    if (!trimmed) throw new Error('Content cannot be empty');
    if (!agentName) throw new Error('agentName is required');

    const message = await prisma.channelMessage.create({
      data: {
        channelId,
        authorType: 'agent',
        agentName,
        content: trimmed,
        replyToId: options?.replyToId || null,
        meta: options?.meta ? JSON.stringify(options.meta) : '{}',
      },
    });

    const shaped = this.shape(message);
    eventBus.publish('channel.message_sent', { channelId, message: shaped });
    this.publishSSE('channel.message_sent', { channelId, message: shaped });
    return shaped;
  }

  async updateMessageMeta(
    messageId: string,
    meta: MessageMeta,
  ): Promise<MessageRecord> {
    const existing = await prisma.channelMessage.findUnique({
      where: { id: messageId },
    });
    if (!existing) throw new Error(`Message ${messageId} not found`);

    const existingMeta = typeof existing.meta === 'string' ? JSON.parse(existing.meta) : existing.meta;
    const merged = { ...(typeof existingMeta === 'object' && existingMeta !== null ? existingMeta : {}), ...meta };

    const updated = await prisma.channelMessage.update({
      where: { id: messageId },
      data: { meta: JSON.stringify(merged) },
    });

    const shaped = this.shape(updated);
    eventBus.publish('channel.message_updated', {
      channelId: existing.channelId,
      messageId,
      meta: merged,
    });
    this.publishSSE('channel.message_updated', { channelId: existing.channelId, messageId, meta: merged });
    return shaped;
  }

  async updateMessage(
    messageId: string,
    updates: { content?: string; meta?: MessageMeta },
  ): Promise<MessageRecord> {
    const existing = await prisma.channelMessage.findUnique({
      where: { id: messageId },
    });
    if (!existing) throw new Error(`Message ${messageId} not found`);

    const data: Record<string, unknown> = {};
    if (updates.content !== undefined) data.content = updates.content.trim();
    if (updates.meta !== undefined) {
      const existingMeta = typeof existing.meta === 'string' ? JSON.parse(existing.meta) : existing.meta;
      const merged = { ...(typeof existingMeta === 'object' && existingMeta !== null ? existingMeta : {}), ...updates.meta };
      data.meta = JSON.stringify(merged);
    }

    const updated = await prisma.channelMessage.update({
      where: { id: messageId },
      data,
    });

    const shaped = this.shape(updated);
    eventBus.publish('channel.message_updated', {
      channelId: existing.channelId,
      messageId,
      content: updates.content,
      meta: updates.meta,
    });
    this.publishSSE('channel.message_updated', {
      channelId: existing.channelId, messageId,
      content: updates.content, meta: updates.meta,
    });
    return shaped;
  }

  async deleteMessage(messageId: string): Promise<void> {
    try {
      await prisma.channelMessage.delete({ where: { id: messageId } });
    } catch (e) {
      logger.warn('[ChannelMessageService] Delete failed', { messageId, error: String(e) });
    }
  }

  async createCardMessage(
    channelId: string,
    agentName: string,
    content: string,
    cardType: string,
    cardMeta: Record<string, unknown>,
    replyToId?: string,
  ): Promise<MessageRecord> {
    return this.createAgentMessage(channelId, agentName, content, {
      replyToId,
      meta: { cardType, cardData: cardMeta, status: 'ready' },
    });
  }

  private shape(record: any): MessageRecord {
    return {
      id: record.id,
      channelId: record.channelId,
      authorType: record.authorType,
      agentName: record.agentName,
      content: record.content,
      replyToId: record.replyToId,
      meta: typeof record.meta === 'string' ? JSON.parse(record.meta) : record.meta,
      createdAt: record.createdAt,
    };
  }
}

export const channelMessageService = new ChannelMessageService();
