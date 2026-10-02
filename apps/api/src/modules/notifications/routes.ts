/**
 * 通知 API 路由
 *
 * #274: 身份源从 x-user-id header 切换为登录态 JWT claims（req.user.id），
 * 鉴权（P2-e 声明式统一）：route-registry /api/v1/notifications 挂 authNotGuest（requireAuth+requireNotGuest），路由内不再挂载。
 *
 * 契约驱动迁移（2026-10 批次 5/7）：走 core/http.ts defineRoute——响应统一
 * `{ data }` 壳（GET / 裸数组、GET /unread-count 与写端点平铺全进壳）；错误统一
 * `{ error: { code, message } }`（code 由 'INTERNAL_ERROR' 归一为
 * ERROR_CODES.INTERNAL；service 错误文案由固定串变为实际错误消息，
 * 「Authenticated user missing」显式拒绝保留原文案）。
 */

import { Router, Request } from 'express';
import { NotificationService } from '@dommaker/studio-notification';

import { createLazyService } from '../../utils/services.js';
import { AuthRequest } from '../../middleware/auth.js';
import { defineRoute, HttpError } from '../../core/http.js';
import {
  ERROR_CODES,
  listNotificationsQuerySchema,
  notificationIdParamsSchema,
} from '@dommaker/studio-contract';
import { getStore } from '../../core/store.js';


const router = Router();

const getNotificationService = createLazyService(() => new NotificationService(getStore()));

/**
 * 取登录态用户 id；缺失（鉴权放行但 user 未挂）抛 500（不回退 default-user）
 */
function resolveUserId(req: Request): string {
  const userId = (req as AuthRequest).user?.id ?? null;
  if (!userId) {
    throw new HttpError(500, ERROR_CODES.INTERNAL, 'Authenticated user missing');
  }
  return userId;
}

/**
 * GET /api/v1/notifications
 * 获取通知列表
 */
router.get('/', defineRoute(
  { query: listNotificationsQuerySchema },
  async (req, _res, { query }) => {
    const userId = resolveUserId(req);
    return getNotificationService().getUserNotifications(userId, {
      unreadOnly: query.unreadOnly === 'true',
      limit: 50,
    });
  },
));

/**
 * GET /api/v1/notifications/unread-count
 * 获取未读数量
 */
router.get('/unread-count', defineRoute({}, async (req) => {
  const userId = resolveUserId(req);
  const count = await getNotificationService().getUnreadCount(userId);
  return { count };
}));

/**
 * POST /api/v1/notifications/:id/read
 * 标记已读
 */
router.post('/:id/read', defineRoute(
  { params: notificationIdParamsSchema },
  async (req, _res, { params }) => {
    const userId = resolveUserId(req);
    await getNotificationService().markAsRead(params.id, userId);
    return { success: true };
  },
));

/**
 * POST /api/v1/notifications/read-all
 * 标记全部已读
 */
router.post('/read-all', defineRoute({}, async (req) => {
  const userId = resolveUserId(req);
  await getNotificationService().markAllAsRead(userId);
  return { success: true };
}));

export { router as notificationRoutes };
