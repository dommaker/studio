/**
 * auth 域契约（批次 6/7；敏感域）——本文件 schema 即 wire 正本（#685 归一：
 * 手写 interface 双写层退役，z.infer alias 与 apps/api/src/modules/auth/
 * service.ts 的 SafeUser/SessionData/AuthResult 对齐，经 routes.ts 实测 wire
 * 与前端 authStore 实际消费双端核对）。
 *
 * 九个端点（route-registry /api/v1/auth 公开挂载，路由内自挂中间件）：
 *   POST /stream-ticket  requireAuth + requireRole('Admin')；短期资源绑定票据
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

/** SafeUser wire（service.sanitizeUser = UserData 去 passwordHash）；
 * 前端 authStore 按必填消费 id/email/role */
export const authUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  avatar: z.string().nullable(),
  /** 数据文件原值（实测词表 Guest/User/Admin；契约不收窄，前端 as 收回） */
  role: z.string(),
  emailVerified: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AuthUser = z.infer<typeof authUserSchema>;

/** PublicSession wire：只含元数据，凭证仅走约定顶层字段。 */
export const authSessionSchema = z.object({
  id: z.string(),
  userId: z.string().nullable(),
  guestId: z.string().nullable(),
  expiresAt: z.string(),
  createdAt: z.string(),
});
export type AuthSession = z.infer<typeof authSessionSchema>;

/** login/register/guest-session 响应 data（service AuthResult）；
 * 前端 authStore 按必填消费 token/session */
export const authResultSchema = z.object({
  /** guest-session 新建 guest 时无 user；login/register 恒有 */
  user: authUserSchema.optional(),
  session: authSessionSchema,
  token: z.string(),
  isNewUser: z.boolean().optional(),
  /** 仅 login/register 返回（guest-session 无） */
  refreshToken: z.string().optional(),
});
export type AuthResult = z.infer<typeof authResultSchema>;

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

/** GET /me 响应 data */
export const authMeResultSchema = z.object({
  user: authUserSchema.nullable(),
  session: authSessionSchema.nullable(),
});
export type AuthMeResult = z.infer<typeof authMeResultSchema>;

/** POST /refresh 响应 data（前端拦截器按必填消费 accessToken/refreshToken） */
export const authRefreshResultSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  userId: z.string(),
});
export type AuthRefreshResult = z.infer<typeof authRefreshResultSchema>;

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

export const streamTicketBodySchema = z.object({
  resource: z.string().min(1),
});
export type StreamTicketBody = z.infer<typeof streamTicketBodySchema>;

export const streamTicketResultSchema = z.object({
  token: z.string(),
  expiresIn: z.number().int().positive(),
});
export type StreamTicketResult = z.infer<typeof streamTicketResultSchema>;

// ── 响应（统一 `{ data }` 壳）──

export const authStatusResponseSchema = dataBodySchema(authStatusResultSchema);
export const authResultResponseSchema = dataBodySchema(authResultSchema);
export const authMeResponseSchema = dataBodySchema(authMeResultSchema);
export const authRefreshResponseSchema = dataBodySchema(authRefreshResultSchema);
export const streamTicketResponseSchema = dataBodySchema(streamTicketResultSchema);
export const logoutResponseSchema = dataBodySchema(z.object({ success: z.boolean() }));
export const cleanupResponseSchema = dataBodySchema(z.object({ cleaned: z.number() }));
