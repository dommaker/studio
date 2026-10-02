// authApi — 认证：端点契约测试（P3-a 自 api/index.ts 拆出后的归位文件）
import { describe, it, expect, vi } from 'vitest';

const { mockGet, mockPost } = vi.hoisted(() => ({ mockGet: vi.fn(), mockPost: vi.fn() }));
vi.mock('../client', () => ({ api: { get: mockGet, post: mockPost, defaults: { baseURL: '/api/v1' } } }));

import { authApi } from '../auth';

describe('authApi（认证）', () => {
  it('createGuestSession → POST /auth/guest-session', () => {
    authApi.createGuestSession('guest_1');
    expect(mockPost).toHaveBeenCalledWith('/auth/guest-session', { guestId: 'guest_1' });
  });

  it('checkAuth / fetchMe → GET /auth/me', () => {
    authApi.checkAuth();
    authApi.fetchMe();
    expect(mockGet).toHaveBeenNthCalledWith(1, '/auth/me');
    expect(mockGet).toHaveBeenNthCalledWith(2, '/auth/me');
  });

  it('login → POST /auth/login', () => {
    authApi.login('a@b.c', 'pw');
    expect(mockPost).toHaveBeenCalledWith('/auth/login', { email: 'a@b.c', password: 'pw' });
  });

  it('register → POST /auth/register（name 可选）', () => {
    authApi.register('a@b.c', 'pw', 'Alice');
    expect(mockPost).toHaveBeenCalledWith('/auth/register', { email: 'a@b.c', password: 'pw', name: 'Alice' });
  });

  it('logout → POST /auth/logout', () => {
    authApi.logout();
    expect(mockPost).toHaveBeenCalledWith('/auth/logout');
  });
});
