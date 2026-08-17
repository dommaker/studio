---
id: "cmqj89zbi034lmekj4m74xaiu"
slug: "jwt-auth-system-test"
title: "JWT 认证系统测试覆盖补全 + 边界加固"
status: "done"
tier: "standard"
version: 1
requirementVersion: 1
designVersion: 1
taskVersion: 1
createdAt: "2026-06-18T08:18:31.034Z"
updatedAt: "2026-06-18T08:18:31.034Z"
---

## Contract Tests

### apps/api/src/modules/auth/__tests__/routes.test.ts
```typescript
// POST /guest-session: 200 → AuthResult with token+session; POST /register: 400 missing fields, 409 email exists, 201 → user+token+session; POST /login: 400 missing fields, 401 wrong password, 200 → user+token+refreshToken; POST /logout: 401 no token, 200 → success; GET /me: 200 with token → user+session, 200 without token → null; POST /refresh: 400 missing refreshToken, 401 invalid/expired, 200 → new access+refresh tokens
```
### apps/api/src/modules/auth/__tests__/oauth.routes.test.ts
```typescript
// GET /:provider: 302 redirect to provider auth URL, Set-Cookie oauth_state; invalid provider → 400; GET /callback/:provider: missing state cookie → 400, state mismatch → 403, valid callback → 302 redirect with #access_token+refresh_token; exchangeCodeForTokens throws → 302 redirect with ?error=
```
### apps/api/src/modules/auth/__tests__/middleware-auth.test.ts
```typescript
// workspaceAuth: valid Bearer token → sha256 hash → findUnique returns workspace → req.workspace set → next(); no Auth header → 401; invalid hash → 401; expired token → 401
// checkOwnership: user owns resource → next(); not owner → 403; Admin role → next() (skip check); invalid model name → 500
// requireNotGuest: Guest role → 403; User/Admin role → next(); no user (unauthenticated) → 401
// generateAnonymousId: same IP+UA+date → same hash; different IP → different hash
```
### apps/api/src/middleware/__tests__/rate-limit.test.ts
```typescript
// authRateLimit: windowMs === 60*1000, max === 10, standardHeaders === true; 11th request within window → 429 Too Many Requests
// refreshRateLimit: windowMs === 60*1000, max === 20, standardHeaders === true; 21st request → 429
```
### apps/api/src/modules/auth/__tests__/oauth.exchange.test.ts
```typescript
// Google exchange: mock fetch token endpoint → { access_token, expires_in, token_type }; mock userinfo → { email, email_verified: true, name, picture }; verify exchangeGoogleCode returns profile+tokens
// Google exchange error: token endpoint → { error: 'invalid_grant' } → throw with 400; userinfo → 401 → throw with 502
// GitHub exchange: mock token endpoint → URL-encoded access_token; mock /user → { email: null, login, avatar_url }; mock /user/emails → [{ email, primary: true, verified: true }]; verify profile.email from emails fallback
// GitHub no verified email: /user/emails → [] or all verified=false → throw 'No verified email found'
```
### apps/api/src/modules/auth/__tests__/service.test.ts
```typescript
// Concurrent exchangeRefreshToken: 2 concurrent calls with same token → first succeeds (new pair returned), second returns null (revokedAt already set); revokeRefreshToken idempotence: revoke already-revoked token → returns false (no update)
```
### apps/web/src/api/__tests__/interceptor-concurrency.test.ts
```typescript
// Concurrent 401 queue: 3 parallel API calls all return 401 → only 1 refresh request sent → all 3 retried with new token → verify isRefreshing flag reset after flush
```
### apps/web/src/stores/__tests__/authStore.test.ts
```typescript
// login: calls API → sets user/session/token/refreshToken; register: calls API → sets user/session/token + isNewUser; logout: clears state → calls API; refreshToken: reads localStorage → calls API → updates token; getCurrentUser: calls /auth/me → sets user/session
```
### apps/web/src/components/__tests__/OAuthCallback.test.tsx
```typescript
// Valid hash: #access_token=abc&refresh_token=xyz → setAuth called → redirect to /; Error hash: #error=access_denied → error displayed; No hash: no action, component renders null/loading
```
### apps/api/src/middleware/__tests__/audit-logger.test.ts
```typescript
// auditLogger('LOGIN_SUCCESS'): calls AuditService.log with { action, userId, ip, userAgent, timestamp }; auditLogger('LOGIN_FAILURE'): includes metadata { reason, email }; auditLogger('ROLE_CHANGE'): includes metadata { from, to, changedBy }; auditLogger('LOGOUT'): calls AuditService.log; error in AuditService.log → next() still called (fire-and-forget)
```
### apps/api/src/modules/auth/__tests__/service.test.ts
```typescript
// verifyPassword with legacy PBKDF2 hash: 'hexSalt:hexHash' format → valid:true + needsRehash:true; wrong password → valid:false + needsRehash:false
// login with legacy password: user.passwordHash is PBKDF2 format → verifyPassword returns needsRehash → prisma.user.update called with bcrypt hash → login response returns AuthResult
```