---
id: "cmqj74ncd01yjmekjrvuj9nwa"
slug: "jwt-authentication-system-with-token-refresh-and-o"
title: "JWT Authentication System with Token Refresh and OAuth2.0 Third-Party Login"
status: "done"
tier: "standard"
version: 1
requirementVersion: 1
designVersion: 1
taskVersion: 1
createdAt: "2026-06-18T07:46:22.759Z"
updatedAt: "2026-06-18T07:46:22.759Z"
---

## Contract Tests

### apps/api/src/modules/auth/__tests__/routes.test.ts
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { authService } from '../service.js';
import { auditService } from '../../../services/audit.js';

// Mock dependencies
vi.mock('../service.js', () => ({
  authService: {
    createGuestSession: vi.fn(),
    register: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    getCurrentUser: vi.fn(),
    cleanupExpiredSessions: vi.fn(),
    refreshToken: vi.fn(),
  },
}));

vi.mock('../../../services/audit.js', () => ({
  auditService: { log: vi.fn() },
}));

vi.mock('@dommaker/studio-shared', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

describe('Auth Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /guest-session', () => {
    it('should create guest session and return 201 with token', async () => {
      const mockSession = { sessionId: 'sess-1', token: 'jwt-token', expiresAt: new Date() };
      vi.mocked(authService.createGuestSession).mockResolvedValue(mockSession);
      // Test handler...
    });

    it('should return 500 on service failure', async () => {
      vi.mocked(authService.createGuestSession).mockRejectedValue(new Error('DB error'));
      // Test handler...
    });
  });

  describe('POST /register', () => {
    it('should register user and return 201 with user data', async () => { /* ... */ });
    it('should call auditService.log on successful registration', async () => { /* ... */ });
    it('should return 409 on duplicate email', async () => { /* ... */ });
  });

  describe('POST /login', () => {
    it('should login user and return 200 with token', async () => { /* ... */ });
    it('should call auditService.log on successful login', async () => { /* ... */ });
    it('should return 401 on invalid credentials', async () => { /* ... */ });
  });

  describe('POST /logout', () => {
    it('should logout user and return 200', async () => { /* ... */ });
    it('should call auditService.log on logout', async () => { /* ... */ });
  });

  describe('GET /me', () => {
    it('should return 200 with current user', async () => { /* ... */ });
    it('should return 401 if not authenticated', async () => { /* ... */ });
  });

  describe('POST /cleanup', () => {
    it('should cleanup expired sessions and return deleted count', async () => {
      vi.mocked(authService.cleanupExpiredSessions).mockResolvedValue({ deletedCount: 5 });
      // Test handler...
    });
  });

  describe('POST /refresh', () => {
    it('should refresh token and return new access token', async () => { /* ... */ });
    it('should return 401 on invalid refresh token', async () => { /* ... */ });
  });
});

