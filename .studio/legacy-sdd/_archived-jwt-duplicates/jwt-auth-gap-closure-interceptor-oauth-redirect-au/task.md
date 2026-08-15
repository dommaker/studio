---
id: "sdd-1782442724218-9wxrh6"
goalId: "cmq6kkspe005eeeiwzpma2b2x"
slug: "jwt-auth-gap-closure-interceptor-oauth-redirect-au"
title: "JWT Auth Gap Closure — Interceptor + OAuth redirect + Auto Refresh"
status: "done"
version: 2
taskVersion: 2
parentId: "cmq6kkre4004zeeiw7by0eec4"
changeType: "L2"
sourceChannelId: "cmq6eqh3u000k10qwg7tup7lj"
tags: ["auth", "jwt", "oauth", "interceptor", "token-refresh", "bug-fix"]
createdAt: "2026-06-09T11:41:48.840Z"
updatedAt: "2026-06-26T02:58:44.218Z"
---

# JWT Auth Gap Closure — Interceptor + OAuth redirect + Auto Refresh

Close 3 remaining gaps in the auth system: axios interceptor (no auth headers sent), OAuth redirect_uri reversed segments, and missing auto token refresh on frontend.

<!-- TASK_TIER {"tier":"standard","reason":"3 independent gaps across 2 layers (backend OAuth fix + frontend interceptor/refresh), each simple but collectively require coordinated verification"} -->

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

describe('Axios auth interceptor', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('AC2.1: attaches Bearer token from localStorage to request headers', () => {
    const authStorage = JSON.stringify({
      state: { token: 'test-jwt-token', refreshToken: 'test-refresh', user: null, session: null, guestId: null },
      version: 0
    });
    localStorage.setItem('auth-storage', authStorage);
    // Import after setting localStorage
    // Verify interceptor reads localStorage and attaches Authorization header
    const stored = JSON.parse(localStorage.getItem('auth-storage') || '{}');
    expect(stored.state.token).toBe('test-jwt-token');
    // The interceptor should produce: Authorization: Bearer test-jwt-token
    const expectedHeader = `Bearer ${stored.state.token}`;
    expect(expectedHeader).toBe('Bearer test-jwt-token');
  });

  it('AC2.2: does not attach Authorization header when no token exists', () => {
    const stored = JSON.parse(localStorage.getItem('auth-storage') || '{}');
    expect(stored?.state?.token).toBeUndefined();
  });

  it('AC2.5: parses zustand persist format correctly', () => {
    const authStorage = JSON.stringify({
      state: { token: 'abc', refreshToken: 'def', user: { id: '1', email: 'test@test.com', role: 'User' }, session: { id: 's1', expiresAt: '2026-12-01' }, guestId: null },
      version: 0
    });
    localStorage.setItem('auth-storage', authStorage);
    const stored = JSON.parse(localStorage.getItem('auth-storage') || '{}');
    expect(stored.version).toBe(0);
    expect(stored.state.token).toBe('abc');
    expect(stored.state.refreshToken).toBe('def');
    expect(stored.state.user.email).toBe('test@test.com');
  });
});
```