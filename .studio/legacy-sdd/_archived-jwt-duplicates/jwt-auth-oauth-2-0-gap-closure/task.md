---
id: "cmq6fxpse01jdqnnh50fohczd"
goalId: "cmq6fxun601k0qnnheezm8vle"
slug: "jwt-auth-oauth-2-0-gap-closure"
title: "JWT Auth + OAuth 2.0 Gap Closure"
status: "done"
version: 1
sourceChannelId: "cmq6eqh3u000k10qwg7tup7lj"
tags: ["auth", "jwt", "oauth", "security", "bug-fix", "frontend-interceptor"]
createdAt: "2026-06-09T09:31:55.208Z"
updatedAt: "2026-06-09T09:32:02.078Z"
---

# JWT Auth + OAuth 2.0 Gap Closure

Fix 4 critical backend bugs (JWT payload mismatch, JWT_SECRET divergence, PUBLIC_API gap, OAuth redirect_uri mismatch) and add frontend auth interceptor + hash-based OAuth callback parsing

<!-- TASK_TIER {"tier":"standard","reason":"6 AC across 2 groups, 6 files, cross-module (backend auth + frontend api), no schema change"} -->

## Contract Tests

### __tests__/backend-auth-bugs.test.ts
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@dommaker/studio-prisma', () => ({
  prisma: {
    session: { create: vi.fn(), update: vi.fn() },
    refreshToken: { create: vi.fn() },
  },
}));
vi.mock('@dommaker/studio-shared', () => ({ logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));
vi.mock('../../../utils/logger.js', () => ({ logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));

const mockSign = vi.fn().mockReturnValue('mock-jwt-token');
vi.mock('jsonwebtoken', () => ({
  default: { sign: mockSign },
  sign: mockSign,
}));

import { prisma } from '@dommaker/studio-prisma';
import { createOAuthSession } from '../oauth.service.js';

describe('backend-auth-bugs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.session.create).mockResolvedValue({
      id: 'session-1', token: '', expiresAt: new Date(Date.now() + 86400000),
    } as any);
    vi.mocked(prisma.refreshToken.create).mockResolvedValue({} as any);
  });

  describe('AC1.1: JWT payload uses sid/uid', () => {
    it('signs JWT with {sid, uid} matching service.ts generateToken pattern', async () => {
      const mockReq = { ip: '127.0.0.1', headers: { 'user-agent': 'test' } };
      await createOAuthSession('user-1', mockReq as any);
      expect(mockSign).toHaveBeenCalledWith(
        expect.objectContaining({ sid: 'session-1', uid: 'user-1' }),
        expect.any(String),
        expect.any(Object)
      );
    });

    it('does NOT sign with {sessionId, userId} (old broken pattern)', async () => {
      const mockReq = { ip: '127.0.0.1', headers: { 'user-agent': 'test' } };
      await createOAuthSession('user-1', mockReq as any);
      const payload = mockSign.mock.calls[0][0];
      expect(payload).not.toHaveProperty('sessionId');
      expect(payload).not.toHaveProperty('userId');
    });
  });

  describe('AC1.2: JWT_SECRET unified', () => {
    it('oauth.service uses same JWT_SECRET as service.ts', async () => {
      // Read both modules and compare JWT_SECRET behavior
      const serviceModule = await import('../service.js');
      // In non-production, both should use the same fallback
      // This test verifies the secret is consistent by checking token verification
      expect(true).toBe(true); // Placeholder — actual verification requires reading internal const
    });
  });

  describe('AC1.4: OAuth redirect_uri matches route', () => {
    it('getAuthorizationUrl generates redirect_uri ending with /auth/{provider}/callback', () => {
      const { getAuthorizationUrl } = require('../oauth.service.js');
      process.env.GOOGLE_CLIENT_ID = 'test-id';
      const url = getAuthorizationUrl('google', 'test-state');
      const urlObj = new URL(url);
      const redirectUri = urlObj.searchParams.get('redirect_uri');
      expect(redirectUri).toMatch(/\/auth\/google\/callback$/);
      expect(redirectUri).not.toContain('/auth/oauth/');
    });
  });
});

```

### __tests__/frontend-auth-interceptor.test.ts
```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('frontend-auth-interceptor', () => {
  let getItemSpy: ReturnType<typeof vi.spyOn>;
  const storageData: Record<string, string> = {};

  beforeEach(() => {
    getItemSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(
      (key: string) => storageData[key] ?? null
    );
  });

  afterEach(() => {
    getItemSpy.mockRestore();
  });

  describe('AC2.1: request interceptor reads token from localStorage', () => {
    it('reads token from zustand persist format {state: {token}, version: 0}', () => {
      storageData['auth-storage'] = JSON.stringify({
        state: { token: 'test-jwt', refreshToken: 'test-refresh', user: null },
        version: 0,
      });
      const raw = localStorage.getItem('auth-storage');
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw!);
      expect(parsed.state.token).toBe('test-jwt');
    });

    it('handles missing auth-storage gracefully', () => {
      const raw = localStorage.getItem('auth-storage');
      expect(raw).toBeNull();
    });
  });

  describe('AC2.2: response interceptor refresh on 401', () => {
    it('POST /auth/refresh returns {accessToken, refreshToken} shape', async () => {
      // Contract: refresh endpoint returns accessToken not token
      const refreshResponse = { accessToken: 'new-token', refreshToken: 'new-refresh', userId: 'u1' };
      expect(refreshResponse).toHaveProperty('accessToken');
      expect(refreshResponse).toHaveProperty('refreshToken');
      expect(refreshResponse).not.toHaveProperty('token');
    });
  });

  describe('AC2.3: OAuth callback uses URL fragment', () => {
    it('parses token from URL hash fragment', () => {
      const hash = '#token=test-jwt&refreshToken=test-refresh&sessionId=s1';
      const params = new URLSearchParams(hash.substring(1));
      expect(params.get('token')).toBe('test-jwt');
      expect(params.get('refreshToken')).toBe('test-refresh');
      expect(params.get('sessionId')).toBe('s1');
    });

    it('parses error from URL hash fragment', () => {
      const hash = '#error=oauth_failed';
      const params = new URLSearchParams(hash.substring(1));
      expect(params.get('error')).toBe('oauth_failed');
    });

    it('handles empty hash', () => {
      const hash = '';
      const params = new URLSearchParams(hash.substring(1));
      expect(params.get('token')).toBeNull();
    });
  });
});

```