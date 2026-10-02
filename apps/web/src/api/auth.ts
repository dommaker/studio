// Auth API - 认证系统（P3-a 自 api/index.ts 拆出）
// 契约驱动迁移（2026-10 批次 6/7）：响应统一 { data } 壳并补泛型（原无泛型），
// 类型 import 自 @dommaker/studio-contract。
// P3-a 死面清退：getOAuthUrl/forgotPassword/resetPassword 后端无对应路由
// （auth 模块 routes 仅 status/guest-session/register/login/logout/me/refresh），已删除。
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
};
