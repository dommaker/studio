/**
 * 认证中间件 - Auth Middleware
 * SEC-001: 用户认证系统
 * SEC-009: 匿名用户识别
 */

import { Request, Response, NextFunction } from 'express';
import { User, Session, Workspace, WorkspaceToken } from '@prisma/client';
import { prisma } from '@dommaker/studio-prisma';
import { logger } from '../utils/logger.js';
import { verifyToken } from '../modules/auth/service.js';
import crypto from 'crypto';

// 扩展 Request 类型
declare global {
  namespace Express {
    interface Request {
      user?: User | null;
      session?: Session | null;
      anonymousId?: string;  // 🆕 SEC-009: 匿名用户标识
      workspace?: Workspace | null;
      workspaceToken?: WorkspaceToken | null;
    }
  }
}

/**
 * 扩展请求，添加 auth 信息
 */
export interface AuthRequest extends Request {
  user?: User | null;
  session?: Session | null;
  anonymousId?: string;  // 🆕 SEC-009
  workspace?: Workspace | null;
  workspaceToken?: WorkspaceToken | null;
}

/**
 * 获取认证信息（用于中间件内部）
 */
export function getAuthInfo(req: Request): { sessionId: string; userId?: string; anonymousId?: string } {
  const authReq = req as AuthRequest;
  return {
    sessionId: authReq.session?.id || '',
    userId: authReq.user?.id,
    anonymousId: authReq.anonymousId,  // 🆕 SEC-009
  };
}

/**
 * SEC-009: 生成匿名用户标识
 * 
 * 基于 IP + UA + 日期生成，同一用户同一天标识相同
 * 格式: anon_{hash}
 */
export function generateAnonymousId(ip: string, userAgent: string): string {
  // 日期窗口：按天分组，同一用户同一天 ID 相同
  const dateWindow = new Date().toISOString().split('T')[0];
  const raw = `${ip}|${userAgent}|${dateWindow}`;
  const hash = crypto.createHash('sha256').update(raw).digest('hex').substring(0, 16);
  return `anon_${hash}`;
}

/**
 * 获取客户端 IP
 */
function getClientIP(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const ips = Array.isArray(forwarded) ? forwarded : forwarded.split(',');
    return ips[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

/**
 * 解析 Authorization Header
 */
function parseAuthHeader(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;
  
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return null;
  }
  
  return parts[1];
}

/**
 * 可选认证 - 不强制要求登录
 * 有 token 则解析，无 token 则生成匿名标识
 * 
 * 🆕 SEC-009: 匿名用户自动生成 anonymousId
 */
export function optionalAuth() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const authReq = req as AuthRequest;
    
    // 🆕 SEC-009: 始终生成匿名标识（用于审计）
    const ip = getClientIP(req);
    const ua = req.headers['user-agent'] || 'unknown';
    authReq.anonymousId = generateAnonymousId(ip, ua);
    
    try {
      const token = parseAuthHeader(req);
      
      if (!token) {
        return next();
      }
      
      const payload = verifyToken(token);
      if (!payload) {
        return next();
      }
      
      // 查询 Session
      const session = await prisma.session.findUnique({
        where: { id: payload.sessionId },
        include: { User: true },
      });
      
      if (!session || session.expiresAt < new Date()) {
        return next();
      }
      
      // 附加到请求
      authReq.user = session.User;
      authReq.session = session;
      
      next();
    } catch (error) {
      // 错误时不阻塞，继续执行
      next();
    }
  };
}

/**
 * 强制认证 - 要求登录
 * 未登录返回 401
 * 
 * 🆕 SEC-009: 登录用户也会生成 anonymousId（备用）
 */
export function requireAuth() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const authReq = req as AuthRequest;
    
    // 🆕 SEC-009: 始终生成匿名标识
    const ip = getClientIP(req);
    const ua = req.headers['user-agent'] || 'unknown';
    authReq.anonymousId = generateAnonymousId(ip, ua);
    
    try {
      const token = parseAuthHeader(req);
      
      if (!token) {
        return res.status(401).json({
          error: '未登录',
          code: 'UNAUTHORIZED',
        });
      }
      
      const payload = verifyToken(token);
      if (!payload) {
        return res.status(401).json({
          error: '登录已过期，请重新登录',
          code: 'TOKEN_EXPIRED',
        });
      }
      
      // 查询 Session
      const session = await prisma.session.findUnique({
        where: { id: payload.sessionId },
        include: { User: true },
      });
      
      if (!session) {
        return res.status(401).json({
          error: 'Session 不存在',
          code: 'SESSION_NOT_FOUND',
        });
      }
      
      if (session.expiresAt < new Date()) {
        return res.status(401).json({
          error: '登录已过期，请重新登录',
          code: 'SESSION_EXPIRED',
        });
      }
      
      // 附加到请求
      authReq.user = session.User;
      authReq.session = session;
      
      next();
    } catch (error) {
      logger.error({ error }, 'Auth middleware error');
      return res.status(500).json({
        error: '认证失败',
        code: 'AUTH_ERROR',
      });
    }
  };
}

/**
 * 角色检查 - 要求特定角色
 */
