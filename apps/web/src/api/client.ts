// API 客户端底座（P3-a 自 api/index.ts 拆出）：axios 实例 + 拦截器
// （Bearer 注入 + 401 refresh 队列）+ refreshToken 帮手。
// 各域 api 文件从这里 import api；消费方仍可经 api/index.ts re-export 取用。
import axios from 'axios';
import type { AuthRefreshResult } from '@dommaker/studio-contract';

// API 基础 URL（相对路径，由 nginx 反向代理）
const API_BASE = import.meta.env.VITE_API_URL || '/api/v1';
export const api = axios.create({
  baseURL: API_BASE,
  headers: { 'Content-Type': 'application/json' },
  withCredentials: true,
});

// ─── Auth interceptor ───
// Reads localStorage directly (not authStore) to avoid circular dep:
// authStore.ts imports from '../api', so api cannot import authStore.

const AUTH_PATHS = ['/auth/login', '/auth/register', '/auth/guest-session', '/auth/refresh', '/auth/me'];

function isAuthPath(url: string | undefined): boolean {
  if (!url) return false;
  return AUTH_PATHS.some((p) => url.includes(p));
}

function getStoredAuth(): { token: string | null; refreshToken: string | null } {
  try {
    const raw = localStorage.getItem('auth-storage');
    if (!raw) return { token: null, refreshToken: null };
    const parsed = JSON.parse(raw);
    return { token: parsed?.state?.token ?? null, refreshToken: parsed?.state?.refreshToken ?? null };
  } catch {
    return { token: null, refreshToken: null };
  }
}

// Request interceptor: inject Bearer token
api.interceptors.request.use((config) => {
  const { token } = getStoredAuth();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});


interface QueuedRequest {
  resolve: (token: string) => void;
  reject: (err: unknown) => void;
}

let isRefreshing = false;
let failedQueue: QueuedRequest[] = [];

function flushQueue(error: unknown, token: string | null) {
  failedQueue.forEach(({ resolve, reject }) => {
    if (error || !token) {
      reject(error);
    } else {
      resolve(token);
    }
  });
  failedQueue = [];
}

/** Refresh access token using a refresh token. Uses standalone axios — no interceptor recursion. */
export async function refreshToken(refreshTokenValue: string): Promise<{ accessToken: string; refreshToken: string }> {
  // 契约驱动迁移（2026-10 批次 6/7）：响应统一 { data } 壳
  const { data } = await axios.post<{ data: AuthRefreshResult }>(`${API_BASE}/auth/refresh`, { refreshToken: refreshTokenValue });
  return { accessToken: data.data.accessToken, refreshToken: data.data.refreshToken };
}

// Response interceptor: catch 401 → refresh → retry
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config as (typeof error.config & { _retry?: boolean }) | undefined;

    // Skip if: no response, already retried, or auth path
    if (!error.response || !originalRequest || originalRequest._retry || isAuthPath(originalRequest.url)) {
      return Promise.reject(error);
    }

    if (error.response.status !== 401) {
      return Promise.reject(error);
    }

    // Concurrent 401 handling: queue while refresh is in progress
    if (isRefreshing) {
      return new Promise<string>((resolve, reject) => {
        failedQueue.push({ resolve, reject });
      }).then((newToken) => {
        originalRequest.headers.Authorization = `Bearer ${newToken}`;
        originalRequest._retry = true;
        return api.request(originalRequest);
      });
    }

    originalRequest._retry = true;
    isRefreshing = true;

    const { refreshToken: storedRefresh } = getStoredAuth();
    if (!storedRefresh) {
      isRefreshing = false;
      flushQueue(new Error('No refresh token'), null);
      localStorage.removeItem('auth-storage');
      return Promise.reject(error);
    }

    try {
      const { accessToken, refreshToken: newRefresh } = await refreshToken(storedRefresh);

      // Update localStorage
      const raw = localStorage.getItem('auth-storage');
      if (raw) {
        const stored = JSON.parse(raw);
        stored.state.token = accessToken;
        stored.state.refreshToken = newRefresh;
        localStorage.setItem('auth-storage', JSON.stringify(stored));
      }

      // Retry original + flush queue
      originalRequest.headers.Authorization = `Bearer ${accessToken}`;
      flushQueue(null, accessToken);
      return api.request(originalRequest);
    } catch (refreshError) {
      flushQueue(refreshError, null);
      localStorage.removeItem('auth-storage');
      return Promise.reject(refreshError);
    } finally {
      isRefreshing = false;
    }
  }
);
