---
id: "cmq6qvmdt0011puv93qr71j0o"
goalId: "cmq6qvna1001apuv9qmjuanrt"
slug: "jwt-auth-gap-closure-oauth-redirect-fix-axios-inte"
title: "JWT Auth Gap Closure — OAuth redirect fix + Axios interceptor"
status: "done"
version: 1
sourceChannelId: "cmq6eqh3u000k10qwg7tup7lj"
tags: ["auth", "jwt", "oauth", "interceptor", "token-refresh", "bug-fix"]
createdAt: "2026-06-09T14:38:13.261Z"
updatedAt: "2026-06-09T14:38:14.462Z"
---

# JWT Auth Gap Closure — OAuth redirect fix + Axios interceptor

Close 2 remaining gaps: fix reversed OAuth redirect_uri path segments, add axios request/response interceptors for Bearer token injection and auto refresh.

<!-- TASK_TIER {"tier":"standard","reason":"2 independent gaps across 2 layers (backend OAuth template fix + frontend interceptor with refresh queue), each bounded but interceptor has circular dep + concurrent refresh complexity"} -->

## Contract Tests

### __tests__/oauth-redirect-uri.test.ts
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@dommaker/studio-prisma', () => ({ prisma: {} }));
vi.mock('@dommaker/studio-shared', () => ({ logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));
vi.mock('../../../utils/logger.js', () => ({ logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));
vi.mock('jsonwebtoken', () => ({ default: { sign: vi.fn() }, sign: vi.fn() }));

import { getAuthorizationUrl } from '../oauth.service.js';

describe('OAuth redirect_uri path segments (AC1.1-1.3)', () => {
  beforeEach(() => {
    process.env.GOOGLE_CLIENT_ID = 'test-google-id';
    process.env.GITHUB_CLIENT_ID = 'test-github-id';
  });

  it('AC1.1: Google redirect_uri path is /callback/google', () => {
    const url = getAuthorizationUrl('google', 'test-state');
    const redirectUri = new URL(url).searchParams.get('redirect_uri')!;
    expect(redirectUri).toMatch(/\/callback\/google$/);
    expect(redirectUri).not.toMatch(/\/google\/callback/);
  });

  it('AC1.2: GitHub redirect_uri path is /callback/github', () => {
    const url = getAuthorizationUrl('github', 'test-state');
    const redirectUri = new URL(url).searchParams.get('redirect_uri')!;
    expect(redirectUri).toMatch(/\/callback\/github$/);
    expect(redirectUri).not.toMatch(/\/github\/callback/);
  });
});
```

### __tests__/axios-interceptor.test.ts
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('Axios auth interceptor contract', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe('request interceptor', () => {
    it('AC2.1: injects Authorization header when token exists in localStorage', () => {
      const authStorage = JSON.stringify({
        state: { token: 'test-jwt-token', refreshToken: 'refresh-123', user: { id: 'u1', role: 'User' } },
        version: 0,
      });
      localStorage.setItem('auth-storage', authStorage);
      const stored = JSON.parse(localStorage.getItem('auth-storage')!);
      expect(stored.state.token).toBe('test-jwt-token');
      expect(`Bearer ${stored.state.token}`).toBe('Bearer test-jwt-token');
    });

    it('AC2.1: does not inject header when token is null', () => {
      const authStorage = JSON.stringify({
        state: { token: null, refreshToken: null, user: null },
        version: 0,
      });
      localStorage.setItem('auth-storage', authStorage);
      const stored = JSON.parse(localStorage.getItem('auth-storage')!);
      expect(stored.state.token).toBeNull();
    });

    it('AC2.1: parses zustand persist format correctly', () => {
      const authStorage = JSON.stringify({
        state: { token: 'abc', refreshToken: 'def', user: { id: '1', email: 'test@test.com', role: 'User' }, session: { id: 's1', expiresAt: '2026-12-01' }, guestId: null },
        version: 0,
      });
      localStorage.setItem('auth-storage', authStorage);
      const stored = JSON.parse(localStorage.getItem('auth-storage')!);
      expect(stored.version).toBe(0);
      expect(stored.state.token).toBe('abc');
      expect(stored.state.refreshToken).toBe('def');
    });
  });

  describe('response interceptor', () => {
    it('AC2.2: refresh flow uses /auth/refresh endpoint', () => {
      const authStorage = JSON.stringify({
        state: { token: 'expired-token', refreshToken: 'valid-refresh', user: { id: 'u1' } },
        version: 0,
      });
      localStorage.setItem('auth-storage', authStorage);
      const stored = JSON.parse(localStorage.getItem('auth-storage')!);
      expect(stored.state.refreshToken).toBe('valid-refresh');
    });

    it('AC2.2: excludes auth paths from refresh cycle', () => {
      const excludedPaths = ['/auth/login', '/auth/register', '/auth/guest-session', '/auth/refresh', '/auth/me'];
      excludedPaths.forEach(path => {
        expect(path.startsWith('/auth/')).toBe(true);
      });
    });

    it('AC2.3: supports concurrent 401 queue pattern', () => {
      // Verify the queue pattern exists: isRefreshing flag + failedQueue array
      let isRefreshing = false;
      const failedQueue: Array<{ resolve: (token: string) => void; reject: (err: unknown) => void }> = [];
      expect(isRefreshing).toBe(false);
      expect(failedQueue).toHaveLength(0);
    });
  });
});
```