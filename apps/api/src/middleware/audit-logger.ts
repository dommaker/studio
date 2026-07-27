/**
 * 审计日志中间件 - Audit Logger Middleware
 * SEC-009: 自动记录关键操作
 */

import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { getAuthInfo } from './auth.js';
import { AuditService, AuditLogInput } from '@dommaker/studio-audit';
import { FileStore } from '@dommaker/studio-shared';
import { logger } from '../utils/logger.js';

const auditService = new AuditService(new FileStore());

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
 * P0 修复 6: 确保请求有 requestId（链路追踪入口）。
 * 优先复用 req 上已有的 requestId，其次 x-request-id 头，都没有则 randomUUID 并落到 req 上
 * —— 下游路由（如频道消息 POST）可复用为 traceId，使 audit.jsonl 的 requestId
 * 与 WU metadata.traceId 同值，串起「请求 → WU → agent-loop 日志」。
 */
export function ensureRequestId(req: Request): string {
  const existing = (req as any).requestId;
  if (typeof existing === 'string' && existing) return existing;
  const header = req.headers['x-request-id'];
  const id = (typeof header === 'string' && header.trim()) || randomUUID();
  (req as any).requestId = id;
  return id;
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
  // P0 修复 6: 频道写操作纳入审计（消息 POST 可触发 agent 执行/LLM 消耗，留审计链）；
  // GET 围观流量不记，避免审计膨胀。
  if (path.startsWith('/api/v1/channels/')) {
    return req.method === 'POST' || req.method === 'PUT';
  }
  const criticalPatterns = [
    '/api/v1/auth/',  // 认证相关
    '/api/v1/roles/',  // 角色管理
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
    // P0 修复 6: 所有请求先确保 requestId（下游路由可复用为 traceId），再按关键操作过滤
    ensureRequestId(req);

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
      // P0 修复 6: requestId 不再为空（req 上已有的 id 或现场生成）
      requestId: ensureRequestId(req),
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
