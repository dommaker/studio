/**
 * Rate Limiting Middleware
 *
 * 基于 express-rate-limit 的速率限制。
 * MCP tools 等高价值端点需要限制调用频率。
 */

import rateLimit from 'express-rate-limit';

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
  message: {
    error: 'Too many requests, please try again later',
  },
});
