// Express 应用配置
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { shouldCompress } from './middleware/compression-filter.js';
import { errorHandler } from './middleware/error-handler.js';
import { requestLogger } from './middleware/request-logger.js';
import { auditLogger } from './middleware/audit-logger.js';
import { optionalAuth } from './middleware/auth.js';
import { getMetrics } from './monitoring/index.js';
import { buildRouteTable } from './route-registry.js';
import { loadRegistry } from './modules/capabilities/routes.js';
import { isAllowedOrigin } from './cors-origin.js';
import { apiRateLimit } from './middleware/rate-limit.js';

export const app = express();

// 单跳反代（nginx/cloudflared 同机）：req.ip 取 X-Forwarded-For 真实客户端，
// rate limit 才能按客户端分桶（此前全站共享 127.0.0.1 一个桶）
app.set('trust proxy', 1);

// 中间件
// 2026-08-25 安全收口：HSTS / COOP 启用（站点 HTTPS-only，HTTP 仅 301）；
// CSP 仍关（SPA 静态资源在 nginx 层，那里以 report-only 起步）
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: false,
}));
// CORS 白名单（此前反射任意 Origin）：同源无 Origin 头不受影响
app.use(cors({
  origin: (origin, cb) => cb(null, isAllowedOrigin(origin)),
}));
// 通用 API 限频（回环直连 skip，见 rate-limit.ts）
app.use('/api', apiRateLimit);
app.use(compression({ filter: shouldCompress }));

// Discord interactions 需要原始 body 进行签名验证，跳过 JSON 解析
app.use('/api/v1/discord/interactions', express.raw({ type: 'application/json', limit: '1mb' }));
// Deploy webhook 同样需要原始 body 做 GitHub HMAC-SHA256 校验
app.use('/api/v1/deploy/webhook', express.raw({ type: 'application/json', limit: '1mb' }));

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(requestLogger);
app.use(auditLogger());

// 健康检查（免认证）
app.get('/health', (req: any, res: any) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Prometheus 指标
app.get('/metrics', async (req: any, res: any) => {
  try {
    const metrics = await getMetrics();
    res.set('Content-Type', 'text/plain; version=0.0.4');
    res.send(metrics);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// API 文档
app.get('/api/docs', (req: any, res: any) => {
  res.redirect('/docs/openapi.yaml');
});

/**
 * 注册所有 API 路由（异步，启动时调用一次）
 */
export async function registerRoutes(): Promise<void> {
  // 预加载能力注册表
  loadRegistry();

  // Lurk Wall: read-gate — production only, skip in dev/test
  if (process.env.NODE_ENV === 'production') {
    const PUBLIC_API = new Set([
      '/auth/login',
      '/auth/register',
      '/auth/guest-session',
      '/auth/refresh',
      '/auth/status',         // 前端检测登录状态（未登录返回 mode:on + user:null）
      '/auth/google',
      '/auth/github',
      '/auth/callback/google',
      '/auth/callback/github',
      '/discord/interactions',
      '/deploy/webhook',     // GitHub webhook（HMAC 即认证）
      '/cso/validate',
      // 2026-08-25：/events/stream 移出白名单——此前匿名可挂流旁观全部内部事件
      // 信封（工单内容/错误堆栈/prompt 片段）。现经 ?token= 认证（optionalAuth
      // 支持 query token，EventSource 无法设置 Authorization 头）。
      // Public read-only endpoints (Lurk Wall bypass)
      '/channels',
      '/health',
      '/pipeline/status',
      '/mcp/tools',        // MCP tool listing + execution (auth via permission service)
      '/mcp/health',       // MCP health check
      '/mcp/sse',          // MCP SSE transport endpoint
      '/mcp/messages',     // MCP SSE message endpoint
    ]);
    const optAuth = optionalAuth();
    app.use('/api/v1', async (req: any, res: any, next: any) => {
      await new Promise<void>((resolve) => optAuth(req, res, resolve as any));
      const authReq = req as import('./middleware/auth.js').AuthRequest;
      if (PUBLIC_API.has(req.path) || [...PUBLIC_API].some(p => req.path.startsWith(p + '/')) || authReq.user) {
        return next();
      }
      res.status(401).json({ error: 'Authentication required' });
    });
  }

  // 注册路由表
  const routes = await buildRouteTable();
  for (const entry of routes) {
    if (entry.middleware && entry.middleware.length > 0) {
      app.use(entry.path, ...entry.middleware, entry.router);
    } else {
      app.use(entry.path, entry.router);
    }
  }

  // 静态资源服务（前端）- 必须在 API 路由之后注册
  // no-cache 防止 Cloudflare/CDN 缓存旧版本前端
  const frontendPath = path.join(__dirname, '../frontend/dist');
  app.use(express.static(frontendPath, {
    index: false,
    setHeaders: (res: any, filePath: string) => {
      if (filePath.endsWith('.js') || filePath.endsWith('.css') || filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      }
    },
  }));

  // SPA 回退 - 所有非 API 路由返回 index.html
  app.get('*', (req: any, res: any, next: any) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/docs/') || req.path.includes('.')) {
      return next();
    }
    // Prevent Cloudflare/CDN from caching stale SPA HTML
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(frontendPath, 'index.html'));
  });

  // 404 处理 - 必须在所有路由之后
  app.use((req: any, res: any) => {
    res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: `Route ${req.method} ${req.path} not found`,
      },
    });
  });

  // 错误处理
  app.use(errorHandler);
}

// 静态资源路径需要延迟加载
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
