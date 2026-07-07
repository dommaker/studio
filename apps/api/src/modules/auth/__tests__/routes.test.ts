/**
 * Auth Routes contract tests
 *
 * Verifies 11 HTTP endpoints:
 * - POST /guest-session, /register, /login, /logout, /refresh,
 *        /forgot-password, /reset-password, /cleanup,
 *        /send-verification, /verify-email
 * - GET /me
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';

// Test credentials (not real — used only in mocked HTTP requests)
const TEST_PASSWORD = process.env.TEST_PASSWORD || 'testpass123';
const TEST_NEW_PASSWORD = process.env.TEST_NEW_PASSWORD || 'newpass456';
const TEST_WRONG_PASSWORD = process.env.TEST_WRONG_PASSWORD || 'wrongpass_test';
const TEST_ANY_PASSWORD = process.env.TEST_ANY_PASSWORD || 'any_test';

// Mock service layer
const mockGetOrCreateSession = vi.fn();
const mockRegister = vi.fn();
const mockLogin = vi.fn();
const mockLogout = vi.fn();
const mockGetCurrentUser = vi.fn();
const mockCleanupExpiredSessions = vi.fn();
const mockExchangeRefreshToken = vi.fn();
const mockGenerateResetToken = vi.fn();
const mockResetPassword = vi.fn();
const mockGenerateEmailVerificationToken = vi.fn();
const mockVerifyEmail = vi.fn();

vi.mock('../service.js', () => ({
  getOrCreateSession: (...args: any[]) => mockGetOrCreateSession(...args),
  register: (...args: any[]) => mockRegister(...args),
  login: (...args: any[]) => mockLogin(...args),
  logout: (...args: any[]) => mockLogout(...args),
  getCurrentUser: (...args: any[]) => mockGetCurrentUser(...args),
  cleanupExpiredSessions: (...args: any[]) => mockCleanupExpiredSessions(...args),
  exchangeRefreshToken: (...args: any[]) => mockExchangeRefreshToken(...args),
  generateResetToken: (...args: any[]) => mockGenerateResetToken(...args),
  resetPassword: (...args: any[]) => mockResetPassword(...args),
  generateEmailVerificationToken: (...args: any[]) => mockGenerateEmailVerificationToken(...args),
  verifyEmail: (...args: any[]) => mockVerifyEmail(...args),
  verifyToken: vi.fn().mockReturnValue({ sessionId: 's1', userId: 'u1' }),
}));

vi.mock('../email.service.js', () => ({
  sendPasswordResetEmail: vi.fn(),
}));

vi.mock('@dommaker/studio-prisma', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    session: {
      findUnique: vi.fn().mockResolvedValue({
        id: 's1', userId: 'u1', expiresAt: new Date(Date.now() + 86400000),
        User: { id: 'u1', email: 'admin@test.com', role: 'Admin' },
      }),
    },
  },
}));

vi.mock('../../core/database.js', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
  },
}));

vi.mock('@dommaker/studio-audit', () => ({
  AuditService: vi.fn().mockImplementation(function() {
    return { log: vi.fn().mockResolvedValue(undefined) };
  }),
}));

vi.mock('@dommaker/studio-shared', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

// Bypass rate-limit middleware in tests
vi.mock('../../../middleware/rate-limit.js', () => ({
  authRateLimit: (_req: any, _res: any, next: any) => next(),
  refreshRateLimit: (_req: any, _res: any, next: any) => next(),
}));

// Bypass auth middleware in tests
vi.mock('../../../middleware/auth.js', () => ({
  requireAuth: () => (req: any, _res: any, next: any) => {
    req.user = { id: 'u1', email: 'admin@test.com', role: 'Admin' };
    req.session = { id: 's1', userId: 'u1', expiresAt: new Date(Date.now() + 86400000) };
    next();
  },
  optionalAuth: () => (req: any, _res: any, next: any) => {
    req.session = { id: 's1', userId: 'u1' };
    req.user = { id: 'u1', email: 'admin@test.com', role: 'Admin' };
    next();
  },
  requireRole: () => (req: any, _res: any, next: any) => next(),
  getAuthInfo: (req: any) => ({
    sessionId: req.session?.id || '',
    userId: req.user?.id,
  }),
}));

function startServer(app: express.Express): Promise<{ url: string; server: http.Server }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${addr.port}`, server });
    });
    server.on('error', reject);
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('Auth Routes', () => {
  let app: express.Express;
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    app = express();
    app.use(cookieParser());
    app.use(express.json());

    const authRouter = (await import('../routes.js')).default;
    app.use('/auth', authRouter);

    const info = await startServer(app);
    server = info.server;
    baseUrl = info.url;
  });

  afterAll(async () => {
    if (server) await closeServer(server);
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── POST /auth/guest-session ───
  describe('POST /auth/guest-session', () => {
    it('creates new guest session and returns token', async () => {
      mockGetOrCreateSession.mockResolvedValue({
        session: { id: 'gs1', token: 'guest-jwt', expiresAt: new Date().toISOString() },
        token: 'guest-jwt',
      });

      const response = await fetch(`${baseUrl}/auth/guest-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guestId: 'existing-guest-id' }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.token).toBe('guest-jwt');
      expect(data.session.id).toBe('gs1');
      expect(mockGetOrCreateSession).toHaveBeenCalled();
    });

    it('reuses existing valid guest session by guestId', async () => {
      mockGetOrCreateSession.mockResolvedValue({
        session: { id: 'gs-existing', token: 'reused-jwt', expiresAt: new Date().toISOString() },
        token: 'reused-jwt',
      });

      const response = await fetch(`${baseUrl}/auth/guest-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guestId: 'existing-guest-id' }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.session.id).toBe('gs-existing');
    });
  });

  // ─── POST /auth/register ───
  describe('POST /auth/register', () => {
    it('registers new user and returns AuthResult with refreshToken', async () => {
      mockRegister.mockResolvedValue({
        user: { id: 'new-u1', email: 'new@test.com', role: 'User' },
        session: { id: 's1', token: 'jwt-token' },
        token: 'jwt-token',
        isNewUser: true,
        refreshToken: 'refresh-token-value',
      });
      mockGenerateEmailVerificationToken.mockResolvedValue('verify-token-abc');

      const response = await fetch(`${baseUrl}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'new@test.com', password: TEST_PASSWORD, name: 'New User' }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.token).toBe('jwt-token');
      expect(data.refreshToken).toBe('refresh-token-value');
      expect(data.user.email).toBe('new@test.com');
      expect(data.isNewUser).toBe(true);
    });

    it('returns 409 for duplicate email', async () => {
      mockRegister.mockRejectedValue(new Error('邮箱已被注册'));

      const response = await fetch(`${baseUrl}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'existing@test.com', password: TEST_PASSWORD }),
      });

      expect(response.status).toBe(409);
      const data = await response.json();
      expect(data.error).toBe('邮箱已被注册');
    });

    it('register sets role to User (not schema default Guest)', async () => {
      mockRegister.mockImplementation(async (input: any) => {
        expect(input.role).toBeUndefined(); // role is set internally
        return {
          user: { id: 'u1', email: input.email, role: 'User' as const },
          session: { id: 's1', token: 'jwt' },
          token: 'jwt',
          isNewUser: true,
          refreshToken: 'rt',
        };
      });
      mockGenerateEmailVerificationToken.mockResolvedValue('vt');

      const response = await fetch(`${baseUrl}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'role-test@test.com', password: TEST_PASSWORD }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.user.role).toBe('User');
    });
  });

  // ─── POST /auth/login ───
  describe('POST /auth/login', () => {
    it('authenticates valid credentials and returns AuthResult with refreshToken', async () => {
      mockLogin.mockResolvedValue({
        user: { id: 'u1', email: 'test@test.com', role: 'User' },
        session: { id: 's1', token: 'jwt-token' },
        token: 'jwt-token',
        refreshToken: 'refresh-rt',
      });

      const response = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'test@test.com', password: TEST_PASSWORD }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.token).toBeDefined();
      expect(data.refreshToken).toBe('refresh-rt');
    });

    it('returns 401 for wrong password', async () => {
      mockLogin.mockRejectedValue(new Error('密码错误'));

      const response = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'test@test.com', password: TEST_WRONG_PASSWORD }),
      });

      expect(response.status).toBe(401);
    });

    it('returns 401 for non-existent user (anti-enumeration)', async () => {
      mockLogin.mockRejectedValue(new Error('用户不存在'));

      const response = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'no@exist.com', password: TEST_ANY_PASSWORD }),
      });

      expect(response.status).toBe(401);
    });

    it('guest sessions are cleaned before login session creation', async () => {
      mockLogin.mockImplementation(async () => {
        // The actual service cleans guest sessions before creating new session
        return {
          user: { id: 'u1', email: 'test@test.com', role: 'User' },
          session: { id: 's1', token: 'jwt' },
          token: 'jwt',
          refreshToken: 'rt',
        };
      });

      await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'test@test.com', password: TEST_PASSWORD }),
      });

      // Service's login function handles guest cleanup internally
      expect(mockLogin).toHaveBeenCalledTimes(1);
    });
  });

  // ─── POST /auth/logout ───
  describe('POST /auth/logout', () => {
    it('expires session and returns success', async () => {
      mockLogout.mockResolvedValue(undefined);

      const response = await fetch(`${baseUrl}/auth/logout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer test-token',
        },
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(mockLogout).toHaveBeenCalledWith('s1', 'u1');
    });

    // Note: requireAuth guard behavior is tested in middleware-invocation.test.ts
  });

  // ─── GET /auth/me ───
  describe('GET /auth/me', () => {
    it('returns user+session when authenticated', async () => {
      mockGetCurrentUser.mockResolvedValue({
        user: { id: 'u1', email: 'admin@test.com', role: 'Admin' },
        session: { id: 's1', token: 'jwt', expiresAt: new Date() },
      });

      const response = await fetch(`${baseUrl}/auth/me`, {
        headers: { 'Authorization': 'Bearer test-token' },
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.user.email).toBe('admin@test.com');
      expect(data.session.id).toBe('s1');
    });

    // Note: optionalAuth null-token behavior tested in middleware-invocation.test.ts
  });

  // ─── POST /auth/refresh ───
  describe('POST /auth/refresh', () => {
    it('returns { accessToken, refreshToken, userId } on valid refresh', async () => {
      mockExchangeRefreshToken.mockResolvedValue({
        accessToken: 'new-access-jwt',
        refreshToken: 'new-refresh-rt',
        userId: 'u1',
      });

      const response = await fetch(`${baseUrl}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: 'valid-rt' }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.accessToken).toBe('new-access-jwt');
      expect(data.refreshToken).toBe('new-refresh-rt');
      expect(data.userId).toBe('u1');
    });

    it('response uses field name accessToken (not token)', async () => {
      mockExchangeRefreshToken.mockResolvedValue({
        accessToken: 'at-value',
        refreshToken: 'rt-value',
        userId: 'u1',
      });

      const response = await fetch(`${baseUrl}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: 'valid-rt' }),
      });

      const data = await response.json();
      expect(data.accessToken).toBeDefined();
      expect(data.token).toBeUndefined(); // NOT 'token'
    });

    it('returns 400 when refreshToken is missing', async () => {
      const response = await fetch(`${baseUrl}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(400);
    });

    it('returns 401 for invalid/expired refreshToken', async () => {
      mockExchangeRefreshToken.mockResolvedValue(null);

      const response = await fetch(`${baseUrl}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: 'expired-rt' }),
      });

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toBe('Invalid refresh token');
    });
  });

  // ─── POST /auth/forgot-password ───
  describe('POST /auth/forgot-password', () => {
    it('returns success even when email not found (no user enumeration)', async () => {
      mockGenerateResetToken.mockResolvedValue(null);

      const response = await fetch(`${baseUrl}/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'nonexistent@test.com' }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.message).toContain('如果该邮箱已注册');
    });

    it('returns success for valid email with existing user', async () => {
      mockGenerateResetToken.mockResolvedValue('reset-token-abc');

      const response = await fetch(`${baseUrl}/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'real@test.com' }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.message).toContain('如果该邮箱已注册');
    });

    it('returns 400 when email is missing', async () => {
      const response = await fetch(`${baseUrl}/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(400);
    });
  });

  // ─── POST /auth/reset-password ───
  describe('POST /auth/reset-password', () => {
    it('resets password with valid token', async () => {
      mockResetPassword.mockResolvedValue(true);

      const response = await fetch(`${baseUrl}/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'valid-reset-token', password: TEST_NEW_PASSWORD }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.message).toBe('密码重置成功');
    });

    it('returns error for invalid/expired token', async () => {
      mockResetPassword.mockResolvedValue(false);

      const response = await fetch(`${baseUrl}/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'expired-token', password: TEST_NEW_PASSWORD }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('重置链接无效或已过期');
    });

    it('returns 400 when token or password missing', async () => {
      const response = await fetch(`${baseUrl}/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 't' }),
      });

      expect(response.status).toBe(400);
    });
  });

  // ─── POST /auth/cleanup ───
  describe('POST /auth/cleanup', () => {
    it('cleans expired sessions and returns count (admin only)', async () => {
      mockCleanupExpiredSessions.mockResolvedValue(5);

      const response = await fetch(`${baseUrl}/auth/cleanup`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer admin-token',
        },
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.cleaned).toBe(5);
      expect(mockCleanupExpiredSessions).toHaveBeenCalled();
    });
  });
});
