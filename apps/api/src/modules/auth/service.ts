/**
 * 认证服务 - Auth Service
 * SEC-001: 用户认证系统
 *
 * 存储迁移: Prisma → FileStore (users.json + sessions.jsonl)
 */

import { FileStore } from "@dommaker/studio-shared";
import * as crypto from "crypto";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import * as path from "node:path";
import * as os from "node:os";

// ─── 本地类型（替代 Prisma model 类型） ───

export interface UserData {
  id: string;
  email: string;
  passwordHash: string | null;
  name: string | null;
  avatar: string | null;
  role: string;
  emailVerified: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionData {
  id: string;
  userId: string | null;
  token: string;
  guestId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  expiresAt: string;
  createdAt: string;
  refreshToken: string | null;
}

// ─── JWT 配置 ───

export const JWT_SECRET =
  process.env.JWT_SECRET ||
  (process.env.NODE_ENV === "production"
    ? (() => {
        throw new Error("JWT_SECRET required in production");
      })()
    : "dev-jwt-secret-change-in-production");
const JWT_EXPIRES_IN_SECONDS = 7 * 24 * 60 * 60; // 7 天
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

export interface AuthResult {
  user?: UserData;
  session: SessionData;
  token: string;
  isNewUser?: boolean;
  refreshToken?: string;
}

// ─── FileStore 实例 ───

const fileStore = new FileStore();
const STUDIO_DIR = path.join(os.homedir(), ".studio");
const USERS_FILE = path.join(STUDIO_DIR, "users.json");
const SESSIONS_FILE = path.join(STUDIO_DIR, "sessions.json");

// ─── FileStore 数据访问层 ───

async function readUsers(): Promise<UserData[]> {
  const data = await fileStore.readJson<UserData[]>(USERS_FILE);
  return data ?? [];
}

async function writeUsers(users: UserData[]): Promise<void> {
  await fileStore.writeJson(USERS_FILE, users);
}

async function findUserByEmail(email: string): Promise<UserData | null> {
  const users = await readUsers();
  return users.find((u) => u.email === email) ?? null;
}

async function findUserById(id: string): Promise<UserData | null> {
  const users = await readUsers();
  return users.find((u) => u.id === id) ?? null;
}

async function updateUser(id: string, patch: Partial<UserData>): Promise<void> {
  const users = await readUsers();
  const idx = users.findIndex((u) => u.id === id);
  if (idx >= 0) {
    users[idx] = { ...users[idx], ...patch };
    await writeUsers(users);
  }
}

async function readSessions(): Promise<SessionData[]> {
  const data = await fileStore.readJson<SessionData[]>(SESSIONS_FILE);
  return data ?? [];
}

async function writeSessions(sessions: SessionData[]): Promise<void> {
  await fileStore.writeJson(SESSIONS_FILE, sessions);
}

async function appendSession(session: SessionData): Promise<void> {
  const sessions = await readSessions();
  sessions.push(session);
  await writeSessions(sessions);
}

async function findSessionById(id: string): Promise<SessionData | null> {
  const sessions = await readSessions();
  return sessions.find((s) => s.id === id) ?? null;
}

async function findSessionByGuestId(guestId: string): Promise<SessionData | null> {
  const sessions = await readSessions();
  return sessions.find((s) => s.guestId === guestId) ?? null;
}

async function findSessionByRefreshToken(token: string): Promise<SessionData | null> {
  const sessions = await readSessions();
  return sessions.find((s) => s.refreshToken === token) ?? null;
}

async function updateSession(id: string, patch: Partial<SessionData>): Promise<void> {
  const sessions = await readSessions();
  const idx = sessions.findIndex((s) => s.id === id);
  if (idx >= 0) {
    sessions[idx] = { ...sessions[idx], ...patch };
    await writeSessions(sessions);
  }
}

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

// ─── 业务函数 ───

function makeId(): string {
  return crypto.randomUUID();
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

  await appendSession(session);

  return { session, token };
}

export async function getOrCreateSession(input: SessionInput): Promise<AuthResult> {
  if (input.guestId) {
    const existing = await findSessionByGuestId(input.guestId);
    if (existing && new Date(existing.expiresAt) > new Date()) {
      const user = existing.userId ? await findUserById(existing.userId) : null;
      return { user: user ?? undefined, session: existing, token: existing.token };
    }
  }
  return createGuestSession(input);
}

export async function login(input: LoginInput): Promise<AuthResult> {
  const user = await findUserByEmail(input.email);
  if (!user) throw new Error("用户不存在");
  if (!user.passwordHash) throw new Error("该用户未设置密码，请使用其他方式登录");

  const pwResult = verifyPassword(input.password, user.passwordHash);
  if (!pwResult.valid) throw new Error("密码错误");

  // 旧格式静默升级为 bcrypt
  if (pwResult.needsRehash) {
    try {
      await updateUser(user.id, { passwordHash: hashPassword(input.password) });
    } catch { /* 静默 */ }
  }

  // 清理旧 guest session
  const allSessions = await readSessions();
  const guestIds = allSessions
    .filter((s) => s.userId === user.id && s.guestId && new Date(s.expiresAt) > new Date())
    .map((s) => s.id);
  if (guestIds.length > 0) {
    const kept = allSessions.filter((s) => !guestIds.includes(s.id));
    await writeSessions(kept);
  }

  // 创建 Session
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);

