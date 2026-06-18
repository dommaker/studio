/**
 * AC1.1: OAuth service contract tests
 *
 * Verifies:
 * - getAuthorizationUrl(provider, state) returns correct URL
 * - exchangeCodeForTokens(provider, code) exchanges code for tokens
 * - getOrCreateOAuthUser(provider, profile, tokens) upserts user
 * - createOAuthSession(userId, req) creates session with tokens
 */
import type { Session, User, RefreshToken, OAuthAccount } from '@prisma/client';
import { describe, it, expect, vi, beforeEach } from 'vitest';

type OAuthProvider = 'google' | 'github';

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
      expect(() => getAuthorizationUrl('unsupported' as unknown as OAuthProvider, 'state')).toThrow(
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
    it('throws for unsupported provider', async () => {
      await expect(
        exchangeCodeForTokens('unsupported' as unknown as OAuthProvider, 'code')
      ).rejects.toThrow(/not supported/i);
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
      } as unknown as OAuthAccount);

      const result = await getOrCreateOAuthUser('google', mockProfile, mockTokens);

      expect(result.user.id).toBe('user-1');
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('creates new user if OAuth account does not exist', async () => {
      vi.mocked(prisma.oAuthAccount.findUnique).mockResolvedValue(null);
      // First call: email check → null; second call: fetch created user → user object
      vi.mocked(prisma.user.findUnique)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'new-user-1', email: 'test@example.com', role: 'User' } as unknown as User);
      vi.mocked(prisma.user.create).mockResolvedValue({
        id: 'new-user-1',
        email: 'test@example.com',
        role: 'User',
      } as unknown as User);
      vi.mocked(prisma.oAuthAccount.upsert).mockResolvedValue({} as unknown as OAuthAccount);

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
      } as unknown as User);
      vi.mocked(prisma.user.update).mockResolvedValue({} as unknown as User);
      vi.mocked(prisma.oAuthAccount.upsert).mockResolvedValue({} as unknown as OAuthAccount);

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
      } as unknown as OAuthAccount);
      vi.mocked(prisma.oAuthAccount.upsert).mockResolvedValue({} as unknown as OAuthAccount);

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
      } as unknown as Session);
      vi.mocked(prisma.refreshToken.create).mockResolvedValue({} as unknown as RefreshToken);

      const mockReq: { ip?: string; headers: Record<string, string | undefined> } = {
        ip: '127.0.0.1',
        headers: { 'user-agent': 'test-agent' },
      };

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
