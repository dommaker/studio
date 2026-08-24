// ChannelMessage Service — centralized message creation + event publishing
import { eventBus, logger, FileStore, type ChannelMessageData } from '@dommaker/studio-shared';
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
  /** 2026-07 PMO-flow UX：里程碑消息归属 PMO 项目 id（NotificationBell 跳转 PMO 详情用；解析不到则不携带） */
  pmoId?: string;
  risks?: string[];
  /** #267（决策 #250 D3）结构化选项卡：NEED_INPUT 内嵌回复区的点选选项。
   * 点选即把 value（缺省 label）作为 replyTo 回复发送，走现有 resumeWaitingWorkUnit 通道，后端零改动 */
  options?: { label: string; description?: string; value?: string }[];
  /** #267（决策 #250 D3）预留多选钩子（v1 恒单选；未来开多选只改发射端字段 + 前端 checkbox 语义） */
  multiSelect?: boolean;
  /** #281（决策 #249 §2）：@文件引用结构化载体——repo = 工程绝对路径（与 PMO gitRepos 条目
   * 同形），path = git ls-files 原样相对路径，无行范围。路由层校验后只含有效引用 */
  files?: { repo: string; path: string }[];
  [key: string]: unknown;
}

export interface AgentMessageOptions {
  replyToId?: string;
  meta?: MessageMeta;
  workUnitId?: string; // AS-025 §5.16: 讨论空间关联
}

export interface MessageRecord {
  id: string;
  channelId: string;
  workUnitId: string | null;
  authorType: string;
  agentName: string | null;
  content: string;
  replyToId: string | null;
  meta: unknown;
  createdAt: Date;
}

/** 将 FileStore 的字符串时间转为 Date，解析 meta JSON */
function shapeMessageData(data: ChannelMessageData): MessageRecord {
  return {
    id: data.id,
    channelId: data.channelId,
    workUnitId: data.workUnitId ?? null,
    authorType: data.authorType,
    agentName: data.agentName ?? null,
    content: data.content,
    replyToId: data.replyToId ?? null,
    meta: typeof data.meta === 'string' ? JSON.parse(data.meta) : (data.meta ?? {}),
    createdAt: new Date(data.createdAt),
  };
}

export class ChannelMessageService {
  private fileStore: FileStore;

  constructor(fileStore?: FileStore) {
    this.fileStore = fileStore ?? new FileStore();
  }

