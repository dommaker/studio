import { Router } from "express";
import {
  requireAuth,
  getAuthInfo,
  optionalAuth,
  requireRole,
} from "../../middleware/auth.js";
import {
  authRateLimit,
  refreshRateLimit,
} from "../../middleware/rate-limit.js";
import * as authService from "./service.js";
import { AuditService } from "@dommaker/studio-audit"; // 🆕 SEC-010
import { FileStore, logger } from "@dommaker/studio-shared";
import { defineRoute, HttpError } from "../../core/http.js";
import { ERROR_CODES } from "@dommaker/studio-contract";
import {
  guestSessionBodySchema,
  registerBodySchema,
  loginBodySchema,
  refreshBodySchema,
} from "@dommaker/studio-contract";

const router = Router();
const auditService = new AuditService(new FileStore()); // 🆕 SEC-010

/**
 * GET /api/v1/auth/status
 * 返回当前认证模式 + 用户信息。前端据此决定是否显示登录页。
 */
router.get("/status", optionalAuth(), defineRoute({}, async (req) => {
  const mode = (process.env.STUDIO_AUTH || 'none') === 'none' ? 'none' : 'on';
  if (mode === 'none') {
    return { mode, user: { id: 'local', name: 'Local User', role: 'Admin' } };
  }
  const authInfo = getAuthInfo(req);
  if (authInfo.userId && authInfo.sessionId) {
    try {
      const result = await authService.getCurrentUser(authInfo.sessionId);
      return { mode, user: result.user ? { id: result.user.id, name: result.user.name || '', role: result.user.role } : null };
    } catch {
      return { mode, user: null };
    }
  }
  return { mode, user: null };
}));

/**
 * POST /api/v1/auth/guest-session
 * 创建或获取 Guest Session
 */
router.post("/guest-session", defineRoute(
  { body: guestSessionBodySchema },
  async (req, _res, { body }) => {
    return authService.getOrCreateSession({
      guestId: body.guestId,
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });
  },
));

/**
 * POST /api/v1/auth/register
 * 用户注册
 * 🆕 SEC-010: 记录审计日志
 */
router.post("/register", authRateLimit, defineRoute(
  { body: registerBodySchema },
  async (req, _res, { body }) => {
    // 2026-08-25 收口：单租户自托管口径，注册默认关闭，
    // REGISTER_ENABLED=true 显式开放（现有用户不受影响）
    if (process.env.REGISTER_ENABLED !== "true") {
      throw new HttpError(403, ERROR_CODES.FORBIDDEN, "注册已关闭");
    }
    try {
      // 路由边界显式收回（z.infer 退化可选，schema 已保必填）
      const result = await authService.register(body as authService.RegisterInput);

      // SEC-010: 记录注册成功
      await auditService
        .log({
          userId: result.user!.id,
          action: "register",
          resource: "user",
          resourceId: result.user!.id,
          details: { email: result.user!.email },
          status: "success",
        })
        .catch((err) => logger.error("Audit log error", { error: String(err) }));

      return result;
    } catch (error) {
      const err = error as Error;

      // SEC-010: 记录注册失败
      await auditService
        .log({
          action: "register",
          resource: "user",
          details: { email: body.email },
          status: "failure",
          errorMessage: err.message,
        })
        .catch((e) => logger.error("Audit log error", { error: String(e) }));

      if (err.message === "邮箱已被注册") {
        throw new HttpError(409, ERROR_CODES.CONFLICT, err.message);
      }
      throw new HttpError(400, ERROR_CODES.BAD_REQUEST, err.message);
    }
  },
));

/**
 * POST /api/v1/auth/login
 * 用户登录
 * 🆕 SEC-010: 记录审计日志
 */
router.post("/login", authRateLimit, defineRoute(
  { body: loginBodySchema },
  async (req, _res, { body }) => {
    const ip = req.ip || req.headers["x-forwarded-for"] || "unknown";
    const ua = req.headers["user-agent"] || "unknown";

    try {
      const result = await authService.login(body as authService.LoginInput);

      // SEC-010: 记录登录成功
      await auditService
        .log({
          userId: result.user!.id,
          sessionId: result.session.id,
          ipAddress: String(ip),
          userAgent: ua,
          action: "login",
          resource: "session",
          resourceId: result.session.id,
          details: { email: result.user!.email, role: result.user!.role },
          status: "success",
        })
        .catch((err) => logger.error("Audit log error", { error: String(err) }));

      return result;
    } catch (error) {
      const err = error as Error;

      // SEC-010: 记录登录失败
      await auditService
        .log({
          ipAddress: String(ip),
          userAgent: ua,
          action: "login",
          resource: "session",
          details: { email: body.email },
          status: "failure",
          errorMessage: err.message,
        })
        .catch((e) => logger.error("Audit log error", { error: String(e) }));

      if (err.message === "邮箱或密码错误") {
        throw new HttpError(401, ERROR_CODES.UNAUTHORIZED, err.message);
      }
      throw new HttpError(400, ERROR_CODES.BAD_REQUEST, err.message);
    }
  },
));

/**
 * POST /api/v1/auth/logout
 * 用户登出
 * 🆕 SEC-010: 记录审计日志
 */
router.post("/logout", requireAuth(), defineRoute({}, async (req) => {
  const authInfo = getAuthInfo(req);
  await authService.logout(authInfo.sessionId, authInfo.userId);

  // SEC-010: 记录登出
  await auditService
    .log({
      userId: authInfo.userId,
      sessionId: authInfo.sessionId,
      action: "logout",
      resource: "session",
      resourceId: authInfo.sessionId,
      status: "success",
    })
    .catch((err) => logger.error("Audit log error", { error: String(err) }));

  return { success: true };
}));

/**
 * GET /api/v1/auth/me
 * 获取当前用户信息
 */
router.get("/me", optionalAuth(), defineRoute({}, async (req) => {
  const authInfo = getAuthInfo(req);
  if (!authInfo?.sessionId) {
    return { user: null, session: null };
  }
  return authService.getCurrentUser(authInfo.sessionId);
}));

/**
 * POST /api/v1/auth/cleanup
 * 清理过期 Session（管理员）
 */
router.post(
  "/cleanup",
  requireAuth(),
  requireRole("Admin"),
  defineRoute({}, async () => {
    const count = await authService.cleanupExpiredSessions();
    return { cleaned: count };
  }),
);

/**
 * POST /api/v1/auth/refresh
 * 刷新 Token（公开端点）
 */
router.post("/refresh", refreshRateLimit, defineRoute(
  { body: refreshBodySchema },
  async (_req, _res, { body }) => {
    const result = await authService.exchangeRefreshToken(body.refreshToken);
    if (!result) {
      throw new HttpError(401, ERROR_CODES.UNAUTHORIZED, "Invalid refresh token");
    }
    return {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      userId: result.userId,
    };
  },
));

export default router;
