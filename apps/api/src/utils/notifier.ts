/**
 * 告警通知出口（P0 观测性修复 4）。
 *
 * notifyAlert 统一入口，内部 fan-out 到两个 sink（各自 try/catch，互不影响）：
 *   1. 频道 sink — 经 ChannelMessageService 以 agentName:'Studio' 发系统消息到告警频道
 *      （eventBus + SSE 发布，频道页实时可见）。
 *      目标频道解析顺序：env STUDIO_ALERT_CHANNEL_ID → 按名字找「系统」/system 频道
 *      → 都没有则跳过并 logger.warn。
 *   2. 企业微信 sink — env WECOM_WEBHOOK_URL 存在时 POST 群机器人 markdown 消息
 *      （5s 超时）；未配置则跳过。
 *
 * utils/discord-notifier.ts 保留不动（可选渠道，后续由配置决定是否并入）。
 */
import { logger, FileStore } from '@dommaker/studio-shared';
import { ChannelMessageService } from '../modules/channels/channel-message.service.js';

export type AlertLevel = 'info' | 'warning' | 'critical';

const WECOM_TIMEOUT_MS = 5_000;

/** 告警频道候选名（频道创建时统一带 '#' 前缀，兼容历史无前缀数据） */
const ALERT_CHANNEL_NAMES = new Set(['#系统', '系统', '#system', 'system']);

/**
 * 发送告警。fire-and-forget 设计：sink 失败仅记日志，绝不抛给调用方。
 */
export async function notifyAlert(level: AlertLevel, title: string, body: string): Promise<void> {
  await Promise.all([
    postToAlertChannel(level, title, body).catch(err =>
      logger.warn('[Notifier] Channel sink failed (non-blocking)', { error: String(err) })
    ),
    postToWeCom(level, title, body).catch(err =>
      logger.warn('[Notifier] WeCom sink failed (non-blocking)', { error: String(err) })
    ),
  ]);
}

/**
 * 频道 sink：写一条系统消息到告警频道。
 * 返回 false = 无可用频道（已跳过）；true = 已投递。
 */
async function postToAlertChannel(level: AlertLevel, title: string, body: string): Promise<boolean> {
  const fs = new FileStore();
  const channelId = await resolveAlertChannelId(fs);
  if (!channelId) {
    logger.warn('[Notifier] No alert channel found (set STUDIO_ALERT_CHANNEL_ID or create a 系统/system channel), skipping');
    return false;
  }

  await new ChannelMessageService(fs).createAgentMessage(
    channelId,
    'Studio',
    `${formatLevelTag(level)} **${title}**\n\n${body}`,
    // warning/critical 带 atHuman（NotificationBell 响铃）；info 只实时上屏不打扰
    level === 'info' ? undefined : { meta: { atHuman: true } },
  );
  return true;
}

/** 目标频道解析：env STUDIO_ALERT_CHANNEL_ID → 名为「系统」/system 的频道 → null */
async function resolveAlertChannelId(fs: FileStore): Promise<string | null> {
  const envId = process.env.STUDIO_ALERT_CHANNEL_ID?.trim();
  if (envId) return envId;

  const channels = await fs.listChannels();
  const hit = channels.find(c => ALERT_CHANNEL_NAMES.has(c.name) || ALERT_CHANNEL_NAMES.has(c.name.toLowerCase()));
  return hit?.id ?? null;
}

/** 企业微信群机器人 sink：POST markdown 消息，5s 超时；未配置 WECOM_WEBHOOK_URL 则跳过 */
async function postToWeCom(level: AlertLevel, title: string, body: string): Promise<void> {
  const url = process.env.WECOM_WEBHOOK_URL?.trim();
  if (!url) return;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WECOM_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        msgtype: 'markdown',
        markdown: { content: `${formatLevelTag(level)} **${title}**\n${body}` },
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      logger.warn('[Notifier] WeCom webhook returned non-OK', { status: response.status });
    }
  } finally {
    clearTimeout(timer);
  }
}

function formatLevelTag(level: AlertLevel): string {
  return level === 'critical' ? '[CRITICAL]' : level === 'warning' ? '[WARNING]' : '[INFO]';
}
