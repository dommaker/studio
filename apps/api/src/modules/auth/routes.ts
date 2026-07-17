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
import { sendPasswordResetEmail } from "./email.service.js";
import { AuditService } from "@dommaker/studio-audit"; // 🆕 SEC-010
import { FileStore, logger } from "@dommaker/studio-shared";
import * as path from "node:path";
import * as os from "node:os";

const router = Router();
const auditService = new AuditService(new FileStore()); // 🆕 SEC-010
const fileStore = new FileStore();

/**
 * POST /api/v1/auth/guest-session
 * 创建或获取 Guest Session
 */
router.post("/guest-session", async (req, res) => {
  try {
    const result = await authService.getOrCreateSession({
      guestId: req.body.guestId,
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * POST /api/v1/auth/register
 * 用户注册
 * 🆕 SEC-010: 记录审计日志
 */
router.post("/register", authRateLimit, async (req, res) => {
  try {
    const result = await authService.register(req.body);

    // 生成邮箱验证 token（开发环境直接返回，生产环境通过邮件发送）
    const verificationToken = await authService.generateEmailVerificationToken(
      result.user.id,
      result.user.email,
    );
    logger.info("Email verification token generated", {
      email: result.user.email,
    });

    // SEC-010: 记录注册成功
    await auditService
      .log({
        userId: result.user.id,
        action: "register",
        resource: "user",
        resourceId: result.user.id,
        details: { email: result.user.email },
        status: "success",
      })
      .catch((err) => logger.error("Audit log error", { error: String(err) }));

    res.json({ ...result, verificationToken });
  } catch (error) {
    const err = error as Error;

    // SEC-010: 记录注册失败
    await auditService
      .log({
        action: "register",
        resource: "user",
        details: { email: req.body.email },
        status: "failure",
        errorMessage: err.message,
      })
      .catch((e) => logger.error("Audit log error", { error: String(e) }));

    if (err.message === "邮箱已被注册") {
      res.status(409).json({ error: err.message });
    } else {
      res.status(400).json({ error: err.message });
    }
  }
});

/**
 * POST /api/v1/auth/login
 * 用户登录
 * 🆕 SEC-010: 记录审计日志
 */
router.post("/login", authRateLimit, async (req, res) => {
  const ip = req.ip || req.headers["x-forwarded-for"] || "unknown";
  const ua = req.headers["user-agent"] || "unknown";

  try {
    const result = await authService.login(req.body);

    // SEC-010: 记录登录成功
    await auditService
      .log({
        userId: result.user.id,
        sessionId: result.session.id,
        ipAddress: String(ip),
        userAgent: ua,
        action: "login",
        resource: "session",
        resourceId: result.session.id,
        details: { email: result.user.email, role: result.user.role },
        status: "success",
      })
      .catch((err) => logger.error("Audit log error", { error: String(err) }));

    res.json(result);
  } catch (error) {
    const err = error as Error;

    // SEC-010: 记录登录失败
    await auditService
      .log({
        ipAddress: String(ip),
        userAgent: ua,
        action: "login",
        resource: "session",
        details: { email: req.body.email },
        status: "failure",
        errorMessage: err.message,
      })
      .catch((e) => logger.error("Audit log error", { error: String(e) }));

    if (err.message === "用户不存在" || err.message === "密码错误") {
      res.status(401).json({ error: err.message });
    } else {
      res.status(400).json({ error: err.message });
    }
  }
});

/**
 * POST /api/v1/auth/logout
 * 用户登出
 * 🆕 SEC-010: 记录审计日志
 */
router.post("/logout", requireAuth(), async (req, res) => {
  try {
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

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * GET /api/v1/auth/me
 * 获取当前用户信息
 */
router.get("/me", optionalAuth(), async (req, res) => {
  try {
    const authInfo = getAuthInfo(req);
    if (!authInfo?.sessionId) {
      res.json({ user: null, session: null });
      return;
    }
    const result = await authService.getCurrentUser(authInfo.sessionId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * POST /api/v1/auth/cleanup
 * 清理过期 Session（管理员）
 */
router.post(
  "/cleanup",
  requireAuth(),
  requireRole("Admin"),
  async (req, res) => {
    try {
      const count = await authService.cleanupExpiredSessions();
      res.json({ cleaned: count });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  },
);

/**
 * POST /api/v1/auth/refresh
 * 刷新 Token（公开端点）
 */
router.post("/refresh", refreshRateLimit, async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      res.status(400).json({ error: "Missing refreshToken" });
      return;
    }
    const result = await authService.exchangeRefreshToken(refreshToken);
    if (!result) {
      res.status(401).json({ error: "Invalid refresh token" });
      return;
    }
    res.json({
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      userId: result.userId,
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * POST /api/v1/auth/forgot-password
 * 请求密码重置邮件（公开端点，不暴露邮箱是否存在）
 */
router.post("/forgot-password", authRateLimit, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      res.status(400).json({ error: "邮箱不能为空" });
      return;
    }

    const token = await authService.generateResetToken(email);
    if (token) {
      logger.info("Password reset token generated", { email });
      await sendPasswordResetEmail(email, token);
    }

    // 统一返回成功，不暴露邮箱是否存在
    res.json({ message: "如果该邮箱已注册，重置密码链接已发送" });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * POST /api/v1/auth/reset-password
 * 使用 token 重置密码（公开端点）
 */
router.post("/reset-password", authRateLimit, async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) {
      res.status(400).json({ error: "token 和密码不能为空" });
      return;
    }

    const success = await authService.resetPassword(token, password);
    if (!success) {
      res.status(400).json({ error: "重置链接无效或已过期" });
      return;
    }

    res.json({ message: "密码重置成功" });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * POST /api/v1/auth/send-verification
 * 重新发送邮箱验证邮件（需要登录）
 */
router.post("/send-verification", requireAuth(), async (req, res) => {
  try {
    const authInfo = getAuthInfo(req);
    if (!authInfo?.userId) {
      res.status(401).json({ error: "请先登录" });
      return;
    }

    const user = await fileStore.readJson<any>(path.join(os.homedir(), '.studio', 'data', 'users', `${authInfo.userId}.json`));
    if (!user) {
      res.status(404).json({ error: "用户不存在" });
      return;
    }
    if (user.emailVerified) {
      res.status(400).json({ error: "邮箱已验证" });
      return;
    }

    const token = await authService.generateEmailVerificationToken(
      user.id,
      user.email,
    );
    logger.info("Email verification token re-generated", { email: user.email });

    res.json({ message: "验证邮件已发送", verificationToken: token });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * POST /api/v1/auth/verify-email
 * 验证邮箱（公开端点，使用 token）
 */
router.post("/verify-email", authRateLimit, async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) {
      res.status(400).json({ error: "token 不能为空" });
      return;
    }

    const success = await authService.verifyEmail(token);
    if (!success) {
      res.status(400).json({ error: "验证链接无效或已过期" });
      return;
    }

    res.json({ message: "邮箱验证成功" });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

export default router;
