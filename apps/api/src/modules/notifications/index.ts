/**
 * notifications 模块公共出口（P2-c 立界，scripts/p2c-public-surface.mjs 生成）
 *
 * 跨模块只允许 import 本文件（模块根）；深路径 import 由 eslint local/no-deep-module-import 拦截。
 * 公共面 = 生成时实际被模块外消费的符号；新增跨模块消费时在此补导出。
 */
// #684 包下沉：NotificationService 自 packages/studio-notification 并入本模块，
// getNotificationService 为进程级单例入口（fire-and-forget 消费方共用）
export { NotificationService, getNotificationService } from './notification-service.js';
export type { CreateNotificationInput } from './notification-service.js';
