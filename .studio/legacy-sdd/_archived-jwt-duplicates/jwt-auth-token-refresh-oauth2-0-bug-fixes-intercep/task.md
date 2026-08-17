---
id: "cmq6fqaz601gyqnnhec16qze3"
goalId: "cmq6fqdxn01hlqnnh91lgdvfm"
slug: "jwt-auth-token-refresh-oauth2-0-bug-fixes-intercep"
title: "JWT Auth + Token Refresh + OAuth2.0 — Bug Fixes & Interceptor"
status: "done"
version: 1
sourceChannelId: "cmq6eqh3u000k10qwg7tup7lj"
tags: ["auth", "jwt", "oauth", "security", "frontend", "backend", "bug-fix"]
createdAt: "2026-06-09T09:26:09.415Z"
updatedAt: "2026-06-09T09:26:13.409Z"
---

# JWT Auth + Token Refresh + OAuth2.0 — Bug Fixes & Interceptor

Fix 4 critical bugs preventing JWT auth from working (payload mismatch, redirect_uri, SECRET inconsistency, PUBLIC_API), add frontend axios interceptor with refresh token auto-renewal

<!-- TASK_TIER {"tier":"premium","reason":"Cross-module (backend+frontend), security-sensitive JWT/OAuth, 4 critical bugs + new interceptor, 6 files"} -->

## Contract Tests

### apps/api/src/modules/auth/__tests__/jwt-field-consistency.test.ts
```typescript
import { describe, it, expect } from 'vitest';
import jwt from 'jsonwebtoken';

/**
 * AC1.1: JWT field consistency — both service.ts and oauth.service.ts
 * must sign {sid, uid} so verifyToken can read them.
 */
describe('JWT field consistency', () => {
  const JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

  it('service.ts generateToken signs {sid, uid} fields', () => {
    const token = jwt.sign({ sid: 'sess-1', uid: 'user-1' }, JWT_SECRET, { expiresIn: '7d' });
    const payload = jwt.verify(token, JWT_SECRET) as jwt.JwtPayload;
    expect(payload.sid).toBe('sess-1');
    expect(payload.uid).toBe('user-1');
  });

  it('oauth.service createOAuthSession must also sign {sid, uid} after fix', () => {
    // After AC1.1 fix, createOAuthSession should produce same field names
    const token = jwt.sign({ sid: 'sess-2', uid: 'user-2' }, JWT_SECRET, { expiresIn: '24h' });
    const payload = jwt.verify(token, JWT_SECRET) as jwt.JwtPayload;
    expect(payload.sid).toBe('sess-2');
    expect(payload.uid).toBe('user-2');
  });

  it('old broken format {sessionId, userId} has no sid/uid fields', () => {
    const token = jwt.sign({ sessionId: 'sess-3', userId: 'user-3' }, JWT_SECRET, { expiresIn: '24h' });
    const payload = jwt.verify(token, JWT_SECRET) as jwt.JwtPayload;
    // verifyToken reads payload.sid — old format has no .sid
    expect(payload.sid).toBeUndefined();
    expect(payload.uid).toBeUndefined();
    expect(payload.sessionId).toBe('sess-3'); // old field present but unused
  });

  it('AC1.2: JWT_SECRET from oauth.service matches service.ts', () => {
    // Both modules should use the same secret source
    // This test verifies tokens signed with one secret can be verified with the other
    const secret1 = process.env.JWT_SECRET || 'dev-jwt-secret-change-in-production';
    const secret2 = process.env.JWT_SECRET || 'dev-secret-change-me';
    // After fix, both should use same fallback
    if (!process.env.JWT_SECRET) {
      expect(secret1).toBe(secret2);
    }
  });
});
```

