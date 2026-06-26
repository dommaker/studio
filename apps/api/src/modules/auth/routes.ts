import { Router } from 'express';
import { requireAuth, getAuthInfo, optionalAuth, requireRole } from '../../middleware/auth.js';
import { authRateLimit, refreshRateLimit } from '../../middleware/rate-limit.js';
import * as authService from './service.js';
import { AuditService } from '@dommaker/studio-audit';  // 🆕 SEC-010
import { prisma } from '../../core/database.js';
import { logger } from '@dommaker/studio-shared';

const router = Router();
const auditService = new AuditService(prisma);  // 🆕 SEC-010

/**
 * POST /api/v1/auth/guest-session
 * 创建或获取 Guest Session
 */
router.post('/guest-session', async (req, res) => {
  try {
    const result = await authService.getOrCreateSession({
      guestId: req.body.guestId,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
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
router.post('/register', authRateLimit, async (req, res) => {
  try {
    const result = await authService.register(req.body);
    
    // SEC-010: 记录注册成功
    await auditService.log({
      userId: result.user.id,
      action: 'register',
      resource: 'user',
      resourceId: result.user.id,
      details: { email: result.user.email },
      status: 'success',
    }).catch(err => logger.error('Audit log error', { error: String(err) }));
    
    res.json(result);
  } catch (error) {
    const err = error as Error;
    
    // SEC-010: 记录注册失败
    await auditService.log({
      action: 'register',
      resource: 'user',
      details: { email: req.body.email },
      status: 'failure',
      errorMessage: err.message,
    }).catch(e => logger.error('Audit log error', { error: String(e) }));
    
    if (err.message === '邮箱已被注册') {
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
router.post('/login', authRateLimit, async (req, res) => {
  const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  const ua = req.headers['user-agent'] || 'unknown';
  
  try {
    const result = await authService.login(req.body);
    
    // SEC-010: 记录登录成功
    await auditService.log({
      userId: result.user.id,
      sessionId: result.session.id,
      ipAddress: String(ip),
      userAgent: ua,
      action: 'login',
      resource: 'session',
      resourceId: result.session.id,
      details: { email: result.user.email, role: result.user.role },
      status: 'success',
    }).catch(err => logger.error('Audit log error', { error: String(err) }));
    
    res.json(result);
  } catch (error) {
    const err = error as Error;
    
    // SEC-010: 记录登录失败
    await auditService.log({
      ipAddress: String(ip),
      userAgent: ua,
      action: 'login',
      resource: 'session',
      details: { email: req.body.email },
      status: 'failure',
      errorMessage: err.message,
    }).catch(e => logger.error('Audit log error', { error: String(e) }));
    
    if (err.message === '用户不存在' || err.message === '密码错误') {
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
router.post('/logout', requireAuth(), async (req, res) => {
  try {
    const authInfo = getAuthInfo(req);
    await authService.logout(authInfo.sessionId, authInfo.userId);
    
    // SEC-010: 记录登出
    await auditService.log({
      userId: authInfo.userId,
      sessionId: authInfo.sessionId,
      action: 'logout',
      resource: 'session',
      resourceId: authInfo.sessionId,
      status: 'success',
    }).catch(err => logger.error('Audit log error', { error: String(err) }));
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * GET /api/v1/auth/me
 * 获取当前用户信息
 */
router.get('/me', optionalAuth(), async (req, res) => {
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
router.post('/cleanup', requireAuth(), requireRole('Admin'), async (req, res) => {
  try {
    const count = await authService.cleanupExpiredSessions();
    res.json({ cleaned: count });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * POST /api/v1/auth/refresh
 * 刷新 Token（公开端点）
 */
router.post('/refresh', refreshRateLimit, async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      res.status(400).json({ error: 'Missing refreshToken' });
      return;
    }
    const result = await authService.exchangeRefreshToken(refreshToken);
    if (!result) {
      res.status(401).json({ error: 'Invalid refresh token' });
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
router.post('/forgot-password', authRateLimit, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      res.status(400).json({ error: '邮箱不能为空' });
      return;
    }

    const token = await authService.generateResetToken(email);
    if (token) {
      logger.info('Password reset token generated', { email });
      // TODO: 接入邮件服务发送重置链接
    }

    // 统一返回成功，不暴露邮箱是否存在
    res.json({ message: '如果该邮箱已注册，重置密码链接已发送' });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * POST /api/v1/auth/reset-password
 * 使用 token 重置密码（公开端点）
 */
router.post('/reset-password', authRateLimit, async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) {
      res.status(400).json({ error: 'token 和密码不能为空' });
      return;
    }

    const success = await authService.resetPassword(token, password);
    if (!success) {
      res.status(400).json({ error: '重置链接无效或已过期' });
      return;
    }

    res.json({ message: '密码重置成功' });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

export default router;
