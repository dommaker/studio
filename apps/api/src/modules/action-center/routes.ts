/**
 * 行动中心 API 路由（#468）
 *
 * GET / — 状态派生（reply/review/confirm）+ 事件持久（notifications）+ unreadCount。
 * 鉴权（P2-e 声明式统一）：route-registry 挂 authNotGuest（requireAuth+requireNotGuest），
 * 路由内不再挂载；身份取登录态 JWT claims（req.user.id）。
 *
 * 契约驱动迁移（2026-10 批次 4/7）：走 core/http.ts defineRoute——响应统一
 * `{ data }` 壳（原平铺裸 payload）；错误统一 `{ error: { code, message } }`
 * （原手写 500 已同形，code/message 文案不变）。
 */

import { Router } from 'express';
import { createLazyService } from '../../utils/services.js';
import { AuthRequest } from '../../middleware/auth.js';
import { ActionCenterService } from './action-center.service.js';
import { defineRoute, HttpError } from '../../core/http.js';
import { ERROR_CODES } from '@dommaker/studio-contract';

const router = Router();

const getActionCenterService = createLazyService(() => new ActionCenterService());

/**
 * GET /api/v1/action-center
 * 统一行动中心：四类待办一个端点（待回复/待验收/待确认 + 通知与告警）
 */
router.get('/', defineRoute({}, async (req) => {
  const userId = (req as AuthRequest).user?.id ?? null;
  if (!userId) {
    throw new HttpError(500, ERROR_CODES.INTERNAL, 'Authenticated user missing');
  }
  return getActionCenterService().getActionCenter(userId);
}));

export { router as actionCenterRoutes };
