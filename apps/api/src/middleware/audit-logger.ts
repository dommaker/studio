/**
 * 审计日志中间件 - Audit Logger Middleware
 * SEC-009: 自动记录关键操作
 */

import { Request, Response, NextFunction } from 'express';
import { getAuthInfo } from './auth.js';
import { AuditService, AuditLogInput } from '@dommaker/studio-audit';
import { prisma } from '../core/database.js';
import { logger } from '../utils/logger.js';

const auditService = new AuditService(prisma as any);

/**
 * 获取客户端 IP
 */
export function getClientIP(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const ips = Array.isArray(forwarded) ? forwarded : forwarded.split(',');
    return ips[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

/**
 * 判断是否为关键操作（需要审计）
 */
export function isCriticalOperation(req: Request): boolean {
  // DELETE 方法始终记录
  if (req.method === 'DELETE') {
    return true;
  }
  
  // POST/PUT 到特定路径
  const path = req.path;
  const criticalPatterns = [
    '/api/v1/auth/',  // 认证相关
    '/api/v1/roles/',  // 角色管理
    '/api/v1/workflows/',  // 工作流
    '/api/v1/executions/',  // 执行
    '/api/v1/backups/',  // 备份
    '/api/v1/pmo/',  // 项目管理
  ];
  
  return criticalPatterns.some(pattern => path.startsWith(pattern));
}

/**
 * 审计日志中间件
 * 
 * 自动记录关键操作到 AuditLog
 */
export function auditLogger() {
  return async (req: Request, res: Response, next: NextFunction) => {
    // 只记录关键操作
    if (!isCriticalOperation(req)) {
      return next();
    }
    
    // 获取认证信息
    const authInfo = getAuthInfo(req);
    const ip = getClientIP(req);
    const ua = req.headers['user-agent'] || 'unknown';
    
    // 拦截 res.json 以获取响应
    const originalJson = res.json.bind(res);
    res.json = (body: any) => {
      // 异步记录审计日志（不阻塞响应）
      recordAuditLog(req, res, authInfo, ip, ua, body).catch(err => {
        logger.error({ error: err }, 'Failed to record audit log');
      });
      
      return originalJson(body);
    };
    
    next();
  };
}

/**
 * 记录审计日志
 */
export async function recordAuditLog(
  req: Request,
  res: Response,
  authInfo: { sessionId: string; userId?: string; anonymousId?: string },
  ip: string,
  ua: string,
  responseBody: any
): Promise<void> {
  try {
    // 判断操作结果
    const isSuccess = res.statusCode < 400;
    
    // 构建审计日志
    const logInput: AuditLogInput = {
      userId: authInfo.userId,
      sessionId: authInfo.sessionId,
      ipAddress: ip,
      userAgent: ua,
      action: req.method.toLowerCase(),
      resource: getResourceType(req.path),
      resourceId: getResourceId(req.path),
      details: {
        anonymousId: authInfo.anonymousId,  // 🆕 SEC-009
        path: req.path,
        query: req.query,
        method: req.method,
      },
      status: isSuccess ? 'success' : 'failure',
      errorCode: isSuccess ? undefined : responseBody?.error?.code,
      errorMessage: isSuccess ? undefined : responseBody?.error?.message,
    };
    
    await auditService.log(logInput);
  } catch (error) {
    logger.error({ error }, 'Audit log error');
  }
}

/**
 * 从路径提取资源类型
 */
export function getResourceType(path: string): string {
  const parts = path.split('/').filter(Boolean);
  // /api/v1/roles/:id -> roles
  if (parts.length >= 3) {
    return parts[2];
  }
  return 'unknown';
}

/**
 * 从路径提取资源 ID
 */
export function getResourceId(path: string): string | undefined {
  const parts = path.split('/').filter(Boolean);
  // /api/v1/roles/:id -> :id
  if (parts.length >= 4) {
    return parts[3];
  }
  return undefined;
}
