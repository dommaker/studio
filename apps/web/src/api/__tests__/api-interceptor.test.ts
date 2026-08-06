import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Hoist mock objects — available inside vi.mock factory
const { mockAxiosInstance, standalonePost } = vi.hoisted(() => {
  const mockAxiosInstance = {
    interceptors: {
      request: { use: vi.fn() },
      response: { use: vi.fn() },
    },
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    request: vi.fn(),
    defaults: { headers: { common: {} } },
  };
  return { mockAxiosInstance, standalonePost: vi.fn() };
});

vi.mock('axios', () => ({
  default: {
    create: vi.fn(() => mockAxiosInstance),
    post: standalonePost,
  },
}));

import axios from 'axios';
import { api, refreshToken } from '../index';

// Capture interceptor callbacks — set during module load
let requestInterceptor: ((config: unknown) => unknown) | null = null;
let responseRejected: ((error: unknown) => unknown) | null = null;

const reqUseCalls = mockAxiosInstance.interceptors.request.use.mock.calls;
const resUseCalls = mockAxiosInstance.interceptors.response.use.mock.calls;
if (reqUseCalls.length > 0) requestInterceptor = reqUseCalls[0][0] as (config: unknown) => unknown;
if (resUseCalls.length > 0) responseRejected = resUseCalls[0][1] as (error: unknown) => unknown;

