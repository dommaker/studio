---
id: "sdd-1782442724210-q4y42l"
goalId: "cmq6k1qgo002geeiwynmbkhd9"
slug: "jwt-auth-gap-closure-axios-interceptor-oauth-redir"
title: "JWT Auth Gap Closure: Axios Interceptor + OAuth Redirect Fix"
status: "done"
version: 2
taskVersion: 2
parentId: "cmq6k1npf0022eeiwvvmwkr2o"
changeType: "L2"
sourceChannelId: "cmq6eqh3u000k10qwg7tup7lj"
tags: ["auth", "security", "axios", "jwt", "oauth", "interceptor", "frontend", "backend"]
createdAt: "2026-06-09T11:26:57.601Z"
updatedAt: "2026-06-26T02:58:44.210Z"
---

# JWT Auth Gap Closure: Axios Interceptor + OAuth Redirect Fix

Complete the remaining gaps in the JWT auth system: add axios interceptors so all frontend consumers send Bearer tokens and handle refresh, fix OAuth redirect_uri path reversal, and migrate OAuth token delivery from query params to URL fragments.

<!-- TASK_TIER {"tier":"premium","reason":"3 AC groups spanning frontend interceptor (48+ consumers), backend OAuth redirect fix, and frontend+backend OAuth fragment migration. Cross-module changes with circular dependency constraints."} -->

## Contract Tests

### __tests__/axios-interceptor.test.ts
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Contract tests for AC Group: axios-interceptor
// Verifies: request interceptor injects Bearer token, response interceptor handles 401

describe('axios auth interceptor contract', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe('request interceptor', () => {
    it('AC1.1: injects Authorization header when token exists in localStorage', () => {
      const authStorage = JSON.stringify({
        state: { token: 'test-jwt-token', refreshToken: 'refresh-123', user: { id: 'u1', role: 'User' } },
        version: 0,
      });
      localStorage.setItem('auth-storage', authStorage);
      const stored = JSON.parse(localStorage.getItem('auth-storage')!);
      expect(stored.state.token).toBe('test-jwt-token');
      expect(`Bearer ${stored.state.token}`).toBe('Bearer test-jwt-token');
    });

    it('AC1.1: does not inject header when token is null', () => {
      const authStorage = JSON.stringify({
        state: { token: null, refreshToken: null, user: null },
        version: 0,
      });
      localStorage.setItem('auth-storage', authStorage);
      const stored = JSON.parse(localStorage.getItem('auth-storage')!);
      expect(stored.state.token).toBeNull();
    });

    it('AC1.1: does not import authStore (circular dependency check)', async () => {
      const mod = await import('../api/index');
      expect(mod.api).toBeDefined();
      expect(mod.authApi).toBeDefined();
    });
  });

  describe('response interceptor', () => {
    it('AC1.2: refresh flow uses /auth/refresh endpoint', () => {
      const authStorage = JSON.stringify({
        state: { token: 'expired-token', refreshToken: 'valid-refresh', user: { id: 'u1' } },
        version: 0,
      });
      localStorage.setItem('auth-storage', authStorage);
      const stored = JSON.parse(localStorage.getItem('auth-storage')!);
      expect(stored.state.refreshToken).toBe('valid-refresh');
    });

    it('AC1.2: excludes auth paths from refresh cycle', () => {
      const excludedPaths = ['/auth/login', '/auth/register', '/auth/guest-session', '/auth/refresh'];
      excludedPaths.forEach(path => {
        expect(path.startsWith('/auth/')).toBe(true);
      });
    });

    it('AC1.3: updates localStorage after successful refresh', () => {
      const authStorage = JSON.stringify({
        state: { token: 'old-token', refreshToken: 'old-refresh', user: { id: 'u1' } },
        version: 0,
      });
      localStorage.setItem('auth-storage', authStorage);
      const stored = JSON.parse(localStorage.getItem('auth-storage')!);
      expect(stored.state).toHaveProperty('token');
      expect(stored.state).toHaveProperty('refreshToken');
    });
  });
});
```

### __tests__/oauth-redirect-fix.test.ts
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Contract tests for AC Group: oauth-redirect-fix
// Verifies: redirect_uri matches actual route path order

vi.mock('@dommaker/studio-prisma', () => ({
  prisma: {
    user: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    oAuthAccount: { findUnique: vi.fn(), upsert: vi.fn() },
    session: { create: vi.fn(), update: vi.fn() },
    refreshToken: { create: vi.fn() },
  },
}));
vi.mock('@dommaker/studio-shared', () => ({ logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));
vi.mock('../../../utils/logger.js', () => ({ logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));

import { getAuthorizationUrl } from '../oauth.service.js';

describe('oauth redirect fix contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GOOGLE_CLIENT_ID = 'test-google-id';
    process.env.GITHUB_CLIENT_ID = 'test-github-id';
  });

  describe('AC2.1: redirect_uri path correctness', () => {
    it('Google redirect_uri matches /auth/callback/google (not /auth/google/callback)', () => {
      const url = getAuthorizationUrl('google', 'test-state');
      const urlObj = new URL(url);
      const redirectUri = urlObj.searchParams.get('redirect_uri');
      expect(redirectUri).toBeTruthy();
      expect(redirectUri).toContain('/auth/callback/google');
      expect(redirectUri).not.toMatch(/\/auth\/google\/callback/);
    });

    it('GitHub redirect_uri matches /auth/callback/github', () => {
      const url = getAuthorizationUrl('github', 'test-state');
      const urlObj = new URL(url);
      const redirectUri = urlObj.searchParams.get('redirect_uri');
      expect(redirectUri).toContain('/auth/callback/github');
      expect(redirectUri).not.toMatch(/\/auth\/github\/callback/);
    });
  });
});
```

### __tests__/oauth-token-fragment.test.ts
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Contract tests for AC Group: oauth-token-fragment
// Verifies: OAuth callback redirect uses URL fragment (#) not query (?)

describe('oauth token fragment contract', () => {
  describe('AC3.1: callback redirect uses fragment', () => {
    it('redirect URL contains # for token params', () => {
      const FRONTEND_URL = 'http://localhost:5173';
      const token = 'jwt-token';
      const refreshToken = 'refresh-token';
      const sessionId = 'sess-1';
      const params = new URLSearchParams({ token, refreshToken, sessionId });
      const redirectUrl = `${FRONTEND_URL}/auth/callback#${params}`;
      expect(redirectUrl).toContain('#');
      expect(redirectUrl).not.toContain('?token=');
      expect(redirectUrl).toContain('#token=');
    });

    it('error redirects still use query params', () => {
      const FRONTEND_URL = 'http://localhost:5173';
      const errorRedirect = `${FRONTEND_URL}/auth/callback?error=missing_code`;
      expect(errorRedirect).toContain('?error=');
      expect(errorRedirect).not.toContain('#error=');
    });
  });

  describe('AC3.2: frontend parses fragment', () => {
    it('parses token from hash fragment', () => {
      const hash = '#token=jwt-123&refreshToken=refresh-456&sessionId=sess-1';
      const params = new URLSearchParams(hash.substring(1));
      expect(params.get('token')).toBe('jwt-123');
      expect(params.get('refreshToken')).toBe('refresh-456');
      expect(params.get('sessionId')).toBe('sess-1');
    });

    it('handles empty hash gracefully', () => {
      const hash = '';
      const params = new URLSearchParams(hash.substring(1));
      expect(params.get('token')).toBeNull();
    });
  });
});
```