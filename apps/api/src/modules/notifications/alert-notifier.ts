/**
 * 告警通知出口（P0 观测性修复 4；#682 自 utils/notifier.ts 并入 notifications 模块）。
 *
 * notifyAlert 统一入口，内部 fan-out 到三个 sink（各自 try/catch，互不影响）：
 *   1. 频道 sink — 经装配注入的 AlertChannelPoster（bootstrap/module-sinks.ts 注
 *      channels 的 ChannelMessageService，以 agentName:'Studio' 发系统消息到告警频道
 *      （eventBus + SSE 发布，频道页实时可见）。
 *      目标频道解析顺序：env STUDIO_ALERT_CHANNEL_ID → 按名字找「系统」/system 频道
 *      → 都没有则跳过并 logger.warn。
 *   2. 企业微信 sink — webhook URL 解析「配置存储（/settings 通知渠道）优先，
 *      env WECOM_WEBHOOK_URL 兜底」（#525 P2-6，解析见 channels/config-store），
 *      POST 群机器人 markdown 消息（5s 超时）；未配置则跳过。
 *   3. 行动中心 sink（#468）— warning/critical 落 NotificationService（type=monitor_alert，
 *      全用户），刷新/重连不丢；info 不持久化（与 atHuman 口径一致，防刷屏）。
 *   4. ClawBot sink（#525 P2-6）— 配置存储里已扫码绑定时 sendText 到 ilinkUserId
 *      （文本同企微段内容；iLink 主动推送受 24h/10 条限制，见 channels/clawbot-client 头注释）。
 *
 * discord-notifier.ts（可选渠道）在同模块，不经 notifyAlert fan-out。
 */
import { FileStore } from '@dommaker/studio-shared';
import { getNotificationService } from './notification-service.js';
import { loadNotifyChannelsConfig, resolveWeComWebhookUrl } from './channels/config-store.js';
import { sendText } from './channels/clawbot-client.js';
import { postWeComMarkdown } from './channels/wecom-client.js';
import { getStore } from '../../core/store.js';
import { logger } from '@dommaker/studio-shared/node';

export type AlertLevel = 'info' | 'warning' | 'critical';

/**
 * 频道 sink 出口缝（Phase 5 SCC 第一刀 #2：消除 notifications→channels 模块边）。
 * 依赖倒置：接口与注册口在调用方（本模块），bootstrap 装配期把 channels 的
 * ChannelMessageService.createAgentMessage 注进来（bootstrap/module-sinks.ts）。
 * 未注册语义：warn 一次 + 跳过该 sink（与「无可用告警频道」同级口径，fire-and-forget 不抛）。
 */
export interface AlertChannelPost {
  channelId: string;
  content: string;
  /** warning/critical 带响铃（meta.atHuman）；info 只实时上屏 */
  atHuman: boolean;
}

export type AlertChannelPoster = (post: AlertChannelPost) => Promise<unknown>;

let channelPoster: AlertChannelPoster | null = null;
let posterWarned = false;

/** 装配期注入实现；测试可传 null 复位到未注册态 */
export function registerAlertChannelPoster(fn: AlertChannelPoster | null): void {
  channelPoster = fn;
  posterWarned = false;
}

export interface NotifyAlertOptions {
  /** 关联 WU——通知获得 /workunits/:id 直链（行动中心点击直达，#468/#464） */
  wuId?: string;
}

/** 告警频道候选名（频道创建时统一带 '#' 前缀，兼容历史无前缀数据） */
const ALERT_CHANNEL_NAMES = new Set(['#系统', '系统', '#system', 'system']);

/**
 * 发送告警。fire-and-forget 设计：sink 失败仅记日志，绝不抛给调用方。
 */
export async function notifyAlert(level: AlertLevel, title: string, body: string, opts?: NotifyAlertOptions): Promise<void> {
  await Promise.all([
    postToAlertChannel(level, title, body).catch(err =>
      logger.warn('[Notifier] Channel sink failed (non-blocking)', { error: String(err) })
    ),
    postToWeCom(level, title, body).catch(err =>
      logger.warn('[Notifier] WeCom sink failed (non-blocking)', { error: String(err) })
    ),
    persistAlertNotification(level, title, body, opts).catch(err =>
      logger.warn('[Notifier] Notification sink failed (non-blocking)', { error: String(err) })
    ),
    postToClawBot(level, title, body).catch(err =>
      logger.warn('[Notifier] ClawBot sink failed (non-blocking)', { error: String(err) })
    ),
  ]);
}

/** 行动中心 sink（#468）：warning/critical 落 NotificationService（全用户），info 不持久化 */
async function persistAlertNotification(
  level: AlertLevel,
  title: string,
  body: string,
  opts?: NotifyAlertOptions,
): Promise<void> {
  if (level === 'info') return;
  await getNotificationService().createForAllUsers({
    type: 'monitor_alert',
    title,
    content: body,
    ...(opts?.wuId ? { wuId: opts.wuId, link: `/workunits/${opts.wuId}` } : {}),
  });
}

/**
 * 频道 sink：写一条系统消息到告警频道。
 * 返回 false = 无可用频道（已跳过）；true = 已投递。
 */
async function postToAlertChannel(level: AlertLevel, title: string, body: string): Promise<boolean> {
  const fs = getStore();
  const channelId = await resolveAlertChannelId(fs);
  if (!channelId) {
    logger.warn('[Notifier] No alert channel found (set STUDIO_ALERT_CHANNEL_ID or create a 系统/system channel), skipping');
    return false;
  }

  if (!channelPoster) {
    if (!posterWarned) {
      posterWarned = true;
      logger.warn('[Notifier] AlertChannelPoster 未注册（bootstrap 装配期应注入 channels 实现），跳过频道 sink');
    }
    return false;
  }

  await channelPoster({
    channelId,
    content: `${formatLevelTag(level)} **${title}**\n\n${body}`,
    // warning/critical 带 atHuman（NotificationBell 响铃）；info 只实时上屏不打扰
    atHuman: level !== 'info',
  });
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

/** 企业微信群机器人 sink：POST markdown 消息（发送实现见 notify-channels/wecom-client）；
 *  URL 解析「配置存储优先、env 兜底」（#525 P2-6），未配置则跳过 */
async function postToWeCom(level: AlertLevel, title: string, body: string): Promise<void> {
  const url = resolveWeComWebhookUrl().url;
  if (!url) return;

  const { ok, status } = await postWeComMarkdown(url, `${formatLevelTag(level)} **${title}**\n${body}`);
  if (!ok) {
    logger.warn('[Notifier] WeCom webhook returned non-OK', { status });
  }
}

/** ClawBot sink（#525 P2-6）：配置存储已绑定时 sendText 到 ilinkUserId（文本同企微段内容）；未绑定跳过 */
async function postToClawBot(level: AlertLevel, title: string, body: string): Promise<void> {
  const clawbot = loadNotifyChannelsConfig().clawbot;
  if (!clawbot?.botToken) return;

  await sendText({
    botToken: clawbot.botToken,
    baseUrl: clawbot.baseUrl,
    toUserId: clawbot.ilinkUserId,
    text: `${formatLevelTag(level)} **${title}**\n${body}`,
  });
}

function formatLevelTag(level: AlertLevel): string {
  return level === 'critical' ? '[CRITICAL]' : level === 'warning' ? '[WARNING]' : '[INFO]';
}
