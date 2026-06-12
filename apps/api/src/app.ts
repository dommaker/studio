// Express 应用配置
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { errorHandler } from './middleware/error-handler.js';
import { requestLogger } from './middleware/request-logger.js';
import { auditLogger } from './middleware/audit-logger.js';
import { optionalAuth } from './middleware/auth.js';
import { getMetrics } from './monitoring/index.js';
import { buildRouteTable } from './route-registry.js';
import { loadRegistry } from './modules/capabilities/routes.js';

export const app = express();

// 中间件
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: false,
  crossOriginResourcePolicy: false,
  hsts: false,
}));
app.use(cors());
app.use(compression());

// Discord interactions 需要原始 body 进行签名验证，跳过 JSON 解析
app.use('/api/v1/discord/interactions', express.raw({ type: 'application/json', limit: '1mb' }));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(requestLogger);
app.use(auditLogger());

// 健康检查（免认证）
app.get('/health', (req: any, res: any) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// G5: 模型路由历史（供 CLI 查询）
app.get('/metrics/routing', async (req: any, res: any) => {
  try {
    const { goalScheduler } = await import('./modules/goals/goal-scheduler.js');
    const history = (goalScheduler as any).recentClassifications || [];
    res.json({ data: history.slice(-10), total: history.length });
  } catch {
    res.json({ data: [], total: 0 });
  }
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
      '/auth/google',
      '/auth/github',
      '/auth/callback/google',
      '/auth/callback/github',
      '/discord/interactions',
      '/cso/validate',
      '/events/stream',  // SSE
      // Public read-only endpoints (Lurk Wall bypass)
      '/channels',
      '/requirements-docs',
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
