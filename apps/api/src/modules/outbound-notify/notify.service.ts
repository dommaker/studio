import { logger } from '../../utils/logger.js';
import { eventBus } from '@dommaker/studio-shared';
import { discordNotifier, DiscordMessageOptions } from '../../utils/discord-notifier.js';

export interface NotifyMessage {
  type: 'task-failed' | 'timeout' | 'crash' | 'zombie' | 'human-needed'
    | 'meeting-started' | 'meeting-message' | 'meeting-completed' | 'meeting-cancelled'
    | 'user-intervention-needed';
  taskId?: string;
  meetingId?: string;
  title: string;
  content: string;
  priority?: 'low' | 'medium' | 'high';
  components?: Record<string, unknown>[];  // Discord 按钮（旧格式，兼容）
}

/**
 * NotifyService - 通知服务
 *
 * 使用公共的 discordNotifier 发送 Discord 消息
 */
export class NotifyService {
  constructor() {
    logger.info('NotifyService initialized');
  }

  async send(message: NotifyMessage): Promise<void> {
    const { type, taskId, meetingId, title, content, priority = 'medium', components } = message;

    // 转换 components 格式并发送 Discord 通知
    if (components && components.length > 0) {
      const buttons = this.convertComponentsToButtons(components);
      await discordNotifier.send({ title, content, buttons });
    } else {
      await discordNotifier.sendText(title, content);
    }

    // 发布到通知频道（#324：直发 eventBus；当前 0 订阅者，保留发布点）
    eventBus.publish('notifications', {
      type,
      taskId: taskId || meetingId,
      message: content,
      priority,
      timestamp: new Date().toISOString(),
    });

    logger.info('Notification sent');
  }

  /**
   * 发送高风险会议确认通知（带按钮）
   */
  async sendHighRiskNotification(
    meetingId: string,
    risk: { score: number; reasons: string[] },
    meetingTitle?: string
  ): Promise<void> {
    const title = '🔴 高风险会议待确认';
    const content = `会议：${meetingTitle || meetingId.slice(0, 8)}
风险评分: ${risk.score}
原因: ${risk.reasons.join(', ')}`;

    await discordNotifier.sendWithConfirmButtons(title, content, meetingId);

    logger.info({ meetingId }, 'High risk notification sent');
  }

  /**
   * 发送中风险会议通知（无按钮，仅通知）
   */
  async sendMediumRiskNotification(
    meetingId: string,
    risk: { score: number; reasons: string[] },
    meetingTitle?: string
  ): Promise<void> {
    const title = '🟡 中风险会议已执行';
    const content = `会议：${meetingTitle || meetingId.slice(0, 8)}
风险评分: ${risk.score}
原因: ${risk.reasons.join(', ')}`;

    await discordNotifier.sendText(title, content);

    logger.info({ meetingId }, 'Medium risk notification sent');
  }

  /**
   * 发送低风险会议通知
   */
  async sendLowRiskNotification(
    meetingId: string,
    meetingTitle?: string
  ): Promise<void> {
    const title = '🟢 低风险会议已自动执行';
    const content = `会议：${meetingTitle || meetingId.slice(0, 8)}
无需人工确认，已自动继续执行`;

    await discordNotifier.sendText(title, content);

    logger.info({ meetingId }, 'Low risk notification sent');
  }

  /**
   * 转换旧的 components 格式到新的 buttons 格式
   */
  private convertComponentsToButtons(components: Record<string, unknown>[]): DiscordMessageOptions['buttons'] {
    const buttons: DiscordMessageOptions['buttons'] = [];

    for (const row of components) {
      if (row.type === 1 && Array.isArray(row.components)) {
        for (const btn of row.components as Record<string, unknown>[]) {
          if (btn.type === 2) {
            const style = btn.style as number;
            let buttonStyle: 'success' | 'danger' | 'primary' | 'secondary' = 'secondary';

            if (style === 3) buttonStyle = 'success';
            else if (style === 4) buttonStyle = 'danger';
            else if (style === 1) buttonStyle = 'primary';

            buttons.push({
              label: btn.label as string,
              customId: btn.custom_id as string,
              style: buttonStyle
            });
          }
        }
      }
    }

    return buttons;
  }
}

export const notifyService = new NotifyService();

export type NotifyEvent = {
  type: string;
  taskId: string;
  message: string;
  priority: string;
  timestamp: string;
};