---
id: "cmr01qh13005mg9d8dhfxakqf"
slug: "jwt-auth-system-token-refresh-oauth2-0"
title: "JWT 认证系统（Token 刷新 + OAuth2.0 第三方登录）"
status: "done"
tier: "standard"
version: 1
requirementVersion: 1
designVersion: 1
taskVersion: 1
createdAt: "2026-06-30T02:47:27.987Z"
updatedAt: "2026-06-30T02:47:27.987Z"
---

## Contract Tests

### apps/api/src/modules/auth/__tests__/service.test.ts
```typescript
describe('generateToken') — verify JWT payload contains { sid, uid }, expiresIn=7d, different JWT_SECRET fails verification
```
### apps/api/src/modules/auth/__tests__/service.test.ts
```typescript
describe('verifyPassword') — bcrypt valid/invalid, legacy PBKDF2 valid/invalid/needsRehash, null passwordHash for OAuth-only users
```
### apps/api/src/modules/auth/__tests__/routes.test.ts
```typescript
describe('POST /auth/register') — success returns AuthResult with refreshToken, duplicate email returns 409, missing fields returns 400
```
### apps/api/src/modules/auth/__tests__/routes.test.ts
```typescript
describe('POST /auth/login') — success returns AuthResult, guest sessions cleaned before login, wrong password 401, non-existent user 401, password hash upgrade on needsRehash
```
### apps/api/src/modules/auth/__tests__/routes.test.ts
```typescript
describe('POST /auth/logout') — expires session, revokes refresh tokens when userId provided, requires auth
```
### apps/api/src/modules/auth/__tests__/routes.test.ts
```typescript
describe('GET /auth/me') — returns user+session when authenticated, returns null when no token
```
### apps/api/src/modules/auth/__tests__/routes.test.ts
```typescript
describe('POST /auth/guest-session') — creates new guest session, reuses existing valid session by guestId
```
### apps/api/src/modules/auth/__tests__/service.test.ts
```typescript
describe('exchangeRefreshToken') — valid token returns new access+refresh pair, old token revoked, invalid/expired/revoked token returns null, concurrent consumption returns null for second request (revoke.count === 0)
```
### apps/api/src/modules/auth/__tests__/routes.test.ts
```typescript
describe('POST /auth/refresh') — returns { accessToken, refreshToken, userId }, missing refreshToken 400, invalid refreshToken 401
```
### apps/api/src/modules/auth/__tests__/oauth.service.test.ts
```typescript
describe('getAuthorizationUrl') — generates correct Google/GitHub URLs with state, client_id, redirect_uri (callback/{provider} format), throws on missing env vars
```
### apps/api/src/modules/auth/__tests__/oauth.service.test.ts
```typescript
describe('exchangeCode') — exchanges code for tokens (Google: form-urlencoded, GitHub: JSON+Accept), returns OAuthProfile with providerAccountId/email/name/avatar
```
### apps/api/src/modules/auth/__tests__/oauth.routes.test.ts
```typescript
describe('GET /auth/:provider') — sets oauth_state cookie, redirects to provider auth URL, 500 on invalid provider
```
### apps/api/src/modules/auth/__tests__/oauth.routes.test.ts
```typescript
describe('GET /auth/callback/:provider') — verifies CSRF state, clears cookie, exchanges code, creates user via 3-path resolution, redirects with fragment on success, query param error on failure
```
### apps/api/src/modules/auth/__tests__/service.test.ts
```typescript
describe('createGuestSession') — 24h expiration, two-phase write (create empty token → sign → update token)
```
### apps/api/src/modules/auth/__tests__/service.test.ts
```typescript
describe('getOrCreateSession') — reuses existing valid guest session by guestId, creates new when expired/missing, returns correct AuthResult
```
### apps/api/src/middleware/__tests__/rate-limit.test.ts
```typescript
describe('authRateLimit') — blocks requests exceeding 10/min, returns 429 with Retry-After, resets after window
```
### apps/api/src/modules/auth/__tests__/middleware-invocation.test.ts
```typescript
describe('requireAuth middleware') — returns 401 for missing token, 401 for expired token (TOKEN_EXPIRED code), 401 for invalid session (SESSION_NOT_FOUND)
```
### apps/api/src/modules/auth/__tests__/middleware-invocation.test.ts
```typescript
describe('optionalAuth middleware') — generates anonymousId for unauthenticated requests, populates user/session for valid token
```
### apps/web/src/api/__tests__/interceptor.test.ts
```typescript
describe('request interceptor') — injects Bearer token from localStorage 'auth-storage' key, skips when no token stored
```
### apps/web/src/api/__tests__/interceptor.test.ts
```typescript
describe('response interceptor 401') — triggers refresh on 401, updates localStorage with new tokens, retries original request, skips refresh for AUTH_PATHS, queues concurrent 401 requests
```
### apps/web/src/stores/__tests__/authStore.test.ts
```typescript
describe('authStore') — stores/retrieves token and refreshToken from localStorage, clears on logout
```