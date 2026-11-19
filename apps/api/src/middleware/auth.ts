/**
 * 认证中间件 - Auth Middleware
 * SEC-001: 用户认证系统
 * SEC-009: 匿名用户识别
 *
 * 存储迁移: Prisma → FileStore
 */

import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger.js';
import { verifyToken, type UserData, type SessionData } from '../modules/auth/index.js';
import crypto from 'crypto';
import * as path from 'node:path';
import { studioDir } from '@dommaker/studio-shared/studio-dir';
import { getStore } from '../core/store.js';
import { isAgentServiceToken, verifyAgentServiceIdentity, verifyAgentBrokerMarker } from '@dommaker/studio-shared/node';


const STUDIO_DIR = studioDir();
const USERS_FILE = path.join(STUDIO_DIR, 'users.json');
const SESSIONS_FILE = path.join(STUDIO_DIR, 'sessions.json');

// ─── 本地类型（替代 Prisma model 类型） ───
// UserData / SessionData 单一来源在 modules/auth/auth-session-store.ts（users.json/sessions.json
// 的唯一写入方），service.ts re-export 保持既有 import 路径可用。

export type { UserData, SessionData };

export type ActorType = 'Operator' | 'Agent' | 'System';

/** Authenticated, storage-secret-free identity exposed to route handlers. */
export interface AuthPrincipal {
  id: string;
  email: string;
  name: string | null;
  avatar: string | null;
  role: 'Admin' | 'Agent' | 'System';
  actorType: ActorType;
}

export interface AuthSessionProjection {
  id: string;
  userId: string | null;
}

const LOCAL_OPERATOR: AuthPrincipal = {
  id: 'local', email: '', name: 'Local User', avatar: null, role: 'Admin', actorType: 'Operator',
};

function operatorPrincipal(user: UserData): AuthPrincipal | null {
  if (user.role !== 'Admin') return null;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatar: user.avatar,
    role: 'Admin',
    actorType: 'Operator',
  };
}

function sessionProjection(session: SessionData): AuthSessionProjection {
  return { id: session.id, userId: session.userId };
}

// 扩展 Request 类型
declare global {
  namespace Express {
    interface Request {
      user?: AuthPrincipal | null;
      session?: AuthSessionProjection | null;
      anonymousId?: string;
      streamSessionId?: string;
    }
  }
}

/** 扩展请求，添加 auth 信息。 */
export interface AuthRequest extends Request {
  user?: AuthPrincipal | null;
  session?: AuthSessionProjection | null;
  anonymousId?: string;
  agentExecutionId?: string;
  streamSessionId?: string;
}

// ─── 内部查询工具 ───

async function findSessionWithUser(sessionId: string): Promise<(SessionData & { User: UserData }) | null> {
  const sessions = await getStore().readJson<SessionData[]>(SESSIONS_FILE);
  const session = (sessions ?? []).find(s => s.id === sessionId);
  if (!session) return null;
  const users = await getStore().readJson<UserData[]>(USERS_FILE);
  const user = (users ?? []).find(u => u.id === session.userId);
  if (!user) return null;
  return { ...session, User: user };
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

function denyAgent(res: Response): void {
  res.status(403).json({
    error: { code: 'AGENT_ENDPOINT_FORBIDDEN', message: 'Agent 服务身份无权访问此端点' },
  });
}

function brokerMarker(req: Request): string | null {
  const value = req.headers['x-studio-agent-broker'];
  return typeof value === 'string' && value ? value : null;
}

/** Broker provenance, not bearer shape, selects the restricted Agent execution plane. */
export function agentServiceEndpointAllowlist() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const marker = brokerMarker(req);
    const token = parseAuthHeader(req);
    if (!marker && (!token || !isAgentServiceToken(token))) return next();
    if (marker && !verifyAgentBrokerMarker(marker)) return denyAgent(res);
    if (req.method === 'POST' && req.path === '/api/v1/executions/events') return next();
    denyAgent(res);
  };
}

