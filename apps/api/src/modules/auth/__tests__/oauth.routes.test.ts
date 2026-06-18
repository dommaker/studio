/**
 * AC3: oauth/routes.ts route-level unit tests
 *
 * Covers:
 * - CSRF state cookie validation (valid / invalid / missing)
 * - Callback error redirect (with error query param)
 * - Success redirect (with URL fragment containing tokens)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Router } from 'express';

vi.mock('../oauth.service.js', () => ({
  getAuthorizationUrl: vi.fn(),
  exchangeCodeForTokens: vi.fn(),
  getOrCreateOAuthUser: vi.fn(),
  createOAuthSession: vi.fn(),
}));

vi.mock('@dommaker/studio-shared', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import * as oauthService from '../oauth.service.js';
import oauthRoutes from '../oauth.routes.js';

const FRONTEND_URL = 'http://localhost:5173';

// ── Helpers ───────────────────────────────────────────────────────────
function createReq(overrides: Record<string, any> = {}) {
  return {
    method: 'GET',
    url: '/',
    headers: {},
    body: undefined,
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
  const res = {
    status: vi.fn(() => res),
    json: vi.fn(),
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
describe('oauth routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /:provider (authorization redirect)', () => {
    it('sets oauth_state cookie and redirects for Google', async () => {
      vi.mocked(oauthService.getAuthorizationUrl).mockReturnValue(
        'https://accounts.google.com/o/oauth2/v2/auth?state=test-state'
      );

      const { res } = await invokeRoute(oauthRoutes, 'get', '/:provider(google|github)', {
        params: { provider: 'google' },
      });

      expect(res.cookie).toHaveBeenCalledWith(
        'oauth_state',
        expect.any(String),
        expect.objectContaining({ httpOnly: true, sameSite: 'lax' })
      );
      expect(res.redirect).toHaveBeenCalledWith(
        'https://accounts.google.com/o/oauth2/v2/auth?state=test-state'
      );
    });

    it('sets oauth_state cookie and redirects for GitHub', async () => {
      vi.mocked(oauthService.getAuthorizationUrl).mockReturnValue(
        'https://github.com/login/oauth/authorize?state=test-state'
      );

      const { res } = await invokeRoute(oauthRoutes, 'get', '/:provider(google|github)', {
        params: { provider: 'github' },
      });

      expect(res.cookie).toHaveBeenCalledWith(
        'oauth_state',
        expect.any(String),
        expect.objectContaining({ httpOnly: true, sameSite: 'lax' })
      );
      expect(res.redirect).toHaveBeenCalledWith(
        'https://github.com/login/oauth/authorize?state=test-state'
      );
    });

    it('returns 500 when getAuthorizationUrl throws', async () => {
      vi.mocked(oauthService.getAuthorizationUrl).mockImplementation(() => {
        throw new Error('Invalid provider');
      });

      const { res } = await invokeRoute(oauthRoutes, 'get', '/:provider(google|github)', {
        params: { provider: 'google' },
      });

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid provider' });
    });
  });

  describe('GET /callback/:provider — CSRF state validation', () => {
    const validQuery = { code: 'auth-code-123', state: 'valid-state' };
    const validCookies = { oauth_state: 'valid-state' };

    it('redirects with missing_code when code missing', async () => {
      const { res } = await invokeRoute(oauthRoutes, 'get', '/callback/:provider(google|github)', {
        params: { provider: 'google' },
        query: { state: 'some-state' },
        cookies: { oauth_state: 'some-state' },
      });

      expect(res.redirect).toHaveBeenCalledWith(
        `${FRONTEND_URL}/auth/callback?error=missing_code`
      );
    });

    it('redirects with invalid_state when state cookie is missing', async () => {
      const { res } = await invokeRoute(oauthRoutes, 'get', '/callback/:provider(google|github)', {
        params: { provider: 'google' },
        query: { code: 'auth-code', state: 'some-state' },
        cookies: {},
      });

      expect(res.redirect).toHaveBeenCalledWith(
        `${FRONTEND_URL}/auth/callback?error=invalid_state`
      );
    });

    it('redirects with invalid_state when state query param is missing', async () => {
      const { res } = await invokeRoute(oauthRoutes, 'get', '/callback/:provider(google|github)', {
        params: { provider: 'google' },
        query: { code: 'auth-code' },
        cookies: { oauth_state: 'some-state' },
      });

      expect(res.redirect).toHaveBeenCalledWith(
        `${FRONTEND_URL}/auth/callback?error=invalid_state`
      );
    });

    it('redirects with invalid_state when state mismatch', async () => {
      const { res } = await invokeRoute(oauthRoutes, 'get', '/callback/:provider(google|github)', {
        params: { provider: 'google' },
        query: { code: 'auth-code', state: 'wrong-state' },
        cookies: { oauth_state: 'expected-state' },
      });

      expect(res.redirect).toHaveBeenCalledWith(
        `${FRONTEND_URL}/auth/callback?error=invalid_state`
      );
    });

    it('clears oauth_state cookie immediately on callback', async () => {
      const { res } = await invokeRoute(oauthRoutes, 'get', '/callback/:provider(google|github)', {
        params: { provider: 'google' },
        query: { code: 'auth-code', state: 'some-state' },
        cookies: { oauth_state: 'some-state' },
      });

      expect(res.clearCookie).toHaveBeenCalledWith('oauth_state');
    });
  });

  describe('GET /callback/:provider — successful flow', () => {
    const validQuery = { code: 'valid-code', state: 'valid-state' };
    const validCookies = { oauth_state: 'valid-state' };

    it('redirects with token in URL fragment on success', async () => {
      vi.mocked(oauthService.exchangeCodeForTokens).mockResolvedValue({
        profile: { id: 'google-123', email: 'user@example.com' },
        tokens: { accessToken: 'at', refreshToken: 'rt', expiresAt: new Date() },
      } as any);
      vi.mocked(oauthService.getOrCreateOAuthUser).mockResolvedValue({
        user: { id: 'u1', email: 'user@example.com' },
      } as any);
      vi.mocked(oauthService.createOAuthSession).mockResolvedValue({
        token: 'jwt-token',
        refreshToken: 'new-rt',
        session: { id: 's1' },
      } as any);

      const { res } = await invokeRoute(oauthRoutes, 'get', '/callback/:provider(google|github)', {
        params: { provider: 'google' },
        query: validQuery,
        cookies: validCookies,
      });

      const redirectUrl = res.redirect.mock.calls[0][0];
      expect(redirectUrl).toContain(`${FRONTEND_URL}/auth/callback#`);
      expect(redirectUrl).toContain('token=jwt-token');
      expect(redirectUrl).toContain('refreshToken=new-rt');
      expect(redirectUrl).toContain('sessionId=s1');
      // Fragment (#) not query (?) for sensitive tokens
      expect(redirectUrl).not.toContain('?token=');
    });

    it('exchanges code and creates session', async () => {
      const exchangeMock = vi.mocked(oauthService.exchangeCodeForTokens).mockResolvedValue({
        profile: { id: 'google-123', email: 'user@example.com' },
        tokens: { accessToken: 'at', refreshToken: 'rt', expiresAt: new Date() },
      } as any);
      const getOrCreateMock = vi.mocked(oauthService.getOrCreateOAuthUser).mockResolvedValue({
        user: { id: 'u1', email: 'user@example.com' },
      } as any);
      const createSessionMock = vi.mocked(oauthService.createOAuthSession).mockResolvedValue({
        token: 'jwt-token', refreshToken: 'new-rt', session: { id: 's1' },
      } as any);

      await invokeRoute(oauthRoutes, 'get', '/callback/:provider(google|github)', {
        params: { provider: 'google' },
        query: validQuery,
        cookies: validCookies,
      });

      expect(exchangeMock).toHaveBeenCalledWith('google', 'valid-code');
      expect(getOrCreateMock).toHaveBeenCalled();
      expect(createSessionMock).toHaveBeenCalledWith('u1', expect.any(Object));
    });
  });

  describe('GET /callback/:provider — error handling', () => {
    it('redirects with oauth_failed when exchange throws', async () => {
      vi.mocked(oauthService.exchangeCodeForTokens).mockRejectedValue(
        new Error('Invalid code')
      );

      const { res } = await invokeRoute(oauthRoutes, 'get', '/callback/:provider(google|github)', {
        params: { provider: 'google' },
        query: { code: 'bad-code', state: 'valid-state' },
        cookies: { oauth_state: 'valid-state' },
      });

      expect(res.redirect).toHaveBeenCalledWith(
        `${FRONTEND_URL}/auth/callback?error=oauth_failed`
      );
    });

    it('redirects with oauth_failed when getOrCreateOAuthUser throws', async () => {
      vi.mocked(oauthService.exchangeCodeForTokens).mockResolvedValue({
        profile: { id: 'g-1', email: 'user@example.com' },
        tokens: { accessToken: 'at', refreshToken: 'rt', expiresAt: new Date() },
      } as any);
      vi.mocked(oauthService.getOrCreateOAuthUser).mockRejectedValue(
        new Error('Email conflict')
      );

      const { res } = await invokeRoute(oauthRoutes, 'get', '/callback/:provider(google|github)', {
        params: { provider: 'google' },
        query: { code: 'valid-code', state: 'valid-state' },
        cookies: { oauth_state: 'valid-state' },
      });

      expect(res.redirect).toHaveBeenCalledWith(
        `${FRONTEND_URL}/auth/callback?error=oauth_failed`
      );
    });

    it('redirects with oauth_failed when createOAuthSession throws', async () => {
      vi.mocked(oauthService.exchangeCodeForTokens).mockResolvedValue({
        profile: { id: 'g-1', email: 'user@example.com' },
        tokens: { accessToken: 'at', refreshToken: 'rt', expiresAt: new Date() },
      } as any);
      vi.mocked(oauthService.getOrCreateOAuthUser).mockResolvedValue({
        user: { id: 'u1', email: 'user@example.com' },
      } as any);
      vi.mocked(oauthService.createOAuthSession).mockRejectedValue(
        new Error('Session error')
      );

      const { res } = await invokeRoute(oauthRoutes, 'get', '/callback/:provider(google|github)', {
        params: { provider: 'google' },
        query: { code: 'valid-code', state: 'valid-state' },
        cookies: { oauth_state: 'valid-state' },
      });

      expect(res.redirect).toHaveBeenCalledWith(
        `${FRONTEND_URL}/auth/callback?error=oauth_failed`
      );
    });
  });

  describe('redirect URL structure (AC3.3)', () => {
    it('error redirects use query param (?) not fragment (#)', async () => {
      const { res } = await invokeRoute(oauthRoutes, 'get', '/callback/:provider(google|github)', {
        params: { provider: 'google' },
        query: { code: 'auth-code' },
        cookies: {},
      });

      const url = res.redirect.mock.calls[0][0];
      expect(url).toContain('?error=');
      expect(url).not.toContain('#');
    });

    it('success redirect uses fragment (#) not query (?) for tokens', async () => {
      vi.mocked(oauthService.exchangeCodeForTokens).mockResolvedValue({
        profile: { id: 'g-1', email: 'user@example.com' },
        tokens: { accessToken: 'at', refreshToken: 'rt', expiresAt: new Date() },
      } as any);
      vi.mocked(oauthService.getOrCreateOAuthUser).mockResolvedValue({
        user: { id: 'u1', email: 'user@example.com' },
      } as any);
      vi.mocked(oauthService.createOAuthSession).mockResolvedValue({
        token: 'jwt-token', refreshToken: 'new-rt', session: { id: 's1' },
      } as any);

      const { res } = await invokeRoute(oauthRoutes, 'get', '/callback/:provider(google|github)', {
        params: { provider: 'google' },
        query: { code: 'valid-code', state: 'valid-state' },
        cookies: { oauth_state: 'valid-state' },
      });

      const url = res.redirect.mock.calls[0][0];
      expect(url).toContain('#');
      expect(url).toMatch(/#token=/);
      expect(url).toMatch(/#.*refreshToken=/);
      expect(url).toMatch(/#.*sessionId=/);
    });
  });
});
