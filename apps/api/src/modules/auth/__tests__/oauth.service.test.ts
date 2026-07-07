/**
 * OAuth Service contract tests
 *
 * Verifies:
 * - getAuthorizationUrl generates correct provider URLs
 * - exchangeCodeForTokens exchanges code for profile + tokens
 * - getOrCreateOAuthUser resolves users via 3-path lookup
 * - createOAuthSession creates session with JWT + refreshToken
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

// Mock service internals first (before any imports that use them)
vi.mock('@dommaker/studio-prisma', () => ({
  prisma: {
    oAuthAccount: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      create: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
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

// Mock the service module that oauth.service imports
vi.mock('../service.js', () => ({
  generateRefreshToken: vi.fn().mockResolvedValue('mock-refresh-token-hex'),
  JWT_SECRET: 'test-jwt-secret-for-oauth-tests',
}));

import { prisma } from '@dommaker/studio-prisma';
import {
  getAuthorizationUrl,
  exchangeCodeForTokens,
  getOrCreateOAuthUser,
  createOAuthSession,
  OAuthError,
} from '../oauth.service.js';

// Save original env and restore after tests
const originalEnv = { ...process.env };

function setOAuthEnv() {
  process.env.GOOGLE_CLIENT_ID = 'google-client-id-test';
  process.env.GOOGLE_CLIENT_SECRET = 'google-client-secret-test';
  process.env.GITHUB_CLIENT_ID = 'github-client-id-test';
  process.env.GITHUB_CLIENT_SECRET = 'github-client-secret-test';
  process.env.OAUTH_REDIRECT_BASE = 'http://localhost:3001/api/v1/auth';
}

describe('OAuthService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setOAuthEnv();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  // ─── getAuthorizationUrl ───
  describe('getAuthorizationUrl', () => {
    it('generates correct Google authorization URL with state, client_id, and callback/{provider} redirect_uri', () => {
      const url = getAuthorizationUrl('google', 'test-state-123');

      expect(url).toContain('https://accounts.google.com/o/oauth2/v2/auth');
      expect(url).toContain('client_id=google-client-id-test');
      expect(url).toContain('state=test-state-123');
      expect(url).toContain('redirect_uri=http%3A%2F%2Flocalhost%3A3001%2Fapi%2Fv1%2Fauth%2Fcallback%2Fgoogle');
      expect(url).toContain('response_type=code');
      expect(url).toContain('scope=openid+email+profile');
      expect(url).toContain('access_type=offline');
    });

    it('generates correct GitHub authorization URL with state and callback/{provider} redirect_uri', () => {
      const url = getAuthorizationUrl('github', 'gh-state-456');

      expect(url).toContain('https://github.com/login/oauth/authorize');
      expect(url).toContain('client_id=github-client-id-test');
      expect(url).toContain('state=gh-state-456');
      expect(url).toContain('redirect_uri=http%3A%2F%2Flocalhost%3A3001%2Fapi%2Fv1%2Fauth%2Fcallback%2Fgithub');
      expect(url).toContain('scope=user%3Aemail');
    });

    it('redirect_uri uses callback/{provider} format (not /{provider}/callback)', () => {
      const url = getAuthorizationUrl('google', 'state');
      expect(url).toContain('callback%2Fgoogle');
      expect(url).not.toContain('google%2Fcallback');
    });

    it('throws on missing GOOGLE_CLIENT_ID env var', () => {
      delete process.env.GOOGLE_CLIENT_ID;
      expect(() => getAuthorizationUrl('google', 'state')).toThrow('GOOGLE_CLIENT_ID not configured');
    });

    it('throws on missing GITHUB_CLIENT_ID env var', () => {
      delete process.env.GITHUB_CLIENT_ID;
      expect(() => getAuthorizationUrl('github', 'state')).toThrow('GITHUB_CLIENT_ID not configured');
    });

    it('throws on unsupported provider', () => {
      expect(() => getAuthorizationUrl('facebook' as any, 'state')).toThrow(
        'not supported',
      );
    });
  });

  // ─── exchangeCodeForTokens ───
  describe('exchangeCodeForTokens', () => {
    it('exchanges code for Google tokens using POST + form-urlencoded', async () => {
      const mockTokenResponse = {
        ok: true,
        json: vi.fn().mockResolvedValue({
          access_token: 'google-access-token',
          refresh_token: 'google-refresh-token',
          expires_in: 3600,
        }),
      };
      const mockProfileResponse = {
        ok: true,
        json: vi.fn().mockResolvedValue({
          id: 'google-user-id',
          email: 'google@test.com',
          name: 'Google User',
          picture: 'https://avatar.url',
        }),
      };

      // fetch() is called twice: token exchange then profile
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(mockTokenResponse as unknown as Response)
        .mockResolvedValueOnce(mockProfileResponse as unknown as Response);

      const result = await exchangeCodeForTokens('google', 'auth-code');

      expect(result.profile.provider).toBe('google');
      expect(result.profile.providerAccountId).toBe('google-user-id');
      expect(result.profile.email).toBe('google@test.com');
      expect(result.profile.name).toBe('Google User');
      expect(result.tokens.accessToken).toBe('google-access-token');

      // Verify Google uses form-urlencoded POST
      const fetchCall = (globalThis.fetch as any).mock.calls[0];
      expect(fetchCall[1].method).toBe('POST');
      expect(fetchCall[1].headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    });

    it('exchanges code for GitHub tokens using POST + JSON + Accept: application/json', async () => {
      const mockTokenResponse = {
        ok: true,
        json: vi.fn().mockResolvedValue({
          access_token: 'github-access-token',
          expires_in: 28800,
        }),
      };
      const mockProfileResponse = {
        ok: true,
        json: vi.fn().mockResolvedValue({
          id: 12345,
          email: 'github@test.com',
          name: 'GitHub User',
          avatar_url: 'https://avatar.url',
          login: 'ghuser',
        }),
      };

      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(mockTokenResponse as unknown as Response)
        .mockResolvedValueOnce(mockProfileResponse as unknown as Response);

      const result = await exchangeCodeForTokens('github', 'gh-code');

      expect(result.profile.provider).toBe('github');
      expect(result.profile.providerAccountId).toBe('12345');
      expect(result.profile.email).toBe('github@test.com');

      // Verify GitHub uses JSON POST + Accept header
      const fetchCall = (globalThis.fetch as any).mock.calls[0];
      expect(fetchCall[1].method).toBe('POST');
      expect(fetchCall[1].headers['Content-Type']).toBe('application/json');
      expect(fetchCall[1].headers['Accept']).toBe('application/json');
    });

    it('fetches GitHub email from /user/emails when profile email is null (filters primary+verified)', async () => {
      const mockTokenResponse = {
        ok: true,
        json: vi.fn().mockResolvedValue({
          access_token: 'gh-token',
          expires_in: 28800,
        }),
      };
      const mockProfileResponse = {
        ok: true,
        json: vi.fn().mockResolvedValue({
          id: 99999,
          email: null,
          name: 'NoEmail User',
          avatar_url: 'https://avatar.url',
          login: 'noemail',
        }),
      };
      const mockEmailsResponse = {
        ok: true,
        json: vi.fn().mockResolvedValue([
          { email: 'secondary@test.com', primary: false, verified: true },
          { email: 'primary@test.com', primary: true, verified: true },
          { email: 'unverified@test.com', primary: false, verified: false },
        ]),
      };

      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(mockTokenResponse as unknown as Response)
        .mockResolvedValueOnce(mockProfileResponse as unknown as Response)
        .mockResolvedValueOnce(mockEmailsResponse as unknown as Response);

      const result = await exchangeCodeForTokens('github', 'gh-code');

      // Should pick primary+verified email
      expect(result.profile.email).toBe('primary@test.com');
      // Should have made 3 fetch calls (token, profile, emails)
      expect(globalThis.fetch).toHaveBeenCalledTimes(3);
      const emailCall = (globalThis.fetch as any).mock.calls[2];
      expect(emailCall[0]).toContain('/user/emails');
    });

    it('throws OAuthError on network error during token exchange', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network down'));

      await expect(exchangeCodeForTokens('google', 'code')).rejects.toThrow(OAuthError);
    });

    it('throws OAuthError on non-ok token response', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        text: vi.fn().mockResolvedValue('invalid_grant'),
      } as unknown as Response);

      await expect(exchangeCodeForTokens('google', 'code')).rejects.toThrow(OAuthError);
    });
  });

  // ─── getOrCreateOAuthUser ───
  describe('getOrCreateOAuthUser', () => {
    const profile = {
      provider: 'google' as const,
      providerAccountId: 'google-acc-1',
      email: 'existing@test.com',
      name: 'Existing User',
      avatar: 'https://pic.url',
    };
    const tokens = {
      accessToken: 'at',
      refreshToken: null as string | null,
      expiresAt: new Date(),
    };

    it('returns existing user when OAuthAccount already exists (path 1)', async () => {
      vi.mocked(prisma.oAuthAccount.findUnique).mockResolvedValue({
        userId: 'existing-user-id',
        provider: 'google',
        providerAccountId: 'google-acc-1',
        User: { id: 'existing-user-id', email: 'existing@test.com', role: 'User' },
      } as any);
      vi.mocked(prisma.oAuthAccount.upsert).mockResolvedValue({} as any);

      const result = await getOrCreateOAuthUser('google', profile, tokens);

      expect(result.user.id).toBe('existing-user-id');
      expect(prisma.oAuthAccount.findUnique).toHaveBeenCalledWith({
        where: {
          provider_providerAccountId: {
            provider: 'google',
            providerAccountId: 'google-acc-1',
          },
        },
        include: { User: true },
      });
    });

    it('links OAuth account to existing user by email (path 2)', async () => {
      vi.mocked(prisma.oAuthAccount.findUnique).mockResolvedValue(null);
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        id: 'email-user-id',
        email: 'existing@test.com',
        role: 'User',
      } as any);
      vi.mocked(prisma.user.update).mockResolvedValue({} as any);
      vi.mocked(prisma.oAuthAccount.upsert).mockResolvedValue({} as any);

      const result = await getOrCreateOAuthUser('github', profile, tokens);

      expect(result.user.id).toBe('email-user-id');
      expect(prisma.user.create).not.toHaveBeenCalled(); // no new user
    });

    it('creates new User + OAuthAccount when neither exists (path 3)', async () => {
      vi.mocked(prisma.oAuthAccount.findUnique).mockResolvedValue(null);
      // findUnique called twice: 1) check by email (null → create new), 2) fetch at end of fn
      vi.mocked(prisma.user.findUnique)
        .mockResolvedValueOnce(null) // email lookup → no existing user
        .mockResolvedValueOnce({ id: 'new-user-id', email: 'existing@test.com', role: 'User' } as any); // final fetch
      vi.mocked(prisma.user.create).mockResolvedValue({
        id: 'new-user-id',
        email: 'existing@test.com',
        role: 'User',
      } as any);
      vi.mocked(prisma.oAuthAccount.upsert).mockResolvedValue({} as any);

      const result = await getOrCreateOAuthUser('google', profile, tokens);

      expect(result.user.id).toBe('new-user-id');
      expect(prisma.user.create).toHaveBeenCalled();
      expect(prisma.user.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          email: 'existing@test.com',
          role: 'User',
        }),
      });
    });

    it('new OAuth user gets role hardcoded to User (not schema default Guest)', async () => {
      vi.mocked(prisma.oAuthAccount.findUnique).mockResolvedValue(null);
      vi.mocked(prisma.user.findUnique)
        .mockResolvedValueOnce(null) // email lookup → no existing user
        .mockResolvedValueOnce({ id: 'new-id', email: 'test@test.com', role: 'User' } as any); // final fetch
      vi.mocked(prisma.user.create).mockResolvedValue({
        id: 'new-id',
        email: 'test@test.com',
        role: 'User',
      } as any);
      vi.mocked(prisma.oAuthAccount.upsert).mockResolvedValue({} as any);

      await getOrCreateOAuthUser('google', profile, tokens);

      expect(prisma.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            role: 'User',
          }),
        }),
      );
    });
  });

  // ─── createOAuthSession ───
  describe('createOAuthSession', () => {
    it('creates session with 7-day expiry and returns JWT + refreshToken', async () => {
      vi.mocked(prisma.session.create).mockResolvedValue({
        id: 'oauth-session-1',
        token: '',
        expiresAt: new Date(Date.now() + 604800000),
      } as any);
      vi.mocked(prisma.session.update).mockResolvedValue({} as any);
      vi.mocked(prisma.refreshToken.create).mockResolvedValue({} as any);

      const result = await createOAuthSession('user-1', {
        ip: '127.0.0.1',
        headers: { 'user-agent': 'TestAgent/1.0' },
      });

      expect(result.token).toBeDefined();
      expect(result.token.length).toBeGreaterThan(0);
      expect(result.refreshToken).toBe('mock-refresh-token-hex');
      expect(result.session.id).toBe('oauth-session-1');

      // OAuth session expires in 7 days (same as email/password)
      const sessionCreatedAt = (prisma.session.create as any).mock.calls[0][0].data.expiresAt;
      expect(sessionCreatedAt.getTime()).toBeGreaterThan(Date.now() + 6 * 86400000);
    });
  });
});
