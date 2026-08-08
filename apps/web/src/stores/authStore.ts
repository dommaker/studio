/**
 * 认证状态管理 - Auth Store (Zustand)
 * SEC-001: 用户认证系统
 * 使用 zustand persist 中间件自动持久化
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { authApi } from '../api';

export interface User {
  id: string;
  email: string;
  name?: string;
  avatar?: string;
  role: 'Guest' | 'User' | 'Admin';
  createdAt?: string;
}

export interface Session {
  id: string;
  expiresAt: string;
}

interface AuthState {
  token: string | null;
  user: User | null;
  session: Session | null;
  refreshToken: string | null;
  guestId: string | null;
  isLoading: boolean;
  error: string | null;

  // Computed
  isAuthenticated: () => boolean;
  isAdmin: () => boolean;
  isGuest: () => boolean;
  getRole: () => string;

  // Actions
  requestPasswordReset: (email: string) => Promise<string>;
  resetPassword: (token: string, password: string) => Promise<string>;
  init: () => Promise<void>;
  createGuestSession: () => Promise<void>;
  checkAuth: () => Promise<void>;
  login: (email: string, password: string) => Promise<boolean>;
  register: (email: string, password: string, name?: string) => Promise<boolean>;
  logout: () => Promise<void>;
  fetchMe: () => Promise<void>;
  getAuthHeader: () => Record<string, string>;
  setToken: (token: string, refreshToken?: string) => void;
  setError: (error: string | null) => void;
}

function generateGuestId(): string {
  return `guest_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      // State
      token: null,
      user: null,
      session: null,
      refreshToken: null,
      guestId: null,
      isLoading: false,
      error: null,

      // Computed
      isAuthenticated: () => !!get().user && get().user!.role !== 'Guest',
      isAdmin: () => get().user?.role === 'Admin',
      isGuest: () => !get().user || get().user!.role === 'Guest',
      getRole: () => get().user?.role || 'Guest',

      // Actions
      requestPasswordReset: async (email: string) => {
        set({ isLoading: true, error: null });
        try {
          const { data } = await authApi.forgotPassword(email);
          set({ isLoading: false });
          return data.message as string;
        } catch (e) {
          set({ error: e.response?.data?.error || e.message || '请求失败', isLoading: false });
          throw e;
        }
      },

      resetPassword: async (token: string, password: string) => {
        set({ isLoading: true, error: null });
        try {
          const { data } = await authApi.resetPassword(token, password);
          set({ isLoading: false });
          return data.message as string;
        } catch (e) {
          set({ error: e.response?.data?.error || e.message || '重置失败', isLoading: false });
          throw e;
        }
      },

      init: async () => {
        if (get().token) {
          await get().checkAuth();
        } else {
          await get().createGuestSession();
        }
      },

      createGuestSession: async () => {
        set({ isLoading: true, error: null });
        try {
          const guestId = get().guestId || generateGuestId();
          const { data } = await authApi.createGuestSession(guestId);

          set({
            token: data.token,
            session: { id: data.session?.id, expiresAt: data.session?.expiresAt },
            user: data.user || { id: guestId, email: '', role: 'Guest' },
            guestId,
            isLoading: false,
          });
        } catch (e) {
          set({ error: e.message || '创建 Session 失败', isLoading: false });
        }
      },

      checkAuth: async () => {
        const token = get().token;
        if (!token) return;

        set({ isLoading: true, error: null });
        try {
          const { data } = await authApi.checkAuth();

          if (data.user) {
            set({ user: { ...data.user, role: data.user.role }, isLoading: false });
          } else {
            set({ isLoading: false });
            await get().createGuestSession();
          }
        } catch (e) {
          set({ error: e.message, isLoading: false });
          await get().createGuestSession();
        }
      },

      login: async (email: string, password: string) => {
        set({ isLoading: true, error: null });
        try {
          const { data } = await authApi.login(email, password);

          if (data.error) {
            set({ error: data.error || '登录失败', isLoading: false });
            return false;
          }

          set({
            token: data.token,
            refreshToken: data.refreshToken || null,
            user: data.user,
            session: { id: data.session?.id, expiresAt: data.session?.expiresAt },
            isLoading: false,
          });
          return true;
        } catch (e) {
          set({ error: e.message || '登录失败', isLoading: false });
          return false;
        }
      },

      register: async (email: string, password: string, name?: string) => {
        set({ isLoading: true, error: null });
        try {
          const { data } = await authApi.register(email, password, name);

          if (data.error) {
            set({ error: data.error || '注册失败', isLoading: false });
            return false;
          }

          set({
            token: data.token,
            refreshToken: data.refreshToken || null,
            user: data.user,
            session: { id: data.session?.id, expiresAt: data.session?.expiresAt },
            isLoading: false,
          });
          return true;
        } catch (e) {
          set({ error: e.message || '注册失败', isLoading: false });
          return false;
        }
      },

      logout: async () => {
        try {
          await authApi.logout();
        } catch (e) {
          console.error('Logout error:', e);
        }

        set({ token: null, user: null, session: null });
        await get().createGuestSession();
      },

      fetchMe: async () => {
        try {
          const { data } = await authApi.fetchMe();
          if (data.user) {
            set({ user: data.user, session: data.session });
          }
        } catch (e) {
          console.error('Fetch me error:', e);
        }
      },

      getAuthHeader: () => {
        const token = get().token;
        if (!token) return {};
        return { Authorization: `Bearer ${token}` };
      },

      setToken: (token: string, refreshToken?: string) =>
        set({ token, ...(refreshToken ? { refreshToken } : {}) }),

      setError: (error: string | null) => set({ error }),
    }),
    {
      name: 'auth-storage',
      partialize: (state) => ({
        token: state.token,
        refreshToken: state.refreshToken,
        user: state.user,
        session: state.session,
        guestId: state.guestId,
      }),
    }
  )
);