/** Authenticate the per-execution credential at the sole Agent callback endpoint. */
export function requireAgentService() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const token = parseAuthHeader(req);
    const identity = token ? verifyAgentServiceIdentity(token) : null;
    const marker = brokerMarker(req);
    const source = marker ? verifyAgentBrokerMarker(marker) : null;
    if (!identity || !marker || source?.executionId !== identity.executionId) return denyAgent(res);
    const claimedExecution = (req.body as { executionId?: unknown } | undefined)?.executionId;
    if (typeof claimedExecution !== 'string' || claimedExecution !== identity.executionId) return denyAgent(res);
    const authReq = req as AuthRequest;
    authReq.agentExecutionId = identity.executionId;
    authReq.user = {
      id: `agent:${identity.executionId}`, email: '', name: 'Agent', avatar: null,
      role: 'Agent', actorType: 'Agent',
    };
    next();
  };
}

/** Preserve unmarked legacy local runtime callbacks; broker-marked calls always need Agent auth. */
export function requireRuntimeCallback() {
  const local = requireLocalhost();
  const agent = requireAgentService();
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const token = parseAuthHeader(req);
    if (brokerMarker(req) || (token && isAgentServiceToken(token))) {
      agent(req, res, next);
      return;
    }
    await local(req, res, next);
  };
}

/**
 * 可选认证 - 不强制要求登录
 * 有 token 则解析，无 token 则生成匿名标识
 * 
 * 🆕 SEC-009: 匿名用户自动生成 anonymousId
 */
export function optionalAuth() {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const authReq = req as AuthRequest;
    if ((process.env.STUDIO_AUTH || 'none') === 'none') {
      authReq.user = { ...LOCAL_OPERATOR };
      return next();
    }

    authReq.anonymousId = generateAnonymousId(getClientIP(req), req.headers['user-agent'] || 'unknown');
    try {
      const token = parseAuthHeader(req);
      const payload = token ? verifyToken(token) : null;
      const sessionId = authReq.streamSessionId ?? payload?.sessionId;
      if (!sessionId) return next();
      const session = await findSessionWithUser(sessionId);
      if (!session || session.revokedAt || new Date(session.expiresAt) <= new Date()) return next();
      const principal = operatorPrincipal(session.User);
      if (!principal) return next();
      authReq.user = principal;
      authReq.session = sessionProjection(session);
      next();
    } catch {
      next();
    }
  };
}

/** 强制认证 - 仅已认证 Operator Session；legacy User/Guest 不获得新 Principal。 */
export function requireAuth() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const authReq = req as AuthRequest;
    const bearer = parseAuthHeader(req);
    if (brokerMarker(req) || (bearer && isAgentServiceToken(bearer))) return denyAgent(res);
    if ((process.env.STUDIO_AUTH || 'none') === 'none') {
      authReq.user = { ...LOCAL_OPERATOR };
      return next();
    }

    authReq.anonymousId = generateAnonymousId(getClientIP(req), req.headers['user-agent'] || 'unknown');
    try {
      const payload = bearer ? verifyToken(bearer) : null;
      const sessionId = authReq.streamSessionId ?? payload?.sessionId;
      if (!sessionId) {
        return res.status(401).json({ error: '未登录', code: 'UNAUTHORIZED' });
      }
      const session = await findSessionWithUser(sessionId);
      if (!session) {
        return res.status(401).json({ error: 'Session 不存在', code: 'SESSION_NOT_FOUND' });
      }
      if (session.revokedAt || new Date(session.expiresAt) <= new Date()) {
        return res.status(401).json({ error: '登录已过期，请重新登录', code: 'SESSION_EXPIRED' });
      }
      const principal = operatorPrincipal(session.User);
      if (!principal) {
        return res.status(401).json({ error: 'Legacy session revoked', code: 'LEGACY_SESSION_REVOKED' });
      }
      authReq.user = principal;
      authReq.session = sessionProjection(session);
      next();
    } catch (error) {
      logger.error({ error }, 'Auth middleware error');
      return res.status(500).json({ error: '认证失败', code: 'AUTH_ERROR' });
    }
  };
}

