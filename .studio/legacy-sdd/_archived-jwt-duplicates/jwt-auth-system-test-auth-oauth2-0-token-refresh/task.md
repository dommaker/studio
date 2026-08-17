---
id: "cmqj7g0mx02gqmekj45bvs69i"
slug: "jwt-auth-system-test-auth-oauth2-0-token-refresh"
title: "JWT 认证系统测试覆盖补全 — Auth + OAuth2.0 + Token 刷新"
status: "done"
tier: "standard"
version: 1
requirementVersion: 1
designVersion: 1
taskVersion: 1
createdAt: "2026-06-18T07:55:13.558Z"
updatedAt: "2026-06-18T07:55:13.558Z"
---

## Contract Tests

### apps/api/src/modules/auth/__tests__/service-edge.test.ts
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPrisma = {
  session: { create: vi.fn(), update: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn() },
  user: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  refreshToken: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() }
};

vi.mock('@dommaker/studio-prisma', () => ({ prisma: mockPrisma }));
vi.mock('jsonwebtoken', () => ({ default: { sign: vi.fn().mockReturnValue('mock-jwt') }, sign: vi.fn().mockReturnValue('mock-jwt') }));

import * as authService from '../service.js';

describe('Auth Service — Edge Cases', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  describe('getOrCreateSession', () => {
    it('should create a new session when none exists');
    it('should return existing valid session when one exists');
    it('should create new session if existing one is expired');
  });

  describe('cleanupExpiredSessions', () => {
    it('should delete sessions with expiresAt < now');
    it('should keep sessions with expiresAt > now');
    it('should return count of deleted sessions');
  });

  describe('verifyPassword — PBKDF2 legacy format', () => {
    it('should verify password against salt:hash format');
    it('should return needsRehash=true for PBKDF2 format');
    it('should throw on malformed hash (no colon)');
    it('should throw on invalid hex in salt or hash');
  });

  describe('login — needsRehash upgrade', () => {
    it('should silently rehash password when stored hash is PBKDF2');
    it('should NOT rehash when stored hash is already bcrypt');
  });

  describe('hashPassword', () => {
    it('should return bcrypt hash string');
    it('should use salt rounds from config');
  });
});

```
### apps/api/src/modules/auth/__tests__/oauth.code-exchange.test.ts
```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockPrisma = {
  oAuthAccount: { findUnique: vi.fn(), upsert: vi.fn() },
  user: { findUnique: vi.fn(), create: vi.fn(), upsert: vi.fn() },
  session: { create: vi.fn() },
  refreshToken: { create: vi.fn() }
};

vi.mock('@dommaker/studio-prisma', () => ({ prisma: mockPrisma }));
vi.mock('jsonwebtoken', () => ({ default: { sign: vi.fn().mockReturnValue('mock-jwt') }, sign: vi.fn().mockReturnValue('mock-jwt') }));

const originalFetch = global.fetch;

import * as oauthService from '../oauth.service.js';

describe('OAuth Code Exchange', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('exchangeCodeForTokens — Google', () => {
    it('should exchange code for Google tokens via global.fetch');
    it('should parse id_token from Google response for user profile');
    it('should throw on Google token endpoint error response');
    it('should throw on network failure to Google');
  });

  describe('exchangeCodeForTokens — GitHub', () => {
    it('should exchange code for GitHub access token');
    it('should fetch primary email from /user endpoint');
    it('should fallback to /user/emails when primary email is null');
    it('should throw when /user/emails returns empty array');
    it('should throw on GitHub token endpoint error');
  });

  describe('exchangeCodeForTokens — unsupported provider', () => {
    it('should throw for unsupported provider');
  });

  describe('getOrCreateOAuthUser — tokens.expiresAt null', () => {
    it('should handle GitHub-style tokens with no expires_in');
  });
});

```
### apps/api/src/modules/auth/__tests__/routes.test.ts
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../service.js');
vi.mock('../../../middleware/audit.js');

import * as authService from '../service.js';
import { auditService } from '../../../middleware/audit.js';

describe('Auth Routes — Integration', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  describe('POST /auth/guest-session', () => {
    it('should return 201 with accessToken and refreshToken');
    it('should call AuditService.log on success');
  });

  describe('POST /auth/register', () => {
    it('should return 201 with tokens for new user');
    it('should return 409 for duplicate email');
    it('should call AuditService.log on success');
  });

  describe('POST /auth/login', () => {
    it('should return 200 with tokens for valid credentials');
    it('should return 401 for invalid password');
    it('should return 401 for non-existent user');
    it('should call AuditService.log on success');
  });

  describe('POST /auth/logout', () => {
    it('should invalidate session and return 204');
    it('should call AuditService.log on success');
  });

  describe('GET /auth/me', () => {
    it('should return user info for valid token');
    it('should return 401 without Authorization header');
  });

  describe('POST /auth/refresh', () => {
    it('should return new accessToken for valid refreshToken');
    it('should return 401 for expired/revoked refreshToken');
  });

  describe('POST /auth/cleanup', () => {
    it('should allow admin to cleanup expired sessions');
    it('should return 403 for non-admin user');
  });
});

```
### apps/api/src/modules/auth/__tests__/oauth.routes.test.ts
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../oauth.service.js');

