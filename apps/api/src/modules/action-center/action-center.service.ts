/**
 * 行动中心派生服务（#468 统一行动中心）。
 *
 * 两类事实、两种语义（设计稿 2026-09-09）：
 * - 状态派生（stateItems）：reply/review/confirm 从 WU 状态机实时派生，
 *   无已读概念、状态变即消，无新存储。
 * - 事件持久（notifications）：NotificationService JSONL 持久面，墓碑=已读。
 */
import { FileStore } from '@dommaker/studio-shared';
import { NotificationService } from '../notifications/index.js';
import { MANUAL_GATE_TYPES, parseWuMetadata, parseWuTitle, snapshotToData } from '../workunit/index.js';
import { getStore } from '../../core/store.js';


export interface ActionCenterStateItem {
  kind: 'reply' | 'review' | 'confirm';
  wuId: string;
  /** 展示口径 = metadata.title ?? scope（parseWuTitle 单一出口） */
  scope: string;
  channelId: string | null;
  waitingQuestion?: string;
  /** D-2（reply 深链）：定位锚点 = 该 WU 频道线程最新一条非人类消息 id（#279 走查 F4 口径）。
   *  #533 起为「WU 当前提问消息」唯一派生点——频道页回复区/提升/chip 定位全消费本字段，
   *  前端不再从已加载消息反推。无 channelId / 热层无匹配消息 / 查询失败 → 缺省（前端 fail-closed） */
  messageId?: string;
  since: string;
}

export interface ActionCenterPayload {
  stateItems: ActionCenterStateItem[];
  notifications: Awaited<ReturnType<NotificationService['getUserNotifications']>>;
  unreadCount: number;
}

export class ActionCenterService {
  private static readonly WAITING_MESSAGE_CACHE_LIMIT = 64;
  private readonly waitingMessageCache = new Map<string, { version: string | null; messageId: string | null }>();

  constructor(
    private fileStore: FileStore = getStore(),
    private notificationService: NotificationService = new NotificationService(fileStore),
  ) {}

  private pruneWaitingMessageCache(activeKeys: ReadonlySet<string>): void {
    for (const key of this.waitingMessageCache.keys()) {
      if (!activeKeys.has(key)) this.waitingMessageCache.delete(key);
    }
    while (this.waitingMessageCache.size > ActionCenterService.WAITING_MESSAGE_CACHE_LIMIT) {
      const oldest = this.waitingMessageCache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.waitingMessageCache.delete(oldest);
    }
  }

  private rememberWaitingMessage(key: string, version: string | null, messageId: string | null): void {
    this.waitingMessageCache.delete(key);
    this.waitingMessageCache.set(key, { version, messageId });
    while (this.waitingMessageCache.size > ActionCenterService.WAITING_MESSAGE_CACHE_LIMIT) {
      const oldest = this.waitingMessageCache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.waitingMessageCache.delete(oldest);
    }
  }

  async getActionCenter(userId: string): Promise<ActionCenterPayload> {
    const [actionable, { notifications, unreadCount }] = await Promise.all([
      this.fileStore.getIndex({ statuses: ['blocked', 'in_review', 'pending'] }),
      this.notificationService.getUserNotificationView(userId, { limit: 50 }),
    ]);
    const sortByCreatedAtDesc = <T extends { createdAt: Date }>(rows: T[]): T[] =>
      rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const blockedSorted = sortByCreatedAtDesc(actionable.filter(wu => wu.status === 'blocked').map(snapshotToData));
    const inReviewSorted = sortByCreatedAtDesc(actionable.filter(wu => wu.status === 'in_review').map(snapshotToData));
    const pendingSorted = sortByCreatedAtDesc(actionable.filter(wu => wu.status === 'pending').map(snapshotToData));
    const activeWaitingKeys = new Set(blockedSorted
      .filter(wu => parseWuMetadata(wu.metadata).waitingForInput && wu.channelId)
      .map(wu => `${wu.id}:${wu.channelId}`));
    this.pruneWaitingMessageCache(activeWaitingKeys);

    const stateItems: ActionCenterStateItem[] = [];

    // reply = blocked + waitingForInput（设计稿：不再排除 decision/spec，
    // 排除规则从 chip 的「避免红点焦虑」改为面板分区解决）
    for (const wu of blockedSorted) {
      const meta = parseWuMetadata(wu.metadata);
      if (!meta.waitingForInput) continue;
      const messageId = await this.resolveWaitingMessageId(wu.id, wu.channelId);
      stateItems.push({
        kind: 'reply',
        wuId: wu.id,
        scope: parseWuTitle(wu.metadata, wu.scope),
        channelId: wu.channelId,
        ...(meta.waitingQuestion ? { waitingQuestion: meta.waitingQuestion } : {}),
        ...(messageId ? { messageId } : {}),
        since: meta.waitingSince ?? new Date(wu.updatedAt).toISOString(),
      });
    }

    // review = in_review 且人工闸门类（MANUAL_GATE_TYPES 单一事实源）
    for (const wu of inReviewSorted) {
      if (!MANUAL_GATE_TYPES.has(wu.type)) continue;
      stateItems.push({
        kind: 'review',
        wuId: wu.id,
        scope: parseWuTitle(wu.metadata, wu.scope),
        channelId: wu.channelId,
        since: new Date(wu.updatedAt).toISOString(),
      });
    }

    // confirm = pending（人闸待确认）
    for (const wu of pendingSorted) {
      stateItems.push({
        kind: 'confirm',
        wuId: wu.id,
        scope: parseWuTitle(wu.metadata, wu.scope),
        channelId: wu.channelId,
        since: new Date(wu.updatedAt).toISOString(),
      });
    }

    return { stateItems, notifications, unreadCount };
  }

  /**
   * reply 深链锚点（D-2）：该 WU 频道线程最新一条非人类消息 id——waitingForInput 的
   * metadata 不记消息 id，而提问消息（agent-loop「需要输入:」/ 归属提问 / 裁决轮）全部经
   * wu-messenger 发为 authorType=agent 且挂 workUnitId，与频道页 chip 的「当前提问消息 =
   * 该 WU 最新非人类消息」（#279 走查 F4）同口径。热层查询（挂起中 WU 的消息不入冷层），
   * 查询失败/无匹配 → null（fail-closed，前端不拼 ?highlight=）。
   * B2：改 readMessagesTail 谓词倒扫 limit 1（同 channels/merge-target resolveMergeTarget 的
   * #524 P1-1 先例）——倒扫序 = 新→旧，首个命中即最新，不再每挂起 WU 全热文件串行扫。
   */
  private async resolveWaitingMessageId(wuId: string, channelId: string | null): Promise<string | null> {
    if (!channelId) return null;
    try {
      const { lastMessageId: version } = await this.fileStore.getChannelVersion(channelId);
      const key = `${wuId}:${channelId}`;
      const cached = this.waitingMessageCache.get(key);
      if (cached && cached.version === version) return cached.messageId;
      const { messages } = await this.fileStore.readMessagesTail(channelId, {
        limit: 1,
        match: m => m.workUnitId === wuId && m.authorType !== 'human',
      });
      const messageId = messages[0]?.id ?? null;
      this.rememberWaitingMessage(key, version, messageId);
      return messageId;
    } catch {
      return null;
    }
  }
}
