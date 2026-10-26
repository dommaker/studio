/**
 * 认证服务 - Auth Service
 * SEC-001: 用户认证系统
 *
 * 存储迁移: Prisma → FileStore (users.json + sessions.json)
 */

import * as crypto from "crypto";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import {
  AuthSessionStore,
  REFRESH_TOKEN_IDLE_EXPIRY_MS,
  type SessionData,
  type UserData,
} from "./auth-session-store.js";

export type { SessionData, UserData } from "./auth-session-store.js";

// ─── JWT 配置 ───

export const JWT_SECRET =
  process.env.JWT_SECRET ||
  (process.env.NODE_ENV === "production"
    ? (() => {
        throw new Error("JWT_SECRET required in production");
      })()
    : "dev-jwt-secret-change-in-production");
const JWT_EXPIRES_IN_SECONDS = 24 * 60 * 60; // 24h；refresh 续期受 7 天 idle / 30 天 absolute 上限约束
const GUEST_EXPIRES_HOURS = 24;

// ─── 公共接口 ───

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

export type PublicSession = Pick<SessionData, 'id' | 'userId' | 'guestId' | 'expiresAt' | 'createdAt'>;

export interface AuthResult {
  user?: SafeUser;
  session: PublicSession;
  token: string;
  isNewUser?: boolean;
  refreshToken?: string;
}

const authSessions = new AuthSessionStore();

// ─── 密码工具 ───

function hashPassword(password: string): string {
  return bcrypt.hashSync(password, 12);
}

function verifyPassword(
  password: string,
  storedHash: string,
): { valid: boolean; needsRehash: boolean } {
  const colonCount = (storedHash.match(/:/g) || []).length;
  if (colonCount === 1) {
    const [salt, hash] = storedHash.split(":");
    if (!salt || !hash) return { valid: false, needsRehash: false };
    const verifyHash = crypto
      .pbkdf2Sync(password, salt, 1000, 64, "sha256")
      .toString("hex");
    return { valid: hash === verifyHash, needsRehash: hash === verifyHash };
  }
  return { valid: bcrypt.compareSync(password, storedHash), needsRehash: false };
}

// ─── JWT 工具 ───

function generateToken(sessionId: string, userId?: string): string {
  return jwt.sign({ sid: sessionId, uid: userId }, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN_SECONDS,
  });
}

export function verifyToken(
  token: string,
): { sessionId: string; userId?: string } | null {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as jwt.JwtPayload;
    return { sessionId: payload.sid, userId: payload.uid };
  } catch {
    return null;
  }
}

// ─── 安全工具 ───

/** 从返回给前端的用户对象中移除 passwordHash */
function sanitizeUser(user: UserData): SafeUser {
  const { passwordHash, ...safe } = user;
  return safe;
}

/** 响应只暴露 Session 元数据；access/refresh 凭证仅走约定顶层字段。 */
function sanitizeSession(session: SessionData): PublicSession {
  return {
    id: session.id,
    userId: session.userId,
    guestId: session.guestId,
    expiresAt: session.expiresAt,
    createdAt: session.createdAt,
  };
}

function makeId(): string {
  return crypto.randomUUID();
}

function makeRefreshToken(): string {
  return crypto.randomBytes(64).toString("hex");
}

function refreshIdleExpiry(): string {
  return new Date(Date.now() + REFRESH_TOKEN_IDLE_EXPIRY_MS).toISOString();
}

export async function createGuestSession(input: SessionInput): Promise<AuthResult> {
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + GUEST_EXPIRES_HOURS);

  const id = makeId();
  const token = generateToken(id);

  const session: SessionData = {
    id,
    userId: null,
    token,
    guestId: input.guestId || crypto.randomUUID(),
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
    expiresAt: expiresAt.toISOString(),
    createdAt: new Date().toISOString(),
    refreshToken: null,
  };

  await authSessions.createGuestSession(session);

  return { session: sanitizeSession(session), token };
}

