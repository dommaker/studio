---
id: "cmq6he2at01vsqnnh6s0gml7q"
goalId: "cmq6he5xp01w3qnnh3ckzvgzt"
slug: "jwt-auth-gap-closure-axios-interceptor-oauth-fragm-vgzt"
title: "JWT Auth Gap Closure — Axios Interceptor + OAuth Fragment Security + Expiry Consistency"
status: "stale"
version: 1
sourceChannelId: "cmq6eqh3u000k10qwg7tup7lj"
tags: ["auth", "jwt", "oauth", "interceptor", "security", "frontend", "backend"]
createdAt: "2026-06-09T10:12:37.532Z"
updatedAt: "2026-06-09T10:12:42.317Z"
---

> **DEPRECATED**: Superseded by `jwt-auth-gap-closure-axios-interceptor-oauth-fragm`. This doc is kept for historical reference only.

# JWT Auth Gap Closure — Axios Interceptor + OAuth Fragment Security + Expiry Consistency

Backend JWT/OAuth/refresh-token system is complete (32 tests pass). Remaining gaps: (1) frontend axios interceptor for automatic Bearer injection + 401 refresh queue, (2) OAuth token URL fragment security fix to prevent Referer leakage, (3) JWT/session expiry alignment between OAuth and email/password flows.

<!-- TASK_TIER {"tier":"standard","reason":"3 AC groups across 4 files (2 frontend, 2 backend), cross-module dependency (interceptor reads localStorage shape defined by authStore). No schema changes, no new modules, no architecture decisions."} -->

## Contract Tests

### __tests__/auth-interceptor.test.ts
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('Axios Auth Interceptor', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe('request interceptor', () => {
    it('should inject Authorization header when token exists in localStorage', () => {
      const stored = JSON.stringify({ state: { token: 'test-jwt', refreshToken: 'test-refresh' }, version: 0 });
      localStorage.setItem('auth-storage', stored);
      // After implementation: config.headers.Authorization should be 'Bearer test-jwt'
    });

    it('should not inject Authorization header when no token in localStorage', () => {
      // After implementation: config.headers should not have Authorization
    });
  });

  describe('response interceptor', () => {
    it('should refresh token on 401 and retry original request', () => {
      // After implementation: 401 response → POST /auth/refresh → retry with new token
    });

    it('should exclude /auth/* paths from auto-refresh', () => {
      // After implementation: 401 on /auth/login should NOT trigger refresh
    });

    it('should queue concurrent 401 requests during refresh', () => {
      // After implementation: multiple 401s → single refresh → batch retry
    });

    it('should reject when refreshToken is missing', () => {
      // After implementation: 401 + no refreshToken → direct reject, no refresh attempt
    });
  });
});
```

### __tests__/oauth-fragment.test.ts
```typescript
import { describe, it, expect, vi } from 'vitest';

describe('OAuth Token Fragment', () => {
  it('should redirect with token in URL fragment not query params', async () => {
    // After implementation: res.redirect called with '#token=...' not '?token=...'
    // Verify: oauth.routes.ts L81 uses '#' separator
  });

  it('should parse token from window.location.hash', () => {
    // After implementation: OAuthCallback reads hash, not searchParams
    // Verify: new URLSearchParams(window.location.hash.slice(1)) extracts token
  });

  it('should clear hash after parsing', () => {
    // After implementation: window.history.replaceState called to remove hash
  });

  it('should keep error in query params', () => {
    // After implementation: ?error=... still in query params (not fragment)
  });
});
```

### __tests__/jwt-expiry-consistency.test.ts
```typescript
import { describe, it, expect, vi } from 'vitest';

describe('JWT Expiry Consistency', () => {
  it('should create OAuth session with 7-day expiry', async () => {
    // After implementation: prisma.session.create called with expiresAt ~7 days from now
    // Verify: oauth.service.ts L320 uses 7 * 24 * 60 * 60 * 1000
  });

  it('should sign OAuth JWT with 7-day expiry', async () => {
    // After implementation: jwt.sign called with { expiresIn: '7d' }
    // Verify: oauth.service.ts L336 uses '7d'
  });
});
```