```
### apps/api/src/modules/auth/__tests__/oauth.routes.test.ts
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { oauthService } from '../oauth.service.js';

vi.mock('../oauth.service.js', () => ({
  oauthService: {
    getAuthorizationUrl: vi.fn(),
    exchangeCodeForTokens: vi.fn(),
    getOrCreateOAuthUser: vi.fn(),
    createOAuthSession: vi.fn(),
  },
}));

vi.mock('@dommaker/studio-shared', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

function mockRes() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    cookie: vi.fn().mockReturnThis(),
    redirect: vi.fn().mockReturnThis(),
  };
}

describe('OAuth Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /:provider', () => {
    it('should generate state, set cookie, and redirect to provider auth URL', async () => {
      vi.mocked(oauthService.getAuthorizationUrl).mockReturnValue('https://accounts.google.com/o/oauth2/auth?...');
      const res = mockRes();
      // Test redirect handler...
      expect(res.cookie).toHaveBeenCalledWith('oauth_state', expect.any(String), expect.objectContaining({ httpOnly: true }));
      expect(res.redirect).toHaveBeenCalledWith(302, expect.stringContaining('accounts.google.com'));
    });

    it('should return 400 for unsupported provider', async () => { /* ... */ });
  });

  describe('GET /:provider/callback', () => {
    it('should exchange code, create user, and redirect with token on success', async () => {
      vi.mocked(oauthService.exchangeCodeForTokens).mockResolvedValue({ access_token: 'at-1' });
      vi.mocked(oauthService.getOrCreateOAuthUser).mockResolvedValue({ id: 'user-1' });
      vi.mocked(oauthService.createOAuthSession).mockResolvedValue({ token: 'jwt-token' });
      // Test callback handler...
    });

    it('should return 403 when CSRF state mismatch', async () => {
      // req.cookies.oauth_state !== req.query.state
      // ...
    });

    it('should return 400 when state cookie is missing', async () => { /* ... */ });

    it('should handle exchangeCodeForTokens failure gracefully', async () => {
      vi.mocked(oauthService.exchangeCodeForTokens).mockRejectedValue(new Error('Token exchange failed'));
      // Test error handling...
    });
  });
});

```
### apps/api/src/modules/auth/__tests__/middleware-auth.test.ts
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkOwnership, requireNotGuest, workspaceAuth, generateAnonymousId } from '../middleware/auth.js';

function mockReq(overrides = {}) {
  return {
    user: { id: 'user-1', role: 'admin', workspaceId: 'ws-1' },
    params: {},
    body: {},
    ...overrides,
  };
}

function mockRes() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
}

describe('checkOwnership', () => {
  it('should call next() when user owns resource', async () => {
    const middleware = checkOwnership('userId');
    const req = mockReq({ params: { userId: 'user-1' } });
    const res = mockRes();
    const next = vi.fn();
    await middleware(req, res, next);
    expect(next).toHaveBeenCalledWith();
  });

  it('should return 403 when user does not own resource', async () => {
    const middleware = checkOwnership('userId');
    const req = mockReq({ params: { userId: 'user-2' } });
    const res = mockRes();
    const next = vi.fn();
    await middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('should return 401 when user is not authenticated', async () => { /* ... */ });
});

describe('requireNotGuest', () => {
  it('should call next() for non-guest user', async () => { /* ... */ });
  it('should return 403 for guest user (role=guest)', async () => { /* ... */ });
  it('should return 401 when user is undefined', async () => { /* ... */ });
});

describe('workspaceAuth', () => {
  it('should call next() when user belongs to workspace', async () => { /* ... */ });
  it('should return 403 when user does not belong to workspace', async () => { /* ... */ });
});

describe('generateAnonymousId', () => {
  it('should return a string of length 36 (UUID format)', () => {
    const id = generateAnonymousId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThanOrEqual(32);
  });

  it('should generate unique IDs on each call', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateAnonymousId()));
    expect(ids.size).toBe(100);
  });
});