  const id = makeId();
  const token = generateToken(id, user.id);

  const session: SessionData = {
    id,
    userId: user.id,
    token,
    guestId: null,
    ipAddress: null,
    userAgent: null,
    expiresAt: expiresAt.toISOString(),
    createdAt: new Date().toISOString(),
    refreshToken: null,
  };

  await appendSession(session);

  const refreshToken = await generateRefreshToken(user.id);

  return { user, session, token, refreshToken };
}

export async function register(input: RegisterInput): Promise<AuthResult> {
  const existing = await findUserByEmail(input.email);
  if (existing) throw new Error("邮箱已被注册");

  // 创建用户
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

  const users = await readUsers();
  users.push(user);
  await writeUsers(users);

  // 创建 Session
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);

  const sid = makeId();
  const token = generateToken(sid, user.id);

  const session: SessionData = {
    id: sid,
    userId: user.id,
    token,
    guestId: null,
    ipAddress: null,
    userAgent: null,
    expiresAt: expiresAt.toISOString(),
    createdAt: now,
    refreshToken: null,
  };

  await appendSession(session);

  const refreshToken = await generateRefreshToken(user.id);

  return { user, session, token, isNewUser: true, refreshToken };
}

export async function logout(sessionId: string, userId?: string): Promise<void> {
  await updateSession(sessionId, { expiresAt: new Date().toISOString() });

  if (userId) {
    const sessions = await readSessions();
    for (const s of sessions) {
      if (s.userId === userId && s.refreshToken) {
        s.refreshToken = null;
      }
    }
    await writeSessions(sessions);
  }
}

export async function getCurrentUser(
  sessionId: string,
): Promise<{ user: UserData | null; session: SessionData | null }> {
  const session = await findSessionById(sessionId);
  if (!session || new Date(session.expiresAt) < new Date()) {
    return { user: null, session: null };
  }
  const user = session.userId ? await findUserById(session.userId) : null;
  return { user, session };
}

export async function cleanupExpiredSessions(): Promise<number> {
  const sessions = await readSessions();
  const now = new Date();
  const kept = sessions.filter((s) => new Date(s.expiresAt) >= now);
  const count = sessions.length - kept.length;
  if (count > 0) {
    await writeSessions(kept);
  }
  return count;
}

const REFRESH_TOKEN_EXPIRY_DAYS = 30;

export async function generateRefreshToken(userId: string): Promise<string> {
  const token = crypto.randomBytes(64).toString("hex");
  // Store refreshToken in the user's most recent session
  const sessions = await readSessions();
  const userSessions = sessions.filter((s) => s.userId === userId);
  if (userSessions.length > 0) {
    userSessions[userSessions.length - 1].refreshToken = token;
    await writeSessions(sessions);
  }
  return token;
}

export async function exchangeRefreshToken(
  refreshToken: string,
): Promise<{ accessToken: string; refreshToken: string; userId: string } | null> {
  const session = await findSessionByRefreshToken(refreshToken);
  if (!session || !session.userId) return null;

  // Revoke old refresh token
  await updateSession(session.id, { refreshToken: null });

  // Create new session + access token
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);

  const id = makeId();
  const accessToken = generateToken(id, session.userId);

  const newSession: SessionData = {
    id,
    userId: session.userId,
    token: accessToken,
    guestId: null,
    ipAddress: null,
    userAgent: null,
    expiresAt: expiresAt.toISOString(),
    createdAt: new Date().toISOString(),
    refreshToken: null,
  };

  await appendSession(newSession);

  // Create new refresh token
  const newRefreshToken = await generateRefreshToken(session.userId);

  return { accessToken, refreshToken: newRefreshToken, userId: session.userId };
}

export async function revokeRefreshToken(refreshToken: string): Promise<boolean> {
  const session = await findSessionByRefreshToken(refreshToken);
  if (!session) return false;
  await updateSession(session.id, { refreshToken: null });
  return true;
}

// ─── 导出工具函数（用于测试） ───
export { hashPassword, verifyPassword };
