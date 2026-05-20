/**
 * 认证服务 - Auth Service
 * SEC-001: 用户认证系统
 */

import { User, Session } from '@prisma/client';
import { prisma } from '@dommaker/studio-prisma';
import * as crypto from 'crypto';

// JWT 配置
const JWT_SECRET = process.env.JWT_SECRET || 'dev-jwt-secret-change-in-production';
const JWT_EXPIRES_IN_SECONDS = 7 * 24 * 60 * 60; // 7 天

// Guest Session 过期时间
const GUEST_EXPIRES_HOURS = 24;

export interface LoginInput {
  email: string;
  password: string;
}

export interface RegisterInput {
  email: string;
  password: string;
  name?: string;
}

export interface SessionInput {
  guestId?: string;
  ipAddress?: string;
  userAgent?: string;
}

export interface AuthResult {
  user?: User;
  session: Session;
  token: string;
  isNewUser?: boolean;
}

/**
 * 密码加密
 */
function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto
    .pbkdf2Sync(password, salt, 1000, 64, 'sha256')
    .toString('hex');
  return `${salt}:${hash}`;
}

/**
 * 验证密码
 */
function verifyPassword(password: string, storedHash: string): boolean {
  const [salt, hash] = storedHash.split(':');
  if (!salt || !hash) return false;
  
  const verifyHash = crypto
    .pbkdf2Sync(password, salt, 1000, 64, 'sha256')
    .toString('hex');
  
  return hash === verifyHash;
}

/**
 * 生成 Token（简化版）
 */
function generateToken(sessionId: string, userId?: string): string {
  const payload = {
    sid: sessionId,
    uid: userId,
    exp: Math.floor(Date.now() / 1000) + JWT_EXPIRES_IN_SECONDS,
  };
  const payloadStr = JSON.stringify(payload);
  const signature = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(payloadStr)
    .digest('hex');
  
  // 格式: base64(payload):signature
  const encoded = Buffer.from(payloadStr).toString('base64url');
  return `${encoded}.${signature}`;
}

/**
 * 验证 Token
 */
export function verifyToken(token: string): { sessionId: string; userId?: string } | null {
  try {
    const [encoded, signature] = token.split('.');
    if (!encoded || !signature) return null;
    
    // 验证签名
    const payloadStr = Buffer.from(encoded, 'base64url').toString('utf8');
    const expectedSig = crypto
      .createHmac('sha256', JWT_SECRET)
      .update(payloadStr)
      .digest('hex');
    
    if (signature !== expectedSig) return null;
    
    // 解析 payload
    const payload = JSON.parse(payloadStr);
    
    // 检查过期
    if (payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    
    return {
      sessionId: payload.sid,
      userId: payload.uid,
    };
  } catch {
    return null;
  }
}

/**
 * 创建 Guest Session
 */
export async function createGuestSession(input: SessionInput): Promise<AuthResult> {
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + GUEST_EXPIRES_HOURS);
  
  const session = await prisma.session.create({
    data: {
      guestId: input.guestId || crypto.randomUUID(),
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      expiresAt,
      token: '', // 先创建，后面更新
    },
  });
  
  // 生成 token
  const token = generateToken(session.id);
  await prisma.session.update({
    where: { id: session.id },
    data: { token },
  });
  
  return {
    session: { ...session, token },
    token,
  };
}

/**
 * 获取或创建 Session
 */
export async function getOrCreateSession(input: SessionInput): Promise<AuthResult> {
  // 如果有 guestId，查找现有 Session
  if (input.guestId) {
    const existing = await prisma.session.findFirst({
      where: { guestId: input.guestId },
      include: { User: true },
    });
    
    if (existing && existing.expiresAt > new Date()) {
      return {
        user: existing.User || undefined,
        session: existing,
        token: existing.token,
      };
    }
  }
  
  // 创建新的 Guest Session
  return createGuestSession(input);
}

/**
 * 用户登录
 */
export async function login(input: LoginInput): Promise<AuthResult> {
  // 查找用户
  const user = await prisma.user.findUnique({
    where: { email: input.email },
  });
  
  if (!user) {
    throw new Error('用户不存在');
  }
  
  if (!user.passwordHash) {
    throw new Error('该用户未设置密码，请使用其他方式登录');
  }
  
  // 验证密码
  if (!verifyPassword(input.password, user.passwordHash)) {
    throw new Error('密码错误');
  }
  
  // 创建 Session
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7); // 7 天
  
  const session = await prisma.session.create({
    data: {
      userId: user.id,
      expiresAt,
      token: '',
    },
  });
  
  // 生成 token
  const token = generateToken(session.id, user.id);
  await prisma.session.update({
    where: { id: session.id },
    data: { token },
  });
  
  return {
    user,
    session: { ...session, token },
    token,
  };
}

/**
 * 用户注册
 */
export async function register(input: RegisterInput): Promise<AuthResult> {
  // 检查邮箱是否已存在
  const existing = await prisma.user.findUnique({
    where: { email: input.email },
  });
  
  if (existing) {
    throw new Error('邮箱已被注册');
  }
  
  // 创建用户
  const passwordHash = hashPassword(input.password);
  const user = await prisma.user.create({
    data: {
      email: input.email,
      passwordHash,
      name: input.name,
      role: 'User', // 默认普通用户
    },
  });
  
  // 创建 Session
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);
  
  const session = await prisma.session.create({
    data: {
      userId: user.id,
      expiresAt,
      token: '',
    },
  });
  
  const token = generateToken(session.id, user.id);
  await prisma.session.update({
    where: { id: session.id },
    data: { token },
  });
  
  return {
    user,
    session: { ...session, token },
    token,
    isNewUser: true,
  };
}

/**
 * 登出
 */
export async function logout(sessionId: string): Promise<void> {
  await prisma.session.update({
    where: { id: sessionId },
    data: { expiresAt: new Date() }, // 立即过期
  });
}

/**
 * 获取当前用户
 */
export async function getCurrentUser(sessionId: string): Promise<{ user: User | null; session: Session | null }> {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: { User: true },
  });
  
  if (!session || session.expiresAt < new Date()) {
    return { user: null, session: null };
  }
  
  return {
    user: session.User,
    session,
  };
}

/**
 * 清理过期 Session
 */
export async function cleanupExpiredSessions(): Promise<number> {
  const result = await prisma.session.deleteMany({
    where: {
      expiresAt: { lt: new Date() },
    },
  });
  
  return result.count;
}

// 导出工具函数（用于测试）
export { hashPassword, verifyPassword };
