/**
 * auth 域契约测试：实体 parity + 请求边界 + 响应壳。
 * 正本 = apps/api/src/modules/auth/routes.ts + service.ts（AuthResult/SafeUser/SessionData）
 * + 前端 authStore 实际消费。
 */

import { describe, it, expect } from 'vitest';
import {
  authUserSchema,
  type AuthUser,
  authSessionSchema,
  type AuthSession,
  authResultSchema,
  type AuthResult,
  authStatusResultSchema,
  authMeResultSchema,
  type AuthMeResult,
  authRefreshResultSchema,
  type AuthRefreshResult,
  guestSessionBodySchema,
  registerBodySchema,
  loginBodySchema,
  refreshBodySchema,
  authStatusResponseSchema,
  authResultResponseSchema,
  authRefreshResponseSchema,
  logoutResponseSchema,
  cleanupResponseSchema,
} from '../auth.js';
import * as contractIndex from '../index.js';

const user: AuthUser = {
  id: 'u1',
  email: 'a@b.com',
  name: 'Alice',
  avatar: null,
  role: 'User',
  emailVerified: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

const session: AuthSession = {
  id: 's1',
  userId: 'u1',
  token: 'jwt',
  guestId: null,
  ipAddress: null,
  userAgent: null,
  expiresAt: '2026-09-08T00:00:00.000Z',
  createdAt: '2026-09-01T00:00:00.000Z',
  refreshToken: null,
};

describe('实体 parity', () => {
  it('AuthUser fixture 通过校验；nullable 字段 null 合法；缺必填抛错', () => {
    expect(authUserSchema.parse(user)).toEqual(user);
    expect(() => authUserSchema.parse({ ...user, id: undefined })).toThrow();
    expect(() => authUserSchema.parse({ ...user, role: undefined })).toThrow();
  });

  it('AuthSession fixture 通过校验；refreshToken 响应面恒 null', () => {
    expect(authSessionSchema.parse(session)).toEqual(session);
    expect(() => authSessionSchema.parse({ ...session, expiresAt: undefined })).toThrow();
  });

  it('AuthResult：login/register 带 user+refreshToken；guest-session 可无 user/refreshToken', () => {
    const loginResult: AuthResult = { user, session, token: 'jwt', refreshToken: 'rt' };
    expect(authResultSchema.parse(loginResult)).toEqual(loginResult);
    const guestResult: AuthResult = { session, token: 'jwt' };
    expect(authResultSchema.parse(guestResult)).toEqual(guestResult);
    expect(() => authResultSchema.parse({ session, token: undefined })).toThrow();
  });

  it('AuthMeResult / AuthRefreshResult fixture', () => {
    const me: AuthMeResult = { user, session };
    expect(authMeResultSchema.parse(me)).toEqual(me);
    expect(authMeResultSchema.parse({ user: null, session: null })).toEqual({ user: null, session: null });
    const refresh: AuthRefreshResult = { accessToken: 'at', refreshToken: 'rt', userId: 'u1' };
    expect(authRefreshResultSchema.parse(refresh)).toEqual(refresh);
  });
});

describe('请求边界', () => {
  it('guest-session：guestId 可选（空 body 合法）', () => {
    expect(guestSessionBodySchema.parse({})).toEqual({});
    expect(guestSessionBodySchema.parse({ guestId: 'g1' })).toEqual({ guestId: 'g1' });
  });

  it('register/login：email/password 必填（原 service 抛错收进 zod）', () => {
    expect(registerBodySchema.parse({ email: 'a@b.com', password: 'p' })).toEqual({ email: 'a@b.com', password: 'p' });
    expect(registerBodySchema.parse({ email: 'a@b.com', password: 'p', name: 'N' }).name).toBe('N');
    expect(() => registerBodySchema.parse({ password: 'p' })).toThrow();
    expect(() => loginBodySchema.parse({ email: 'a@b.com' })).toThrow();
    expect(() => loginBodySchema.parse({ email: '', password: 'p' })).toThrow();
  });

  it('refresh：refreshToken 必填（原手写 400 收进 zod）', () => {
    expect(refreshBodySchema.parse({ refreshToken: 'rt' })).toEqual({ refreshToken: 'rt' });
    expect(() => refreshBodySchema.parse({})).toThrow();
  });
});

describe('响应壳', () => {
  it('GET /status：mode=none 本地用户 / mode=on user=null', () => {
    const noneRes = { mode: 'none', user: { id: 'local', name: 'Local User', role: 'Admin' } };
    expect(authStatusResultSchema.parse(noneRes)).toEqual(noneRes);
    expect(authStatusResponseSchema.parse({ data: { mode: 'on', user: null } }).data.user).toBeNull();
    expect(() => authStatusResultSchema.parse({ mode: 'bogus', user: null })).toThrow();
  });

  it('login → { data: AuthResult }；logout/cleanup → { data: { success|cleaned } }', () => {
    const result: AuthResult = { user, session, token: 'jwt', refreshToken: 'rt', isNewUser: true };
    expect(authResultResponseSchema.parse({ data: result }).data.token).toBe('jwt');
    expect(logoutResponseSchema.parse({ data: { success: true } }).data.success).toBe(true);
    expect(cleanupResponseSchema.parse({ data: { cleaned: 3 } }).data.cleaned).toBe(3);
  });

  it('refresh → { data: { accessToken, refreshToken, userId } }', () => {
    const r = { accessToken: 'at', refreshToken: 'rt', userId: 'u1' };
    expect(authRefreshResponseSchema.parse({ data: r }).data.accessToken).toBe('at');
  });
});

describe('index.ts 出口', () => {
  it('auth 域 schema 经 index 导出', () => {
    expect(contractIndex.authResultSchema).toBeDefined();
    expect(contractIndex.loginBodySchema).toBeDefined();
    expect(contractIndex.authRefreshResponseSchema).toBeDefined();
  });
});