export async function getOrCreateSession(input: SessionInput): Promise<AuthResult> {
  if (input.guestId) {
    const existing = await authSessions.findSessionByGuestId(input.guestId);
    if (existing && !existing.revokedAt && new Date(existing.expiresAt) > new Date()) {
      const user = existing.userId ? await authSessions.findUserById(existing.userId) : null;
      return {
        user: user ? sanitizeUser(user) : undefined,
        session: sanitizeSession(existing),
        token: existing.token,
      };
    }
  }
  return createGuestSession(input);
}

export async function login(input: LoginInput): Promise<AuthResult> {
  const user = await authSessions.findUserByEmail(input.email);
  // 统一失败文案：不区分"用户不存在"与"密码错误"，防邮箱枚举（2026-08-25 收口）
  if (!user) throw new Error("邮箱或密码错误");
  if (!user.passwordHash) throw new Error("该用户未设置密码，请使用其他方式登录");

  const pwResult = verifyPassword(input.password, user.passwordHash);
  if (!pwResult.valid || user.role !== 'Admin') throw new Error("邮箱或密码错误");
  const upgradedPasswordHash = pwResult.needsRehash ? hashPassword(input.password) : undefined;

  const id = makeId();
  const token = generateToken(id, user.id);
  const refreshToken = makeRefreshToken();
  const session: SessionData = {
    id,
    userId: user.id,
    token,
    guestId: null,
    ipAddress: null,
    userAgent: null,
    expiresAt: refreshIdleExpiry(),
    createdAt: new Date().toISOString(),
    refreshToken: null,
  };

  await authSessions.createLoginSession(user.id, session, refreshToken, upgradedPasswordHash);

  return { user: sanitizeUser(user), session: sanitizeSession(session), token, refreshToken };
}

export async function register(input: RegisterInput): Promise<AuthResult> {
  const now = new Date().toISOString();
  const user: UserData = {
    id: makeId(),
    email: input.email,
    passwordHash: hashPassword(input.password),
    name: input.name ?? null,
    avatar: null,
    role: "User",
    emailVerified: null,
    createdAt: now,
    updatedAt: now,
  };

  const sid = makeId();
  const token = generateToken(sid, user.id);
  const refreshToken = makeRefreshToken();
  const session: SessionData = {
    id: sid,
    userId: user.id,
    token,
    guestId: null,
    ipAddress: null,
    userAgent: null,
    expiresAt: refreshIdleExpiry(),
    createdAt: now,
    refreshToken: null,
  };

  await authSessions.register(user, session, refreshToken);

  return {
    user: sanitizeUser(user),
    session: sanitizeSession(session),
    token,
    isNewUser: true,
    refreshToken,
  };
}

export async function logout(sessionId: string, _userId?: string): Promise<void> {
  await authSessions.revokeSession(sessionId);
}

export type SafeUser = Omit<UserData, "passwordHash">;

export async function getCurrentUser(
  sessionId: string,
): Promise<{ user: SafeUser | null; session: PublicSession | null }> {
  const session = await authSessions.findSessionById(sessionId);
  if (!session || session.revokedAt || new Date(session.expiresAt) <= new Date()) {
    return { user: null, session: null };
  }
  const user = session.userId ? await authSessions.findUserById(session.userId) : null;
  if (session.userId && (!user || user.role !== 'Admin')) return { user: null, session: null };
  return { user: user ? sanitizeUser(user) : null, session: sanitizeSession(session) };
}

export async function cleanupExpiredSessions(): Promise<number> {
  return authSessions.cleanupExpiredSessions();
}

export async function generateRefreshToken(sessionId: string): Promise<string> {
  const token = makeRefreshToken();
  if (!(await authSessions.setRefreshToken(sessionId, token))) {
    throw new Error("Session not found or expired");
  }
  return token;
}

export async function exchangeRefreshToken(
  refreshToken: string,
): Promise<{ accessToken: string; refreshToken: string; userId: string } | null> {
  const result = await authSessions.rotateRefreshToken(refreshToken, generateToken, async (userId, users) => {
    return users.find((user) => user.id === userId)?.role === 'Admin';
  });
  if (!result) return null;
  return {
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    userId: result.userId,
  };
}

export async function revokeRefreshToken(refreshToken: string): Promise<boolean> {
  return authSessions.revokeRefreshToken(refreshToken);
}

// ─── 导出工具函数（用于测试） ───
export { hashPassword, verifyPassword };