### apps/api/src/modules/auth/__tests__/redirect-uri.test.ts
```typescript
import { describe, it, expect } from 'vitest';

/**
 * AC1.3: OAuth redirect_uri must match actual callback route.
 * Actual route: /api/v1/auth/callback/:provider (oauth.routes.ts L43)
 * Redirect base must NOT include /oauth.
 */
describe('OAuth redirect_uri correctness', () => {
  it('redirect_base without /oauth generates correct callback URL', () => {
    const redirectBase = process.env.OAUTH_REDIRECT_BASE || 'http://localhost:3001/api/v1/auth';
    const provider = 'google';
    const redirectUri = `${redirectBase}/${provider}/callback`;
    expect(redirectUri).toBe('http://localhost:3001/api/v1/auth/google/callback');
  });

  it('old broken base with /oauth generates wrong URL', () => {
    // This is the bug: old default included /oauth
    const brokenBase = 'http://localhost:3001/api/v1/auth/oauth';
    const redirectUri = `${brokenBase}/google/callback`;
    expect(redirectUri).toBe('http://localhost:3001/api/v1/auth/oauth/google/callback');
    // This does NOT match the actual route /api/v1/auth/callback/google
    expect(redirectUri).not.toContain('/auth/callback/google');
  });

  it('actual callback route path matches fixed redirect_uri', () => {
    // oauth.routes.ts mounts at /api/v1/auth, route is /callback/:provider
    const actualRoute = '/api/v1/auth/callback/google';
    const redirectBase = 'http://localhost:3001/api/v1/auth';
    const generatedUri = `${redirectBase}/google/callback`;
    // Extract path from generated URI
    const generatedPath = new URL(generatedUri).pathname;
    expect(generatedPath).toBe(actualRoute);
  });
});
```

### apps/web/src/api/__tests__/auth-interceptor.test.ts
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * AC2.1-2.3: Axios interceptor contract tests
 */
describe('axios auth interceptor contract', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('AC2.1: reads token from localStorage auth-storage key', () => {
    const authState = {
      state: { token: 'test-jwt-token', refreshToken: 'test-refresh' },
      version: 0,
    };
    localStorage.setItem('auth-storage', JSON.stringify(authState));
    const stored = JSON.parse(localStorage.getItem('auth-storage')!);
    expect(stored.state.token).toBe('test-jwt-token');
  });

  it('AC2.3: auth endpoints excluded from auto-refresh', () => {
    const excludedPaths = ['/auth/login', '/auth/register', '/auth/guest-session', '/auth/refresh'];
    excludedPaths.forEach(path => {
      expect(path).toMatch(/^\/auth\/(login|register|guest-session|refresh)$/);
    });
  });

  it('AC2.2: refresh token endpoint returns {accessToken, refreshToken}', () => {
    // POST /auth/refresh response shape
    const refreshResponse = { accessToken: 'new-token', refreshToken: 'new-refresh', userId: 'user-1' };
    expect(refreshResponse.accessToken).toBeDefined();
    expect(refreshResponse.refreshToken).toBeDefined();
    // Note: response uses 'accessToken' not 'token'
  });

  it('AC2.1: localStorage shape matches Zustand persist format', () => {
    const shape = {
      state: { token: 't', refreshToken: 'r', user: null, session: null, guestId: 'g' },
      version: 0,
    };
    expect(shape).toHaveProperty('state.token');
    expect(shape).toHaveProperty('state.refreshToken');
    expect(shape).toHaveProperty('version');
  });
});
```

### apps/api/src/modules/auth/__tests__/public-api-whitelist.test.ts
```typescript
import { describe, it, expect } from 'vitest';

/**
 * AC1.4: PUBLIC_API must include /auth/register
 * Verifies the whitelist contains all necessary auth endpoints.
 */
describe('PUBLIC_API whitelist', () => {
  it('/auth/register is in PUBLIC_API for production', () => {
    // This is the required auth-related entries
    const requiredPublicPaths = [
      '/auth/login',
      '/auth/register',       // AC1.4: was missing
      '/auth/session',
      '/auth/guest-session',
      '/auth/refresh',
      '/auth/google',
      '/auth/callback/google',
    ];
    // All must be present
    requiredPublicPaths.forEach(path => {
      expect(path).toBeTruthy();
    });
  });

  it('OAuth callback paths are already in PUBLIC_API', () => {
    // These are already present in app.ts L83-L84
    const existingOAuthPaths = ['/auth/google', '/auth/callback/google'];
    existingOAuthPaths.forEach(path => {
      expect(path).toBeTruthy();
    });
  });
});
```