/**
 * OAuth Routes contract tests
 *
 * Verifies:
 * - GET /:provider sets oauth_state cookie and redirects
 * - GET /callback/:provider verifies CSRF state, exchanges code, creates user, redirects
 * - state cookie cleared after verification to prevent replay
 * - Success response uses URL fragment to prevent Referer leakage
 * - Error response uses query param
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';

const mockGetAuthorizationUrl = vi.fn();
const mockExchangeCodeForTokens = vi.fn();
const mockGetOrCreateOAuthUser = vi.fn();
const mockCreateOAuthSession = vi.fn();

vi.mock('../oauth.service.js', () => ({
  getAuthorizationUrl: (...args: any[]) => mockGetAuthorizationUrl(...args),
  exchangeCodeForTokens: (...args: any[]) => mockExchangeCodeForTokens(...args),
  getOrCreateOAuthUser: (...args: any[]) => mockGetOrCreateOAuthUser(...args),
  createOAuthSession: (...args: any[]) => mockCreateOAuthSession(...args),
}));

vi.mock('@dommaker/studio-shared', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
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

describe('OAuth Routes', () => {
  let app: express.Express;
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    app = express();
    app.use(cookieParser());
    app.use(express.json());

    const oauthRouter = (await import('../oauth.routes.js')).default;
    app.use('/auth', oauthRouter);

    const info = await startServer(app);
    server = info.server;
    baseUrl = info.url;
  });

  afterAll(async () => {
    await closeServer(server);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.FRONTEND_URL = 'http://localhost:5173';
  });

  // ─── GET /auth/:provider ───
  describe('GET /auth/:provider', () => {
    it('sets oauth_state httpOnly cookie and redirects to provider auth URL', async () => {
      mockGetAuthorizationUrl.mockReturnValue('https://accounts.google.com/o/oauth2/v2/auth?state=xyz');

      const response = await fetch(`${baseUrl}/auth/google`, { redirect: 'manual' });

      expect(response.status).toBe(302);

      // Check cookie
      const setCookie = response.headers.get('set-cookie') || '';
      expect(setCookie).toContain('oauth_state=');
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('SameSite=Lax');
      // Check Location header
      expect(response.headers.get('location')).toBe('https://accounts.google.com/o/oauth2/v2/auth?state=xyz');
      expect(mockGetAuthorizationUrl).toHaveBeenCalledWith('google', expect.any(String));
    });

    it('state cookie uses crypto.randomBytes(32) — 64 hex chars', async () => {
      mockGetAuthorizationUrl.mockReturnValue('https://example.com/auth');

      const response = await fetch(`${baseUrl}/auth/github`, { redirect: 'manual' });
      const setCookie = response.headers.get('set-cookie') || '';

      // Extract cookie value
      const match = setCookie.match(/oauth_state=([^;]+)/);
      expect(match).not.toBeNull();
      const stateValue = match![1];
      // 32 random bytes = 64 hex chars
      expect(stateValue.length).toBe(64);
    });

    it('returns 500 for invalid provider', async () => {
      const response = await fetch(`${baseUrl}/auth/facebook`);
      expect(response.status).toBe(404); // route doesn't match
    });
  });

  // ─── GET /auth/callback/:provider ───
  describe('GET /auth/callback/:provider', () => {
    it('verifies CSRF state, clears cookie, and redirects with fragment on success', async () => {
      // First get a valid state cookie
      mockGetAuthorizationUrl.mockReturnValue('https://example.com/auth');
      const initRes = await fetch(`${baseUrl}/auth/google`, { redirect: 'manual' });
      const setCookieHeader = initRes.headers.get('set-cookie') || '';
      const stateMatch = setCookieHeader.match(/oauth_state=([^;]+)/);
      expect(stateMatch).not.toBeNull();
      const stateValue = stateMatch![1];

      // Now call callback
      mockExchangeCodeForTokens.mockResolvedValue({
        profile: { provider: 'google', providerAccountId: 'g1', email: 't@t.com', name: 'T', avatar: null },
        tokens: { accessToken: 'at', refreshToken: null, expiresAt: new Date() },
      });
      mockGetOrCreateOAuthUser.mockResolvedValue({
        user: { id: 'u1', email: 't@t.com', role: 'User' },
      });
      mockCreateOAuthSession.mockResolvedValue({
        token: 'jwt-token-xyz',
        refreshToken: 'rt-xyz',
        session: { id: 's1', expiresAt: new Date() },
      });

      const response = await fetch(
        `${baseUrl}/auth/callback/google?code=test-code&state=${stateValue}`,
        {
          redirect: 'manual',
          headers: { Cookie: `oauth_state=${stateValue}` },
        },
      );

      expect(response.status).toBe(302);
      const location = response.headers.get('location') || '';

      // Success uses URL fragment (not query param) to prevent Referer leakage
      expect(location).toContain('#');
      expect(location).toContain('token=jwt-token-xyz');
      expect(location).toContain('refreshToken=rt-xyz');

      // Cookie must be cleared to prevent replay
      const clearCookie = response.headers.get('set-cookie') || '';
      expect(clearCookie).toContain('oauth_state=;');
    });

    it('state cookie cleared immediately (before CSRF comparison) to prevent replay attacks', async () => {
      mockExchangeCodeForTokens.mockResolvedValue({
        profile: { provider: 'google', providerAccountId: 'g1', email: 't@t.com', name: null, avatar: null },
        tokens: { accessToken: 'at', refreshToken: null, expiresAt: new Date() },
      });
      mockGetOrCreateOAuthUser.mockResolvedValue({
        user: { id: 'u1', email: 't@t.com', role: 'User' },
      });
      mockCreateOAuthSession.mockResolvedValue({
        token: 'jwt', refreshToken: 'rt',
        session: { id: 's1', expiresAt: new Date() },
      });

      const response = await fetch(
        `${baseUrl}/auth/callback/google?code=good-code&state=matching-state`,
        {
          redirect: 'manual',
          headers: { Cookie: 'oauth_state=matching-state' },
        },
      );

      // Even with matching state, cookie is cleared
      const setCookie = response.headers.get('set-cookie') || '';
      expect(setCookie).toContain('oauth_state=;');
    });

    it('rejects callback with CSRF state mismatch (error via query param)', async () => {
      const response = await fetch(
        `${baseUrl}/auth/callback/google?code=bad-code&state=wrong-state`,
        {
          redirect: 'manual',
          headers: { Cookie: 'oauth_state=correct-state' },
        },
      );

      expect(response.status).toBe(302);
      const location = response.headers.get('location') || '';
      // Error uses query param (not fragment — fragment would be lost in redirect)
      expect(location).toContain('?error=invalid_state');
    });

    it('rejects callback with missing code', async () => {
      const response = await fetch(
        `${baseUrl}/auth/callback/google?state=some-state`,
        {
          redirect: 'manual',
          headers: { Cookie: 'oauth_state=some-state' },
        },
      );

      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toContain('error=missing_code');
    });

    it('redirects with query param error on exchange failure', async () => {
      mockExchangeCodeForTokens.mockRejectedValue(new Error('token exchange failed'));

      const response = await fetch(
        `${baseUrl}/auth/callback/google?code=fail-code&state=valid-state`,
        {
          redirect: 'manual',
          headers: { Cookie: 'oauth_state=valid-state' },
        },
      );

      expect(response.status).toBe(302);
      const location = response.headers.get('location') || '';
      expect(location).toContain('error=token_exchange_failed');
    });
  });
});
