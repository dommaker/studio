---
id: "cmq6gmlia01o4qnnhrtp84j60"
goalId: "cmq6gmnw701okqnnhapfpov1g"
slug: "jwt-auth-token-refresh-oauth2-0-gap-closure-interc"
title: "JWT Auth + Token Refresh + OAuth2.0 — Gap Closure (Interceptor + Security + Consistency)"
status: "done"
version: 1
sourceChannelId: "cmq6eqh3u000k10qwg7tup7lj"
tags: ["auth", "jwt", "oauth", "interceptor", "security", "frontend", "backend"]
createdAt: "2026-06-09T09:51:16.066Z"
updatedAt: "2026-06-09T09:51:19.237Z"
---

# JWT Auth + Token Refresh + OAuth2.0 — Gap Closure (Interceptor + Security + Consistency)

Backend JWT/OAuth system is complete. Remaining gaps: (1) frontend axios interceptor for Bearer injection + 401 refresh, (2) OAuth token URL fragment security fix, (3) JWT expiry consistency alignment.

<!-- TASK_TIER {"tier":"standard","reason":"3 AC groups across frontend + backend, ~6 files, cross-module dependency (interceptor reads localStorage shape defined by authStore). Not premium because no schema changes, no new modules, no architecture decisions."} -->

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