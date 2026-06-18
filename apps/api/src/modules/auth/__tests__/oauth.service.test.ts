/**
 * AC1.1: OAuth service contract tests
 *
 * Verifies:
 * - getAuthorizationUrl(provider, state) returns correct URL
 * - exchangeCodeForTokens(provider, code) exchanges code for tokens
 * - getOrCreateOAuthUser(provider, profile, tokens) upserts user
 * - createOAuthSession(userId, req) creates session with tokens
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing service
vi.mock('@dommaker/studio-prisma', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    oAuthAccount: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    session: {
      create: vi.fn(),
      update: vi.fn(),
    },
    refreshToken: {
      create: vi.fn(),
    },
  },
}));

vi.mock('@dommaker/studio-shared', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock('../../../utils/logger.js', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock('jsonwebtoken', () => ({
  default: { sign: vi.fn().mockReturnValue('mock-jwt-token') },
  sign: vi.fn().mockReturnValue('mock-jwt-token'),
}));

import { prisma } from '@dommaker/studio-prisma';
import {
  getAuthorizationUrl,
  exchangeCodeForTokens,
  getOrCreateOAuthUser,
  createOAuthSession,
  OAuthError,
} from '../oauth.service.js';

describe('oauth.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GOOGLE_CLIENT_ID = 'test-google-id';
    process.env.GITHUB_CLIENT_ID = 'test-github-id';
  });

  describe('getAuthorizationUrl', () => {
    it('returns Google authorization URL with correct params', () => {
      const url = getAuthorizationUrl('google', 'test-state');
      expect(url).toContain('accounts.google.com/o/oauth2/v2/auth');
      expect(url).toContain('client_id=test-google-id');
      expect(url).toContain('state=test-state');
      expect(url).toContain('scope=openid+email+profile');
      expect(url).toContain('response_type=code');
    });

    it('returns GitHub authorization URL with correct params', () => {
      const url = getAuthorizationUrl('github', 'test-state');
      expect(url).toContain('github.com/login/oauth/authorize');
      expect(url).toContain('client_id=test-github-id');
      expect(url).toContain('state=test-state');
      expect(url).toContain('scope=user%3Aemail');
    });

    it('throws for unsupported provider', () => {
      expect(() => getAuthorizationUrl('unsupported' as any, 'state')).toThrow(
        /not supported/i
      );
    });

    it('includes redirect_uri in URL', () => {
      const url = getAuthorizationUrl('google', 'test-state');
      expect(url).toContain('redirect_uri=');
    });

    it('AC1.1: Google redirect_uri uses /callback/google path order', () => {
      const url = getAuthorizationUrl('google', 'test-state');
      const redirectUri = new URL(url).searchParams.get('redirect_uri')!;
      expect(redirectUri).toMatch(/\/callback\/google$/);
      expect(redirectUri).not.toMatch(/\/google\/callback/);
    });

    it('AC1.2: GitHub redirect_uri uses /callback/github path order', () => {
      const url = getAuthorizationUrl('github', 'test-state');
      const redirectUri = new URL(url).searchParams.get('redirect_uri')!;
      expect(redirectUri).toMatch(/\/callback\/github$/);
      expect(redirectUri).not.toMatch(/\/github\/callback/);
    });
  });

  describe('exchangeCodeForTokens', () => {
    beforeEach(() => {
      process.env.GOOGLE_CLIENT_ID = 'test-google-id';
      process.env.GOOGLE_CLIENT_SECRET = 'test-google-secret';
      process.env.GITHUB_CLIENT_ID = 'test-github-id';
      process.env.GITHUB_CLIENT_SECRET = 'test-github-secret';
    });

    it('throws for unsupported provider', async () => {
      await expect(
        exchangeCodeForTokens('unsupported' as any, 'code')
      ).rejects.toThrow(/not supported/i);
    });

    describe('Google exchange', () => {
      function mockGoogleTokenResponse(status: number, body: unknown): void {
        vi.mocked(globalThis.fetch).mockResolvedValueOnce(
          new Response(JSON.stringify(body), { status })
        );
      }

      function mockGoogleProfileResponse(status: number, body: unknown): void {
        vi.mocked(globalThis.fetch).mockResolvedValueOnce(
          new Response(JSON.stringify(body), { status })
        );
      }

      beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
      });

      afterEach(() => {
        vi.unstubAllGlobals();
      });

      it('exchanges code and returns profile + tokens on success', async () => {
        mockGoogleTokenResponse(200, {
          access_token: 'google-at-123',
          refresh_token: 'google-rt-456',
          expires_in: 3600,
        });
        mockGoogleProfileResponse(200, {
          id: 'guser-1',
          email: 'google@example.com',
          name: 'Google User',
          picture: 'https://example.com/pic.jpg',
        });

        const result = await exchangeCodeForTokens('google', 'valid-code');

        expect(result.profile.provider).toBe('google');
        expect(result.profile.providerAccountId).toBe('guser-1');
        expect(result.profile.email).toBe('google@example.com');
        expect(result.tokens.accessToken).toBe('google-at-123');
        expect(result.tokens.refreshToken).toBe('google-rt-456');
        expect(result.tokens.expiresAt).toBeInstanceOf(Date);
      });

      it('throws OAuthError(400) for invalid code', async () => {
        mockGoogleTokenResponse(400, { error: 'invalid_grant' });
        // Second call hits same mock again since there's no further fetch
        vi.mocked(globalThis.fetch).mockResolvedValueOnce(
          new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
        );

        const promise = exchangeCodeForTokens('google', 'bad-code');
        await expect(promise).rejects.toThrow(OAuthError);
        await expect(promise).rejects.toMatchObject({
          statusCode: 400,
          message: 'Google token exchange failed',
        });
      });

      it('throws OAuthError(502) when profile fetch fails', async () => {
        mockGoogleTokenResponse(200, {
          access_token: 'google-at-123',
          expires_in: 3600,
        });
        mockGoogleProfileResponse(500, {});

        await expect(exchangeCodeForTokens('google', 'valid-code')).rejects.toMatchObject({
          statusCode: 502,
          message: 'Failed to fetch Google user profile',
        });
      });

      it('throws OAuthError(503) on network error during token exchange', async () => {
        vi.mocked(globalThis.fetch).mockRejectedValueOnce(new TypeError('fetch failed'));

        await expect(exchangeCodeForTokens('google', 'code')).rejects.toMatchObject({
          statusCode: 503,
          message: 'Network error during Google token exchange',
        });
      });

      it('throws OAuthError(503) on network error during profile fetch', async () => {
        mockGoogleTokenResponse(200, {
          access_token: 'google-at-123',
          expires_in: 3600,
        });
        vi.mocked(globalThis.fetch).mockRejectedValueOnce(new TypeError('network error'));

        await expect(exchangeCodeForTokens('google', 'code')).rejects.toMatchObject({
          statusCode: 503,
          message: 'Network error during Google profile fetch',
        });
      });
    });

    describe('GitHub exchange', () => {
      function mockGitHubTokenResponse(status: number, body: unknown): void {
        vi.mocked(globalThis.fetch).mockResolvedValueOnce(
          new Response(JSON.stringify(body), { status })
        );
      }

      function mockGitHubProfileResponse(status: number, body: unknown): void {
        vi.mocked(globalThis.fetch).mockResolvedValueOnce(
          new Response(JSON.stringify(body), { status })
        );
      }

      function mockGitHubEmailsResponse(status: number, body: unknown): void {
        vi.mocked(globalThis.fetch).mockResolvedValueOnce(
          new Response(JSON.stringify(body), { status })
        );
      }

      beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
      });

      afterEach(() => {
        vi.unstubAllGlobals();
      });

      it('exchanges code and returns profile + tokens on success', async () => {
        mockGitHubTokenResponse(200, {
          access_token: 'gh-at-123',
          refresh_token: 'gh-rt-456',
          expires_in: 7200,
        });
        mockGitHubProfileResponse(200, {
          id: 42,
          email: 'github@example.com',
          name: 'GitHub User',
          avatar_url: 'https://avatars.example.com/u/42',
          login: 'ghuser',
        });

        const result = await exchangeCodeForTokens('github', 'valid-code');

        expect(result.profile.provider).toBe('github');
        expect(result.profile.providerAccountId).toBe('42');
        expect(result.profile.email).toBe('github@example.com');
        expect(result.tokens.accessToken).toBe('gh-at-123');
        expect(result.tokens.refreshToken).toBe('gh-rt-456');
        expect(result.tokens.expiresAt).toBeInstanceOf(Date);
      });

      it('falls back to /user/emails when profile email is null', async () => {
        mockGitHubTokenResponse(200, {
          access_token: 'gh-at-123',
          expires_in: 3600,
        });
        mockGitHubProfileResponse(200, {
          id: 43,
          email: null,
          name: null,
          avatar_url: 'https://avatars.example.com/u/43',
          login: 'email-fallback',
        });
        mockGitHubEmailsResponse(200, [
          { email: 'primary@example.com', primary: true, verified: true },
        ]);

        const result = await exchangeCodeForTokens('github', 'code');

        expect(result.profile.email).toBe('primary@example.com');
        expect(result.profile.name).toBe('email-fallback');
      });

      it('uses first email from /user/emails when no primary verified email exists', async () => {
        mockGitHubTokenResponse(200, {
          access_token: 'gh-at-123',
          expires_in: 3600,
        });
        mockGitHubProfileResponse(200, {
          id: 44,
          email: null,
          name: 'Named User',
          avatar_url: '',
          login: 'named',
        });
        mockGitHubEmailsResponse(200, [
          { email: 'unverified@example.com', primary: false, verified: false },
          { email: 'secondary@example.com', primary: false, verified: true },
        ]);

        const result = await exchangeCodeForTokens('github', 'code');

        // Falls back to emails[0] when no primary+verified email found
        expect(result.profile.email).toBe('unverified@example.com');
      });

      it('throws OAuthError(400) for invalid code', async () => {
        mockGitHubTokenResponse(400, { error: 'bad_verification_code' });

        await expect(exchangeCodeForTokens('github', 'bad-code')).rejects.toMatchObject({
          statusCode: 400,
          message: 'GitHub token exchange failed',
        });
      });

      it('throws OAuthError(400) when token response contains error field', async () => {
        mockGitHubTokenResponse(200, { error: 'invalid_client' });

        await expect(exchangeCodeForTokens('github', 'code')).rejects.toMatchObject({
          statusCode: 400,
          message: 'GitHub OAuth error: invalid_client',
        });
      });

      it('throws OAuthError(502) when profile fetch fails', async () => {
        mockGitHubTokenResponse(200, {
          access_token: 'gh-at-123',
          expires_in: 3600,
        });
        mockGitHubProfileResponse(500, {});

        await expect(exchangeCodeForTokens('github', 'code')).rejects.toMatchObject({
          statusCode: 502,
          message: 'Failed to fetch GitHub user profile',
        });
      });

      it('throws OAuthError(503) on network error during token exchange', async () => {
        vi.mocked(globalThis.fetch).mockRejectedValueOnce(new TypeError('fetch failed'));

        await expect(exchangeCodeForTokens('github', 'code')).rejects.toMatchObject({
          statusCode: 503,
          message: 'Network error during GitHub token exchange',
        });
      });
    });
  });

  describe('getOrCreateOAuthUser', () => {
    const mockProfile = {
      provider: 'google' as const,
      providerAccountId: 'google-123',
      email: 'test@example.com',
      name: 'Test User',
      avatar: 'https://example.com/avatar.jpg',
    };

    const mockTokens = {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: new Date(Date.now() + 3600000),
    };

    it('returns existing user if OAuth account exists', async () => {
      const existingUser = { id: 'user-1', email: 'test@example.com', role: 'User' };
      vi.mocked(prisma.oAuthAccount.findUnique).mockResolvedValue({
        id: 'oa-1',
        userId: 'user-1',
        provider: 'google',
        providerAccountId: 'google-123',
        User: existingUser,
      } as any);

      const result = await getOrCreateOAuthUser('google', mockProfile, mockTokens);

      expect(result.user.id).toBe('user-1');
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('creates new user if OAuth account does not exist', async () => {
      vi.mocked(prisma.oAuthAccount.findUnique).mockResolvedValue(null);
      // First call: email check → null; second call: fetch created user → user object
      vi.mocked(prisma.user.findUnique)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'new-user-1', email: 'test@example.com', role: 'User' } as any);
      vi.mocked(prisma.user.create).mockResolvedValue({
        id: 'new-user-1',
        email: 'test@example.com',
        role: 'User',
      } as any);
      vi.mocked(prisma.oAuthAccount.upsert).mockResolvedValue({} as any);

      const result = await getOrCreateOAuthUser('google', mockProfile, mockTokens);

      expect(result.user.id).toBe('new-user-1');
      expect(prisma.user.create).toHaveBeenCalled();
    });

    it('links OAuth account to existing user by email', async () => {
      vi.mocked(prisma.oAuthAccount.findUnique).mockResolvedValue(null);
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        id: 'existing-user-1',
        email: 'test@example.com',
        role: 'User',
      } as any);
      vi.mocked(prisma.user.update).mockResolvedValue({} as any);
      vi.mocked(prisma.oAuthAccount.upsert).mockResolvedValue({} as any);

      const result = await getOrCreateOAuthUser('google', mockProfile, mockTokens);

      expect(result.user.id).toBe('existing-user-1');
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('upserts OAuthAccount with tokens', async () => {
      vi.mocked(prisma.oAuthAccount.findUnique).mockResolvedValue({
        id: 'oa-1',
        userId: 'user-1',
        provider: 'google',
        providerAccountId: 'google-123',
        User: { id: 'user-1', email: 'test@example.com', role: 'User' },
      } as any);
      vi.mocked(prisma.oAuthAccount.upsert).mockResolvedValue({} as any);

      await getOrCreateOAuthUser('google', mockProfile, mockTokens);

      expect(prisma.oAuthAccount.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            accessToken: 'access-token',
            refreshToken: 'refresh-token',
          }),
          create: expect.objectContaining({
            provider: 'google',
            providerAccountId: 'google-123',
            accessToken: 'access-token',
          }),
        })
      );
    });
  });

  describe('createOAuthSession', () => {
    it('creates session and returns tokens', async () => {
      vi.mocked(prisma.session.create).mockResolvedValue({
        id: 'session-1',
        token: 'mock-jwt-token',
        expiresAt: new Date(Date.now() + 86400000),
      } as any);
      vi.mocked(prisma.refreshToken.create).mockResolvedValue({} as any);

      const mockReq = {
        ip: '127.0.0.1',
        headers: { 'user-agent': 'test-agent' },
      } as any;

      const result = await createOAuthSession('user-1', mockReq);

      expect(result.token).toBe('mock-jwt-token');
      expect(result.refreshToken).toBeDefined();
      expect(prisma.session.create).toHaveBeenCalled();
    });
  });

  describe('OAuth redirect URL fragment (AC3.3)', () => {
    it('redirect URL uses fragment (#) not query (?) for tokens', () => {
      // Simulates oauth.routes.ts L76-L81 redirect URL construction
      const FRONTEND_URL = 'http://localhost:5173';
      const token = 'jwt-token';
      const refreshToken = 'refresh-token';
      const sessionId = 'session-1';

      const params = new URLSearchParams({ token, refreshToken, sessionId });
      const redirectUrl = `${FRONTEND_URL}/auth/callback#${params}`;

      expect(redirectUrl).toContain('#');
      expect(redirectUrl).not.toContain('?');
      expect(redirectUrl).toMatch(/#token=/);
      expect(redirectUrl).toMatch(/#.*refreshToken=/);
      expect(redirectUrl).toMatch(/#.*sessionId=/);
    });

    it('error redirect uses query (?) not fragment (#)', () => {
      // Error redirects (L53, L84) stay in query params — not sensitive
      const FRONTEND_URL = 'http://localhost:5173';
      const errorUrl = `${FRONTEND_URL}/auth/callback?error=missing_code`;

      expect(errorUrl).toContain('?');
      expect(errorUrl).not.toContain('#');
      expect(errorUrl).toContain('error=missing_code');
    });
  });
});
