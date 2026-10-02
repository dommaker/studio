// Auth API - 认证系统（P3-a 自 api/index.ts 拆出）
// 契约驱动迁移（2026-10 批次 6/7）：响应统一 { data } 壳并补泛型（原无泛型），
// 类型 import 自 @dommaker/studio-contract。
// getOAuthUrl/forgotPassword/resetPassword 后端无对应路由（死面），保持原样不补类型。
import type { AuthResult, AuthMeResult } from '@dommaker/studio-contract';
import { api } from './client';

export const authApi = {
  createGuestSession: (guestId: string) =>
    api.post<{ data: AuthResult }>('/auth/guest-session', { guestId }),
  checkAuth: () => api.get<{ data: AuthMeResult }>('/auth/me'),
  login: (email: string, password: string) =>
    api.post<{ data: AuthResult }>('/auth/login', { email, password }),
  register: (email: string, password: string, name?: string) =>
    api.post<{ data: AuthResult }>('/auth/register', { email, password, name }),
  logout: () => api.post<{ data: { success: boolean } }>('/auth/logout'),
  fetchMe: () => api.get<{ data: AuthMeResult }>('/auth/me'),
  /** Returns the OAuth authorization URL for the given provider */
  getOAuthUrl: (provider: 'google' | 'github'): string =>
    `${api.defaults.baseURL}/auth/${provider}`,
  /** Request password reset email */
  forgotPassword: (email: string) =>
    api.post('/auth/forgot-password', { email }),
  /** Reset password using token from email */
  resetPassword: (token: string, password: string) =>
    api.post('/auth/reset-password', { token, password }),
};
