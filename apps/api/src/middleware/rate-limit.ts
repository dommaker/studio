/**
 * Rate Limiting Middleware
 *
 * 基于 express-rate-limit 的速率限制。
 * MCP tools 等高价值端点需要限制调用频率。
 */

import rateLimit from 'express-rate-limit';
import type { Request } from 'express';

/**
 * 回环直连（本机 daemon/脚本，对端 127.0.0.1）不参与限频——它们共享
 * 同一个 IP 桶，限频会误伤内部调用。公网流量经 nginx 单跳代理，
 * req.ip 为真实客户端（需 app.set('trust proxy', 1)）。
 */
export const isLoopbackIp = (ip: string | undefined): boolean =>
  ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';

export const skipLoopback = (req: Request): boolean => isLoopbackIp(req.ip);

/**
 * MCP tools 速率限制
 * 每个 session 每分钟最多 60 次调用
 */
export const mcpRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 分钟窗口
  max: 60, // 每窗口最大请求数
  standardHeaders: true, // 返回 RateLimit-* headers
  legacyHeaders: false,
  // 不使用自定义 keyGenerator，使用默认的 IP 限制
  skip: skipLoopback,
  message: {
    error: 'Too many requests, please try again later',
    retryAfter: '60s',
  },
});

/**
 * 通用 API 速率限制
 * 每个 IP 每分钟最多 120 次调用
 */
export const apiRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipLoopback,
  message: {
    error: 'Too many requests, please try again later',
  },
});

/**
 * 认证端点速率限制
 * 每个 IP 每分钟最多 10 次登录/注册尝试
 * 防止暴力破解密码
 */
export const authRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many login attempts, please try again later',
  },
});

/**
 * Token 刷新速率限制
 * 每个 IP 每分钟最多 20 次刷新
 * 比登录宽松，合法用户刷新频率更高
 */
export const refreshRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many refresh attempts, please try again later',
  },
});
