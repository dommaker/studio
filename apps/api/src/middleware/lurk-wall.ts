// Lurk Wall — 全局访问控制（2026-05-08）
// Landing Page 公开，API 需认证。白名单路径可跳过。

import { Request, Response, NextFunction } from 'express';

// 无需认证的路径白名单
const PUBLIC_PATHS = [
  '/health',
  '/api/v1/health',
  '/api/v1/auth/login',
  '/api/v1/auth/guest-session',
  '/api/v1/events/stream',  // SSE (认证在 query param)
  '/api/v1/channels',       // B2 Channel UI (get/list public)
  '/api/v1/requirements-docs',  // B2-009 RequirementsDoc edit
];

function isPublicPath(path: string): boolean {
  return PUBLIC_PATHS.some(p => path === p || path.startsWith(p + '/'));
}

export function lurkWall(req: Request, res: Response, next: NextFunction) {
  // 白名单放行
  if (isPublicPath(req.path)) return next();

  // 静态资源（Vite 构建产物）放行
  if (req.path.match(/\.(js|css|png|svg|ico|woff2?|ttf|html)$/)) return next();
  if (req.path.startsWith('/assets/')) return next();

  // API 需认证
  const token = req.headers.authorization?.replace('Bearer ', '') ||
    req.cookies?.token || req.query?.token as string;

  if (!token) {
    return res.status(401).json({
      error: 'Authentication required',
      message: 'Lurk Wall: please authenticate to access Studio',
    });
  }

  // 简化验证：token 存在即通过（后续接入完整 JWT 验证）
  (req as any).authToken = token;
  next();
}
