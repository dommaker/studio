/**
 * auth 域契约（批次 6/7；敏感域）——正本以 apps/api/src/modules/auth/
 * routes.ts + service.ts（AuthResult/SafeUser/SessionData）实测 wire 与
 * 前端 authStore 实际消费双端核对为准。
 *
 * 八个端点（route-registry /api/v1/auth 公开挂载，路由内自挂中间件）：
 *   GET  /status         optionalAuth；STUDIO_AUTH=none 短路本地用户
 *   POST /guest-session  创建或复用 Guest Session
 *   POST /register       authRateLimit；REGISTER_ENABLED!=true → 403
 *   POST /login          authRateLimit；统一失败文案防邮箱枚举
 *   POST /logout         requireAuth
 *   GET  /me             optionalAuth
 *   POST /cleanup        requireAuth + requireRole('Admin')
 *   POST /refresh        refreshRateLimit（公开端点）
 *
 * （前端 authApi 另有 getOAuthUrl/forgotPassword/resetPassword 三个死面——
 *  后端无对应路由，本契约不声明；死面清退另案。）
 *
 * wire 形状（defineRoute 统一壳后）：
 * - 全部 `{ data: T }`（原裸对象进壳）
 * - 错误统一 `{ error: { code, message } }`（原 `{ error: string }` 退役；
 *   401/409/403/400 业务拒绝 message 文案保留，code 归词表；
 *   500 message 由 err.message 原样透传不变）
 */

import { z } from 'zod';
import { dataBodySchema } from './envelope.js';

// ── 实体 ──

/** SafeUser wire（service.sanitizeUser = UserData 去 passwordHash）。
 * 手写 interface（前端 authStore 按必填消费 id/email/role）；parity 测试见 __tests__ */
export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  avatar: string | null;
  /** 数据文件原值（实测词表 Guest/User/Admin；契约不收窄，前端 as 收回） */
  role: string;
  emailVerified: string | null;
  createdAt: string;
  updatedAt: string;
}
export const authUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  avatar: z.string().nullable(),
  role: z.string(),
  emailVerified: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** SessionData wire（AuthResult.session / GET /me 的 session）。
 * 手写 interface（前端 authStore 按必填消费 id/expiresAt）；parity 测试见 __tests__ */
export interface AuthSession {
  id: string;
  userId: string | null;
  token: string;
  guestId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  expiresAt: string;
  createdAt: string;
  /** 响应面恒 null（refreshToken 落最近 session 存储，不回读进响应对象） */
  refreshToken: string | null;
}
export const authSessionSchema = z.object({
  id: z.string(),
  userId: z.string().nullable(),
  token: z.string(),
  guestId: z.string().nullable(),
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  expiresAt: z.string(),
  createdAt: z.string(),
  refreshToken: z.string().nullable(),
});

/** login/register/guest-session 响应 data（service AuthResult）。
 * 手写 interface（含手写实体子树；前端 authStore 按必填消费 token/session） */
export interface AuthResult {
  /** guest-session 新建 guest 时无 user；login/register 恒有 */
  user?: AuthUser;
  session: AuthSession;
  token: string;
  isNewUser?: boolean;
  /** 仅 login/register 返回（guest-session 无） */
  refreshToken?: string;
}
export const authResultSchema = z.object({
  user: authUserSchema.optional(),
  session: authSessionSchema,
  token: z.string(),
  isNewUser: z.boolean().optional(),
  refreshToken: z.string().optional(),
});

/** GET /status 响应 data 的 user 段（{ id, name, role } 投影，非完整 AuthUser） */
export const authStatusUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string(),
});
export type AuthStatusUser = z.infer<typeof authStatusUserSchema>;

/** GET /status 响应 data（mode=none → 本地用户；mode=on 无会话 → user=null） */
export const authStatusResultSchema = z.object({
  mode: z.enum(['none', 'on']),
  user: authStatusUserSchema.nullable(),
});
export type AuthStatusResult = z.infer<typeof authStatusResultSchema>;

/** GET /me 响应 data（手写：含手写实体子树） */
export const authMeResultSchema = z.object({
  user: authUserSchema.nullable(),
  session: authSessionSchema.nullable(),
});
export interface AuthMeResult {
  user: AuthUser | null;
  session: AuthSession | null;
}

/** POST /refresh 响应 data（手写：前端拦截器按必填消费 accessToken/refreshToken） */
export const authRefreshResultSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  userId: z.string(),
});
export interface AuthRefreshResult {
  accessToken: string;
  refreshToken: string;
  userId: string;
}

// ── 请求 ──

export const guestSessionBodySchema = z.object({
  guestId: z.string().optional(),
});
export type GuestSessionBody = z.infer<typeof guestSessionBodySchema>;

/** 注册（email/password 必填收进 zod——原缺字段由 service 抛错，同为 400 文案变 zod 格式） */
export const registerBodySchema = z.object({
  email: z.string().min(1),
  password: z.string().min(1),
  name: z.string().optional(),
});
export type RegisterBody = z.infer<typeof registerBodySchema>;

export const loginBodySchema = z.object({
  email: z.string().min(1),
  password: z.string().min(1),
});
export type LoginBody = z.infer<typeof loginBodySchema>;

/** refreshToken 必填收进 zod（原手写 400 'Missing refreshToken' 退役，文案变 zod 格式） */
export const refreshBodySchema = z.object({
  refreshToken: z.string().min(1),
});
export type RefreshBody = z.infer<typeof refreshBodySchema>;

// ── 响应（统一 `{ data }` 壳）──

export const authStatusResponseSchema = dataBodySchema(authStatusResultSchema);
export const authResultResponseSchema = dataBodySchema(authResultSchema);
export const authMeResponseSchema = dataBodySchema(authMeResultSchema);
export const authRefreshResponseSchema = dataBodySchema(authRefreshResultSchema);
export const logoutResponseSchema = dataBodySchema(z.object({ success: z.boolean() }));
export const cleanupResponseSchema = dataBodySchema(z.object({ cleaned: z.number() }));
