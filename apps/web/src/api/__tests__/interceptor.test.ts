/**
 * Axios interceptor tests
 *
 * Verifies:
 * - Request interceptor injects Bearer token from localStorage
 * - Request interceptor skips auth paths
 * - Response interceptor: 401 → refresh → retry with new token
 * - Response interceptor: concurrent 401s queue and share one refresh
 * - Response interceptor: no refresh token → clear storage and reject
 * - Response interceptor: refresh failure → clear storage and reject
 * - Response interceptor: non-401 errors pass through
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import type { AxiosError, AxiosResponse, InternalAxiosRequestConfig } from 'axios';

// Mock localStorage
const store: Record<string, string> = {};
const localStorageMock = {
  getItem: vi.fn((key: string) => store[key] ?? null),
  setItem: vi.fn((key: string, value: string) => { store[key] = value; }),
  removeItem: vi.fn((key: string) => { delete store[key]; }),
  clear: vi.fn(() => { for (const k of Object.keys(store)) delete store[k]; }),
};
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock });

// We'll use a fresh axios instance per test via dynamic import + module reset
// to avoid module-level state (isRefreshing, failedQueue) leaking between tests.

function setAuthStorage(token: string | null, refreshToken: string | null) {
  if (token || refreshToken) {
    store['auth-storage'] = JSON.stringify({ state: { token, refreshToken } });
  } else {
    delete store['auth-storage'];
  }
}

describe('api interceptor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorageMock.clear();
    vi.resetModules();
  });

  describe('request interceptor', () => {
    it('injects Bearer token for non-auth paths', async () => {
      setAuthStorage('my-token', 'my-refresh');
      const { api } = await import('../index.js');

      // Use adapter to capture the request config
      const captured: InternalAxiosRequestConfig[] = [];
      api.defaults.adapter = async (config) => {
        captured.push(config);
        return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
      };

      await api.get('/tasks');

      expect(captured[0].headers.Authorization).toBe('Bearer my-token');
    });

    it('still injects Bearer token for auth paths (isAuthPath only affects refresh)', async () => {
      setAuthStorage('my-token', 'my-refresh');
      const { api } = await import('../index.js');

      const captured: InternalAxiosRequestConfig[] = [];
      api.defaults.adapter = async (config) => {
        captured.push(config);
        return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
      };

      await api.get('/auth/me');

      // Request interceptor injects Bearer for ALL paths.
      // isAuthPath is only used by response interceptor (skip refresh on 401).
      expect(captured[0].headers.Authorization).toBe('Bearer my-token');
    });

    it('does not inject when no token stored', async () => {
      setAuthStorage(null, null);
      const { api } = await import('../index.js');

      const captured: InternalAxiosRequestConfig[] = [];
      api.defaults.adapter = async (config) => {
        captured.push(config);
        return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
      };

      await api.get('/tasks');

      expect(captured[0].headers.Authorization).toBeUndefined();
    });
  });

  describe('response interceptor — 401 refresh flow', () => {
    it('refreshes token and retries original request on 401', async () => {
      setAuthStorage('old-token', 'valid-refresh');
      const { api } = await import('../index.js');

      let callCount = 0;
      api.defaults.adapter = async (config) => {
        callCount++;
        // First call: return 401. Second call (retry): succeed.
        if (callCount === 1) {
          const err = new Error('Unauthorized') as AxiosError;
          err.response = { status: 401, data: { error: 'Unauthorized' } };
          err.config = { ...config, _retry: false };
          throw err;
        }
        return { data: { ok: true }, status: 200, statusText: 'OK', headers: {}, config };
      };

      // Mock the refresh endpoint (standalone axios call to /auth/refresh)
      // The refreshToken function uses axios.post directly, so we mock the global axios.post
      const originalPost = axios.post;
      vi.spyOn(axios, 'post').mockImplementation(async (url: string, data?: unknown) => {
        if (url.includes('/auth/refresh')) {
          return { data: { accessToken: 'new-token', refreshToken: 'new-refresh' } } as AxiosResponse;
        }
        return originalPost(url, data);
      });

      const response = await api.get('/tasks');

      expect(response.data).toEqual({ ok: true });
      // localStorage should be updated with new tokens
      expect(localStorageMock.setItem).toHaveBeenCalledWith(
        'auth-storage',
        expect.stringContaining('new-token')
      );
    });

    it('rejects when no refresh token is stored', async () => {
      setAuthStorage('old-token', null);
      const { api } = await import('../index.js');

      api.defaults.adapter = async (config) => {
        const err = new Error('Unauthorized') as AxiosError;
        err.response = { status: 401, data: { error: 'Unauthorized' } };
        err.config = { ...config, _retry: false };
        throw err;
      };

      await expect(api.get('/tasks')).rejects.toThrow();
      // Should clear auth storage
      expect(localStorageMock.removeItem).toHaveBeenCalledWith('auth-storage');
    });

    it('rejects and clears storage when refresh fails', async () => {
      setAuthStorage('old-token', 'bad-refresh');
      const { api } = await import('../index.js');

      api.defaults.adapter = async (config) => {
        const err = new Error('Unauthorized') as AxiosError;
        err.response = { status: 401, data: { error: 'Unauthorized' } };
        err.config = { ...config, _retry: false };
        throw err;
      };

      vi.spyOn(axios, 'post').mockRejectedValue(new Error('Refresh failed'));

      await expect(api.get('/tasks')).rejects.toThrow('Refresh failed');
      expect(localStorageMock.removeItem).toHaveBeenCalledWith('auth-storage');
    });

    it('passes through non-401 errors', async () => {
      setAuthStorage('token', 'refresh');
      const { api } = await import('../index.js');

      api.defaults.adapter = async () => {
        const err = new Error('Server Error') as AxiosError;
        err.response = { status: 500, data: { error: 'Internal' } };
        err.config = { url: '/tasks', _retry: false };
        throw err;
      };

      await expect(api.get('/tasks')).rejects.toThrow('Server Error');
    });

    it('skips refresh for auth paths (login, register, etc.)', async () => {
      setAuthStorage('token', 'refresh');
      const { api } = await import('../index.js');

      api.defaults.adapter = async () => {
        const err = new Error('Bad credentials') as AxiosError;
        err.response = { status: 401, data: { error: 'Bad credentials' } };
        err.config = { url: '/auth/login', _retry: false };
        throw err;
      };

      const postSpy = vi.spyOn(axios, 'post');

      await expect(api.post('/auth/login', { email: 'a', password: 'b' })).rejects.toThrow();
      // Should NOT call refresh
      expect(postSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('/auth/refresh'),
        expect.anything()
      );
    });
  });

  describe('response interceptor — concurrent 401 queuing', () => {
    it('queues concurrent 401s and retries all after single refresh', async () => {
      setAuthStorage('old-token', 'valid-refresh');
      const { api } = await import('../index.js');

      let callCount = 0;
      api.defaults.adapter = async (config) => {
        callCount++;
        if (callCount <= 2) {
          // First two requests get 401
          const err = new Error('Unauthorized') as AxiosError;
          err.response = { status: 401, data: { error: 'Unauthorized' } };
          err.config = { ...config, _retry: false };
          throw err;
        }
        // Retries succeed
        return { data: { ok: callCount }, status: 200, statusText: 'OK', headers: {}, config };
      };

      let refreshCount = 0;
      vi.spyOn(axios, 'post').mockImplementation(async (url: string) => {
        if (url.includes('/auth/refresh')) {
          refreshCount++;
          return { data: { accessToken: 'new-token', refreshToken: 'new-refresh' } } as AxiosResponse;
        }
        throw new Error('unexpected post');
      });

      // Fire two requests concurrently
      const [res1, res2] = await Promise.all([
        api.get('/tasks'),
        api.get('/agents'),
      ]);

      expect(res1.data.ok).toBeDefined();
      expect(res2.data.ok).toBeDefined();
      // Only one refresh call should have been made
      expect(refreshCount).toBe(1);
    });
  });
});
