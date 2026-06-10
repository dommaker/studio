/**
 * 认证服务 - Auth Service
 * SEC-001: 用户认证系统
 */

import { User, Session, RefreshToken } from '@prisma/client';
import { prisma } from '@dommaker/studio-prisma';
import * as crypto from 'crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

// JWT 配置
export const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? (() => { throw new Error('JWT_SECRET required in production'); })() : 'dev-jwt-secret-change-in-production');
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
  refreshToken?: string;
}

/**
 * 密码加密 (bcrypt)
 */
function hashPassword(password: string): string {
  return bcrypt.hashSync(password, 12);
}

/**
 * 验证密码
 * 支持两种格式：bcrypt 新格式和旧 PBKDF2 salt:hash 格式
 * 旧格式验证成功返回 needsRehash: true，调用方可静默升级
 */
function verifyPassword(password: string, storedHash: string): { valid: boolean; needsRehash: boolean } {
  // 旧 PBKDF2 格式：salt:hash（恰好一个冒号）
  const colonCount = (storedHash.match(/:/g) || []).length;
  if (colonCount === 1) {
    const [salt, hash] = storedHash.split(':');
    if (!salt || !hash) return { valid: false, needsRehash: false };
    const verifyHash = crypto
      .pbkdf2Sync(password, salt, 1000, 64, 'sha256')
      .toString('hex');
    return { valid: hash === verifyHash, needsRehash: hash === verifyHash };
  }

  // bcrypt 格式
  return { valid: bcrypt.compareSync(password, storedHash), needsRehash: false };
}

/**
 * 生成 Token (JWT)
 */
function generateToken(sessionId: string, userId?: string): string {
  return jwt.sign({ sid: sessionId, uid: userId }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN_SECONDS });
}

/**
 * 验证 Token (JWT)
 */
export function verifyToken(token: string): { sessionId: string; userId?: string } | null {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as jwt.JwtPayload;
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
  const pwResult = verifyPassword(input.password, user.passwordHash);
  if (!pwResult.valid) {
    throw new Error('密码错误');
  }

  // 旧格式静默升级为 bcrypt
  if (pwResult.needsRehash) {
    try {
      const newHash = hashPassword(input.password);
      await prisma.user.update({ where: { id: user.id }, data: { passwordHash: newHash } });
    } catch {
      // 静默忽略，下次登录再试
    }
  }
  
  // 清理旧 guest session（用户登录后不再需要）
  const guestSessions = await prisma.session.findMany({
    where: { userId: user.id, guestId: { not: null }, expiresAt: { gt: new Date() } },
    select: { id: true },
  });
  if (guestSessions.length > 0) {
    await prisma.session.deleteMany({
      where: { id: { in: guestSessions.map(s => s.id) } },
    });
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
    refreshToken: await generateRefreshToken(user.id),
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
    refreshToken: await generateRefreshToken(user.id),
  };
}

/**
 * 登出
 * @param sessionId - 要过期的 session ID
 * @param userId - 可选，提供时同时吊销该用户所有 refresh token
 */
export async function logout(sessionId: string, userId?: string): Promise<void> {
  await prisma.session.update({
    where: { id: sessionId },
    data: { expiresAt: new Date() }, // 立即过期
  });

  if (userId) {
    await prisma.refreshToken.updateMany({
      where: { userId },
      data: { revokedAt: new Date() },
    });
  }
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

const REFRESH_TOKEN_EXPIRY_DAYS = 30;

/**
 * 生成 Refresh Token
 */
export async function generateRefreshToken(userId: string): Promise<string> {
  const token = crypto.randomBytes(64).toString('hex');
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + REFRESH_TOKEN_EXPIRY_DAYS);

  await prisma.refreshToken.create({
    data: { token, userId, expiresAt },
  });

  return token;
}

/**
 * 刷新 Token：验证旧 refresh token，吊销旧的，创建新的 access + refresh pair
 */
export async function exchangeRefreshToken(refreshToken: string): Promise<{ accessToken: string; refreshToken: string; userId: string } | null> {
  const record = await prisma.refreshToken.findUnique({
    where: { token: refreshToken },
  });

  if (!record || record.revokedAt || record.expiresAt < new Date()) {
    return null;
  }

  // 吊销旧 token
  await prisma.refreshToken.update({
    where: { id: record.id },
    data: { revokedAt: new Date() },
  });

  // 创建新 session + access token
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);
  const session = await prisma.session.create({
    data: { userId: record.userId, expiresAt, token: '' },
  });
  const accessToken = generateToken(session.id, record.userId);
  await prisma.session.update({
    where: { id: session.id },
    data: { token: accessToken },
  });

  // 创建新 refresh token
  const newRefreshToken = await generateRefreshToken(record.userId);

  return { accessToken, refreshToken: newRefreshToken, userId: record.userId };
}

/**
 * 吊销 Refresh Token
 */
export async function revokeRefreshToken(refreshToken: string): Promise<boolean> {
  const record = await prisma.refreshToken.findUnique({
    where: { token: refreshToken },
  });

  if (!record || record.revokedAt) {
    return false;
  }

  await prisma.refreshToken.update({
    where: { id: record.id },
    data: { revokedAt: new Date() },
  });

  return true;
}

// 导出工具函数（用于测试）
export { hashPassword, verifyPassword };
