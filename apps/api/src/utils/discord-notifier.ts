/**
 * Discord 通知工具
 *
 * 直接调用 Discord API 发送消息（支持按钮）
 */

import { logger } from '@dommaker/studio-shared';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface DiscordMessageOptions {
  title: string;
  content: string;
  /** Discord 按钮 */
  buttons?: Array<{
    label: string;
    customId?: string;
    url?: string;
    style: 'success' | 'danger' | 'primary' | 'secondary' | 'link';
  }>;
  /** 指定频道 ID */
  channelId?: string;
}

/**
 * DiscordNotifier - 公共 Discord 通知方法
 */
export class DiscordNotifier {
  private defaultChannelId: string;
  private botToken: string;
  private proxyUrl: string;

  constructor() {
    this.defaultChannelId = '';
    this.botToken = '';
    this.proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || 'http://127.0.0.1:7890';
    this.loadConfig();
  }

  private loadConfig(): void {
    // 从 openclaw 配置读取 bot token（可通过环境变量自定义路径）
    try {
      const configPath = process.env.OPENCLAW_CONFIG_PATH
        || path.join(os.homedir(), '.openclaw', 'openclaw.json');
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        this.botToken = config?.channels?.discord?.token || '';
      }
    } catch (error) {
      logger.error('[DiscordNotifier] Failed to load config', { error: String(error) });
    }

    // 频道 ID 必须通过环境变量配置
    this.defaultChannelId = process.env.DISCORD_CHANNEL_ID || '';

    if (this.botToken && this.defaultChannelId) {
      logger.info('[DiscordNotifier] Initialized');
    } else {
      logger.warn('[DiscordNotifier] Not configured: set DISCORD_CHANNEL_ID and ensure openclaw.json has discord.token');
    }
  }

  /**
   * 发送 Discord 消息
   */
  async send(options: DiscordMessageOptions): Promise<void> {
    const channelId = options.channelId || this.defaultChannelId;

    if (!this.botToken || !channelId) {
      logger.warn('[DiscordNotifier] Not configured, skipping');
      return;
    }

    const message = `${options.title}\n\n${options.content}`;

    const body: Record<string, unknown> = {
      content: message
    };

    // 添加按钮
    if (options.buttons && options.buttons.length > 0) {
      body.components = [this.buildActionRow(options.buttons)];
    }

    try {
      const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Bot ${this.botToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        const error = await response.text();
        logger.error('[DiscordNotifier] API error', { error });
      } else {
        logger.info('[DiscordNotifier] Message sent successfully');
      }
    } catch (error) {
      logger.error('[DiscordNotifier] Failed to send', { error: String(error) });

      // 尝试通过代理重试
      if (this.proxyUrl) {
        await this.sendViaCurl(channelId, body);
      }
    }
  }

  /**
   * 通过 curl 发送（支持代理）
   */
  private async sendViaCurl(channelId: string, body: Record<string, unknown>): Promise<void> {
    try {
      const { execFile } = await import('child_process');
      const payload = JSON.stringify(body);

      return new Promise((resolve) => {
        // execFile 数组参数不经 shell：token 直接作为 curl argv，
        // 不拼进命令字符串；curl 报错不回显 argv（含 -d / -H 内容），明文 token 不落日志
        execFile(
          'curl',
          [
            '-s', '--proxy', this.proxyUrl,
            '-X', 'POST',
            `https://discord.com/api/v10/channels/${channelId}/messages`,
            '-H', `Authorization: Bot ${this.botToken}`,
            '-H', 'Content-Type: application/json',
            '-d', payload,
          ],
          (error, stdout) => {
            if (error) {
              logger.error('[DiscordNotifier] curl failed', { error: String(error) });
            } else if (stdout.includes('"id"')) {
              logger.info('[DiscordNotifier] Message sent via curl');
            }
            resolve();
          }
        );
      });
    } catch (error) {
      logger.error('[DiscordNotifier] curl fallback failed', { error: String(error) });
    }
  }

  /**
   * 发送简单文本消息
   */
  async sendText(title: string, content: string, channelId?: string): Promise<void> {
    await this.send({ title, content, channelId });
  }

  /**
   * 发送带确认/拒绝按钮的消息
   *
   * meetings 模块已删除，确认/拒绝 URL 无有效目标 —— 降级为纯文本通知。
   * TODO: 接入新审批链路后恢复按钮
   */
  async sendWithConfirmButtons(
    title: string,
    content: string,
    actionId: string,
    channelId?: string
  ): Promise<void> {
    logger.info(`[DiscordNotifier] confirm action ${actionId} sent without buttons (meetings module removed)`);
    await this.send({ title, content, channelId });
  }

  /**
   * B3-004: 单向推送 Channel 消息到 Discord
   *
   * 仅推送 @human 的消息和 Agent 结果卡片，不双向同步。
   */
  async sendChannelMessage(
    channelName: string,
    authorName: string,
    content: string,
    meta?: { cardType?: string; goalId?: string; status?: string },
  ): Promise<void> {
    const prefix = meta?.cardType
      ? `[${channelName}] **${authorName}** posted ${meta.cardType} card`
      : `[${channelName}] **${authorName}**:`;

    const maxLen = 1800;
    const truncated = content.length > maxLen ? content.slice(0, maxLen) + '\n\n...(truncated)' : content;

    await this.send({
      title: prefix,
      content: truncated,
    });
  }

  /**
   * 构建 Discord ActionRow
   */
  private buildActionRow(buttons: DiscordMessageOptions['buttons']): Record<string, unknown> {
    const styleMap: Record<string, number> = {
      primary: 1,    // Blue
      secondary: 2,  // Gray
      success: 3,    // Green
      danger: 4,     // Red
      link: 5        // Link (opens URL)
    };

    return {
      type: 1,  // ActionRow
      components: buttons!.map(btn => {
        const component: Record<string, unknown> = {
          type: 2,  // Button
          style: styleMap[btn.style] || 1,
          label: btn.label
        };

        // Link buttons use url, others use custom_id
        if (btn.style === 'link' && btn.url) {
          component.url = btn.url;
        } else if (btn.customId) {
          component.custom_id = btn.customId;
        }

        return component;
      })
    };
  }
}

// 导出单例
export const discordNotifier = new DiscordNotifier();

// 导出便捷方法
export async function sendDiscordNotification(
  title: string,
  content: string,
  buttons?: DiscordMessageOptions['buttons']
): Promise<void> {
  await discordNotifier.send({ title, content, buttons });
}