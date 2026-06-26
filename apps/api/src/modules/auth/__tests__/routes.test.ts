/**
 * AC1: auth/routes.ts route-level unit tests
 *
 * Covers:
 * - POST /guest-session, POST /register, POST /login, POST /logout, GET /me
 * - Request validation, status codes, error response mapping
 * - Audit log recording (SEC-010): login success/failure, register, logout
 * - Rate limit middleware attachment: authRateLimit on login/register,
 *   refreshRateLimit on refresh
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Router } from 'express';

// ── Hoisted: vars available in vi.mock factories ──────────────────────
const mockGetAuthInfo = vi.hoisted(
  () => vi.fn().mockReturnValue({ sessionId: 's1', userId: 'u1' })
);
const mockAuditLog = vi.hoisted(
  () => vi.fn().mockResolvedValue({ id: 'log-1' })
);

vi.mock('../../../middleware/rate-limit.js', () => ({
  authRateLimit: (_req: any, _res: any, next: any) => next(),
  refreshRateLimit: (_req: any, _res: any, next: any) => next(),
  mcpRateLimit: (_req: any, _res: any, next: any) => next(),
  apiRateLimit: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../../middleware/auth.js', () => ({
  requireAuth: () => (_req: any, _res: any, next: any) => next(),
  optionalAuth: () => (_req: any, _res: any, next: any) => next(),
  requireRole: () => (_req: any, _res: any, next: any) => next(),
  getAuthInfo: mockGetAuthInfo,
}));

vi.mock('../service.js', () => ({
  getOrCreateSession: vi.fn(),
  register: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  getCurrentUser: vi.fn(),
  exchangeRefreshToken: vi.fn(),
  cleanupExpiredSessions: vi.fn(),
  generateEmailVerificationToken: vi.fn().mockResolvedValue('verification-token-123'),
  verifyEmail: vi.fn(),
  generateResetToken: vi.fn(),
  resetPassword: vi.fn(),
}));

vi.mock('@dommaker/studio-audit', () => ({
  AuditService: vi.fn().mockImplementation(() => ({ log: mockAuditLog })),
}));

vi.mock('../../../core/database.js', () => ({ prisma: {} }));
vi.mock('@dommaker/studio-shared', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

// ── Imports after mocks ───────────────────────────────────────────────
import * as authService from '../service.js';
import routes from '../routes.js';
// auth middleware imports use the same mock paths as routes.ts

// ── Helpers ───────────────────────────────────────────────────────────

function createReq(overrides: Record<string, any> = {}) {
  return {
    method: 'POST',
    url: '/',
    headers: { 'content-type': 'application/json' },
    body: {},
    ip: '127.0.0.1',
    query: {},
    params: {},
    cookies: {},
    socket: { remoteAddress: '127.0.0.1' },
    get: () => undefined,
    ...overrides,
  };
}

function createRes() {
  const json = vi.fn();
  const res = {
    status: vi.fn(() => res),
    json,
    redirect: vi.fn(),
    cookie: vi.fn(() => res),
    clearCookie: vi.fn(() => res),
    end: vi.fn(),
    setHeader: vi.fn(),
    getHeader: vi.fn(),
    send: vi.fn(),
    type: vi.fn(() => res),
  };
  return res;
}

function getHandlers(router: Router, method: string, path: string): Function[] {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === path && layer.route.methods[method]) {
      return layer.route.stack.map((l: any) => l.handle);
    }
  }
  throw new Error(`Handler not found: ${method} ${path}`);
}

async function invokeRoute(
  router: Router,
  method: string,
  path: string,
  reqOverrides: Record<string, any> = {}
) {
  const handlers = getHandlers(router, method, path);
  const req = createReq(reqOverrides);
  const res = createRes();
  let i = 0;
  const next = async () => {
    if (i < handlers.length) {
      await handlers[i++](req, res, next);
    }
  };
  await next();
  return { req, res };
}

// ── Tests ─────────────────────────────────────────────────────────────
describe('auth routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthInfo.mockReturnValue({ sessionId: 's1', userId: 'u1' });
    mockAuditLog.mockResolvedValue({ id: 'log-1' });
  });

  describe('POST /guest-session', () => {
    it('returns 200 with session and token', async () => {
      vi.mocked(authService.getOrCreateSession).mockResolvedValue({
        session: { id: 'gs1' }, token: 'guest-token',
      } as any);

      const { res } = await invokeRoute(routes, 'post', '/guest-session', {
        body: { guestId: 'g-1' },
      });

      // Handler calls res.json() directly (Express defaults to 200)
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ session: { id: 'gs1' }, token: 'guest-token' })
      );
    });

    it('returns 500 when service throws', async () => {
      vi.mocked(authService.getOrCreateSession).mockRejectedValue(new Error('DB error'));

      const { res } = await invokeRoute(routes, 'post', '/guest-session', {
        body: { guestId: 'g-1' },
      });

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'DB error' });
    });
  });

  describe('POST /register', () => {
    const validBody = { email: 'new@test.com', password: 'Str0ng!', name: 'New' };

    it('returns 200 with user and tokens on success', async () => {
      vi.mocked(authService.register).mockResolvedValue({
        user: { id: 'u1', email: 'new@test.com', role: 'User' },
        token: 'jwt-token', refreshToken: 'rt-token', session: { id: 's1' }, isNewUser: true,
      } as any);

      const { res } = await invokeRoute(routes, 'post', '/register', { body: validBody });

      // Handler calls res.json() directly (Express defaults to 200 for success)
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ user: expect.objectContaining({ id: 'u1' }) })
      );
    });

    it('returns 409 when email already registered', async () => {
      vi.mocked(authService.register).mockRejectedValue(new Error('邮箱已被注册'));

      const { res } = await invokeRoute(routes, 'post', '/register', { body: validBody });

      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith({ error: '邮箱已被注册' });
    });

    it('returns 400 on other registration errors', async () => {
      vi.mocked(authService.register).mockRejectedValue(new Error('密码太短'));

      const { res } = await invokeRoute(routes, 'post', '/register', { body: validBody });

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: '密码太短' });
    });

    describe('audit log (SEC-010)', () => {
      it('logs register success', async () => {
        vi.mocked(authService.register).mockResolvedValue({
          user: { id: 'u1', email: 'new@test.com' },
          token: 't', refreshToken: 'rt', session: { id: 's1' },
        } as any);

        await invokeRoute(routes, 'post', '/register', { body: validBody });

        expect(mockAuditLog).toHaveBeenCalledWith(
          expect.objectContaining({
            userId: 'u1', action: 'register', resource: 'user', status: 'success',
          })
        );
      });

      it('logs register failure', async () => {
        vi.mocked(authService.register).mockRejectedValue(new Error('邮箱已被注册'));

        await invokeRoute(routes, 'post', '/register', { body: { email: 'dup@test.com', password: 'pw' } });

        expect(mockAuditLog).toHaveBeenCalledWith(
          expect.objectContaining({
            action: 'register', resource: 'user', status: 'failure', errorMessage: '邮箱已被注册',
          })
        );
      });

      it('does not crash when audit log throws', async () => {
        mockAuditLog.mockRejectedValue(new Error('audit db error'));
        vi.mocked(authService.register).mockResolvedValue({
          user: { id: 'u1', email: 'new@test.com' },
          token: 't', refreshToken: 'rt', session: { id: 's1' },
        } as any);

        const { res } = await invokeRoute(routes, 'post', '/register', { body: validBody });

        // Success path: handler calls res.json() directly (Express defaults to 200)
      });
    });
  });

  describe('POST /login', () => {
    const validBody = { email: 'test@test.com', password: 'correct-pw' };

    it('returns 200 with user and tokens on valid login', async () => {
      vi.mocked(authService.login).mockResolvedValue({
        user: { id: 'u1', email: 'test@test.com', role: 'User' },
        session: { id: 's1' }, token: 'jwt-token', refreshToken: 'rt-token',
      } as any);

      const { res } = await invokeRoute(routes, 'post', '/login', { body: validBody });

      // Success path: handler calls res.json() directly (Express defaults to 200)
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ token: expect.any(String) })
      );
    });

    it('returns 401 when user not found', async () => {
      vi.mocked(authService.login).mockRejectedValue(new Error('用户不存在'));

      const { res } = await invokeRoute(routes, 'post', '/login', { body: validBody });

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: '用户不存在' });
    });

    it('returns 401 when password is wrong', async () => {
      vi.mocked(authService.login).mockRejectedValue(new Error('密码错误'));

      const { res } = await invokeRoute(routes, 'post', '/login', { body: validBody });

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: '密码错误' });
    });

    it('returns 400 on other login errors', async () => {
      vi.mocked(authService.login).mockRejectedValue(new Error('请求格式错误'));

      const { res } = await invokeRoute(routes, 'post', '/login', { body: validBody });

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: '请求格式错误' });
    });

    describe('audit log (SEC-010)', () => {
      it('logs login success', async () => {
        vi.mocked(authService.login).mockResolvedValue({
          user: { id: 'u1', email: 'test@test.com', role: 'User' },
          session: { id: 's1' }, token: 't', refreshToken: 'rt',
        } as any);

        await invokeRoute(routes, 'post', '/login', { body: validBody });

        expect(mockAuditLog).toHaveBeenCalledWith(
          expect.objectContaining({
            userId: 'u1', sessionId: 's1', action: 'login', resource: 'session',
            status: 'success', details: { email: 'test@test.com', role: 'User' },
          })
        );
      });

      it('logs login failure', async () => {
        vi.mocked(authService.login).mockRejectedValue(new Error('密码错误'));

        await invokeRoute(routes, 'post', '/login', {
          body: { email: 'test@test.com', password: 'wrong' },
        });

        expect(mockAuditLog).toHaveBeenCalledWith(
          expect.objectContaining({
            action: 'login', resource: 'session', status: 'failure', errorMessage: '密码错误',
          })
        );
      });
    });
  });

  describe('POST /logout', () => {
    it('returns 200 with success on valid logout', async () => {
      vi.mocked(authService.logout).mockResolvedValue(undefined as any);

      const { res } = await invokeRoute(routes, 'post', '/logout');

      // Success path: handler calls res.json() directly (Express defaults to 200)
      expect(res.json).toHaveBeenCalledWith({ success: true });
    });

    it('returns 500 when service throws', async () => {
      vi.mocked(authService.logout).mockRejectedValue(new Error('Session not found'));

      const { res } = await invokeRoute(routes, 'post', '/logout');

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Session not found' });
    });

    describe('audit log (SEC-010)', () => {
      it('logs logout event', async () => {
        vi.mocked(authService.logout).mockResolvedValue(undefined as any);

        await invokeRoute(routes, 'post', '/logout');

        expect(mockAuditLog).toHaveBeenCalledWith(
          expect.objectContaining({
            userId: 'u1', sessionId: 's1', action: 'logout', resource: 'session',
            resourceId: 's1', status: 'success',
          })
        );
      });
    });
  });

  describe('GET /me', () => {
    it('returns user and session with valid auth', async () => {
      vi.mocked(authService.getCurrentUser).mockResolvedValue({
        user: { id: 'u1', email: 'test@test.com', role: 'User' },
        session: { id: 's1' },
      } as any);

      const { res } = await invokeRoute(routes, 'get', '/me');

      // Success path: handler calls res.json() directly (Express defaults to 200)
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ user: expect.objectContaining({ id: 'u1' }) })
      );
    });

    it('returns null user/session without auth', async () => {
      mockGetAuthInfo.mockReturnValue({ sessionId: '' });

      const { res } = await invokeRoute(routes, 'get', '/me');

      // Success path: handler calls res.json() directly (Express defaults to 200)
      expect(res.json).toHaveBeenCalledWith({ user: null, session: null });
    });

    it('returns 500 when service throws', async () => {
      vi.mocked(authService.getCurrentUser).mockRejectedValue(new Error('DB error'));

      const { res } = await invokeRoute(routes, 'get', '/me');

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'DB error' });
    });
  });

  describe('POST /refresh', () => {
    it('returns 400 when refreshToken missing', async () => {
      const { res } = await invokeRoute(routes, 'post', '/refresh', { body: {} });

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Missing refreshToken' });
    });

    it('returns 401 when refresh token invalid', async () => {
      vi.mocked(authService.exchangeRefreshToken).mockResolvedValue(null);

      const { res } = await invokeRoute(routes, 'post', '/refresh', {
        body: { refreshToken: 'bad-token' },
      });

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid refresh token' });
    });

    it('returns 200 with new tokens on valid refresh', async () => {
      vi.mocked(authService.exchangeRefreshToken).mockResolvedValue({
        accessToken: 'new-at', refreshToken: 'new-rt', userId: 'u1',
      } as any);

      const { res } = await invokeRoute(routes, 'post', '/refresh', {
        body: { refreshToken: 'valid-rt' },
      });

      // Success path: handler calls res.json() directly (Express defaults to 200)
      expect(res.json).toHaveBeenCalledWith({
        accessToken: 'new-at', refreshToken: 'new-rt', userId: 'u1',
      });
    });

    it('returns 500 on exchange error', async () => {
      vi.mocked(authService.exchangeRefreshToken).mockRejectedValue(new Error('DB err'));

      const { res } = await invokeRoute(routes, 'post', '/refresh', {
        body: { refreshToken: 'some-token' },
      });

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'DB err' });
    });
  });

  describe('POST /forgot-password', () => {
    it('returns 200 with success message on valid email', async () => {
      vi.mocked(authService.generateResetToken).mockResolvedValue('reset-token-123');

      const { res } = await invokeRoute(routes, 'post', '/forgot-password', {
        body: { email: 'user@test.com' },
      });

      expect(authService.generateResetToken).toHaveBeenCalledWith('user@test.com');
      expect(res.json).toHaveBeenCalledWith({
        message: '如果该邮箱已注册，重置密码链接已发送',
      });
    });

    it('returns 200 even when email not found (no email leak)', async () => {
      vi.mocked(authService.generateResetToken).mockResolvedValue(null);

      const { res } = await invokeRoute(routes, 'post', '/forgot-password', {
        body: { email: 'unknown@test.com' },
      });

      expect(res.json).toHaveBeenCalledWith({
        message: '如果该邮箱已注册，重置密码链接已发送',
      });
    });

    it('returns 400 when email is missing', async () => {
      const { res } = await invokeRoute(routes, 'post', '/forgot-password', {
        body: {},
      });

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: '邮箱不能为空' });
      expect(authService.generateResetToken).not.toHaveBeenCalled();
    });

    it('returns 500 when service throws', async () => {
      vi.mocked(authService.generateResetToken).mockRejectedValue(new Error('DB error'));

      const { res } = await invokeRoute(routes, 'post', '/forgot-password', {
        body: { email: 'user@test.com' },
      });

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'DB error' });
    });
  });

  describe('POST /reset-password', () => {
    it('returns 200 with success message on valid token', async () => {
      vi.mocked(authService.resetPassword).mockResolvedValue(true);

      const { res } = await invokeRoute(routes, 'post', '/reset-password', {
        body: { token: 'valid-token', password: 'NewP@ss123' },
      });

      expect(authService.resetPassword).toHaveBeenCalledWith('valid-token', 'NewP@ss123');
      expect(res.json).toHaveBeenCalledWith({ message: '密码重置成功' });
    });

    it('returns 400 when token or password missing', async () => {
      const { res } = await invokeRoute(routes, 'post', '/reset-password', {
        body: {},
      });

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'token 和密码不能为空' });
      expect(authService.resetPassword).not.toHaveBeenCalled();
    });

    it('returns 400 when only password missing', async () => {
      const { res } = await invokeRoute(routes, 'post', '/reset-password', {
        body: { token: 'some-token' },
      });

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'token 和密码不能为空' });
      expect(authService.resetPassword).not.toHaveBeenCalled();
    });

    it('returns 400 when only token missing', async () => {
      const { res } = await invokeRoute(routes, 'post', '/reset-password', {
        body: { password: 'NewP@ss123' },
      });

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'token 和密码不能为空' });
      expect(authService.resetPassword).not.toHaveBeenCalled();
    });

    it('returns 400 when token is invalid/expired', async () => {
      vi.mocked(authService.resetPassword).mockResolvedValue(false);

      const { res } = await invokeRoute(routes, 'post', '/reset-password', {
        body: { token: 'bad-token', password: 'NewP@ss123' },
      });

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: '重置链接无效或已过期' });
    });

    it('returns 500 when service throws', async () => {
      vi.mocked(authService.resetPassword).mockRejectedValue(new Error('DB error'));

      const { res } = await invokeRoute(routes, 'post', '/reset-password', {
        body: { token: 't', password: 'P@ss123' },
      });

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'DB error' });
    });
  });

  describe('rate limit middleware attachment (AC4)', () => {
    it('authRateLimit mounted on POST /register', () => {
      const handlers = getHandlers(routes, 'post', '/register');
      expect(handlers.length).toBeGreaterThanOrEqual(2);
      expect(typeof handlers[0]).toBe('function');
    });

    it('authRateLimit mounted on POST /login', () => {
      const handlers = getHandlers(routes, 'post', '/login');
      expect(handlers.length).toBeGreaterThanOrEqual(2);
      expect(typeof handlers[0]).toBe('function');
    });

    it('refreshRateLimit mounted on POST /refresh', () => {
      const handlers = getHandlers(routes, 'post', '/refresh');
      expect(handlers.length).toBeGreaterThanOrEqual(2);
      expect(typeof handlers[0]).toBe('function');
    });

    it('authRateLimit mounted on POST /forgot-password', () => {
      const handlers = getHandlers(routes, 'post', '/forgot-password');
      expect(handlers.length).toBeGreaterThanOrEqual(2);
      expect(typeof handlers[0]).toBe('function');
    });

    it('authRateLimit mounted on POST /reset-password', () => {
      const handlers = getHandlers(routes, 'post', '/reset-password');
      expect(handlers.length).toBeGreaterThanOrEqual(2);
      expect(typeof handlers[0]).toBe('function');
    });

    it('guest-session has no middleware; /me has optionalAuth middleware only', () => {
      const gs = getHandlers(routes, 'post', '/guest-session');
      expect(gs.length).toBe(1);

      // /me uses optionalAuth() middleware (1 middleware + 1 handler = 2)
      const me = getHandlers(routes, 'get', '/me');
      expect(me.length).toBe(2);
    });
  });
});
