/**
 * Notify API 路由
 *
 * 端点：
 * - POST /api/v1/notify/send - 发送通知（供内部模块调用）
 *
 * #434：用户通知渠道配置端点（POST /config、GET /config/status）已随设置页死配置清理删除——
 * 配置落盘后无任何发送方消费（真实通路走 env/外部配置），notify-config.json 不再读写。
 *
 * 契约驱动迁移（2026-10 批次 5/7）：走 core/http.ts defineRoute——type/title/content
 * 必填与 type/priority 词表收进 zod（原手写 400 退役，词表外值由透传收紧为 400——
 * 无消费方，收紧安全）；响应统一 `{ data }` 壳（原平铺 `{ success, message }` 进壳）；
 * 错误统一 `{ error: { code, message } }`（500 文案由固定串变为实际错误消息）。
 */

import { Router } from 'express';
import { notifyService, NotifyMessage } from './notify.service.js';
import { defineRoute } from '../../core/http.js';
import { notifySendBodySchema } from '@dommaker/studio-contract';

const router = Router();

// ==================== 发送通知 ====================
router.post('/send', defineRoute(
  { body: notifySendBodySchema },
  async (_req, _res, { body }) => {
    await notifyService.send({
      ...body,
      priority: body.priority || 'medium',
    } as NotifyMessage);

    return { success: true, message: 'Notification sent' };
  },
));

export default router;
