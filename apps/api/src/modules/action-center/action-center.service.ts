/**
 * 行动中心派生服务（#468 统一行动中心）。
 *
 * 两类事实、两种语义（设计稿 2026-09-09）：
 * - 状态派生（stateItems）：reply/review/confirm 从 WU 状态机实时派生，
 *   无已读概念、状态变即消，无新存储。
 * - 事件持久（notifications）：NotificationService JSONL 持久面，墓碑=已读。
 */
import { FileStore } from '@dommaker/studio-shared';
import { NotificationService } from '@dommaker/studio-notification';
import { WorkUnitService } from '../workunit/workunit.service.js';
import { MANUAL_GATE_TYPES } from '../workunit/workunit.types.js';
import { parseWuMetadata, parseWuTitle } from '../workunit/wu-metadata.js';

export interface ActionCenterStateItem {
  kind: 'reply' | 'review' | 'confirm';
  wuId: string;
  /** 展示口径 = metadata.title ?? scope（parseWuTitle 单一出口） */
  scope: string;
  channelId: string | null;
  waitingQuestion?: string;
  /** D-2（reply 深链）：定位锚点 = 该 WU 频道线程最新一条非人类消息 id
   *  （与频道页 NEED_INPUT chip「当前提问消息」同口径，#279 走查 F4）。
   *  无 channelId / 热层无匹配消息 / 查询失败 → 缺省（前端 fail-closed 回退纯频道跳转） */
  messageId?: string;
  since: string;
}

export interface ActionCenterPayload {
  stateItems: ActionCenterStateItem[];
  notifications: Awaited<ReturnType<NotificationService['getUserNotifications']>>;
  unreadCount: number;
}

export class ActionCenterService {
  constructor(
    private fileStore: FileStore = new FileStore(),
    private notificationService: NotificationService = new NotificationService(fileStore),
  ) {}

  async getActionCenter(userId: string): Promise<ActionCenterPayload> {
    const wuService = new WorkUnitService(this.fileStore);
    const [blocked, inReview, pending] = await Promise.all([
      wuService.list({ status: 'blocked', limit: 1000 }),
      wuService.list({ status: 'in_review', limit: 1000 }),
      wuService.list({ status: 'pending', limit: 1000 }),
    ]);

    const stateItems: ActionCenterStateItem[] = [];

    // reply = blocked + waitingForInput（设计稿：不再排除 decision/spec，
    // 排除规则从 chip 的「避免红点焦虑」改为面板分区解决）
    for (const wu of blocked.data) {
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
    for (const wu of inReview.data) {
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
    for (const wu of pending.data) {
      stateItems.push({
        kind: 'confirm',
        wuId: wu.id,
        scope: parseWuTitle(wu.metadata, wu.scope),
        channelId: wu.channelId,
        since: new Date(wu.updatedAt).toISOString(),
      });
    }

    const [notifications, unreadCount] = await Promise.all([
      this.notificationService.getUserNotifications(userId, { limit: 50 }),
      this.notificationService.getUnreadCount(userId),
    ]);

    return { stateItems, notifications, unreadCount };
  }

  /**
   * reply 深链锚点（D-2）：该 WU 频道线程最新一条非人类消息 id——waitingForInput 的
   * metadata 不记消息 id，而提问消息（agent-loop「需要输入:」/ 归属提问 / 裁决轮）全部经
   * wu-messenger 发为 authorType=agent 且挂 workUnitId，与频道页 chip 的「当前提问消息 =
   * 该 WU 最新非人类消息」（#279 走查 F4）同口径。热层查询（挂起中 WU 的消息不入冷层），
   * 查询失败/无匹配 → null（fail-closed，前端不拼 ?highlight=）。
   */
  private async resolveWaitingMessageId(wuId: string, channelId: string | null): Promise<string | null> {
    if (!channelId) return null;
    try {
      const messages = await this.fileStore.queryMessages(channelId, { workUnitId: wuId });
      const latest = messages.filter(m => m.authorType !== 'human').at(-1);
      return latest?.id ?? null;
    } catch {
      return null;
    }
  }
}