  /** 测试用：替换 FileStore 实例 */
  setFileStore(fs: FileStore): void {
    this.fileStore = fs;
  }

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
    workUnitId?: string,
    meta?: MessageMeta,
  ): Promise<MessageRecord> {
    const trimmed = content.trim();
    if (!trimmed) throw new Error('Content cannot be empty');

    const now = new Date().toISOString();
    const msg: ChannelMessageData = {
      id: uuidv4(),
      channelId,
      authorType: 'human',
      agentName: null,
      content: trimmed,
      replyToId: replyToId || null,
      meta: meta && Object.keys(meta).length > 0 ? JSON.stringify(meta) : '{}',
      workUnitId: workUnitId || null,
      createdAt: now,
    };
    await this.fileStore.appendMessage(channelId, msg);

    const shaped = shapeMessageData(msg);
    eventBus.publish('channel.message_sent', { channelId, message: shaped });
    this.publishSSE('channel.message_sent', { channelId, message: shaped });

    // T-1.4: Wire preference observer — update active hours
    import('../knowledge/preference-observer.js').then(({ preferenceObserver }) => {
      preferenceObserver.updateActiveHours([{ createdAt: new Date(now) }]).catch(() => {});
    }).catch(() => {});

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

    const now = new Date().toISOString();
    const msg: ChannelMessageData = {
      id: uuidv4(),
      channelId,
      authorType: 'agent',
      agentName,
      content: trimmed,
      replyToId: options?.replyToId || null,
      meta: options?.meta ? JSON.stringify(options.meta) : '{}',
      workUnitId: options?.workUnitId || null,
      createdAt: now,
    };
    await this.fileStore.appendMessage(channelId, msg);

    const shaped = shapeMessageData(msg);
    eventBus.publish('channel.message_sent', { channelId, message: shaped });
    this.publishSSE('channel.message_sent', { channelId, message: shaped });

    // T-1.4: Wire preference observer — update response style
    import('../knowledge/preference-observer.js').then(({ preferenceObserver }) => {
      preferenceObserver.updateResponseStyle([{ content: trimmed }]).catch(() => {});
    }).catch(() => {});

    return shaped;
  }

  async updateMessageMeta(
    messageId: string,
    meta: MessageMeta,
  ): Promise<MessageRecord> {
    const found = await this.fileStore.getMessageById(messageId);
    if (!found) throw new Error(`Message ${messageId} not found`);

    const existingMeta = typeof found.message.meta === 'string' ? JSON.parse(found.message.meta) : found.message.meta;
    const merged = { ...(typeof existingMeta === 'object' && existingMeta !== null ? existingMeta : {}), ...meta };

    const now = new Date().toISOString();
    const updated: ChannelMessageData = {
      ...found.message,
      meta: JSON.stringify(merged),
      createdAt: now,
    };
    await this.fileStore.appendMessage(found.channelId, updated);

    const shaped = shapeMessageData(updated);
    // #311（ADR 2026-08-24 D1/D2）：additive 挂全量 shaped message 本体，既有增量字段语义不动
    eventBus.publish('channel.message_updated', {
      channelId: found.channelId,
      messageId,
      meta: merged,
      message: shaped,
    });
    this.publishSSE('channel.message_updated', { channelId: found.channelId, messageId, meta: merged, message: shaped });
    return shaped;
  }

  async updateMessage(
    messageId: string,
    updates: { content?: string; meta?: MessageMeta },
  ): Promise<MessageRecord> {
    const found = await this.fileStore.getMessageById(messageId);
    if (!found) throw new Error(`Message ${messageId} not found`);

    const patched: ChannelMessageData = { ...found.message };
    if (updates.content !== undefined) patched.content = updates.content.trim();
    if (updates.meta !== undefined) {
      const existingMeta = typeof found.message.meta === 'string' ? JSON.parse(found.message.meta) : found.message.meta;
      const merged = { ...(typeof existingMeta === 'object' && existingMeta !== null ? existingMeta : {}), ...updates.meta };
      patched.meta = JSON.stringify(merged);
    }
    patched.createdAt = new Date().toISOString();
    await this.fileStore.appendMessage(found.channelId, patched);

    const shaped = shapeMessageData(patched);
    // #311（ADR 2026-08-24 D1/D2）：additive 挂全量 shaped message 本体，既有增量字段语义不动
    eventBus.publish('channel.message_updated', {
      channelId: found.channelId,
      messageId,
      content: updates.content,
      meta: updates.meta,
      message: shaped,
    });
    this.publishSSE('channel.message_updated', {
      channelId: found.channelId, messageId,
      content: updates.content, meta: updates.meta,
      message: shaped,
    });
    return shaped;
  }

  async deleteMessage(messageId: string): Promise<void> {
    const found = await this.fileStore.getMessageById(messageId);
    if (!found) {
      logger.warn('[ChannelMessageService] Delete failed', { messageId, error: 'Message not found' });
      return;
    }
    try {
      await this.fileStore.softDeleteMessage(found.channelId, messageId);
    } catch (e) {
      logger.warn('[ChannelMessageService] Delete failed', { messageId, error: String(e) });
    }
  }

  /**
   * AS-025 §5.16: List messages in a discussion space (grouped by workUnitId).
   * Returns messages ordered by createdAt ascending (chronological).
   */
  async listByWorkUnitId(
    workUnitId: string,
    options?: { before?: Date; limit?: number },
  ): Promise<{ data: MessageRecord[]; total: number }> {
    const limit = options?.limit ?? 50;
    const since = options?.before ? options.before.toISOString() : undefined;

    // 轮询所有频道，按 workUnitId 过滤（消息按频道分组存储）
    let allMessages: ChannelMessageData[] = [];
    const allChannels = await this.fileStore.listChannels();
    for (const ch of allChannels) {
      const msgs = await this.fileStore.queryMessages(ch.id, { workUnitId });
      allMessages = allMessages.concat(msgs);
    }

    if (since) {
      allMessages = allMessages.filter(m => new Date(m.createdAt).getTime() < new Date(since).getTime());
    }

    allMessages.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    const total = allMessages.length;
    const sliced = limit > 0 ? allMessages.slice(0, limit) : allMessages;

    return {
      data: sliced.map(m => shapeMessageData(m)),
      total,
    };
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
}

export const channelMessageService = new ChannelMessageService();