/**
 * 角色检查 - 要求特定角色
 *
 * 2026-07 修复：STUDIO_AUTH=none（本地免登录）下此前因无 session 恒 401，
 * 导致 pmo/outputs 等 Admin 端点在本地不可用；现与 requireAuth/optionalAuth
 * 对称，none 模式直接放行并注入本地 Admin 用户。
 */
export function requireRole(...roles: string[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const authReq = req as AuthRequest;

    // STUDIO_AUTH=none: 本地免登录模式，直接放行
    if ((process.env.STUDIO_AUTH || 'none') === 'none') {
      authReq.user = authReq.user ?? { ...LOCAL_OPERATOR };
      return next();
    }

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

    if (user.actorType !== 'Operator' || !roles.includes(user.role)) {
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
 * Guest 检查 - 要求不是 Guest 角色
 *
 * 2026-07 修复：补 STUDIO_AUTH=none 分支（与 requireRole 对称），
 * 否则 none 模式下未先经 requireAuth 注入用户时恒 403。
 */
export function requireNotGuest() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const authReq = req as AuthRequest;

    // STUDIO_AUTH=none: 本地免登录模式，直接放行
    if ((process.env.STUDIO_AUTH || 'none') === 'none') {
      authReq.user = authReq.user ?? { ...LOCAL_OPERATOR };
      return next();
    }

    if (!authReq.user || authReq.user.actorType !== 'Operator') {
      return res.status(403).json({
        error: '访客无权执行此操作，请先登录',
        code: 'GUEST_FORBIDDEN',
      });
    }

    next();
  };
}

/**
 * Admin 检查 — 2026-07 服务器信息暴露修复
 *
 * requireRole('Admin') 的语义化包装。生产环境要求 requireAuth 之后
 * role==='Admin'；STUDIO_AUTH=none 本地免登录模式直接放行（继承
 * requireRole 的 none 分支）。用于 workspaces 模块等暴露服务器
 * 信息/远程操作能力的端点。
 */
export function requireAdmin() {
  return requireRole('Admin');
}

/**
 * 本机回环检查 — 2026-07 API 鉴权收紧 / 2026-08-25 修复同机反代绕过
 *
 * 仅放行 127.0.0.1 / ::1（含 ::ffff: 映射）的**直连**请求，其余 403。
 * 用于"假定本机调用方、无凭证"的端点（/api/knowledge 内部知识 API、
 * /api/v1/mcp/messages|sse）。
 *
 * 2026-08-25 修复：原先只查 TCP 对端，但 nginx/cloudflared 与 API 同机时，
 * 公网流量的 socket 对端也是 127.0.0.1，导致恒放行。现加判：请求带
 * X-Forwarded-For / CF-Connecting-IP 头即视为经代理的转发流量，一律 403
 * （本机 daemon/CLI 直连不会携带这些头，nginx/Cloudflare 边缘必带）。
 * 与认证模式无关（网络层检查），STUDIO_AUTH=none 下同样生效。
 */
export function requireLocalhost() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const bearer = parseAuthHeader(req);
    if (brokerMarker(req) || (bearer && isAgentServiceToken(bearer))) return denyAgent(res);
    // 经代理转发的流量一律拒绝（同机反代下 TCP 对端也是回环，单靠 IP 判不出）
    if (req.headers['x-forwarded-for'] || req.headers['cf-connecting-ip']) {
      return res.status(403).json({
        error: '该端点仅允许本机调用',
        code: 'LOCALHOST_ONLY',
      });
    }

    const ip = req.ip ?? req.socket?.remoteAddress ?? '';
    const normalized = ip.startsWith('::ffff:') ? ip.slice(7) : ip;

    if (normalized === '127.0.0.1' || normalized === '::1') {
      const authReq = req as AuthRequest;
      authReq.user ??= {
        id: 'system:localhost', email: '', name: 'System', avatar: null,
        role: 'System', actorType: 'System',
      };
      return next();
    }

    return res.status(403).json({
      error: '该端点仅允许本机调用',
      code: 'LOCALHOST_ONLY',
    });
  };
}