import * as oauthService from '../oauth.service.js';

describe('OAuth Routes — Integration', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  describe('GET /auth/oauth/:provider', () => {
    it('should redirect to OAuth authorization URL');
    it('should set CSRF state cookie with httpOnly');
    it('should return 400 for unsupported provider');
  });

  describe('GET /auth/oauth/:provider/callback', () => {
    it('should redirect to oauth_failed when state cookie is missing');
    it('should redirect to oauth_failed when state does not match');
    it('should redirect to oauth_failed when code param is missing');
    it('should redirect to oauth_failed when exchangeCodeForTokens fails');
    it('should redirect with access_token fragment on success');
    it('should clear CSRF state cookie after successful exchange');
  });
});

```
### apps/api/src/modules/auth/__tests__/middleware-additional.test.ts
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPrisma = {
  user: { findUnique: vi.fn() },
  session: { findUnique: vi.fn() },
  workspaceSession: { findUnique: vi.fn() }
};

vi.mock('@dommaker/studio-prisma', () => ({ prisma: mockPrisma }));
vi.mock('jsonwebtoken', () => ({ default: { verify: vi.fn() }, verify: vi.fn() }));

import { checkOwnership, requireNotGuest, workspaceAuth } from '../middleware/auth.js';

describe('Auth Middleware — Additional', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  describe('checkOwnership', () => {
    it('should call next() when resource.creatorId matches user id');
    it('should call next() when resource.createdBy matches user id (legacy field)');
    it('should call next() for admin user regardless of ownership');
    it('should return 404 when resource does not exist');
    it('should return 403 when user is not owner and not admin');
  });

  describe('requireNotGuest', () => {
    it('should call next() for role=user');
    it('should call next() for role=admin');
    it('should return 403 for role=guest');
  });

  describe('workspaceAuth', () => {
    it('should find workspace session by tokenHash and inject req.workspace');
    it('should return 401 when workspace session is revoked');
    it('should return 401 when tokenHash not found');
  });

  describe('generateAnonymousId', () => {
    it('should return same ID for same IP in same date window');
    it('should return different ID for different IPs');
    it('should return different ID for same IP in different date window');
  });

  describe('requireAuth — detailed 401 body', () => {
    it('should return JSON error body when session not found');
    it('should return JSON error body when session is expired');
  });

  describe('requireRole — edge cases', () => {
    it('should pass when user role matches any in array');
    it('should return 401 when user not found');
    it('should return 401 when req.user is null');
  });
});

```
### apps/api/src/modules/channels/__tests__/analyst-knowledge.test.ts
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs');
vi.mock('../../../utils/logger.js');

describe('Analyst Knowledge', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  describe('loadKnowledge', () => {
    it('should load and parse knowledge entries from filesystem');
    it('should return empty array when knowledge directory is empty');
    it('should skip invalid markdown files gracefully');
  });

  describe('queryKnowledge', () => {
    it('should return matching entries for a query');
    it('should return empty result for no match');
    it('should deduplicate results by entry ID');
  });
});

```
### apps/api/src/modules/channels/__tests__/analyst-prompt.test.ts
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('Analyst Prompt', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  describe('buildSystemPrompt', () => {
    it('should generate prompt with required sections');
    it('should include knowledge context when provided');
    it('should handle empty context gracefully');
  });

  describe('buildUserPrompt', () => {
    it('should wrap user input with instructions');
    it('should handle empty user input');
  });

  describe('truncateContext', () => {
    it('should pass through context under token limit');
    it('should truncate context exceeding token limit');
    it('should preserve section structure after truncation');
    it('should handle special characters without breaking template');
  });
});

```
### apps/api/src/modules/channels/__tests__/analyst-trigger.test.ts
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../analyst-prescan.js');
vi.mock('../analyst-scout.js');
vi.mock('../analyst-synthesizer.js');
vi.mock('../../../utils/logger.js');

describe('Analyst Trigger Service', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  describe('trigger', () => {
    it('should invoke full pipeline (prescan → scout → synthesizer)');
    it('should return AnalysisResult on success');
    it('should propagate prescan errors');
    it('should propagate scout errors');
    it('should propagate synthesizer errors');
  });

  describe('handleTriggerError', () => {
    it('should handle null/undefined input gracefully');
    it('should handle empty string input');
    it('should handle downstream service timeout');
  });
});

```