export function requireRole(...roles: string[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const authReq = req as AuthRequest;
    
    // 先执行 requireAuth
    if (!authReq.session || !authReq.session.userId) {
      return res.status(401).json({
        error: '未登录',
        code: 'UNAUTHORIZED',
      });
    }
    
    const user = authReq.user;
    if (!user) {
      return res.status(401).json({
        error: '用户不存在',
        code: 'USER_NOT_FOUND',
      });
    }
    
    if (!roles.includes(user.role)) {
      return res.status(403).json({
        error: '权限不足',
        code: 'FORBIDDEN',
        required: roles,
        current: user.role,
      });
    }
    
    next();
  };
}

/**
 * 类型安全地查询资源创建者
 * 各模型使用对应的 creatorId / createdBy 字段
 */
async function findResourceCreator(model: string, resourceId: string): Promise<string | null | undefined> {
  switch (model.toLowerCase()) {
    case 'role': {
      const r = await prisma.role.findUnique({ where: { id: resourceId }, select: { creatorId: true } });
      return r?.creatorId ?? undefined;
    }
    case 'goal': {
      const r = await prisma.goal.findUnique({ where: { id: resourceId }, select: { createdBy: true } });
      return r?.createdBy ?? undefined;
    }
    case 'signedDocument': {
      const r = await prisma.signedDocument.findUnique({ where: { id: resourceId }, select: { createdBy: true } });
      return r?.createdBy ?? undefined;
    }
    case 'document': {
      const r = await prisma.document.findUnique({ where: { id: resourceId }, select: { createdBy: true } });
      return r?.createdBy ?? undefined;
    }
    default:
      throw new Error(`Unsupported ownership model: ${model}`);
  }
}

/**
 * 所有权检查 - 要求是资源创建者或管理员
 */
export function checkOwnership(model: string, paramKey: string = 'id') {
  return async (req: Request, res: Response, next: NextFunction) => {
    const authReq = req as AuthRequest;
    
    if (!authReq.user) {
      return res.status(401).json({
        error: '未登录',
        code: 'UNAUTHORIZED',
      });
    }
    
    // Admin 可以操作所有资源
    if (authReq.user.role === 'Admin') {
      return next();
    }
    
    // 获取资源 ID
    const resourceId = req.params[paramKey];
    if (!resourceId) {
      return res.status(400).json({
        error: '缺少资源 ID',
        code: 'MISSING_RESOURCE_ID',
      });
    }
    
    try {
      // 查询资源的创建者 — 类型安全的分发
      const creatorId = await findResourceCreator(model, resourceId);

      if (creatorId === undefined) {
        return res.status(404).json({
          error: '资源不存在',
          code: 'RESOURCE_NOT_FOUND',
        });
      }

      if (creatorId !== authReq.user.id) {
        return res.status(403).json({
          error: '无权操作他人创建的资源',
          code: 'FORBIDDEN',
        });
      }
      
      next();
    } catch (error) {
      logger.error({ error }, 'Check ownership error');
      return res.status(500).json({
        error: '权限检查失败',
        code: 'AUTH_CHECK_ERROR',
      });
    }
  };
}

/**
 * Guest 检查 - 要求不是 Guest 角色
 */
export function requireNotGuest() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const authReq = req as AuthRequest;

    if (!authReq.user || authReq.user.role === 'Guest') {
      return res.status(403).json({
        error: '访客无权执行此操作，请先登录',
        code: 'GUEST_FORBIDDEN',
      });
    }

    next();
  };
}

/**
 * Workspace Token 认证 - 用于 Daemon 端点
 * 读取 Authorization: Bearer st_mach_xxx header
 * hash token → 查 WorkspaceToken → 查 Workspace
 */
export function workspaceAuth() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const authReq = req as AuthRequest;

    try {
      const token = parseAuthHeader(req);
      if (!token) {
        return res.status(401).json({
          error: 'Missing workspace token',
          code: 'MISSING_WORKSPACE_TOKEN',
        });
      }

      // Hash incoming token to compare with stored hash
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

      const workspaceToken = await prisma.workspaceToken.findUnique({
        where: { tokenHash },
        include: { workspaces: true },
      });

      if (!workspaceToken) {
        return res.status(401).json({
          error: 'Invalid workspace token',
          code: 'INVALID_WORKSPACE_TOKEN',
        });
      }

      if (workspaceToken.revokedAt) {
        return res.status(401).json({
          error: 'Workspace token has been revoked',
          code: 'WORKSPACE_TOKEN_REVOKED',
        });
      }

      // Find workspace associated with this token
      const workspace = workspaceToken.workspaces[0];
      if (!workspace) {
        return res.status(401).json({
          error: 'No workspace registered for this token',
          code: 'WORKSPACE_NOT_FOUND',
        });
      }

      authReq.workspace = workspace;
      authReq.workspaceToken = workspaceToken;
      next();
    } catch (error) {
      logger.error({ error }, 'Workspace auth middleware error');
      return res.status(500).json({
        error: 'Workspace authentication failed',
        code: 'WORKSPACE_AUTH_ERROR',
      });
    }
  };
}
