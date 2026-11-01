/**
 * MessagesStore — 频道消息子域组合壳（#681 P1-1：自 FileStoreMessagesBase 空壳
 * 继承类转型为组合壳——空壳类删除，本类持有三个内部件实例并逐方法委托）
 *
 * 子域三个内部件（每层一个文件，构造注入替代继承叠加）：
 *   file-store-messages-core.ts    MessagesCoreStore     写路径/压实（#319）/路径件
 *   file-store-messages-query.ts   MessagesQueryStore    尾部倒扫/分页（#524/B4）/增量水位线（B5）/跨频道查询
 *   file-store-messages-archive.ts MessagesArchiveStore  冷热归档与解冻（#327）
 * 归档件的 WU 计龄锚点依赖经构造注入 WorkUnitStore.getIndex（替代原跨层 this 调用）。
 * 门面 FileStore 持有本类实例委托消息方法群，对外方法签名不变。
 */

import type { FileStoreCore } from './file-store-core';
import { MessagesCoreStore, type FileStoreOptions } from './file-store-messages-core';
import { MessagesQueryStore } from './file-store-messages-query';
import { MessagesArchiveStore } from './file-store-messages-archive';
import type { WorkUnitStore } from './file-store-workunit';
import type {
  ChannelMessageData,
  QueryOpts,
  MessagePageOpts,
  MessagePage,
} from './file-store-types';

export type { FileStoreOptions } from './file-store-messages-core';

export class MessagesStore {
  private readonly core: MessagesCoreStore;
  private readonly query: MessagesQueryStore;
  private readonly archive: MessagesArchiveStore;

  constructor(ctx: FileStoreCore, workunit: WorkUnitStore, opts?: FileStoreOptions) {
    this.core = new MessagesCoreStore(ctx, opts);
    this.query = new MessagesQueryStore(ctx, this.core);
    this.archive = new MessagesArchiveStore(ctx, this.core, this.query, workunit);
  }

  // ─── core：写路径 ───

  appendMessage(channelId: string, msg: ChannelMessageData): Promise<void> {
    return this.core.appendMessage(channelId, msg);
  }

  softDeleteMessage(channelId: string, messageId: string): Promise<void> {
    return this.core.softDeleteMessage(channelId, messageId);
  }

  // ─── query：查询面 ───

  getChannelVersion(channelId: string): Promise<{ lastMessageId: string | null }> {
    return this.query.getChannelVersion(channelId);
  }

  getMessagesSince(channelId: string, messageId: string | null): Promise<ChannelMessageData[]> {
    return this.query.getMessagesSince(channelId, messageId);
  }

  readMessagesTail(
    channelId: string,
    opts: { limit: number; match?: (m: ChannelMessageData) => boolean },
  ): Promise<{ messages: ChannelMessageData[]; exhausted: boolean }> {
    return this.query.readMessagesTail(channelId, opts);
  }

  readChannelMessagesDelta(
    channelId: string,
    fromOffset: number,
    opts: { boundarySinceMs: number },
  ): Promise<{ messages: ChannelMessageData[]; newOffset: number; endOffset: number; valid: boolean; touchedIds?: string[] }> {
    return this.query.readChannelMessagesDelta(channelId, fromOffset, opts);
  }

  listMessageChannelIds(): Promise<string[]> {
    return this.query.listMessageChannelIds();
  }

  queryMessages(channelId: string, opts?: QueryOpts): Promise<ChannelMessageData[]> {
    return this.query.queryMessages(channelId, opts);
  }

  queryMessagesPage(channelId: string, opts?: MessagePageOpts): Promise<MessagePage> {
    return this.query.queryMessagesPage(channelId, opts);
  }

  queryAllMessages(filter?: { workUnitIds?: string[]; workUnitId?: string; authorType?: string; agentName?: string; agentNames?: string[]; channelIds?: string[] }): Promise<ChannelMessageData[]> {
    return this.query.queryAllMessages(filter);
  }

  getMessageById(messageId: string, channelId?: string): Promise<{ channelId: string; message: ChannelMessageData } | null> {
    return this.query.getMessageById(messageId, channelId);
  }

  // ─── archive：冷热归档/解冻 ───

  archiveChannelMessages(): Promise<{ archivedMessages: number }> {
    return this.archive.archiveChannelMessages();
  }

  thawWorkUnitMessages(workUnitId: string): Promise<{ thawedMessages: number }> {
    return this.archive.thawWorkUnitMessages(workUnitId);
  }
}
