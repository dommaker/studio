/**
 * notifications 模块公共出口（P2-c 立界；#682 通知域合一后重写）
 *
 * 跨模块只允许 import 本文件（模块根）；深路径 import 由 eslint local/no-deep-module-import 拦截。
 * 公共面 = 实际被模块外消费的符号；新增跨模块消费时在此补导出。
 *
 * #682：通知域合一——notify-channels（渠道配置）、outbound-notify（Discord 出站）、
 * utils/notifier（notifyAlert fan-out）、utils/discord-notifier 全部并入本模块，
 * utils→modules 反向依赖消除。渠道内部件（channels/*）与出站路由不跨模块消费，不进公共面。
 */
// #684 包下沉：NotificationService 自 packages/studio-notification 并入本模块，
// getNotificationService 为进程级单例入口（fire-and-forget 消费方共用）
export { NotificationService, getNotificationService } from './notification-service.js';
export type { CreateNotificationInput } from './notification-service.js';
// 告警统一出口（workunit/agent-loop/ops 外推）
export { notifyAlert, registerAlertChannelPoster } from './alert-notifier.js';
export type { AlertChannelPost, AlertChannelPoster, AlertLevel, NotifyAlertOptions } from './alert-notifier.js';
// Discord 出站（bootstrap/agent-knowledge/skills/ops 直发）
export { DiscordNotifier, discordNotifier, sendDiscordNotification } from './discord-notifier.js';
export type { DiscordMessageOptions } from './discord-notifier.js';