describe('Axios auth interceptor', () => {
  beforeEach(() => {
    localStorage.clear();
    mockAxiosInstance.post.mockReset();
    mockAxiosInstance.request.mockReset();
    vi.mocked(axios.post).mockReset();
  });

  afterEach(() => {
    localStorage.clear();
  });

  // ─── AC2.1: Request interceptor ───

  describe('AC2.1: request interceptor', () => {
    it('injects Authorization header when token exists', () => {
      localStorage.setItem('auth-storage', JSON.stringify({
        state: { token: 'test-jwt', refreshToken: 'r', user: null, session: null, guestId: null },
        version: 0,
      }));

      const config = { headers: {} as Record<string, string>, url: '/tasks' };
      const result = requestInterceptor!(config) as { headers: Record<string, string> };

      expect(result.headers.Authorization).toBe('Bearer test-jwt');
    });

    it('does not inject header when token is null', () => {
      localStorage.setItem('auth-storage', JSON.stringify({
        state: { token: null, refreshToken: null, user: null },
        version: 0,
      }));

      const config = { headers: {} as Record<string, string>, url: '/tasks' };
      const result = requestInterceptor!(config) as { headers: Record<string, string> };

      expect(result.headers.Authorization).toBeUndefined();
    });

    it('does not inject header when localStorage is empty', () => {
      const config = { headers: {} as Record<string, string>, url: '/tasks' };
      const result = requestInterceptor!(config) as { headers: Record<string, string> };

      expect(result.headers.Authorization).toBeUndefined();
    });

    it('parses zustand persist format {state:{token,...},version:0}', () => {
      localStorage.setItem('auth-storage', JSON.stringify({
        state: { token: 'abc', refreshToken: 'def', user: { id: '1' }, session: null, guestId: null },
        version: 0,
      }));

      const config = { headers: {} as Record<string, string>, url: '/tasks' };
      const result = requestInterceptor!(config) as { headers: Record<string, string> };

      expect(result.headers.Authorization).toBe('Bearer abc');
    });
  });

  // ─── AC2.2: Response interceptor (401 refresh) ───

  describe('AC2.2: response interceptor', () => {
    it('skips refresh for auth endpoints', async () => {
      const authPaths = ['/auth/login', '/auth/register', '/auth/guest-session', '/auth/refresh', '/auth/me'];

      for (const path of authPaths) {
        vi.mocked(axios.post).mockReset();
        const error = {
          config: { url: path, headers: {} as Record<string, string> },
          response: { status: 401 },
        };
        await expect(responseRejected!(error)).rejects.toBeDefined();
      }
      expect(standalonePost).not.toHaveBeenCalled();
    });

    it('retries request after successful refresh', async () => {
      localStorage.setItem('auth-storage', JSON.stringify({
        state: { token: 'expired', refreshToken: 'valid-refresh', user: { id: 'u1' } },
        version: 0,
      }));

      const originalRequest = {
        url: '/tasks',
        headers: {} as Record<string, string>,
        _retry: undefined as boolean | undefined,
      };
      const error = { config: originalRequest, response: { status: 401 } };

      // refreshToken() uses axios.post (standalone)
      standalonePost.mockResolvedValueOnce({
        data: { accessToken: 'new-token', refreshToken: 'new-refresh', userId: 'u1' },
      });
      mockAxiosInstance.request.mockResolvedValueOnce({ data: 'success' });

      await responseRejected!(error);

      expect(standalonePost).toHaveBeenCalledWith(
        expect.stringContaining('/auth/refresh'),
        { refreshToken: 'valid-refresh' }
      );

      const stored = JSON.parse(localStorage.getItem('auth-storage')!);
      expect(stored.state.token).toBe('new-token');
      expect(stored.state.refreshToken).toBe('new-refresh');

      expect(originalRequest.headers.Authorization).toBe('Bearer new-token');
      expect(originalRequest._retry).toBe(true);
    });

    it('clears localStorage on refresh failure', async () => {
      localStorage.setItem('auth-storage', JSON.stringify({
        state: { token: 'expired', refreshToken: 'bad', user: { id: 'u1' } },
        version: 0,
      }));

      const error = {
        config: { url: '/tasks', headers: {} as Record<string, string> },
        response: { status: 401 },
      };

      standalonePost.mockRejectedValueOnce(new Error('refresh failed'));

      await expect(responseRejected!(error)).rejects.toThrow();
      expect(localStorage.getItem('auth-storage')).toBeNull();
    });

    it('does not retry if _retry flag already set', async () => {
      const error = {
        config: { url: '/tasks', headers: {} as Record<string, string>, _retry: true },
        response: { status: 401 },
      };

      await expect(responseRejected!(error)).rejects.toBeDefined();
      expect(standalonePost).not.toHaveBeenCalled();
    });
  });

  // ─── AC2.3: Concurrent 401 queue ───

  describe('AC2.3: concurrent 401 handling', () => {
    it('queues second 401 while first refresh is in progress', async () => {
      localStorage.setItem('auth-storage', JSON.stringify({
        state: { token: 'expired', refreshToken: 'valid-refresh', user: { id: 'u1' } },
        version: 0,
      }));

      let resolveRefresh: (value: unknown) => void;
      const refreshPromise = new Promise((resolve) => { resolveRefresh = resolve; });
      standalonePost.mockReturnValueOnce(refreshPromise as never);

      const error1 = { config: { url: '/tasks', headers: {} as Record<string, string> }, response: { status: 401 } };
      const error2 = { config: { url: '/agents', headers: {} as Record<string, string> }, response: { status: 401 } };

      const promise1 = responseRejected!(error1);
      // Small delay to ensure first request sets isRefreshing=true
      await new Promise((r) => setTimeout(r, 5));
      const promise2 = responseRejected!(error2);

      // Only one refresh call made
      expect(standalonePost).toHaveBeenCalledTimes(1);

      resolveRefresh!({ data: { accessToken: 'new-token', refreshToken: 'new-refresh', userId: 'u1' } });

      mockAxiosInstance.request
        .mockResolvedValueOnce({ data: 'tasks-ok' })
        .mockResolvedValueOnce({ data: 'agents-ok' });

      await Promise.allSettled([promise1, promise2]);

      // Still only one refresh call
      expect(standalonePost).toHaveBeenCalledTimes(1);
    });
  });

  // ─── AC2.4: refreshToken export ───

  describe('AC2.4: refreshToken function', () => {
    it('is exported', () => {
      expect(typeof refreshToken).toBe('function');
    });

    it('calls POST /auth/refresh with refreshToken param', async () => {
      standalonePost.mockResolvedValueOnce({
        data: { accessToken: 'new-access', refreshToken: 'new-refresh' },
      });

      const result = await refreshToken('my-refresh-token');

      expect(standalonePost).toHaveBeenCalledWith(
        expect.stringContaining('/auth/refresh'),
        { refreshToken: 'my-refresh-token' }
      );
      expect(result).toEqual({ accessToken: 'new-access', refreshToken: 'new-refresh' });
    });

    it('uses standalone axios, not the api instance', async () => {
      standalonePost.mockResolvedValueOnce({
        data: { accessToken: 'a', refreshToken: 'b' },
      });

      await refreshToken('token');

      expect(standalonePost).toHaveBeenCalled();
      expect(mockAxiosInstance.post).not.toHaveBeenCalled();
    });
  });
});
