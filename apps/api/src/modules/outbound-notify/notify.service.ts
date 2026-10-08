import { logger } from '../../utils/logger.js';
import { discordNotifier, DiscordMessageOptions } from '../../utils/discord-notifier.js';

export interface NotifyMessage {
  type: 'task-failed' | 'timeout' | 'crash' | 'zombie' | 'human-needed'
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
    const { title, content, components } = message;

    // 转换 components 格式并发送 Discord 通知
    if (components && components.length > 0) {
      const buttons = this.convertComponentsToButtons(components);
      await discordNotifier.send({ title, content, buttons });
    } else {
      await discordNotifier.sendText(title, content);
    }

    logger.info('Notification sent');
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