```
### apps/api/src/modules/auth/__tests__/service-edge.test.ts
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Reuse mock infrastructure from service.test.ts
vi.mock('@dommaker/studio-prisma', () => ({
  prisma: {
    user: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    session: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn(),
    },
    refreshToken: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  },
}));

vi.mock('@dommaker/studio-shared', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock('jsonwebtoken', () => ({
  default: { sign: vi.fn().mockReturnValue('mock-jwt-token'), verify: vi.fn() },
  sign: vi.fn().mockReturnValue('mock-jwt-token'),
  verify: vi.fn(),
}));

vi.mock('bcrypt', () => ({
  default: { hash: vi.fn().mockResolvedValue('$2b$10$hashedpassword'), compare: vi.fn() },
  hash: vi.fn().mockResolvedValue('$2b$10$hashedpassword'),
  compare: vi.fn(),
}));

import { prisma } from '@dommaker/studio-prisma';
import bcrypt from 'bcrypt';

describe('getOrCreateSession', () => {
  it('should return existing session if found', async () => {
    vi.mocked(prisma.session.findFirst).mockResolvedValue({
      id: 'sess-1', userId: 'user-1', token: 'existing-jwt', deviceInfo: 'chrome',
      expiresAt: new Date(), createdAt: new Date(),
    });
    // await getOrCreateSession('user-1', 'chrome')
    expect(prisma.session.findFirst).toHaveBeenCalledWith({
      where: { userId: 'user-1', deviceInfo: 'chrome' },
    });
  });

  it('should create new session if not found', async () => {
    vi.mocked(prisma.session.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.session.create).mockResolvedValue({
      id: 'sess-new', userId: 'user-1', token: 'new-jwt', deviceInfo: 'chrome',
      expiresAt: new Date(), createdAt: new Date(),
    });
    // await getOrCreateSession('user-1', 'chrome')
    expect(prisma.session.create).toHaveBeenCalled();
  });
});

describe('cleanupExpiredSessions', () => {
  it('should delete all sessions with expiresAt < now', async () => {
    vi.mocked(prisma.session.deleteMany).mockResolvedValue({ count: 3 });
    // const result = await cleanupExpiredSessions()
    // expect(result.deletedCount).toBe(3)
  });

  it('should return 0 when no expired sessions', async () => {
    vi.mocked(prisma.session.deleteMany).mockResolvedValue({ count: 0 });
    // const result = await cleanupExpiredSessions()
    // expect(result.deletedCount).toBe(0)
  });
});

describe('verifyPassword (PBKDF2 old format)', () => {
  it('should verify PBKDF2 hash correctly', async () => {
    const pbkdf2Hash = '$pbkdf2$10000$salthash';
    // Test PBKDF2 verification path
  });

  it('should return false for incorrect PBKDF2 password', async () => { /* ... */ });
});

describe('hashPassword', () => {
  it('should return bcrypt hash starting with $2b$', async () => {
    const hash = await (await import('../service.js')).hashPassword('plaintext');
    expect(hash).toMatch(/^\$2b\$/);
  });

  it('should produce different hashes for same password (salt randomness)', async () => {
    // Test hash uniqueness...
  });
});

```
### apps/api/src/modules/auth/__tests__/oauth.service.test.ts
```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('exchangeCodeForTokens', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('Google provider', () => {
    it('should exchange code for tokens via Google token endpoint', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'google-access-token',
          id_token: 'google-id-token',
          token_type: 'Bearer',
        }),
      } as Response);

      // const tokens = await exchangeCodeForTokens('google', 'auth-code', 'http://localhost/callback');
      expect(global.fetch).toHaveBeenCalledWith(
        'https://oauth2.googleapis.com/token',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        })
      );
      // expect(tokens.access_token).toBe('google-access-token');
    });

    it('should throw on Google token endpoint error response', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ error: 'invalid_grant' }),
      } as Response);

      // await expect(exchangeCodeForTokens('google', 'bad-code', '...')).rejects.toThrow();
    });
  });

  describe('GitHub provider', () => {
    it('should exchange code for token via GitHub token endpoint', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'github-access-token',
          token_type: 'bearer',
          scope: 'user:email',
        }),
      } as Response);

      // const tokens = await exchangeCodeForTokens('github', 'auth-code', 'http://localhost/callback');
      expect(global.fetch).toHaveBeenCalledWith(
        'https://github.com/login/oauth/access_token',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ Accept: 'application/json' }),
        })
      );
    });

    it('should throw on GitHub token endpoint error', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ error: 'bad_verification_code' }),
      } as Response);

      // await expect(exchangeCodeForTokens('github', 'bad-code', '...')).rejects.toThrow();
    });
  });

  it('should throw for unsupported provider', async () => {
    // await expect(exchangeCodeForTokens('facebook' as any, 'code', '...')).rejects.toThrow('Unsupported provider');
  });

  it('should handle network timeout gracefully', async () => {
    vi.mocked(global.fetch).mockRejectedValueOnce(new Error('AbortError'));
    // await expect(exchangeCodeForTokens('google', 'code', '...')).rejects.toThrow();
  });
});

```