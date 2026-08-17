---
id: "cmq6i4znn01z6qnnhczsy0pm5"
goalId: "cmq6i53h401zfqnnhgmkc292v"
slug: "jwt-auth-token-refresh-oauth2-0-interceptor-fragme"
title: "JWT Auth + Token Refresh + OAuth2.0 — 剩余缺口闭合 (Interceptor + Fragment Security)"
status: "done"
version: 1
sourceChannelId: "cmq6eqh3u000k10qwg7tup7lj"
tags: ["auth", "jwt", "oauth", "interceptor", "security", "frontend", "backend"]
createdAt: "2026-06-09T10:33:33.819Z"
updatedAt: "2026-06-09T10:33:38.860Z"
---

# JWT Auth + Token Refresh + OAuth2.0 — 剩余缺口闭合 (Interceptor + Fragment Security)

Backend JWT/OAuth/Refresh 全部完成 (32/32 tests)。剩余缺口：(1) 前端 axios interceptor 注入 Bearer + 401 自动刷新，(2) OAuth token URL fragment 安全修复。

<!-- TASK_TIER {"tier":"standard","reason":"2 AC 组，3 文件，无 schema 变更，无新模块。interceptor 逻辑复杂（并发队列 + 循环依赖规避）但不涉及架构决策。"} -->

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